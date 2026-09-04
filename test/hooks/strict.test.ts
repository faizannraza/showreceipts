/**
 * S31 — strict-mode nudges end to end (§9): spawned `hook … --strict` over
 * real transcripts/ledgers. Claude Code `Stop --strict` blocks exactly once
 * for a `no-test-run` receipt (the hash guard silences the second call),
 * never blocks under `stop_hook_active`, suppresses the 6th nudge of a
 * session, and answers the fixed `git-op-failed` message; Cursor
 * `loop_count: 1` never emits a `followup_message`; Gemini strict answers
 * the `{"decision":"deny"}` shape; strict SessionStart injects the
 * additionalContext object.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PINNED_NOW } from '../helpers/env.js';
import { cc, type CC } from '../helpers/cc-lines.js';
import { runCli, type RunCliResult } from '../helpers/spawn.js';
import { makeTempDir } from '../helpers/tmp.js';

const BLOCK_NO_TEST_RUN = 'showreceipts: you said tests pass but no test command ran after your last edit — run them';
const BLOCK_GIT_OP_FAILED = 'showreceipts: you reported a git operation as done but it failed — check git status and retry';

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The transcript's text (CC sources are always `kind: 'text'`). */
function ccText(t: CC): string {
  const src = t.src();
  if (src.kind !== 'text') throw new Error('CC.src() is always a text source');
  return src.text;
}

/**
 * A flushed transcript whose final claims "Tests pass." after one ok Write
 * and no test run — CONTRADICTED `no-test-run` (§4.8 row 1).
 */
function contraTranscript(dir: string): { path: string; sid: string } {
  const t = cc();
  t.human('add the feature', { promptId: 'p1' });
  t.assistant({ stop: 'tool_use', tools: [{ id: 'tu-1', name: 'Write', input: { file_path: '/home/u/proj/a.ts', content: 'x' } }] });
  t.toolResult('tu-1', 'ok', { result: { type: 'create', filePath: '/home/u/proj/a.ts', content: 'x', structuredPatch: [] } });
  t.assistant({ text: 'Tests pass.', stop: 'end_turn' });
  const path = join(dir, `${t.sid}.jsonl`);
  writeFileSync(path, ccText(t));
  return { path, sid: t.sid };
}

/** A transcript whose final claims a commit that the log shows failing (§4.8 row 15). */
function gitFailTranscript(dir: string): { path: string; sid: string } {
  const t = cc();
  t.human('wrap it up please', { promptId: 'p1' });
  t.assistant({ stop: 'tool_use', tools: [{ id: 'tu-1', name: 'Bash', input: { command: 'git commit -m "fix"' } }] });
  t.toolResult('tu-1', 'Error: Exit code 1', { result: 'Error: Exit code 1', isError: true });
  t.assistant({ text: 'Committed the fix.', stop: 'end_turn' });
  const path = join(dir, `${t.sid}.jsonl`);
  writeFileSync(path, ccText(t));
  return { path, sid: t.sid };
}

function stopStdin(path: string, sid: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: sid,
    prompt_id: 'p1',
    transcript_path: path,
    cwd: '/home/u/proj',
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'Tests pass.',
    ...over,
  });
}

function runStrict(harness: string, event: string, srHome: string, stdin: string): RunCliResult {
  return runCli(['hook', harness, event, '--strict', '--now', PINNED_NOW], {
    env: { SHOWRECEIPTS_HOME: srHome },
    stdin,
    cwd: tempDir('sr-strict-cwd-'),
  });
}

function stdoutOf(r: RunCliResult): Record<string, unknown> {
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

/** The per-session strict state file the hook persists. */
function readState(srHome: string, harness: string, sid: string): { nudges: number; lastNudgeFinalHash?: string; turnIds: string[] } {
  return JSON.parse(readFileSync(join(srHome, 'state', harness, `${sid}.json`), 'utf8')) as {
    nudges: number;
    lastNudgeFinalHash?: string;
    turnIds: string[];
  };
}

describe('claude-code Stop --strict (§9)', () => {
  it('blocks once for no-test-run; an identical final is never re-nudged (hash guard)', () => {
    const srHome = tempDir('sr-strict-');
    const { path, sid } = contraTranscript(tempDir('sr-strict-tr-'));
    const first = stdoutOf(runStrict('claude-code', 'Stop', srHome, stopStdin(path, sid)));
    expect(first).toEqual({ decision: 'block', reason: BLOCK_NO_TEST_RUN });
    const state = readState(srHome, 'claude-code', sid);
    expect(state.nudges).toBe(1);
    expect(state.lastNudgeFinalHash).toMatch(/^[0-9a-f]{64}$/);

    const second = stdoutOf(runStrict('claude-code', 'Stop', srHome, stopStdin(path, sid)));
    expect(second['decision']).toBeUndefined();
    expect(second['systemMessage']).toMatch(/^receipt: 1 contradicted/);
    expect(second['suppressOutput']).toBe(true);
    expect(readState(srHome, 'claude-code', sid).nudges).toBe(1);
  });

  it('stop_hook_active: true never blocks — the systemMessage answer stands', () => {
    const srHome = tempDir('sr-strict-');
    const { path, sid } = contraTranscript(tempDir('sr-strict-tr-'));
    const out = stdoutOf(runStrict('claude-code', 'Stop', srHome, stopStdin(path, sid, { stop_hook_active: true })));
    expect(out['decision']).toBeUndefined();
    expect(out['systemMessage']).toMatch(/^receipt: 1 contradicted/);
    expect(existsSync(join(srHome, 'state', 'claude-code', `${sid}.json`))).toBe(false);
  });

  it('the 6th nudge of a session is suppressed (cap 5)', () => {
    const srHome = tempDir('sr-strict-');
    const { path, sid } = contraTranscript(tempDir('sr-strict-tr-'));
    const stateDir = join(srHome, 'state', 'claude-code');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(stateDir, `${sid}.json`), `${JSON.stringify({ nudges: 5, turnIds: [] })}\n`, { mode: 0o600 });
    const out = stdoutOf(runStrict('claude-code', 'Stop', srHome, stopStdin(path, sid)));
    expect(out['decision']).toBeUndefined();
    expect(out['systemMessage']).toMatch(/^receipt: 1 contradicted/);
    expect(readState(srHome, 'claude-code', sid).nudges).toBe(5);
  });

  it('a failed git commit behind a "Committed" final blocks with the git-op-failed message', () => {
    const srHome = tempDir('sr-strict-');
    const { path, sid } = gitFailTranscript(tempDir('sr-strict-tr-'));
    const out = stdoutOf(
      runStrict('claude-code', 'Stop', srHome, stopStdin(path, sid, { last_assistant_message: 'Committed the fix.' })),
    );
    expect(out).toEqual({ decision: 'block', reason: BLOCK_GIT_OP_FAILED });
  });

  it('strict SessionStart injects the auditing additionalContext (§9)', () => {
    const srHome = tempDir('sr-strict-');
    const out = stdoutOf(
      runStrict('claude-code', 'SessionStart', srHome, JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart', source: 'startup' })),
    );
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'showreceipts is auditing this session: final messages are checked against the tool log.',
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Ledger-harness strict stops (Cursor followup_message, Gemini deny).
// ---------------------------------------------------------------------------

/**
 * Seeds a ledger whose session has an ok write and a tests-pass response but
 * no test run (`no-test-run`, §4.8), backdated past the §9 race window.
 */
function seedLedger(srHome: string, harness: 'cursor' | 'gemini', sid: string): void {
  const dir = join(srHome, 'ledger', harness);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${sid}.jsonl`);
  const tid = harness === 'cursor' ? { tid: 'g1' } : {};
  const tool = harness === 'cursor' ? 'Write' : 'write_file';
  const lines: Record<string, unknown>[] = [
    { v: 1, t: '2026-08-29T11:59:00.000Z', h: harness, e: 'session-start', sid },
    { v: 1, t: '2026-08-29T11:59:10.000Z', h: harness, e: 'tool-post', sid, ...tid, cwd: '/w', id: 'w1', tool, kind: 'write', in: { path: '/w/a.ts' }, out: { text: 'ok', bytes: 2 } },
  ];
  if (harness === 'cursor') {
    lines.push({ v: 1, t: '2026-08-29T11:59:20.000Z', h: harness, e: 'agent-response', sid, ...tid, text: 'All tests pass.' });
  }
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, { mode: 0o600 });
  const old = new Date(Date.now() - 60_000);
  utimesSync(path, old, old);
}

describe('cursor stop --strict (§9: loop_count guard)', () => {
  const stopStdinFor = (loopCount: number): string =>
    JSON.stringify({ conversation_id: 'cur-s', generation_id: 'g1', hook_event_name: 'stop', status: 'completed', loop_count: loopCount });

  it('loop_count 0 nudges with a followup_message and persists the state', () => {
    const srHome = tempDir('sr-strict-cur-');
    seedLedger(srHome, 'cursor', 'cur-s');
    const out = stdoutOf(runStrict('cursor', 'stop', srHome, stopStdinFor(0)));
    expect(out).toEqual({ followup_message: BLOCK_NO_TEST_RUN });
    expect(readState(srHome, 'cursor', 'cur-s').nudges).toBe(1);
  });

  it('loop_count 1 never emits a followup_message', () => {
    const srHome = tempDir('sr-strict-cur-');
    seedLedger(srHome, 'cursor', 'cur-s');
    const out = stdoutOf(runStrict('cursor', 'stop', srHome, stopStdinFor(1)));
    expect(out).toEqual({});
    expect(existsSync(join(srHome, 'state', 'cursor', 'cur-s.json'))).toBe(false);
  });
});

describe('gemini AfterAgent --strict (§9: experimental deny shape)', () => {
  it('answers {"decision":"deny","reason":"showreceipts: …"} when a nudge fires', () => {
    const srHome = tempDir('sr-strict-gem-');
    seedLedger(srHome, 'gemini', 'g-strict');
    const stdin = JSON.stringify({
      session_id: 'g-strict',
      cwd: '/w',
      hook_event_name: 'AfterAgent',
      prompt: 'run the suite',
      prompt_response: 'Done. All tests pass.',
      stop_hook_active: false,
    });
    const out = stdoutOf(runStrict('gemini', 'AfterAgent', srHome, stdin));
    expect(out['decision']).toBe('deny');
    expect(String(out['reason']).startsWith('showreceipts:')).toBe(true);
    expect(Object.keys(out).sort()).toEqual(['decision', 'reason']);
  });

  it('never denies when stop_hook_active is set', () => {
    const srHome = tempDir('sr-strict-gem-');
    seedLedger(srHome, 'gemini', 'g-strict');
    const stdin = JSON.stringify({
      session_id: 'g-strict',
      cwd: '/w',
      hook_event_name: 'AfterAgent',
      prompt: 'run the suite',
      prompt_response: 'Done. All tests pass.',
      stop_hook_active: true,
    });
    const out = stdoutOf(runStrict('gemini', 'AfterAgent', srHome, stdin));
    expect(out).toEqual({});
  });
});
