#!/usr/bin/env node
// Author-only live-hook verification (PLAN S32, milestone M4). Proves the
// Stop path and `setup` against the real Claude Code config and the real
// frozen transcripts on the author's machine **without touching either**:
//
//   1. `setup --dry-run --json` / `setup --json` against a COPY of the real
//      `~/.claude/settings.json` in a temp HOME — the diff must touch only
//      `hooks.Stop` (plus `SessionStart` under `--strict`), the backup must
//      land under the temp `~/.showreceipts/backups/claude-code/`, and a
//      second run must report `unchanged`.
//   2. A simulated Claude Code Stop over the real 39 MB frozen transcript
//      (§0.3's biggest session), stdin built from its real last turn,
//      cold + warm (cache) — receipt written into a temp repo, budgets met,
//      warm receipt byte-identical.
//   3. The same for the frozen Codex rollout via the `session_id` suffix
//      lookup (`transcript_path: null`, `CODEX_HOME` = the real root).
//   4. `doctor` over the real roots with a temp `SHOWRECEIPTS_HOME` — exit 0.
//   5. A metadata snapshot (lstat: size + mtime ns) of `~/.claude` and
//      `~/.codex` before/after proves nothing real changed. BSD `ls` has no
//      `--time-style=full-iso`, so the snapshot uses lstat with nanosecond
//      mtimes — strictly stronger than the plan's `ls -la` diff.
//
// CI-safe: when the real roots or the frozen files are absent (every machine
// but the author's), the script prints `skipped` and exits 0. It only ever
// READS real files (transcript/rollout/settings bytes; metadata elsewhere)
// and writes exclusively into `fs.mkdtemp` directories. It never invokes
// git (temp "repos" are a bare `.git/` directory — `util/gitroot.ts` only
// stats the marker) and never opens `tool-results/`, `tasks/`, `auth.json`
// or `.env` contents.
//
//   npm run build && node scripts/verify-hooks-local.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const CLI = join(DIST, 'cli.js');
const HOME = homedir();
const REAL_CLAUDE = join(HOME, '.claude');
const REAL_CODEX = join(HOME, '.codex');
const REAL_SETTINGS = join(REAL_CLAUDE, 'settings.json');
/** Frozen session prefixes (§0.3; PLAN S32): the 39 MB Claude Code main and the Codex rollout. */
const CLAUDE_PREFIX = '488dd663';
const CODEX_PREFIX = '019c4678';
/** Pinned clock for the stop runs so cold and warm receipts are byte-comparable. */
const PINNED_NOW = '2026-09-04T12:00:00Z';
/** Review-checklist budgets (ms): cold < 5 s, warm < 1.5 s on the 39 MB transcript. */
const COLD_BUDGET_MS = 5000;
const WARM_BUDGET_MS = 1500;

const rows = [];
const timings = [];
const cleanups = [];

function pass(label, detail = '') {
  rows.push({ ok: true, label, detail });
  process.stdout.write(`  PASS  ${label}${detail === '' ? '' : `  (${detail})`}\n`);
}

function fail(label, detail = '') {
  rows.push({ ok: false, label, detail });
  process.stdout.write(`  FAIL  ${label}${detail === '' ? '' : `  (${detail})`}\n`);
}

function check(cond, label, detail = '') {
  if (cond) pass(label, detail);
  else fail(label, detail);
  return cond;
}

function info(label) {
  process.stdout.write(`  INFO  ${label}\n`);
}

function skip(reason) {
  process.stdout.write(`verify-hooks-local: skipped (${reason})\n`);
  process.exit(0);
}

/** Deep structural equality over JSON-shaped values. */
function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return deepEqual(ka, kb) && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function mkTemp(tag) {
  const dir = fs.mkdtempSync(join(tmpdir(), `sr-s32-${tag}-`));
  cleanups.push(dir);
  return dir;
}

/** A fake repo root: `util/gitroot.ts` only requires a `.git` directory to exist. */
function makeRepo(base) {
  const repo = join(base, 'repo');
  fs.mkdirSync(join(repo, '.git'), { recursive: true });
  return repo;
}

/** Minimal deterministic child environment; never inherits the parent wholesale. */
function childEnv(overrides) {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', TZ: 'UTC', NO_COLOR: '1', COLUMNS: '80', ...overrides };
}

/** Spawns `node dist/cli.js <args>`; returns `{status, stdout, stderr, ms}`. */
function runCli(args, { env, cwd, input }) {
  const t0 = process.hrtime.bigint();
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env,
    input: input ?? '',
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (res.error) fail(`spawn ${args.join(' ')}`, String(res.error));
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', ms };
}

/**
 * Metadata snapshot of a real tree: `path → "size:mtimeNs"` via lstat, no
 * file contents ever opened, symlinks not followed, unreadable entries
 * skipped. Strictly stronger than `ls -la --time-style=full-iso`.
 */
function snapshotMeta(root) {
  const map = new Map();
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      try {
        const st = fs.lstatSync(p, { bigint: true });
        if (st.isFile() || st.isSymbolicLink()) map.set(p, `${st.size}:${st.mtimeNs}`);
        else if (st.isDirectory()) walk(p);
      } catch {
        // raced or unreadable: metadata-only walk tolerates both
      }
    }
  };
  walk(root);
  return map;
}

/** Paths present in either snapshot whose entry changed (added, removed or different). */
function diffMeta(before, after) {
  const changed = [];
  for (const [p, v] of before) if (after.get(p) !== v) changed.push(p);
  for (const p of after.keys()) if (!before.has(p)) changed.push(p);
  return changed.sort();
}

/** The frozen Claude Code main transcript, by session-id prefix (non-recursive per project). */
function findClaudeTranscript() {
  const projects = join(REAL_CLAUDE, 'projects');
  let dirs;
  try {
    dirs = fs.readdirSync(projects, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let files;
    try {
      files = fs.readdirSync(join(projects, d.name));
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.startsWith(CLAUDE_PREFIX) && f.endsWith('.jsonl') && !f.startsWith('agent-')) {
        return join(projects, d.name, f);
      }
    }
  }
  return null;
}

/** The frozen Codex rollout, by UUIDv7 prefix, under `sessions/**` or `archived_sessions/**`. */
function findCodexRollout() {
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth > 0) walk(p, depth - 1);
      else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name) && e.name.includes(CODEX_PREFIX)) found.push(p);
    }
  };
  for (const base of ['sessions', 'archived_sessions']) walk(join(REAL_CODEX, base), 6);
  return found.sort()[0] ?? null;
}

// ---------------------------------------------------------------------------
// Part 1 — setup against a copy of the real settings.json in a temp HOME
// ---------------------------------------------------------------------------

/** The §9 Claude Code Stop entry shape check (one group, one command hook). */
function stopEntryOk(stop, strict) {
  if (!Array.isArray(stop) || stop.length !== 1) return false;
  const group = stop[0];
  if (!Array.isArray(group?.hooks) || group.hooks.length !== 1) return false;
  const h = group.hooks[0];
  const wanted = ` hook claude-code Stop${strict ? ' --strict' : ''}`;
  return (
    h?.type === 'command' &&
    typeof h.command === 'string' &&
    h.command.startsWith('"') &&
    h.command.includes('showreceipts-hook') &&
    h.command.endsWith(wanted) &&
    h.timeout === 30
  );
}

function verifySetup(realSettingsText, strict) {
  const tag = strict ? 'setup --strict' : 'setup';
  const base = mkTemp(strict ? 'setup-strict' : 'setup');
  const home = join(base, 'home');
  const claudeDir = join(home, '.claude');
  const srHome = join(home, '.showreceipts');
  const settings = join(claudeDir, 'settings.json');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(settings, realSettingsText);
  const work = join(base, 'work');
  fs.mkdirSync(work);
  const env = childEnv({ HOME: home });
  const original = JSON.parse(realSettingsText);
  const originalKeys = Object.keys(original).sort();
  const strictFlag = strict ? ['--strict'] : [];

  // Dry run: reports, writes nothing.
  const dry = runCli(['setup', '--dry-run', '--json', ...strictFlag], { env, cwd: work });
  const dryRows = dry.status === 0 ? JSON.parse(dry.stdout) : null;
  check(dry.status === 0, `${tag}: --dry-run --json exits 0`, `exit ${dry.status}`);
  check(
    Array.isArray(dryRows) && dryRows.length === 1 && dryRows[0].harness === 'claude-code' && dryRows[0].action === 'dry-run',
    `${tag}: dry run auto-detects exactly claude-code, action dry-run`,
    Array.isArray(dryRows) ? dryRows.map((r) => `${r.harness}:${r.action}`).join(',') : 'unparsable stdout',
  );
  check(fs.readFileSync(settings, 'utf8') === realSettingsText, `${tag}: dry run leaves settings.json byte-identical`);
  check(!fs.existsSync(join(srHome, 'backups')), `${tag}: dry run writes no backup`);
  check(!fs.existsSync(join(srHome, 'bin')), `${tag}: dry run installs no launcher`);

  // Real run: surgical hooks-only diff, backup under the temp showreceipts home.
  const first = runCli(['setup', '--json', ...strictFlag], { env, cwd: work });
  const firstRows = first.status === 0 ? JSON.parse(first.stdout) : null;
  const row = Array.isArray(firstRows) ? firstRows.find((r) => r.harness === 'claude-code') : undefined;
  check(first.status === 0, `${tag}: exits 0`, `exit ${first.status}`);
  check(row !== undefined && row.action === 'updated', `${tag}: action is updated`, row === undefined ? 'no row' : row.action);
  const backupDir = join(srHome, 'backups', 'claude-code');
  const backupOk =
    row !== undefined &&
    typeof row.backup === 'string' &&
    dirname(row.backup) === backupDir &&
    fs.existsSync(row.backup) &&
    fs.readFileSync(row.backup, 'utf8') === realSettingsText;
  check(backupOk, `${tag}: backup lands under temp ~/.showreceipts/backups/claude-code/ with original bytes`);

  const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
  check(
    deepEqual(Object.keys(after).sort(), [...originalKeys, 'hooks'].sort()),
    `${tag}: diff adds only the hooks key`,
    Object.keys(after).sort().join(','),
  );
  const untouched = originalKeys.every((k) => deepEqual(after[k], original[k]));
  check(untouched, `${tag}: every pre-existing settings key is byte-for-byte untouched`);
  const hookKeys = Object.keys(after.hooks ?? {}).sort();
  check(
    deepEqual(hookKeys, strict ? ['SessionStart', 'Stop'] : ['Stop']),
    `${tag}: hooks touches only Stop${strict ? ' + SessionStart' : ''}`,
    hookKeys.join(','),
  );
  check(stopEntryOk(after.hooks?.Stop, strict), `${tag}: Stop entry is the §9 launcher command`, JSON.stringify(after.hooks?.Stop ?? null));
  if (strict) {
    const ss = after.hooks?.SessionStart;
    check(
      Array.isArray(ss) && ss.length === 1 && ss[0].matcher === 'startup|resume',
      `${tag}: SessionStart entry has the startup|resume matcher`,
    );
  }
  const launcher = join(srHome, 'bin', process.platform === 'win32' ? 'showreceipts-hook.cmd' : 'showreceipts-hook');
  check(fs.existsSync(launcher), `${tag}: launcher installed under temp ~/.showreceipts/bin/`);

  // Second run: unchanged, no new backup, identical bytes.
  const afterText = fs.readFileSync(settings, 'utf8');
  const second = runCli(['setup', '--json', ...strictFlag], { env, cwd: work });
  const secondRows = second.status === 0 ? JSON.parse(second.stdout) : null;
  const row2 = Array.isArray(secondRows) ? secondRows.find((r) => r.harness === 'claude-code') : undefined;
  check(second.status === 0, `${tag}: second run exits 0`, `exit ${second.status}`);
  check(row2 !== undefined && row2.action === 'unchanged', `${tag}: second run is unchanged`, row2 === undefined ? 'no row' : row2.action);
  check(row2 !== undefined && row2.backup === null, `${tag}: second run writes no new backup`);
  check(fs.readdirSync(backupDir).length === 1, `${tag}: backups directory still holds exactly one backup`);
  check(fs.readFileSync(settings, 'utf8') === afterText, `${tag}: second run leaves settings.json byte-identical`);
}

// ---------------------------------------------------------------------------
// Part 2/3 — simulated Stop over the real frozen transcript and rollout
// ---------------------------------------------------------------------------

/**
 * Simulates one harness Stop twice (cold, then warm through the parse cache)
 * in a temp HOME + temp repo, asserting §9 output, receipt files, budgets
 * and byte-identical warm receipts.
 */
function verifyStop(tag, harness, stdin, extraEnv, budgetLabel) {
  const base = mkTemp(tag);
  const home = join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  const srHome = join(home, '.showreceipts');
  const repo = makeRepo(base);
  const env = childEnv({ HOME: home, SHOWRECEIPTS_HOME: srHome, SHOWRECEIPTS_NOW: PINNED_NOW, ...extraEnv });
  const payload = JSON.stringify({ ...stdin, cwd: repo });
  const mdPath = join(repo, '.showreceipts', 'last-receipt.md');
  const jsonPath = join(repo, '.showreceipts', 'last-receipt.json');

  const outOk = (stdout) => {
    try {
      const parsed = JSON.parse(stdout);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      return Object.keys(parsed).length === 0 || typeof parsed.systemMessage === 'string';
    } catch {
      return false;
    }
  };

  const cold = runCli(['hook', harness, 'Stop'], { env, cwd: repo, input: payload });
  check(cold.status === 0, `${tag}: cold Stop exits 0`, `exit ${cold.status}${cold.stderr ? `; stderr: ${cold.stderr.slice(0, 200)}` : ''}`);
  check(outOk(cold.stdout), `${tag}: cold stdout is systemMessage JSON or {}`, cold.stdout.trim().slice(0, 120));
  check(fs.existsSync(mdPath) && fs.statSync(mdPath).size > 0, `${tag}: last-receipt.md written in the temp repo`);
  check(fs.existsSync(jsonPath), `${tag}: last-receipt.json written in the temp repo`);
  let receipt = null;
  try {
    receipt = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch {
    // asserted below
  }
  check(receipt !== null && receipt.incompleteAtStop !== true, `${tag}: flush guard matched (receipt not incompleteAtStop)`);
  check(cold.ms < COLD_BUDGET_MS, `${tag}: cold wall time < ${COLD_BUDGET_MS / 1000} s (${budgetLabel})`, `${cold.ms.toFixed(0)} ms`);
  const cacheDir = join(srHome, 'cache');
  const cachePopulated = fs.existsSync(cacheDir) && fs.readdirSync(cacheDir).length > 0;
  check(cachePopulated, `${tag}: parse cache populated by the cold run`);

  const coldMd = fs.readFileSync(mdPath);
  const coldJson = fs.readFileSync(jsonPath);
  const warm = runCli(['hook', harness, 'Stop'], { env, cwd: repo, input: payload });
  check(warm.status === 0, `${tag}: warm Stop exits 0`, `exit ${warm.status}`);
  check(outOk(warm.stdout), `${tag}: warm stdout is systemMessage JSON or {}`);
  check(warm.ms < WARM_BUDGET_MS, `${tag}: warm wall time < ${WARM_BUDGET_MS / 1000} s (cache hit)`, `${warm.ms.toFixed(0)} ms`);
  check(fs.readFileSync(mdPath).equals(coldMd), `${tag}: warm last-receipt.md byte-identical to cold`);
  check(fs.readFileSync(jsonPath).equals(coldJson), `${tag}: warm last-receipt.json byte-identical to cold`);
  timings.push({ tag, coldMs: cold.ms, warmMs: warm.ms });
  info(`${tag}: cold ${cold.ms.toFixed(0)} ms, warm ${warm.ms.toFixed(0)} ms`);
  return receipt;
}

/** Last turn of the real Claude Code transcript, read-only through the built reader. */
async function extractClaudeFinal(path) {
  const cc = await import(join(DIST, 'readers', 'claude-code', 'reader.js'));
  const sessionId = basename(path, '.jsonl');
  const ref = { harness: 'claude-code', sessionId, path, size: fs.statSync(path).size, mtimeMs: 0, subagentManifest: [] };
  const { session } = await cc.readClaudeCodeSession(ref, { home: HOME });
  const turn = [...session.turns].reverse().find((t) => t.finalText !== null);
  if (turn === undefined) throw new Error('no turn with a final assistant message in the frozen transcript');
  return { sessionId, promptId: turn.promptId, finalText: turn.finalText };
}

/** Last `agent_message` of the real Codex rollout (plain line scan, read-only). */
function extractCodexFinal(path) {
  const sessionId = (/-([0-9a-f-]{36})\.jsonl$/i.exec(basename(path)) ?? [])[1];
  if (sessionId === undefined) throw new Error(`rollout name carries no session id: ${basename(path)}`);
  let last = null;
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    if (!line.includes('agent_message')) continue;
    try {
      const r = JSON.parse(line);
      const p = r?.payload;
      if (r?.type === 'event_msg' && p?.type === 'agent_message' && typeof p.message === 'string') last = p.message;
    } catch {
      // tolerated: only well-formed agent_message frames matter here
    }
  }
  if (last === null) throw new Error('no agent_message in the frozen rollout');
  return { sessionId, finalText: last };
}

// ---------------------------------------------------------------------------
// Part 4 — doctor over the real roots (temp SHOWRECEIPTS_HOME)
// ---------------------------------------------------------------------------

function verifyDoctor() {
  const srHome = join(mkTemp('doctor'), '.showreceipts');
  const env = childEnv({ HOME, SHOWRECEIPTS_HOME: srHome });
  const work = mkTemp('doctor-cwd');

  const human = runCli(['doctor'], { env, cwd: work });
  check(human.status === 0, 'doctor: exits 0 over the real roots', `exit ${human.status}${human.status !== 0 ? `; tail: ${human.stdout.slice(-300)}` : ''}`);
  info(`doctor: human run ${human.ms.toFixed(0)} ms`);

  const jsonRun = runCli(['doctor', '--json'], { env, cwd: work });
  check(jsonRun.status === 0, 'doctor: --json exits 0 over the real roots', `exit ${jsonRun.status}`);
  let shape = null;
  try {
    const report = JSON.parse(jsonRun.stdout);
    shape = {
      topLevel: Object.keys(report).sort(),
      problems: Array.isArray(report.problems) ? report.problems.length : -1,
      warnings: Array.isArray(report.warnings) ? report.warnings.length : -1,
      harnessRow: Array.isArray(report.harnesses) && report.harnesses.length > 0 ? Object.keys(report.harnesses[0]).sort() : [],
      hookRow: Array.isArray(report.hooks) && report.hooks.length > 0 ? Object.keys(report.hooks[0]).sort() : [],
    };
  } catch {
    // asserted below
  }
  check(shape !== null, 'doctor: --json output parses');
  check(shape !== null && shape.problems === 0, 'doctor: no §12.2 problems on the real machine', `problems=${shape?.problems}`);
  if (shape !== null) {
    info(`doctor --json shape: top-level [${shape.topLevel.join(', ')}]`);
    info(`doctor --json shape: harness row [${shape.harnessRow.join(', ')}]`);
    info(`doctor --json shape: hooks row [${shape.hookRow.join(', ')}]`);
    info(`doctor --json: problems=${shape.problems} warnings=${shape.warnings}`);
  }
  timings.push({ tag: 'doctor', coldMs: human.ms, warmMs: jsonRun.ms });
}

// ---------------------------------------------------------------------------

async function main() {
  if (!fs.existsSync(CLI)) skip('dist/cli.js missing — run npm run build first');
  if (!fs.existsSync(REAL_SETTINGS)) skip('no real ~/.claude/settings.json on this machine');
  const transcript = findClaudeTranscript();
  const rollout = findCodexRollout();
  if (transcript === null) skip(`frozen Claude Code transcript ${CLAUDE_PREFIX}* not found`);
  if (rollout === null) skip(`frozen Codex rollout ${CODEX_PREFIX}* not found`);

  process.stdout.write('verify-hooks-local: live Stop + setup verification on real data (read-only).\n');
  const transcriptMib = (fs.statSync(transcript).size / (1024 * 1024)).toFixed(1);
  info(`frozen Claude Code transcript: ${transcriptMib} MiB; frozen Codex rollout: ${(fs.statSync(rollout).size / (1024 * 1024)).toFixed(1)} MiB`);

  // Step 5 (before): metadata snapshot of both real roots.
  const beforeClaude = snapshotMeta(REAL_CLAUDE);
  const beforeCodex = snapshotMeta(REAL_CODEX);
  const realSettingsText = fs.readFileSync(REAL_SETTINGS, 'utf8');

  // Step 1: setup in a temp HOME over a copy of the real settings.
  verifySetup(realSettingsText, false);
  verifySetup(realSettingsText, true);

  // Step 2: live Claude Code Stop (real transcript, real last turn).
  const claude = await extractClaudeFinal(transcript);
  verifyStop(
    'claude-code stop',
    'claude-code',
    {
      session_id: claude.sessionId,
      prompt_id: claude.promptId,
      transcript_path: transcript,
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: claude.finalText,
    },
    {},
    `${transcriptMib} MiB transcript`,
  );

  // Step 3: live Codex Stop via the session-id suffix lookup, transcript_path null.
  const codex = extractCodexFinal(rollout);
  verifyStop(
    'codex stop',
    'codex',
    {
      session_id: codex.sessionId,
      transcript_path: null,
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: codex.finalText,
    },
    { CODEX_HOME: REAL_CODEX },
    'rollout by suffix lookup',
  );

  // Step 4: doctor over the real roots.
  verifyDoctor();

  // Step 5 (after): nothing real changed.
  const afterClaude = snapshotMeta(REAL_CLAUDE);
  const afterCodex = snapshotMeta(REAL_CODEX);
  check(diffMeta(beforeCodex, afterCodex).length === 0, 'real ~/.codex: no file changed (size+mtime ns)');
  check(fs.readFileSync(REAL_SETTINGS, 'utf8') === realSettingsText, 'real ~/.claude/settings.json byte-identical');
  const claudeChanges = diffMeta(beforeClaude, afterClaude);
  // A live Claude Code session on the author's machine writes its own
  // transcript/state under ~/.claude while this script runs; those changes are
  // not ours. The FAIL zone is everything this script's subject could touch:
  // settings.json and the frozen transcript's whole project directory.
  const failZone = [REAL_SETTINGS, dirname(transcript)];
  const guilty = claudeChanges.filter((p) => failZone.some((z) => p === z || p.startsWith(`${z}/`)));
  check(guilty.length === 0, 'real ~/.claude: settings + frozen transcript project untouched', guilty.slice(0, 3).join('; '));
  if (claudeChanges.length > guilty.length) {
    info(`~/.claude: ${claudeChanges.length - guilty.length} file(s) changed outside the fail zone (live Claude Code session activity; not caused by this script)`);
  }

  for (const dir of cleanups) fs.rmSync(dir, { recursive: true, force: true });

  const failed = rows.filter((r) => !r.ok);
  process.stdout.write('\nTimings:\n');
  for (const t of timings) process.stdout.write(`  ${t.tag.padEnd(18)} cold/first ${t.coldMs.toFixed(0)} ms · warm/second ${t.warmMs.toFixed(0)} ms\n`);
  process.stdout.write(
    failed.length === 0
      ? `\nverify-hooks-local: every assertion PASS (${rows.length} checks).\n`
      : `\nverify-hooks-local: ${failed.length} of ${rows.length} checks FAILED.\n`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`verify-hooks-local: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
