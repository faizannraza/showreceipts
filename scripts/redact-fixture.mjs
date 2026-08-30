#!/usr/bin/env node
// Redacts the author's real transcripts into committed, privacy-safe,
// real-shape fixtures (PLAN S03). Author-only: it reads ~/.claude and ~/.codex
// (never writes there) and regenerates fixtures/readers/**.
//
//   node scripts/redact-fixture.mjs --all [--seed S] [--only <fixtureId>]
//   node scripts/redact-fixture.mjs --check          # regenerate into a temp dir and diff
//   node scripts/redact-fixture.mjs --sign "<name>"  # record reviewedBy in expected.json
//   node scripts/redact-fixture.mjs --forbidden      # rebuild fixtures/redaction/forbidden.sha256.json
//
// Real sources are discovered by harness version (the manifest never names a
// real session id or path). Determinism: every map is seeded, output bytes are
// identical on re-run; the only unstable input (this machine's live session)
// is frozen at `freezeLines` (main file) and `frozenFiles` (per-file caps for
// its subagent/workflow/journal files, keyed by the mapped fixture path).
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createIdMap } from './lib/idmap.mjs';
import { createPathMap } from './lib/pathmap.mjs';
import { POLICY_VERSION, canonicalToken, collectIds, createRedactor, toolNameOf } from './lib/redact-policy.mjs';
import { createSurvey, parseLine, sortedSigs, splitLines, surveyJournal, surveyLines, surveyMeta } from './lib/shapes.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = join(ROOT, 'fixtures');
const MANIFEST_PATH = join(FIXTURES, 'manifest.json');
const FORBIDDEN_LOCAL = join(FIXTURES, '.forbidden.local');
const FORBIDDEN_SHA = join(FIXTURES, 'redaction', 'forbidden.sha256.json');
const DEFAULT_SEED = 'showreceipts-fixtures-1';
/** Pinned by test/unit/fixtures/redaction.test.ts, which hashes the same canonical form. */
const FORBIDDEN_ALGORITHM = 'sha256(canonical token: lower-case, every non-alphanumeric character removed)';
const MIB = 1048576;

// ----------------------------------------------------------------- utilities
function log(msg) {
  process.stdout.write(msg + '\n');
}

function fail(msg) {
  process.stderr.write(`redact-fixture: ${msg}\n`);
  process.exit(1);
}

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeFileEnsuring(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

function stableJson(v) {
  return JSON.stringify(v, null, 2) + '\n';
}

/** Deterministic gzip (mtime 0, max compression). */
function gz(buf) {
  return gzipSync(buf, { level: 9 });
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.isFile()) out.push(p);
  }
  return out.sort();
}

/** `--lines a-b[,c-d]` → predicate on 1-based line numbers. */
export function parseWindow(spec) {
  if (spec === null || spec === undefined || spec === '') return null;
  const ranges = String(spec)
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const m = /^(\d+)-(\d+)$/.exec(r);
      if (!m) fail(`bad --lines range: ${r}`);
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (a < 1 || b < a) fail(`bad --lines range: ${r}`);
      return [a, b];
    });
  return ranges;
}

function inWindow(ranges, n) {
  if (ranges === null) return true;
  return ranges.some(([a, b]) => n >= a && n <= b);
}

// ----------------------------------------------------------------- discovery
function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR_REAL ?? join(homedir(), '.claude');
}

function codexHome() {
  return process.env.CODEX_HOME_REAL ?? join(homedir(), '.codex');
}

/** First capture of `re` in the first 64 KiB of a file (the `version` / `cli_version` of a transcript). */
function headVersion(path, re) {
  try {
    const buf = Buffer.alloc(65536);
    const fd = openSync(path, 'r');
    const n = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    const m = re.exec(buf.toString('utf8', 0, n));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Every main Claude Code transcript under a project directory, with its first `version`. */
function discoverClaudeSessions() {
  const root = join(claudeConfigDir(), 'projects');
  if (!existsSync(root)) return [];
  const out = [];
  for (const dash of readdirSync(root).sort()) {
    const dir = join(root, dash);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith('.jsonl')) continue;
      const path = join(dir, f);
      const version = headVersion(path, /"version":"([0-9.]+)"/);
      out.push({ path, dash, sessionId: f.slice(0, -'.jsonl'.length), version, bytes: statSync(path).size });
    }
  }
  return out;
}

/** Every Codex rollout with its `cli_version`. */
function discoverCodexRollouts() {
  const out = [];
  for (const sub of ['sessions', 'archived_sessions']) {
    const root = join(codexHome(), sub);
    if (!existsSync(root)) continue;
    for (const path of walk(root)) {
      if (!/rollout-.*\.jsonl$/.test(basename(path))) continue;
      const version = headVersion(path, /"cli_version":"([0-9.]+)"/);
      out.push({ path, rel: relative(codexHome(), path), version });
    }
  }
  return out;
}

// ----------------------------------------------------------------- forbidden list
function loadForbiddenLocal() {
  if (!existsSync(FORBIDDEN_LOCAL)) return [];
  return readFileSync(FORBIDDEN_LOCAL, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

function autoForbiddenTokens(sources) {
  const tokens = new Set();
  const user = userInfo().username;
  tokens.add(user);
  tokens.add(homedir());
  for (const s of sources) {
    if (s.sessionId) tokens.add(s.sessionId);
    for (const sid of s.sessionIds ?? []) tokens.add(sid);
    if (s.projectDir) tokens.add(s.projectDir);
    for (const id of s.agentIds ?? []) tokens.add(id);
  }
  try {
    const pkg = readJson(join(ROOT, 'package.json'));
    if (typeof pkg.author === 'string') for (const part of pkg.author.split(/\s+/)) if (part.length >= 3) tokens.add(part);
    const url = typeof pkg.repository === 'object' ? pkg.repository.url : pkg.repository;
    const m = /github\.com[/:]([^/]+)\//.exec(String(url ?? ''));
    if (m) tokens.add(m[1]);
  } catch {
    /* no package.json */
  }
  try {
    const gitconfig = readFileSync(join(homedir(), '.gitconfig'), 'utf8');
    for (const m of gitconfig.matchAll(/^\s*email\s*=\s*(\S+)/gm)) {
      const email = m[1];
      tokens.add(email);
      const at = email.indexOf('@');
      if (at > 0) {
        tokens.add(email.slice(0, at));
        tokens.add(email.slice(at + 1));
      }
    }
    for (const m of gitconfig.matchAll(/^\s*name\s*=\s*(.+)$/gm)) for (const part of m[1].trim().split(/\s+/)) if (part.length >= 3) tokens.add(part);
  } catch {
    /* no ~/.gitconfig */
  }
  return [...tokens];
}

/** Writes the plaintext (git-ignored) and hashed (committed) forbidden lists. */
function writeForbidden(tokens) {
  const all = [...new Set([...loadForbiddenLocal(), ...tokens])].filter((t) => t.length >= 3).sort();
  writeFileEnsuring(FORBIDDEN_LOCAL, '# plaintext forbidden tokens (git-ignored); regenerated by scripts/redact-fixture.mjs\n' + all.join('\n') + '\n');
  const hashes = [...new Set(all.map(canonicalToken).filter((t) => t.length >= 3).map(sha256))].sort();
  writeFileEnsuring(FORBIDDEN_SHA, stableJson({ algorithm: FORBIDDEN_ALGORITHM, count: hashes.length, hashes }));
  return all;
}

// ----------------------------------------------------------------- source selection
function readLines(path) {
  return splitLines(readFileSync(path));
}

function lastTimestamp(lines) {
  let ts = null;
  for (const buf of lines) {
    const r = parseLine(buf);
    if (r && typeof r.timestamp === 'string') ts = r.timestamp;
  }
  return ts;
}

function firstTimestamp(lines) {
  for (const buf of lines) {
    const r = parseLine(buf);
    if (r && typeof r.timestamp === 'string') return r.timestamp;
  }
  return null;
}

/**
 * Resolves the real files behind one Claude Code fixture: the windowed main
 * file, the subagent files referenced by `Agent` results inside the window
 * (plus nested children, depth ≤ 4), the workflow files of `Workflow` results
 * (capped), their `.meta.json` and one `journal.jsonl`.
 */
function resolveClaudeSource(id, entry, sessions) {
  const candidates = sessions.filter((s) => s.version === entry.harnessVersion);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.bytes - a.bytes);
  const main = candidates[0];
  const allLines = readLines(main.path);
  const window = parseWindow(entry.window);
  const freeze = typeof entry.freezeLines === 'number' ? entry.freezeLines : null;
  const selected = [];
  for (let i = 0; i < allLines.length; i++) {
    const n = i + 1;
    if (freeze !== null && n > freeze) break;
    if (allLines[i].length === 0) continue;
    if (inWindow(window, n)) selected.push({ n, buf: allLines[i] });
  }
  const sessionDir = join(dirname(main.path), main.sessionId);
  const subagentsDir = join(sessionDir, 'subagents');
  const metas = new Map();
  for (const path of walk(subagentsDir)) {
    if (!path.endsWith('.meta.json')) continue;
    const agentId = basename(path).replace(/^agent-/, '').replace(/\.meta\.json$/, '');
    try {
      metas.set(agentId, { path, meta: readJson(path), jsonl: path.replace(/\.meta\.json$/, '.jsonl') });
    } catch {
      /* unreadable sidecar */
    }
  }
  const caps = { directCap: 12, workflowCap: 3, journal: false, ...(entry.subagents ?? {}) };
  const direct = [];
  const workflowDirs = [];
  for (const { buf } of selected) {
    const r = parseLine(buf);
    const t = r?.toolUseResult;
    if (t && typeof t === 'object' && !Array.isArray(t)) {
      if (t.status === 'async_launched' && typeof t.agentId === 'string' && !direct.includes(t.agentId)) direct.push(t.agentId);
      if (typeof t.runId === 'string' && typeof t.transcriptDir === 'string' && !workflowDirs.includes(t.transcriptDir)) workflowDirs.push(t.transcriptDir);
    }
  }
  const chosen = [];
  const seen = new Set();
  const addAgent = (agentId, depth) => {
    if (depth > 4 || seen.has(agentId)) return;
    const m = metas.get(agentId);
    if (!m) return;
    seen.add(agentId);
    chosen.push({ agentId, ...m, depth });
    const children = [...metas.entries()].filter(([, v]) => v.meta.parentAgentId === agentId).map(([k]) => k).sort();
    for (const child of children) addAgent(child, depth + 1);
  };
  for (const agentId of direct.slice(0, caps.directCap)) addAgent(agentId, 1);
  const workflowFiles = [];
  let journal = null;
  for (const dir of workflowDirs) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).sort();
    for (const f of files) {
      if (workflowFiles.length >= caps.workflowCap) break;
      if (!/^agent-[0-9a-f]+\.jsonl$/.test(f)) continue;
      workflowFiles.push({ jsonl: join(dir, f), meta: join(dir, f.replace(/\.jsonl$/, '.meta.json')), dir });
    }
    if (caps.journal && journal === null && files.includes('journal.jsonl')) journal = { path: join(dir, 'journal.jsonl'), dir };
    if (workflowFiles.length >= caps.workflowCap && (!caps.journal || journal !== null)) break;
  }
  return {
    id,
    harness: 'claude-code',
    main,
    allLines,
    selected,
    window,
    freeze,
    sessionDir,
    chosen,
    workflowFiles,
    journal,
    projectDir: null,
    agentIds: [...chosen.map((c) => c.agentId), ...workflowFiles.map((w) => basename(w.jsonl).replace(/^agent-/, '').replace(/\.jsonl$/, ''))],
    sessionId: main.sessionId,
  };
}

/** The rollout id is the file-name suffix (`rollout-<ts>-<uuid>.jsonl`). */
const ROLLOUT_ID_RE = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function resolveCodexSource(id, entry, rollouts) {
  const files = rollouts.filter((r) => r.version === entry.harnessVersion).sort((a, b) => (a.rel < b.rel ? -1 : 1));
  if (files.length === 0) return null;
  // Real rollout ids join the forbidden list like Claude session ids, so a real id used as a test vector fails the privacy scan.
  const sessionIds = files.map((f) => ROLLOUT_ID_RE.exec(basename(f.path))?.[1] ?? null).filter((sid) => sid !== null);
  return { id, harness: 'codex', files, sessionId: null, sessionIds, agentIds: [] };
}

// ----------------------------------------------------------------- generation
function relOut(fixtureDir, path) {
  return relative(fixtureDir, path).split(sep).join('/');
}

function createReview() {
  const categories = new Map();
  return {
    add(category, text) {
      let m = categories.get(category);
      if (!m) {
        m = new Map();
        categories.set(category, m);
      }
      m.set(text, (m.get(text) ?? 0) + 1);
    },
    render(id, extra) {
      const out = [`# Redaction review — ${id}`, '', 'Every string kept verbatim by the redaction policy, for the author\'s eyeball review before commit. Stubs (`<kind:Nb>`) are not listed.', ''];
      for (const [k, v] of Object.entries(extra)) out.push(`- ${k}: ${v}`);
      out.push('');
      for (const category of [...categories.keys()].sort()) {
        const m = categories.get(category);
        out.push(`## ${category} (${m.size} distinct)`, '');
        for (const text of [...m.keys()].sort()) out.push(`- \`${text.replace(/`/g, '\u0060\u200b').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}\` ×${m.get(text)}`);
        out.push('');
      }
      return out.join('\n');
    },
  };
}

function padRecord(json, originalBytes) {
  if (originalBytes < MIB) return json;
  const current = Buffer.byteLength(json, 'utf8');
  if (current >= MIB) return json;
  const padLen = MIB - current;
  return json.slice(0, -1) + `,"__pad":"${'x'.repeat(padLen)}"}`;
}

function serialize(records) {
  return Buffer.from(records.map((r) => r + '\n').join(''), 'utf8');
}

/** Generates one Claude Code fixture into `outDir`; returns the survey + file list. */
function generateClaude(src, outDir, ctx) {
  const { ids, paths, redactor, toolNames } = ctx;
  const sid = ids.mapUuid(src.main.sessionId);
  const dash = paths.rewrite(src.main.dash);
  const projectDir = join(outDir, 'projects', dash);
  const written = [];
  const files = {};
  const survey = createSurvey();
  const emit = (path, buf) => {
    writeFileEnsuring(path, buf);
    written.push(path);
  };
  /** Pinned line cap for a still-growing source file (`manifest.frozenFiles`, keyed by mapped path). */
  const capped = (relPath, entries) => {
    const cap = ctx.frozenFiles[relPath];
    return typeof cap === 'number' && cap >= 0 && entries.length > cap ? entries.slice(0, cap) : entries;
  };
  const redactLines = (entries, fileRole) => {
    const out = [];
    const raw = [];
    for (const { buf } of entries) {
      const r = parseLine(buf);
      if (r === null) {
        ctx.stats.badLines++;
        continue;
      }
      if (r.toolUseResult !== undefined) r.__tool = toolNameOf(r, toolNames);
      const json = padRecord(JSON.stringify(redactor.redactClaudeRecord(r)), buf.length);
      out.push(json);
      raw.push(Buffer.from(json, 'utf8'));
    }
    surveyLines(raw, 'claude-code', fileRole, survey);
    return out;
  };
  const mainOut = redactLines(src.selected, 'main');
  const mainPath = join(projectDir, `${sid}.jsonl.gz`);
  emit(mainPath, gz(serialize(mainOut)));
  files[relOut(outDir, mainPath).replace(/\.gz$/, '')] = mainOut.length;
  for (const agent of src.chosen) {
    const mapped = ids.mapAgent(agent.agentId);
    const jsonlPath = join(projectDir, sid, 'subagents', `agent-${mapped}.jsonl.gz`);
    const relPath = relOut(outDir, jsonlPath).replace(/\.gz$/, '');
    const lines = capped(relPath, readLines(agent.jsonl).map((buf, i) => ({ n: i + 1, buf })).filter((e) => e.buf.length > 0));
    const outLines = redactLines(lines, 'subagent');
    emit(jsonlPath, gz(serialize(outLines)));
    files[relPath] = outLines.length;
    const meta = redactor.redactMeta(agent.meta);
    surveyMeta(meta, survey);
    emit(join(projectDir, sid, 'subagents', `agent-${mapped}.meta.json`), stableJson(meta));
  }
  for (const wf of src.workflowFiles) {
    const agentId = basename(wf.jsonl).replace(/^agent-/, '').replace(/\.jsonl$/, '');
    const mapped = ids.mapAgent(agentId);
    const wfDir = ids.rewrite(basename(wf.dir));
    const jsonlPath = join(projectDir, sid, 'subagents', 'workflows', wfDir, `agent-${mapped}.jsonl.gz`);
    const relPath = relOut(outDir, jsonlPath).replace(/\.gz$/, '');
    const lines = capped(relPath, readLines(wf.jsonl).map((buf, i) => ({ n: i + 1, buf })).filter((e) => e.buf.length > 0));
    const outLines = redactLines(lines, 'workflow');
    emit(jsonlPath, gz(serialize(outLines)));
    files[relPath] = outLines.length;
    if (existsSync(wf.meta)) {
      const meta = redactor.redactMeta(readJson(wf.meta));
      surveyMeta(meta, survey);
      emit(join(projectDir, sid, 'subagents', 'workflows', wfDir, `agent-${mapped}.meta.json`), stableJson(meta));
    }
  }
  if (src.journal) {
    const wfDir = ids.rewrite(basename(src.journal.dir));
    const journalPath = join(projectDir, sid, 'subagents', 'workflows', wfDir, 'journal.jsonl.gz');
    const relPath = relOut(outDir, journalPath).replace(/\.gz$/, '');
    const out = [];
    for (const { buf } of capped(relPath, readLines(src.journal.path).map((buf, i) => ({ n: i + 1, buf })).filter((e) => e.buf.length > 0))) {
      const r = parseLine(buf);
      if (r === null) continue;
      out.push(JSON.stringify(redactor.redactJournal(r)));
    }
    emit(journalPath, gz(serialize(out)));
    surveyJournal(out.map((l) => Buffer.from(l)), survey);
    files[relPath] = out.length;
  }
  return { survey, files, written, startedAt: firstTimestamp(src.selected.map((e) => e.buf)), endedAt: lastTimestamp(src.selected.map((e) => e.buf)) };
}

function generateCodex(src, outDir, ctx) {
  const { ids, redactor } = ctx;
  const written = [];
  const files = {};
  const survey = createSurvey();
  const selectedIds = new Set();
  let startedAt = null;
  let endedAt = null;
  const emit = (path, buf) => {
    writeFileEnsuring(path, buf);
    written.push(path);
  };
  for (const f of src.files) {
    const lines = readLines(f.path).filter((b) => b.length > 0);
    const out = [];
    for (const buf of lines) {
      const r = parseLine(buf);
      if (r === null) {
        ctx.stats.badLines++;
        continue;
      }
      if (r.type === 'session_meta' && typeof r.payload?.id === 'string') selectedIds.add(r.payload.id);
      out.push(padRecord(JSON.stringify(redactor.redactCodexRecord(r)), buf.length));
    }
    startedAt = startedAt ?? firstTimestamp(lines);
    endedAt = lastTimestamp(lines) ?? endedAt;
    const relPath = ids.rewrite(f.rel.split(sep).join('/'));
    const path = join(outDir, relPath + '.gz');
    emit(path, gz(serialize(out)));
    files[relPath] = out.length;
    surveyLines(out.map((l) => Buffer.from(l)), 'codex', 'main', survey);
  }
  const indexPath = join(codexHome(), 'session_index.jsonl');
  if (existsSync(indexPath)) {
    const out = [];
    for (const buf of readLines(indexPath)) {
      if (buf.length === 0) continue;
      const r = parseLine(buf);
      if (r && selectedIds.has(r.id)) out.push(JSON.stringify(redactor.redactSessionIndex(r)));
    }
    emit(join(outDir, 'session_index.jsonl'), serialize(out));
    files['session_index.jsonl'] = out.length;
    survey.sigs.add('file:codex:session_index');
  }
  const modelsPath = join(codexHome(), 'models_cache.json');
  if (existsSync(modelsPath)) {
    emit(join(outDir, 'models_cache.json'), stableJson(redactor.redactModelsCache(readJson(modelsPath))));
    survey.sigs.add('file:codex:models_cache');
  }
  return { survey, files, written, startedAt, endedAt };
}

function mergeExpected(existingPath, fresh, sign) {
  let existing = {};
  if (existsSync(existingPath)) {
    try {
      existing = readJson(existingPath);
    } catch {
      existing = {};
    }
  }
  const reviewedBy = sign ?? existing.redaction?.reviewedBy ?? null;
  const out = { fixture: fresh.fixture, harness: fresh.harness, confidence: fresh.confidence };
  for (const [k, v] of Object.entries(existing)) if (!(k in out) && k !== 'source' && k !== 'shapes' && k !== 'redaction') out[k] = v;
  out.source = fresh.source;
  out.shapes = fresh.shapes;
  out.redaction = { ...fresh.redaction, reviewedBy };
  return out;
}

/** Generates one real fixture into `fixturesRoot/readers/<id>/`. */
function generateFixture(id, entry, src, seed, forbidden, fixturesRoot, sign) {
  const outDir = join(fixturesRoot, 'readers', id);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const ids = createIdMap(seed);
  const user = userInfo().username;
  const home = homedir();
  const paths = createPathMap({
    user,
    home,
    primaryProject: entry.primaryProject ? join(home, entry.primaryProject) : join(home, 'Desktop', 'Wattage'),
    hashSegment: (seg) => ids.mapToken('pathseg', seg.length >= 8 ? seg : seg.padEnd(8, '_')),
  });
  const review = createReview();
  const toolNames = new Map();
  const redactor = createRedactor({ ids, paths, forbidden, review });
  const stats = { badLines: 0 };
  const frozenFiles = entry.frozenFiles && typeof entry.frozenFiles === 'object' ? entry.frozenFiles : {};
  const ctx = { ids, paths, redactor, toolNames, stats, frozenFiles };
  // pass 1: ids by key, tool names, cwds
  if (src.harness === 'claude-code') {
    const everyLine = [...src.selected.map((e) => e.buf)];
    for (const agent of src.chosen) everyLine.push(...readLines(agent.jsonl));
    for (const wf of src.workflowFiles) everyLine.push(...readLines(wf.jsonl));
    for (const buf of everyLine) {
      if (buf.length === 0) continue;
      collectIds(parseLine(buf), { ids, paths, toolNames, harness: 'claude-code' });
    }
    for (const agent of src.chosen) collectIds({ agentId: agent.agentId, ...agent.meta }, { ids, paths, toolNames, harness: 'claude-code' });
    for (const wf of src.workflowFiles) ids.register(basename(wf.jsonl).replace(/^agent-/, '').replace(/\.jsonl$/, ''), 'agent');
  } else {
    for (const f of src.files) for (const buf of readLines(f.path)) if (buf.length > 0) collectIds(parseLine(buf), { ids, paths, toolNames, harness: 'codex' });
  }
  // pass 2
  const gen = src.harness === 'claude-code' ? generateClaude(src, outDir, ctx) : generateCodex(src, outDir, ctx);
  const shapes = sortedSigs(gen.survey);
  const required = Array.isArray(entry.requiredShapes) ? entry.requiredShapes : [];
  const missing = required.filter((s) => !gen.survey.sigs.has(s));
  const source = {
    harnessVersion: entry.harnessVersion,
    // A frozen (still-growing) source reports the frozen count, so `--check` stays stable as the transcript grows.
    originalLines: src.harness === 'claude-code' ? Math.min(src.allLines.filter((b) => b.length > 0).length, src.freeze ?? Infinity) : src.files.reduce((n, f) => n + readLines(f.path).filter((b) => b.length > 0).length, 0),
    window: entry.window ?? null,
    freezeLines: entry.freezeLines ?? null,
    startedAt: gen.startedAt,
    endedAt: gen.endedAt,
    files: gen.files,
    badLines: stats.badLines,
  };
  const expectedPath = join(outDir, 'expected.json');
  const expected = mergeExpected(join(FIXTURES, 'readers', id, 'expected.json'), {
    fixture: id,
    harness: src.harness,
    confidence: 'real',
    source,
    shapes: required.length > 0 ? required : shapes,
    redaction: { policyVersion: POLICY_VERSION, seed },
  }, sign);
  writeFileEnsuring(expectedPath, stableJson(expected));
  const reviewText = review.render(id, {
    'kept sentences': redactor.stats.keptSentences,
    'kept output lines': redactor.stats.keptLines,
    'commands (skeleton)': redactor.stats.commands,
    'stubs': redactor.stats.stubs,
    'forbidden-token hits (masked)': redactor.stats.forbiddenHits,
    'masked hosts': Object.keys(redactor.hosts()).length,
    'mapped branches': Object.keys(redactor.branches()).length,
    'project roots mapped': Object.keys(paths.projectMap()).length,
    'dropped unparsable lines': stats.badLines,
  });
  writeFileEnsuring(join(outDir, 'REDACTION-REVIEW.md'), reviewText + '\n');
  return { outDir, shapes, missing, lines: gen.survey.lines, bytes: gen.written.reduce((n, p) => n + statSync(p).size, 0) + statSync(expectedPath).size, files: Object.keys(gen.files).length, forbiddenHits: redactor.stats.forbiddenHits };
}

// ----------------------------------------------------------------- driver
function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) fail(`missing ${MANIFEST_PATH}`);
  return readJson(MANIFEST_PATH);
}

/** Resolves every real fixture's sources; entries without sources are reported and skipped. */
export function resolveAllSources(manifest, only) {
  const sessions = discoverClaudeSessions();
  const rollouts = discoverCodexRollouts();
  const resolved = [];
  for (const [id, entry] of Object.entries(manifest.fixtures)) {
    if (entry.confidence !== 'real') continue;
    if (only && id !== only) continue;
    const src = entry.harness === 'codex' ? resolveCodexSource(id, entry, rollouts) : resolveClaudeSource(id, entry, sessions);
    resolved.push({ id, entry, src });
  }
  return resolved;
}

function generateAll(manifest, fixturesRoot, opts) {
  const resolved = resolveAllSources(manifest, opts.only);
  const withSources = resolved.filter((r) => r.src !== null);
  const forbidden = writeForbiddenIfLocal(withSources.map((r) => r.src), opts.writeForbidden);
  const results = [];
  for (const { id, entry, src } of resolved) {
    if (src === null) {
      log(`skip ${id}: no real source for ${entry.harness} ${entry.harnessVersion}`);
      continue;
    }
    const res = generateFixture(id, entry, src, manifest.seed ?? DEFAULT_SEED, forbidden, fixturesRoot, opts.sign);
    results.push({ id, ...res });
    log(`${id}: ${res.files} files, ${res.lines} lines, ${(res.bytes / 1024).toFixed(0)} KB, forbidden hits masked: ${res.forbiddenHits}${res.missing.length ? `, MISSING SHAPES: ${res.missing.join(' ')}` : ''}`);
  }
  return results;
}

function writeForbiddenIfLocal(sources, write) {
  const auto = autoForbiddenTokens(sources);
  if (write) return writeForbidden(auto);
  return [...new Set([...loadForbiddenLocal(), ...auto])];
}

function checkAll(manifest) {
  const tmp = mkdtempSync(join(tmpdir(), 'showreceipts-redact-check-'));
  try {
    const results = generateAll(manifest, tmp, { only: null, sign: null, writeForbidden: false });
    let problems = 0;
    for (const { id } of results) {
      const fresh = join(tmp, 'readers', id);
      const committed = join(FIXTURES, 'readers', id);
      const freshFiles = walk(fresh).map((p) => relative(fresh, p));
      const committedFiles = existsSync(committed) ? walk(committed).map((p) => relative(committed, p)) : [];
      for (const rel of new Set([...freshFiles, ...committedFiles])) {
        const a = join(fresh, rel);
        const b = join(committed, rel);
        if (!existsSync(a) || !existsSync(b)) {
          problems++;
          log(`  ${id}/${rel}: ${existsSync(a) ? 'missing from committed fixtures' : 'not regenerated'}`);
          continue;
        }
        if (basename(rel) === 'expected.json') {
          const ea = readJson(a);
          const eb = readJson(b);
          const pick = (e) => JSON.stringify({ source: e.source, shapes: e.shapes, redaction: { ...e.redaction, reviewedBy: null } });
          if (pick(ea) !== pick(eb)) {
            problems++;
            log(`  ${id}/${rel}: source/shapes/redaction differ`);
          }
          continue;
        }
        if (!readFileSync(a).equals(readFileSync(b))) {
          problems++;
          log(`  ${id}/${rel}: bytes differ`);
        }
      }
    }
    if (problems > 0) fail(`--check: ${problems} difference(s)`);
    log(`--check: ${results.length} fixture(s) identical`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function signAll(name) {
  const manifest = loadManifest();
  for (const id of Object.keys(manifest.fixtures)) {
    const p = join(FIXTURES, 'readers', id, 'expected.json');
    if (!existsSync(p)) continue;
    const e = readJson(p);
    e.redaction = { ...(e.redaction ?? {}), reviewedBy: name };
    writeFileSync(p, stableJson(e));
    log(`signed ${id}`);
  }
}

function main(argv) {
  const opts = { all: false, check: false, only: null, seed: null, sign: null, forbidden: false, sizeCheck: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') opts.all = true;
    else if (a === '--check') opts.check = true;
    else if (a === '--forbidden') opts.forbidden = true;
    else if (a === '--only') opts.only = argv[++i];
    else if (a === '--seed') opts.seed = argv[++i];
    else if (a === '--sign') opts.sign = argv[++i];
    else if (a === '--help' || a === '-h') {
      log('usage: redact-fixture.mjs --all [--only id] [--seed S] [--sign name] | --check | --forbidden | --sign name');
      return;
    } else fail(`unknown argument ${a}`);
  }
  const manifest = loadManifest();
  if (opts.seed !== null && opts.seed !== (manifest.seed ?? DEFAULT_SEED)) fail(`--seed ${opts.seed} disagrees with manifest seed ${manifest.seed}`);
  const discovered = resolveAllSources(manifest, null).some((r) => r.src !== null);
  if (!discovered) {
    log('redact-fixture: no real transcripts on this machine; nothing to do (author-only script)');
    return;
  }
  if (opts.check) {
    checkAll(manifest);
    return;
  }
  if (opts.forbidden && !opts.all) {
    const sources = resolveAllSources(manifest, null).filter((r) => r.src !== null).map((r) => r.src);
    const all = writeForbidden(autoForbiddenTokens(sources));
    log(`forbidden list: ${all.length} tokens hashed into ${relative(ROOT, FORBIDDEN_SHA)}`);
    return;
  }
  if (opts.sign !== null && !opts.all) {
    signAll(opts.sign);
    return;
  }
  if (!opts.all) fail('nothing to do (use --all, --check, --forbidden or --sign)');
  const results = generateAll(manifest, FIXTURES, { only: opts.only, sign: opts.sign, writeForbidden: true });
  const total = walk(FIXTURES).reduce((n, p) => n + statSync(p).size, 0);
  log(`fixtures/: ${(total / 1024 / 1024).toFixed(2)} MB total${total > 8 * MIB ? ' — OVER THE 8 MB BUDGET' : ''}`);
  const missing = results.filter((r) => r.missing.length > 0);
  if (missing.length > 0) fail(`required shapes missing in: ${missing.map((r) => r.id).join(', ')}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
