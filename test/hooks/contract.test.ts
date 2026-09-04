/**
 * S31 — black-box hook contracts (§9): every fixture under
 * `fixtures/hooks/<harness>/<case>/` is spawned as
 * `node dist/cli.js hook <harness> <event> --now …` with a temp
 * `SHOWRECEIPTS_HOME`, and the contract is asserted end to end: exact stdout
 * JSON, exit 0, the Appendix C ledger line (count + parsed last line), file
 * modes (`0600` ledger, `0700` dir), receipt files, and wall time within the
 * event-class budget (stop 20 s · record 1.5 s · session 1 s; ×3 on CI).
 *
 * Generated variants (never committed; `fixtures/hooks/generated/` is
 * git-ignored and removed afterwards): the Cursor 5 MB `afterFileEdit`, two
 * 33 MiB oversize stdins (salvageable `tool-post` vs `gap`), plus inline
 * unparsable/hostile-sid/empty/no-stdin/unknown-dialect/debug-throw cases.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { safeSid } from '../../src/util/ids.js';
import { PINNED_NOW, pinnedEnv } from '../helpers/env.js';
import { CLI_PATH, NETGUARD_PATH, runCli, type RunCliResult } from '../helpers/spawn.js';
import { makeTempDir } from '../helpers/tmp.js';

const HOOKS_ROOT = fileURLToPath(new URL('../../fixtures/hooks/', import.meta.url));
const GENERATED_DIR = join(HOOKS_ROOT, 'generated');
/**
 * CI machines are slower and noisier (§9 fixture note: budgets ×3 on CI);
 * off-CI a ×2 cushion absorbs a loaded developer machine (observed spawn
 * times sit 5–10× under the raw class budgets) without weakening the CI gate.
 */
const BUDGET_FACTOR = process.env['CI'] !== undefined ? 3 : 2;
/** The frozen invocation instant every ledger line's `t` must carry. */
const NOW_ISO = '2026-08-29T12:00:00.000Z';

interface LedgerExpectation {
  sid: string;
  lines: number;
  last: Record<string, unknown>;
}

interface CaseExpectation {
  harness: string;
  event: string;
  stdout: Record<string, unknown>;
  exit: number;
  ledger: LedgerExpectation | null;
  files?: string[];
  receiptsLog?: boolean;
  noFiles?: boolean;
  classBudgetMs: number;
}

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  rmSync(GENERATED_DIR, { recursive: true, force: true });
});

/** Substitutes `${FIXTURE_DIR}` / `${SR_HOME}` in every string of a JSON value. */
function subst<T>(value: T, map: Readonly<Record<string, string>>): T {
  if (typeof value === 'string') {
    let out: string = value;
    for (const [key, replacement] of Object.entries(map)) out = out.replaceAll(`\${${key}}`, replacement);
    return out as unknown as T;
  }
  if (Array.isArray(value)) return value.map((item) => subst(item, map)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = subst(item, map);
    return out as unknown as T;
  }
  return value;
}

/** Collects every point where `actual` fails to be a superset of `expected`. */
function collectMismatches(actual: unknown, expected: unknown, path: string, out: string[]): void {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      out.push(`${path}: expected array of ${expected.length}, got ${JSON.stringify(actual)}`);
      return;
    }
    expected.forEach((item, i) => {
      collectMismatches(actual[i], item, `${path}[${i}]`, out);
    });
    return;
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      out.push(`${path}: expected an object, got ${JSON.stringify(actual)}`);
      return;
    }
    for (const [key, item] of Object.entries(expected)) {
      collectMismatches((actual as Record<string, unknown>)[key], item, `${path}.${key}`, out);
    }
    return;
  }
  if (actual !== expected) out.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Asserts `actual` matches `expected` on every key `expected` names (extra keys tolerated). */
function expectSubset(actual: unknown, expected: unknown): void {
  const mismatches: string[] = [];
  collectMismatches(actual, expected, '$', mismatches);
  expect(mismatches).toEqual([]);
}

/** Every committed contract case, discovered from the fixture tree. */
function listCases(): { rel: string; dir: string; expected: CaseExpectation }[] {
  const out: { rel: string; dir: string; expected: CaseExpectation }[] = [];
  for (const harness of readdirSync(HOOKS_ROOT).sort()) {
    const harnessDir = join(HOOKS_ROOT, harness);
    if (harness === 'generated' || !statSync(harnessDir).isDirectory()) continue;
    for (const name of readdirSync(harnessDir).sort()) {
      const dir = join(harnessDir, name);
      if (!statSync(dir).isDirectory()) continue;
      const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as CaseExpectation;
      out.push({ rel: `${harness}/${name}`, dir, expected });
    }
  }
  return out;
}

interface HookRun {
  r: RunCliResult;
  srHome: string;
}

/** Spawns one hook invocation with a fresh SHOWRECEIPTS_HOME and non-repo cwd. */
function runHook(harness: string, event: string, stdin: string, extraArgs: readonly string[] = [], extraEnv: Record<string, string> = {}): HookRun {
  const srHome = tempDir('sr-hook-home-');
  const cwd = tempDir('sr-hook-cwd-');
  const r = runCli(['hook', harness, event, '--now', PINNED_NOW, ...extraArgs], {
    env: { SHOWRECEIPTS_HOME: srHome, ...extraEnv },
    stdin,
    cwd,
  });
  return { r, srHome };
}

/** Path of the case's ledger file under the temp home. */
function ledgerPathOf(srHome: string, harness: string, sid: string): string {
  return join(srHome, 'ledger', harness, `${safeSid(sid)}.jsonl`);
}

/** Non-empty parsed ledger lines of one file. */
function ledgerLines(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function assertLedger(srHome: string, harness: string, expectation: LedgerExpectation | null): void {
  if (expectation === null) {
    expect(existsSync(join(srHome, 'ledger'))).toBe(false);
    return;
  }
  const path = ledgerPathOf(srHome, harness, expectation.sid);
  expect(existsSync(path)).toBe(true);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(join(srHome, 'ledger', harness)).mode & 0o777).toBe(0o700);
  const lines = ledgerLines(path);
  expect(lines).toHaveLength(expectation.lines);
  expectSubset(lines[lines.length - 1], expectation.last);
}

function assertFiles(srHome: string, expected: CaseExpectation): void {
  const lastDir = join(srHome, 'last', expected.harness);
  if (expected.noFiles === true) {
    expect(existsSync(join(srHome, 'last'))).toBe(false);
    expect(existsSync(join(srHome, 'receipts.log'))).toBe(false);
    return;
  }
  for (const name of expected.files ?? []) {
    const path = join(lastDir, name);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  }
  if (expected.receiptsLog === true) {
    const logPath = join(srHome, 'receipts.log');
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, 'utf8').trim().split('\n')).toHaveLength(1);
  }
}

/** Tolerant read of `<home>/state/counters.json`. */
function counters(srHome: string): Record<string, number> {
  return JSON.parse(readFileSync(join(srHome, 'state', 'counters.json'), 'utf8')) as Record<string, number>;
}

// ---------------------------------------------------------------------------
// The committed fixture cases (one `it` per directory).
// ---------------------------------------------------------------------------
describe('hook contracts — fixtures/hooks/<harness>/<case> (§9)', () => {
  for (const { rel, dir, expected } of listCases()) {
    it(rel, () => {
      const stdinText = readFileSync(join(dir, 'stdin.json'), 'utf8').replaceAll('${FIXTURE_DIR}', dir);
      const { r, srHome } = runHook(expected.harness, expected.event, stdinText);
      expect(r.code).toBe(expected.exit);
      const stdout = JSON.parse(r.stdout) as Record<string, unknown>;
      expect(stdout).toEqual(subst(expected.stdout, { SR_HOME: srHome }));
      expect(r.ms).toBeLessThanOrEqual(expected.classBudgetMs * BUDGET_FACTOR);
      assertLedger(srHome, expected.harness, expected.ledger);
      assertFiles(srHome, expected);
    });
  }
});

// ---------------------------------------------------------------------------
// Generated large payloads (gen-large.mjs; §9 Cursor 5 MB + 32 MiB cap).
// ---------------------------------------------------------------------------
describe('hook contracts — generated large payloads (§9)', () => {
  let generated: { afterFileEdit: string; oversizeSalvageable: string; oversizeGap: string };

  beforeAll(async () => {
    const mod = (await import(new URL('../../fixtures/hooks/gen-large.mjs', import.meta.url).href)) as {
      generateAll: (outDir?: string) => { afterFileEdit: string; oversizeSalvageable: string; oversizeGap: string };
    };
    generated = mod.generateAll(GENERATED_DIR);
  }, 120_000);

  it('cursor afterFileEdit at 5 MB: parsed, edits capped at 32 with editsTruncated, line under 256 KiB', () => {
    const stdin = readFileSync(generated.afterFileEdit, 'utf8');
    const { r, srHome } = runHook('cursor', 'afterFileEdit', stdin);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({});
    expect(r.ms).toBeLessThanOrEqual(1500 * BUDGET_FACTOR);
    const path = ledgerPathOf(srHome, 'cursor', 'big-edit-1');
    const raw = readFileSync(path, 'utf8').trim().split('\n');
    expect(raw).toHaveLength(1);
    expect(Buffer.byteLength(raw[0] as string, 'utf8')).toBeLessThanOrEqual(256 * 1024);
    const line = JSON.parse(raw[0] as string) as { e: string; kind: string; in: { edits: { old: string; new: string }[]; editsTruncated?: boolean } };
    expect(line.e).toBe('tool-post');
    expect(line.kind).toBe('edit');
    expect(line.in.editsTruncated).toBe(true);
    expect(line.in.edits).toHaveLength(32);
    for (const edit of line.in.edits) {
      expect(Buffer.byteLength(edit.old, 'utf8')).toBeLessThanOrEqual(2048);
      expect(Buffer.byteLength(edit.new, 'utf8')).toBeLessThanOrEqual(2048);
    }
  });

  it('33 MiB oversize with a salvageable tool_name+command: tool-post{truncated, exitSource unknown} + stdinOverflow', () => {
    const stdin = readFileSync(generated.oversizeSalvageable, 'utf8');
    const { r, srHome } = runHook('cursor', 'postToolUse', stdin);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({});
    const lines = ledgerLines(ledgerPathOf(srHome, 'cursor', 'big-tool-1'));
    expect(lines).toHaveLength(1);
    expectSubset(lines[0], {
      v: 1,
      t: NOW_ISO,
      h: 'cursor',
      e: 'tool-post',
      sid: 'big-tool-1',
      tid: 'g-big',
      exitSource: 'unknown',
      tool: 'Shell',
      in: { command: 'npm test' },
      out: { text: '', bytes: Buffer.byteLength(stdin, 'utf8'), truncated: true },
    });
    expect(counters(srHome)['stdinOverflow']).toBe(1);
  }, 60_000);

  it('33 MiB oversize with no salvageable tool_name: gap{reason oversize, bytes} + stdinOverflow', () => {
    const stdin = readFileSync(generated.oversizeGap, 'utf8');
    const { r, srHome } = runHook('cursor', 'postToolUse', stdin);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({});
    const lines = ledgerLines(ledgerPathOf(srHome, 'cursor', 'big-gap-1'));
    expect(lines).toHaveLength(1);
    expectSubset(lines[0], {
      v: 1,
      t: NOW_ISO,
      h: 'cursor',
      e: 'gap',
      sid: 'big-gap-1',
      reason: 'oversize',
      bytes: Buffer.byteLength(stdin, 'utf8'),
    });
    expect(counters(srHome)['stdinOverflow']).toBe(1);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Inline degenerate payloads (§9): unparsable, hostile sids, empty, no stdin.
// ---------------------------------------------------------------------------
describe('hook contracts — degenerate stdin (§9)', () => {
  it('unparsable stdin appends gap{reason unparsable} under the salvaged sid', () => {
    const stdin = '{"session_id":"unp-1", this is not json';
    const { r, srHome } = runHook('cursor', 'postToolUse', stdin);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({});
    const lines = ledgerLines(ledgerPathOf(srHome, 'cursor', 'unp-1'));
    expect(lines).toHaveLength(1);
    expectSubset(lines[0], { v: 1, h: 'cursor', e: 'gap', sid: 'unp-1', reason: 'unparsable', bytes: Buffer.byteLength(stdin, 'utf8') });
    expect(counters(srHome)['stdinOverflow']).toBe(1);
  });

  const HOSTILE_SIDS = ['../../evil', '/abs/evil', 'a b c', 'x'.repeat(200), '.hidden'];
  for (const sid of HOSTILE_SIDS) {
    it(`hostile sid ${JSON.stringify(sid.slice(0, 24))}: ledger file is the hashed form inside the ledger dir`, () => {
      const stdin = JSON.stringify({
        conversation_id: sid,
        hook_event_name: 'postToolUse',
        tool_name: 'Shell',
        tool_input: '{"command":"true"}',
        tool_output: '{"exitCode":0,"stdout":""}',
        tool_use_id: 't-hostile',
      });
      const { r, srHome } = runHook('cursor', 'postToolUse', stdin);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({});
      const dir = join(srHome, 'ledger', 'cursor');
      const names = readdirSync(dir);
      expect(names).toEqual([`${safeSid(sid)}.jsonl`]);
      expect(names[0]).toMatch(/^h[0-9a-f]{32}\.jsonl$/);
      // The hashed name never escapes: it is a plain basename inside the dir.
      expect(names[0]).not.toContain('/');
      expect(names[0]).not.toContain('..');
      const lines = ledgerLines(join(dir, names[0] as string));
      expect(lines).toHaveLength(1);
      expect(lines[0]?.['sid']).toBe(sid); // the raw sid stays inside the line (§9)
    });
  }

  it('empty stdin answers {} and writes nothing (claude-code Stop)', () => {
    const { r, srHome } = runHook('claude-code', 'Stop', '');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({});
    expect(existsSync(join(srHome, 'ledger'))).toBe(false);
    expect(existsSync(join(srHome, 'last'))).toBe(false);
    expect(r.ms).toBeLessThanOrEqual(20_000 * BUDGET_FACTOR);
  });

  it('a TTY-less process with no stdin at all still answers {} and exits 0', () => {
    const srHome = tempDir('sr-hook-nostdin-');
    const cwd = tempDir('sr-hook-nostdin-cwd-');
    const env = { ...pinnedEnv(), NODE_OPTIONS: `--require "${NETGUARD_PATH}"`, SHOWRECEIPTS_HOME: srHome };
    const r = spawnSync(process.execPath, [CLI_PATH, 'hook', 'claude-code', 'Stop', '--now', PINNED_NOW], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({});
  });

  it('an unknown dialect answers {} and bumps unknownDialect', () => {
    const { r, srHome } = runHook('nope', 'Stop', '{}');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({});
    expect(counters(srHome)['unknownDialect']).toBe(1);
    expect(existsSync(join(srHome, 'ledger'))).toBe(false);
  });

  it('SHOWRECEIPTS_DEBUG_THROW with --debug still answers {} and exits 0 (S27)', () => {
    const stdin = JSON.stringify({
      conversation_id: 'dbg-1',
      hook_event_name: 'postToolUse',
      tool_name: 'Shell',
      tool_input: '{"command":"true"}',
      tool_output: '{"exitCode":0,"stdout":""}',
      tool_use_id: 't-dbg',
    });
    const { r, srHome } = runHook('cursor', 'postToolUse', stdin, ['--debug'], { SHOWRECEIPTS_DEBUG_THROW: '1' });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({});
    // The deliberate throw pre-empts the handler: no ledger line, one hook.log trace.
    expect(existsSync(join(srHome, 'ledger'))).toBe(false);
    expect(readFileSync(join(srHome, 'hook.log'), 'utf8')).toContain('answered {}');
  });
});
