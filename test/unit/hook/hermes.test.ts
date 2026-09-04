/**
 * S29 — Hermes dialect (§9 Hermes row, Appendix C): `post_tool_call` →
 * `tool-post`/`tool-fail` (`out.text = extra.result`, `id = tool_call_id`,
 * `tid = turn_id`, exit from the status / result text), `post_llm_call` →
 * `prompt` + `stop{completed, text, model}`, `on_session_start`,
 * `on_session_end` as a deduped turn boundary, `on_session_finalize` →
 * `session-end`, the kind map, and `{}` stdout everywhere.
 */
import fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HookContext } from '../../../src/hook/dialect.js';
import { dialect } from '../../../src/hook/dialects/hermes.js';
import type { LedgerLine } from '../../../src/model/types.js';
import { makeTempDir } from '../../helpers/tmp.js';

const T = '2026-08-29T12:00:00.000Z';
const dirs: string[] = [];

function tempDir(): string {
  const dir = makeTempDir('sr-hermes-');
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeCtx(over: Partial<HookContext> = {}): HookContext {
  return {
    harness: 'hermes',
    event: 'post_tool_call',
    eventClass: 'record',
    now: new Date(T),
    home: '',
    cwd: '/hook/cwd',
    env: { HOME: '/home/u' },
    flags: { strict: false, strictMax: 1, strictReasons: [], forceRecord: false, verbose: false, debug: false, noCache: false, tz: 'local' },
    salvage: {},
    stdinBytes: 0,
    overflow: false,
    debug: () => undefined,
    ...over,
  };
}

async function run(event: string, input: Record<string, unknown>, ctx = makeCtx()): Promise<{ lines: LedgerLine[]; stdout: object }> {
  const model = dialect.parse(event, input, ctx);
  const out = await dialect.handle(model, ctx);
  return { lines: out.ledgerLines ?? [], stdout: out.stdout };
}

type ToolPost = Extract<LedgerLine, { e: 'tool-post' }>;
type ToolFail = Extract<LedgerLine, { e: 'tool-fail' }>;
type Stop = Extract<LedgerLine, { e: 'stop' }>;

/** Seeds a hermes ledger holding one already-recorded stop for `tid`, backdated past the race window. */
function seedStop(home: string, tid: string): string {
  const dir = join(home, 'ledger', 'hermes');
  fs.mkdirSync(dir, { recursive: true });
  const path = join(dir, 'h-1.jsonl');
  const line = { v: 1, t: T, h: 'hermes', e: 'stop', sid: 'h-1', tid, status: 'completed', text: 'Fixed.' };
  fs.writeFileSync(path, `${JSON.stringify(line)}\n`);
  const old = new Date(Date.now() - 5_000);
  fs.utimesSync(path, old, old);
  return path;
}

describe('hermes post_tool_call', () => {
  it('success → tool-post with out.text = extra.result, exit 0 (parsed), id/tid from extra', async () => {
    const { lines, stdout } = await run('post_tool_call', {
      hook_event_name: 'post_tool_call',
      tool_name: 'terminal',
      tool_input: { command: 'pytest -q' },
      session_id: 'h-1',
      cwd: '/w',
      extra: { tool_call_id: 'c1', turn_id: 't1', result: '5 passed', duration_ms: 320, status: 'success' },
    });
    expect(stdout).toEqual({});
    const line = lines[0] as ToolPost;
    expect(line).toMatchObject({
      v: 1,
      t: T,
      h: 'hermes',
      e: 'tool-post',
      sid: 'h-1',
      tid: 't1',
      cwd: '/w',
      id: 'c1',
      tool: 'terminal',
      kind: 'shell',
      exitSource: 'parsed',
    });
    expect(line.in.command).toBe('pytest -q');
    expect(line.out).toMatchObject({ text: '5 passed', exit: 0, durationMs: 320 });
  });

  it('a non-success status → tool-fail with a parsed exit and mapped failureType', async () => {
    const { lines } = await run('post_tool_call', {
      tool_name: 'terminal',
      tool_input: { command: 'sleep 999' },
      session_id: 'h-1',
      cwd: '/w',
      extra: { tool_call_id: 'c2', turn_id: 't1', result: 'killed: exit code 124', status: 'timeout', error_type: 'timeout', error_message: 'timed out' },
    });
    const line = lines[0] as ToolFail;
    expect(line.e).toBe('tool-fail');
    expect(line.error).toBe('timed out');
    expect(line.failureType).toBe('timeout');
    expect(line.out?.exit).toBe(124);
    expect(line.exitSource).toBe('parsed');
    expect(line.id).toBe('c2');
  });

  it('kind map: write_file→write, edit_file→edit, unknown→other (never a write)', async () => {
    const write = await run('post_tool_call', { tool_name: 'write_file', tool_input: { path: '/w/a.py', content: 'x' }, session_id: 'h-1', extra: { status: 'success' } });
    expect((write.lines[0] as ToolPost).kind).toBe('write');
    const edit = await run('post_tool_call', { tool_name: 'edit_file', tool_input: { path: '/w/a.py' }, session_id: 'h-1', extra: { status: 'success' } });
    expect((edit.lines[0] as ToolPost).kind).toBe('edit');
    const unknown = await run('post_tool_call', { tool_name: 'wibble', tool_input: { x: 1 }, session_id: 'h-1', extra: { status: 'success' } });
    expect((unknown.lines[0] as ToolPost).kind).toBe('other');
  });

  it('a missing status yields a tool-post with no invented exit', async () => {
    const { lines } = await run('post_tool_call', { tool_name: 'terminal', tool_input: { command: 'ls' }, session_id: 'h-1', extra: { tool_call_id: 'c3', result: 'ok' } });
    const line = lines[0] as ToolPost;
    expect(line.e).toBe('tool-post');
    expect(line.out.exit).toBeUndefined();
    expect(line.exitSource).toBeUndefined();
  });
});

describe('hermes turn and session events', () => {
  it('post_llm_call → prompt + stop{completed, text, model} sharing the turn id', async () => {
    const { lines, stdout } = await run('post_llm_call', {
      session_id: 'h-1',
      cwd: '/w',
      extra: { user_message: 'fix the bug', assistant_response: 'Fixed it.', turn_id: 't2', model: 'hermes-4' },
    });
    expect(stdout).toEqual({});
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ e: 'prompt', text: 'fix the bug', tid: 't2', model: 'hermes-4' });
    expect(lines[1]).toMatchObject({ e: 'stop', status: 'completed', text: 'Fixed it.', tid: 't2', model: 'hermes-4' });
  });

  it('on_session_start → session-start carrying the model', async () => {
    const { lines } = await run('on_session_start', { session_id: 'h-1', extra: { model: 'hermes-4', platform: 'darwin' } });
    expect(lines[0]).toMatchObject({ e: 'session-start', model: 'hermes-4' });
  });

  it('on_session_end is deduped against a stop already recorded for the same turn_id', async () => {
    const home = tempDir();
    seedStop(home, 't3');
    const ctx = makeCtx({ event: 'on_session_end', eventClass: 'stop', home, cwd: tempDir() });
    const { lines, stdout } = await run('on_session_end', { session_id: 'h-1', extra: { completed: true, turn_id: 't3' } }, ctx);
    expect(stdout).toEqual({});
    expect(lines).toHaveLength(0);
  });

  it('an undeduped on_session_end records the turn-boundary stop with a mapped status', async () => {
    const home = tempDir();
    seedStop(home, 't3');
    const ctx = makeCtx({ event: 'on_session_end', eventClass: 'stop', home, cwd: tempDir() });
    const { lines } = await run('on_session_end', { session_id: 'h-1', extra: { interrupted: true, turn_id: 't4' } }, ctx);
    expect(lines).toHaveLength(1);
    expect(lines[0] as Stop).toMatchObject({ e: 'stop', status: 'aborted', tid: 't4' });
  });

  it('on_session_finalize → session-end; stdout is always {}', async () => {
    const { lines, stdout } = await run('on_session_finalize', { session_id: 'h-1', extra: {} });
    expect(lines[0]).toMatchObject({ e: 'session-end' });
    expect(JSON.stringify(stdout)).toBe('{}');
  });
});
