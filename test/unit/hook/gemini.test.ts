/**
 * S29 — Gemini CLI dialect (§9 Gemini row, Appendix C): `AfterTool` exit
 * parsing (`Exit Code:` line and `exit_code`/`exitCode` keys, both
 * `exitSource: 'parsed'`), the stable `h`+12-hex fallback tool id, the kind
 * map (unknown → `other`, never a write), `AfterAgent` → `prompt` +
 * `stop{text}` with the fallback sniff + diagnostic, stdout that is exactly
 * one JSON object (`{}`), and the strict deny that never fires when
 * `stop_hook_active` is set.
 */
import fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HookContext } from '../../../src/hook/dialect.js';
import { dialect } from '../../../src/hook/dialects/gemini.js';
import type { LedgerLine } from '../../../src/model/types.js';
import { makeTempDir } from '../../helpers/tmp.js';

const T = '2026-08-29T12:00:00.000Z';
const dirs: string[] = [];

function tempDir(): string {
  const dir = makeTempDir('sr-gemini-');
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeCtx(over: Partial<HookContext> = {}): HookContext {
  return {
    harness: 'gemini',
    event: 'AfterTool',
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

const COMMON = { session_id: 'g-sess', cwd: '/w', timestamp: '2026-08-29T11:59:58.000Z' };

/**
 * Seeds a gemini ledger with a session-start and one ok write (so a
 * tests-pass final contradicts as `no-test-run`, §4.8), backdated past the
 * race window.
 */
function seedLedger(home: string): void {
  const dir = join(home, 'ledger', 'gemini');
  fs.mkdirSync(dir, { recursive: true });
  const path = join(dir, 'g-sess.jsonl');
  const lines = [
    { v: 1, t: '2026-08-29T11:59:00.000Z', h: 'gemini', e: 'session-start', sid: 'g-sess' },
    {
      v: 1,
      t: '2026-08-29T11:59:10.000Z',
      h: 'gemini',
      e: 'tool-post',
      sid: 'g-sess',
      cwd: '/w',
      id: 'h1',
      tool: 'write_file',
      kind: 'write',
      in: { path: '/w/a.ts' },
      out: { text: 'ok', bytes: 2 },
    },
  ];
  fs.writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const old = new Date(Date.now() - 5_000);
  fs.utimesSync(path, old, old);
}

async function run(event: string, input: Record<string, unknown>, ctx = makeCtx()): Promise<{ lines: LedgerLine[]; stdout: object; state: unknown }> {
  const model = dialect.parse(event, input, ctx);
  const out = await dialect.handle(model, ctx);
  return { lines: out.ledgerLines ?? [], stdout: out.stdout, state: out.state };
}

type ToolPost = Extract<LedgerLine, { e: 'tool-post' }>;
type Stop = Extract<LedgerLine, { e: 'stop' }>;

describe('gemini AfterTool', () => {
  const shellEvent = {
    ...COMMON,
    tool_name: 'run_shell_command',
    tool_input: { command: 'ls -la' },
    tool_response: { llmContent: 'total 0\nExit Code: 3', returnDisplay: 'ran' },
  };

  it('parses the Exit Code line from a string llmContent and uses the event timestamp', async () => {
    const { lines, stdout } = await run('AfterTool', shellEvent);
    expect(JSON.stringify(stdout)).toBe('{}');
    const line = lines[0] as ToolPost;
    expect(line).toMatchObject({
      v: 1,
      t: '2026-08-29T11:59:58.000Z',
      h: 'gemini',
      e: 'tool-post',
      sid: 'g-sess',
      cwd: '/w',
      kind: 'shell',
      tool: 'run_shell_command',
      exitSource: 'parsed',
    });
    expect(line.in.command).toBe('ls -la');
    expect(line.out.exit).toBe(3);
    expect(line.out.text).toBe('total 0\nExit Code: 3');
  });

  it('the fallback tool id is h + 12 hex and stable across runs', async () => {
    const first = (await run('AfterTool', shellEvent)).lines[0] as ToolPost;
    const second = (await run('AfterTool', shellEvent)).lines[0] as ToolPost;
    expect(first.id).toMatch(/^h[0-9a-f]{12}$/);
    expect(second.id).toBe(first.id);
  });

  it('finds exit_code/exitCode keys inside a structured llmContent (parsed)', async () => {
    const { lines } = await run('AfterTool', {
      ...COMMON,
      tool_name: 'run_shell_command',
      tool_input: { command: 'make' },
      tool_response: { llmContent: { parts: [{ exit_code: 2 }] }, returnDisplay: 'failed' },
    });
    const line = lines[0] as ToolPost;
    expect(line.out.exit).toBe(2);
    expect(line.exitSource).toBe('parsed');
    expect(line.out.text).toBe('failed');
  });

  it('an errored tool_response marks out.error (tool-post, exit still parsed)', async () => {
    const { lines } = await run('AfterTool', {
      ...COMMON,
      tool_name: 'run_shell_command',
      tool_input: { command: 'make' },
      tool_response: { llmContent: 'boom\nExit Code: 1', error: { type: 'ToolError' } },
    });
    const line = lines[0] as ToolPost;
    expect(line.e).toBe('tool-post');
    expect(line.out.error).toBe(true);
    expect(line.out.exit).toBe(1);
    expect(line.exitSource).toBe('parsed');
  });

  it('maps tool names per Appendix C and unknown names to other, never a write', async () => {
    const write = await run('AfterTool', { ...COMMON, tool_name: 'write_file', tool_input: { file_path: '/w/a.ts', content: 'x' }, tool_response: { llmContent: 'ok' } });
    expect((write.lines[0] as ToolPost).kind).toBe('write');
    expect((write.lines[0] as ToolPost).in.path).toBe('/w/a.ts');
    const unknown = await run('AfterTool', { ...COMMON, tool_name: 'wibble', tool_input: { anything: 1 }, tool_response: { llmContent: 'ok' } });
    expect((unknown.lines[0] as ToolPost).kind).toBe('other');
  });
});

describe('gemini AfterAgent', () => {
  it('emits prompt + stop{text: prompt_response} and answers exactly {}', async () => {
    const { lines, stdout } = await run('AfterAgent', { ...COMMON, prompt: 'add a flag', prompt_response: 'Added the flag.' });
    expect(JSON.stringify(stdout)).toBe('{}');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ e: 'prompt', text: 'add a flag' });
    expect(lines[1]).toMatchObject({ e: 'stop', status: 'completed', text: 'Added the flag.' });
  });

  it('sniffs response|final_response|text|message when prompt_response is missing, with a diagnostic', async () => {
    const debug = vi.fn();
    const ctx = makeCtx({ event: 'AfterAgent', eventClass: 'stop', debug });
    const { lines } = await run('AfterAgent', { ...COMMON, prompt: 'hi', response: 'Hello there.' }, ctx);
    expect((lines[1] as Stop).text).toBe('Hello there.');
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('prompt_response missing'));
  });

  it('strict mode denies with a showreceipts reason when a nudge fires', async () => {
    const home = tempDir();
    const cwd = tempDir();
    seedLedger(home);
    const ctx = makeCtx({
      event: 'AfterAgent',
      eventClass: 'stop',
      home,
      cwd,
      flags: { strict: true, strictMax: 1, strictReasons: [], forceRecord: false, verbose: false, debug: false, noCache: false, tz: 'local' },
    });
    const { stdout, state } = await run('AfterAgent', { ...COMMON, prompt: 'run the suite', prompt_response: 'Done. All tests pass.' }, ctx);
    expect(stdout).toHaveProperty('decision', 'deny');
    expect((stdout as { reason: string }).reason.startsWith('showreceipts:')).toBe(true);
    expect((state as { nudges: number }).nudges).toBe(1);
  });

  it('never denies when stop_hook_active is set', async () => {
    const home = tempDir();
    const ctx = makeCtx({
      event: 'AfterAgent',
      eventClass: 'stop',
      home,
      cwd: tempDir(),
      flags: { strict: true, strictMax: 1, strictReasons: [], forceRecord: false, verbose: false, debug: false, noCache: false, tz: 'local' },
    });
    const { stdout } = await run('AfterAgent', { ...COMMON, prompt: 'x', prompt_response: 'Done. All tests pass.', stop_hook_active: true }, ctx);
    expect(JSON.stringify(stdout)).toBe('{}');
  });
});

describe('gemini session events', () => {
  it('SessionStart records the transcript path; SessionEnd closes the session', async () => {
    const start = await run('SessionStart', { ...COMMON, transcript_path: '/tmp/gem.json' });
    expect(start.lines[0]).toMatchObject({ e: 'session-start', transcript: '/tmp/gem.json', sid: 'g-sess' });
    expect(JSON.stringify(start.stdout)).toBe('{}');
    const end = await run('SessionEnd', { ...COMMON });
    expect(end.lines[0]).toMatchObject({ e: 'session-end' });
    expect(JSON.stringify(end.stdout)).toBe('{}');
  });

  it('an invalid timestamp falls back to the invocation clock', async () => {
    const { lines } = await run('SessionStart', { ...COMMON, timestamp: 'yesterday-ish' });
    expect(lines[0]?.t).toBe(T);
  });

  it('a non-UTC offset timestamp is normalised to ISO UTC in t (Appendix C)', async () => {
    const { lines } = await run('SessionStart', { ...COMMON, timestamp: '2026-08-29T13:59:58+02:00' });
    expect(lines[0]?.t).toBe('2026-08-29T11:59:58.000Z');
  });
});
