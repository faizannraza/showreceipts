#!/usr/bin/env node
// Keeps the generated regions of README.md and the docs set in sync (S33).
//
//   node scripts/gen-docs.mjs           rewrite every region in place
//                                       (also refreshes docs/catalogue.md and
//                                       docs/receipt.svg via their own scripts)
//   node scripts/gen-docs.mjs --check   exit 1 when any region or generated
//                                       file is stale; write nothing
//
// Regions are marked in the Markdown as
//
//   <!-- gen:NAME -->
//   …generated content…
//   <!-- /gen -->
//
// and every region NAME has exactly one generator below. Everything between
// the markers is replaced wholesale, so hand edits inside a region never
// survive `npm run docs:gen` — that is the point: every table and sample in
// the docs is generated output, never hand-maintained prose.
//
// Generators (all deterministic; `--check` is a fixed point):
//   claims-table     `scripts/gen-claims-doc.mjs` (S15) over dist/claims/rules.js
//   prices-table     `scripts/gen-prices-doc.mjs` (S16) over src/cost/prices.json
//   coverage-matrix  the dialect registry (dist/hook/dialects) + §9 facts
//   demo-sample      `docs/samples/contradicted.txt` (S23b golden), fenced
//   publish-example  `bench --publish` run over the committed fixture tree
//
// Requires `npm run build` first (the claims table and the publish example
// load compiled modules / spawn dist/cli.js).
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const CLI = join(DIST, 'cli.js');
const READERS = join(ROOT, 'fixtures', 'readers');
/** The frozen documentation clock (PLAN §0.4); fixture sessions are Feb–Aug 2026. */
const DOC_NOW = '2026-08-29T12:00:00Z';

/** Every file that may carry gen regions. */
const FILES = ['README.md', 'docs/claims.md', 'docs/harnesses.md', 'docs/prices.md', 'docs/privacy.md'];

function fail(msg) {
  process.stderr.write(`gen-docs: ${msg}\n`);
  process.exit(1);
}

function run(argv, opts = {}) {
  return execFileSync(process.execPath, argv, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts });
}

// ---------------------------------------------------------------------------
// coverage matrix
// ---------------------------------------------------------------------------

/**
 * §9 facts the registry does not encode as data: where receipts come from,
 * where exit codes and the final message are read, and strict-nudge support.
 * The events column is pulled live from the dialect registry so a new or
 * renamed hook event can never leave the docs behind.
 */
const HARNESS_FACTS = {
  'claude-code': {
    label: 'Claude Code',
    from: 'transcripts on disk (`~/.claude/projects`)',
    exit: 'parsed from `toolUseResult`',
    final: 'transcript final message',
    strict: 'yes',
  },
  codex: {
    label: 'Codex CLI',
    from: 'rollouts on disk (`~/.codex/sessions`)',
    exit: 'parsed from output headers',
    final: 'rollout `agent_message`',
    strict: 'yes',
  },
  cursor: {
    label: 'Cursor',
    from: 'hook-captured ledger',
    exit: 'harness (`tool_output.exitCode`)',
    final: '`afterAgentResponse.text`',
    strict: 'yes',
  },
  gemini: {
    label: 'Gemini CLI',
    from: 'hook-captured ledger',
    exit: 'parsed (`Exit Code:` in `llmContent`)',
    final: '`AfterAgent.prompt_response`',
    strict: 'experimental',
  },
  copilot: {
    label: 'Copilot CLI',
    from: 'hook-captured ledger',
    exit: 'parsed (`exit code N` in `textResultForLlm`)',
    final: 'transcript at `agentStop.transcriptPath` (best-effort)',
    strict: 'no (v1)',
  },
  hermes: {
    label: 'Hermes',
    from: 'hook-captured ledger',
    exit: 'parsed (`extra.status` / returncode)',
    final: '`post_llm_call.assistant_response`',
    strict: 'no (v1)',
  },
  dsh: {
    label: 'dsh',
    from: 'hook-captured ledger (opt-in)',
    exit: 'parsed (`Exit code N`)',
    final: 'Stop `last_assistant_message`',
    strict: 'as Claude Code (unverified)',
  },
  opencode: {
    label: 'OpenCode',
    from: 'plugin template (roadmap)',
    exit: '&#8212;',
    final: '&#8212;',
    strict: 'no',
  },
  openclaw: {
    label: 'OpenClaw',
    from: 'plugin template (roadmap)',
    exit: '&#8212;',
    final: '&#8212;',
    strict: 'no',
  },
};

async function coverageMatrix() {
  const { DIALECTS } = await import(pathToFileURL(join(DIST, 'hook', 'dialects', 'index.js')).href);
  const { HARNESSES } = await import(pathToFileURL(join(DIST, 'model', 'types.js')).href);
  const lines = [];
  lines.push('| harness | receipts from | hook events | exit codes | final message | strict nudge |');
  lines.push('|---|---|---|---|---|---|');
  for (const h of HARNESSES) {
    const facts = HARNESS_FACTS[h];
    if (facts === undefined) fail(`coverage-matrix: no facts row for harness '${h}' — update scripts/gen-docs.mjs`);
    const events = Object.keys(DIALECTS[h].events)
      .map((e) => `\`${e}\``)
      .join(' · ');
    lines.push(`| ${facts.label} | ${facts.from} | ${events} | ${facts.exit} | ${facts.final} | ${facts.strict} |`);
  }
  lines.push('');
  lines.push(
    'Generated by `scripts/gen-docs.mjs` from the dialect registry (`src/hook/dialects/index.ts`); the source columns follow ARCHITECTURE §9. Transcript harnesses are audited from their own files on disk even with no hook installed; ledger harnesses need `showreceipts setup` first.',
  );
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// demo sample
// ---------------------------------------------------------------------------

function demoSample() {
  const sample = readFileSync(join(ROOT, 'docs', 'samples', 'contradicted.txt'), 'utf8');
  return `\`\`\`text\n${sample.endsWith('\n') ? sample : `${sample}\n`}\`\`\`\n`;
}

// ---------------------------------------------------------------------------
// publish example: a real `bench --publish` run over the committed fixtures
// ---------------------------------------------------------------------------

/** Fixture directories: every directory under fixtures/readers holding an expected.json. */
function listFixtureDirs() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!entry.isDirectory()) continue;
      const p = join(dir, entry.name);
      if (existsSync(join(p, 'expected.json'))) out.push(p);
      else walk(p);
    }
  };
  walk(READERS);
  return out.sort();
}

/** Mirrors `test/helpers/fixtures.ts materializeAll` in plain JS (same layout, mtimes, gz, session_index append). */
function materializeFixtures(into) {
  const claude = join(into, 'claude');
  const codex = join(into, 'codex');
  mkdirSync(claude, { recursive: true });
  mkdirSync(codex, { recursive: true });
  const walkFiles = (dir) => {
    const files = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...walkFiles(p));
      else files.push(p);
    }
    return files.sort();
  };
  for (const dir of listFixtureDirs()) {
    const id = relative(READERS, dir).split(sep).join('/');
    const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'));
    const endedAt = new Date(expected.source?.endedAt ?? '2026-08-01T00:00:00Z');
    const mtime = Number.isNaN(endedAt.getTime()) ? new Date('2026-08-01T00:00:00Z') : endedAt;
    const root = id.startsWith('codex/') ? codex : claude;
    for (const file of walkFiles(dir)) {
      const name = basename(file);
      if (name === 'expected.json' || name === 'REDACTION-REVIEW.md') continue;
      const rel = relative(dir, file).replace(/\.gz$/, '');
      const target = join(root, rel);
      mkdirSync(dirname(target), { recursive: true });
      const bytes = file.endsWith('.gz') ? gunzipSync(readFileSync(file)) : readFileSync(file);
      if (existsSync(target) && basename(target) === 'session_index.jsonl') appendFileSync(target, bytes);
      else writeFileSync(target, bytes);
      utimesSync(target, mtime, mtime);
    }
  }
  return { claudeConfigDir: claude, codexHome: codex };
}

function publishExample() {
  const tmp = mkdtempSync(join(tmpdir(), 'showreceipts-docs-'));
  try {
    const { claudeConfigDir, codexHome } = materializeFixtures(tmp);
    const home = join(tmp, 'home');
    const cwd = join(tmp, 'cwd');
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const out = join(tmp, 'publish.json');
    run([CLI, 'bench', '--publish', out, '--home-dir', '/home/u', '--now', DOC_NOW], {
      cwd,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        USERPROFILE: home,
        TZ: 'UTC',
        NO_COLOR: '1',
        COLUMNS: '80',
        CLAUDE_CONFIG_DIR: claudeConfigDir,
        CODEX_HOME: codexHome,
        SHOWRECEIPTS_HOME: join(tmp, 'sr'),
      },
    });
    const payload = JSON.parse(readFileSync(out, 'utf8'));
    // Everything in the payload is byte-stable across machines EXCEPT the
    // platform fields (node major, os) and the contentHash that covers them.
    // Redact those two visibly so `gen-docs --check` is a fixed point on every
    // OS/Node combination (the first push failed CI when a doc generated on
    // darwin/node-26 was re-checked on linux/node-20). The caption in
    // docs/privacy.md tells the reader exactly which fields are redacted.
    if (payload.platform && typeof payload.platform === 'object') {
      payload.platform = { node: '(varies by machine)', os: '(varies by machine)' };
    }
    if (typeof payload.contentHash === 'string') payload.contentHash = '(varies by machine)';
    return `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// region plumbing
// ---------------------------------------------------------------------------

const REGION_RE = /(<!-- gen:([a-z][a-z0-9-]*) -->\n)([\s\S]*?)(<!-- \/gen -->)/g;

async function buildGenerators() {
  const claims = run([join(ROOT, 'scripts', 'gen-claims-doc.mjs')]);
  const prices = run([join(ROOT, 'scripts', 'gen-prices-doc.mjs')]);
  return {
    'claims-table': claims,
    'prices-table': prices,
    'coverage-matrix': await coverageMatrix(),
    'demo-sample': demoSample(),
    'publish-example': publishExample(),
  };
}

async function main() {
  const check = process.argv.includes('--check');
  if (!existsSync(CLI)) fail('missing dist/cli.js — run `npm run build` first');
  const generators = await buildGenerators();
  const used = new Set();
  const stale = [];

  for (const rel of FILES) {
    const path = join(ROOT, rel);
    if (!existsSync(path)) fail(`${rel} does not exist`);
    const original = readFileSync(path, 'utf8');
    let sawRegion = false;
    const next = original.replace(REGION_RE, (whole, open, name, _body, close) => {
      sawRegion = true;
      const content = generators[name];
      if (content === undefined) fail(`${rel}: unknown gen region '${name}'`);
      used.add(name);
      return `${open}${content}${close}`;
    });
    if (!sawRegion) fail(`${rel}: no <!-- gen:… --> region found`);
    if (next !== original) {
      if (check) stale.push(rel);
      else {
        writeFileSync(path, next);
        process.stdout.write(`gen-docs: rewrote ${rel}\n`);
      }
    }
  }

  for (const name of Object.keys(generators)) {
    if (!used.has(name)) fail(`generator '${name}' is not referenced by any file`);
  }

  // Generated sibling files with their own scripts: the fixture catalogue
  // (owned by scripts/catalogue.mjs since S10) and the README SVG.
  const sub = (script, args) =>
    execFileSync(process.execPath, [join(ROOT, 'scripts', script), ...args], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
  if (check) {
    try {
      sub('catalogue.mjs', ['--check']);
    } catch {
      stale.push('docs/catalogue.md');
    }
    try {
      sub('screenshot.mjs', ['--check']);
    } catch {
      stale.push('docs/receipt.svg');
    }
    if (stale.length > 0) fail(`stale generated content in: ${stale.join(', ')} — run \`npm run docs:gen\``);
    process.stdout.write('gen-docs: all generated regions are up to date\n');
  } else {
    sub('catalogue.mjs', ['--write']);
    sub('screenshot.mjs', []);
    process.stdout.write('gen-docs: done\n');
  }
}

await main();
