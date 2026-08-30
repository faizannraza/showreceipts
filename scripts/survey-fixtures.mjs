#!/usr/bin/env node
// Shape survey for transcripts and fixtures (PLAN S03, instruction 8).
//
//   node scripts/survey-fixtures.mjs <file-or-fixture-dir> [--harness codex] [--lines a-b,c-d]
//       prints the shape signatures (record types, system subtypes, attachment
//       types, tool names, toolUseResult key sets, content-block types, Codex
//       payload kinds), line count, max line bytes and hazard presence.
//   node scripts/survey-fixtures.mjs --compare <fixtureId>
//       asserts the real source window and the committed fixture yield the same
//       signature set (values differ, shapes don't). Author machine only.
//   node scripts/survey-fixtures.mjs --check
//       asserts expected.json.shapes ⊆ found for every fixture and fixtures/ ≤ 8 MB.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSurvey, fileRoleOf, readMaybeGz, sortedSigs, splitLines, surveyFixtureDir, surveyJournal, surveyLines, surveyMeta } from './lib/shapes.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = join(ROOT, 'fixtures');
const SIZE_BUDGET = 8 * 1024 * 1024;

function log(msg) {
  process.stdout.write(msg + '\n');
}

function fail(msg) {
  process.stderr.write(`survey-fixtures: ${msg}\n`);
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.isFile()) out.push(p);
  }
  return out.sort();
}

function parseRanges(spec) {
  if (!spec) return null;
  return spec.split(',').map((r) => {
    const m = /^(\d+)-(\d+)$/.exec(r.trim());
    if (!m) fail(`bad --lines range ${r}`);
    return [Number(m[1]), Number(m[2])];
  });
}

function surveyOneFile(path, harness, ranges, state) {
  const lines = splitLines(readMaybeGz(path)).filter((b, i) => b.length > 0 && (ranges === null || ranges.some(([a, z]) => i + 1 >= a && i + 1 <= z)));
  surveyLines(lines, harness, harness === 'codex' ? 'main' : fileRoleOf(path), state);
}

function printSurvey(state, label) {
  log(`# ${label}`);
  log(`lines: ${state.lines}  files: ${state.files}  badLines: ${state.badLines}  maxLineBytes: ${state.maxLineBytes}  u2028: ${state.sigs.has('hazard:u2028')}  u2029: ${state.sigs.has('hazard:u2029')}`);
  for (const s of sortedSigs(state)) log(s);
}

/** Every fixture directory (one `expected.json` each) under fixtures/readers. */
export function listFixtureDirs() {
  const root = join(FIXTURES, 'readers');
  if (!existsSync(root)) return [];
  return walk(root)
    .filter((p) => basename(p) === 'expected.json')
    .map((p) => join(p, '..'))
    .map((p) => ({ id: relative(root, p).split('/').join('/'), dir: p }));
}

function harnessOf(id, expected) {
  if (expected && typeof expected.harness === 'string') return expected.harness;
  return id.startsWith('codex') ? 'codex' : 'claude-code';
}

/** `--check`: expected.json.shapes ⊆ found for every fixture; fixtures/ ≤ 8 MB. */
export function check() {
  const fixtures = listFixtureDirs();
  if (fixtures.length === 0) fail('no fixtures under fixtures/readers');
  let problems = 0;
  for (const { id, dir } of fixtures) {
    const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'));
    const state = surveyFixtureDir(dir, harnessOf(id, expected));
    const shapes = Array.isArray(expected.shapes) ? expected.shapes : [];
    const missing = shapes.filter((s) => !state.sigs.has(s));
    if (missing.length > 0) {
      problems++;
      log(`${id}: ${missing.length} expected shape(s) not found: ${missing.join(' ')}`);
    } else log(`${id}: ok (${shapes.length} expected shapes ⊆ ${state.sigs.size} found; ${state.lines} lines, max ${state.maxLineBytes} B)`);
    if (state.badLines > 0) {
      problems++;
      log(`${id}: ${state.badLines} unparsable line(s)`);
    }
  }
  const total = walk(FIXTURES).reduce((n, p) => n + statSync(p).size, 0);
  log(`fixtures/: ${(total / 1024 / 1024).toFixed(2)} MB (budget ${SIZE_BUDGET / 1024 / 1024} MB)`);
  if (total > SIZE_BUDGET) {
    problems++;
    log('fixtures/ exceeds the 8 MB budget');
  }
  if (problems > 0) fail(`${problems} problem(s)`);
  log(`--check: ${fixtures.length} fixture(s) ok`);
}

async function compare(fixtureId) {
  const { resolveAllSources } = await import('./redact-fixture.mjs');
  const manifest = JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8'));
  const [resolved] = resolveAllSources(manifest, fixtureId);
  if (!resolved || resolved.src === null) fail(`no real source for ${fixtureId} on this machine`);
  const { src } = resolved;
  const real = createSurvey();
  if (src.harness === 'claude-code') {
    surveyLines(src.selected.map((e) => e.buf), 'claude-code', 'main', real);
    for (const agent of src.chosen) {
      surveyLines(splitLines(readFileSync(agent.jsonl)), 'claude-code', 'subagent', real);
      surveyMeta(agent.meta, real);
    }
    for (const wf of src.workflowFiles) {
      surveyLines(splitLines(readFileSync(wf.jsonl)), 'claude-code', 'workflow', real);
      if (existsSync(wf.meta)) surveyMeta(JSON.parse(readFileSync(wf.meta, 'utf8')), real);
    }
    if (src.journal) surveyJournal(splitLines(readFileSync(src.journal.path)), real);
  } else {
    for (const f of src.files) surveyLines(splitLines(readFileSync(f.path)), 'codex', 'main', real);
    real.sigs.add('file:codex:session_index');
    real.sigs.add('file:codex:models_cache');
  }
  const dir = join(FIXTURES, 'readers', fixtureId);
  const fixture = surveyFixtureDir(dir, src.harness);
  const onlyReal = sortedSigs(real).filter((s) => !fixture.sigs.has(s));
  const onlyFixture = sortedSigs(fixture).filter((s) => !real.sigs.has(s));
  log(`real: ${real.lines} lines / ${real.sigs.size} shapes; fixture: ${fixture.lines} lines / ${fixture.sigs.size} shapes`);
  for (const s of onlyReal) log(`  only in real:    ${s}`);
  for (const s of onlyFixture) log(`  only in fixture: ${s}`);
  if (onlyReal.length > 0 || onlyFixture.length > 0) fail(`${fixtureId}: shape sets differ`);
  log(`--compare ${fixtureId}: shape sets equal`);
}

async function main(argv) {
  let target = null;
  let harness = null;
  let ranges = null;
  let mode = 'print';
  let compareId = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') mode = 'check';
    else if (a === '--compare') {
      mode = 'compare';
      compareId = argv[++i];
    } else if (a === '--harness') harness = argv[++i];
    else if (a === '--lines') ranges = parseRanges(argv[++i]);
    else if (a === '--help' || a === '-h') {
      log('usage: survey-fixtures.mjs <file|dir> [--harness codex] [--lines a-b] | --compare <fixtureId> | --check');
      return;
    } else if (a.startsWith('--')) fail(`unknown argument ${a}`);
    else target = a;
  }
  if (mode === 'check') return check();
  if (mode === 'compare') return compare(compareId ?? fail('--compare needs a fixture id'));
  if (!target) fail('give a transcript file or a fixture directory (or --check / --compare)');
  const st = statSync(target);
  if (st.isDirectory()) {
    const expectedPath = join(target, 'expected.json');
    const expected = existsSync(expectedPath) ? JSON.parse(readFileSync(expectedPath, 'utf8')) : null;
    const h = harness ?? harnessOf(basename(target), expected) ?? 'claude-code';
    printSurvey(surveyFixtureDir(target, h), target);
    return;
  }
  const h = harness ?? (/rollout-/.test(basename(target)) ? 'codex' : 'claude-code');
  const state = createSurvey();
  if (/\.meta\.json$/.test(target)) surveyMeta(JSON.parse(readFileSync(target, 'utf8')), state);
  else if (/journal\.jsonl(\.gz)?$/.test(target)) surveyJournal(splitLines(readMaybeGz(target)), state);
  else surveyOneFile(target, h, ranges, state);
  printSurvey(state, target);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((err) => fail(err instanceof Error ? err.stack ?? err.message : String(err)));
}
