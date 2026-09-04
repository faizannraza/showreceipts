/**
 * S29 — OpenCode and OpenClaw ledger dialects (§9 roadmap rows): the
 * forwarded payload shapes map onto Appendix C `tool-post`/`stop` lines,
 * unknown tool names map to `other` (never a write), and stdout is always
 * `{}` — the plugins read nothing back.
 */
import { describe, expect, it } from 'vitest';
import type { HookContext } from '../../../src/hook/dialect.js';
import { dialect as openclaw } from '../../../src/hook/dialects/openclaw.js';
import { dialect as opencode } from '../../../src/hook/dialects/opencode.js';
import type { LedgerLine } from '../../../src/model/types.js';

const T = '2026-08-29T12:00:00.000Z';

function makeCtx(over: Partial<HookContext> = {}): HookContext {
  return {
    harness: 'opencode',
    event: 'tool.execute.after',
    eventClass: 'record',
    now: new Date(T),
    home: '',
    cwd: '/proj',
    env: { HOME: '/home/u' },
    flags: { strict: false, strictMax: 1, strictReasons: [], forceRecord: false, verbose: false, debug: false, noCache: false, tz: 'local' },
    salvage: {},
    stdinBytes: 0,
    overflow: false,
    debug: () => undefined,
    ...over,
  };
}

type ToolPost = Extract<LedgerLine, { e: 'tool-post' }>;
type Stop = Extract<LedgerLine, { e: 'stop' }>;

describe('opencode dialect', () => {
  const ctx = makeCtx();

  async function run(event: string, input: Record<string, unknown>): Promise<{ lines: LedgerLine[]; stdout: object }> {
    const model = opencode.parse(event, input, ctx);
    const out = await opencode.handle(model, ctx);
    return { lines: out.ledgerLines ?? [], stdout: out.stdout };
  }

  it('tool.execute.after → tool-post with callID id, title as the bash command, and a cwd', async () => {
    const { lines, stdout } = await run('tool.execute.after', {
      tool: 'bash',
      sessionID: 'oc-1',
      callID: 'call-9',
      title: 'npm test',
      output: '42 passing',
      metadata: { cwd: '/w' },
    });
    expect(stdout).toEqual({});
    const line = lines[0] as ToolPost;
    expect(line).toMatchObject({ v: 1, t: T, h: 'opencode', e: 'tool-post', sid: 'oc-1', id: 'call-9', tool: 'bash', kind: 'shell', cwd: '/w' });
    expect(line.in.command).toBe('npm test');
    expect(line.out.text).toBe('42 passing');
  });

  it('metadata command/filepath win over the title; the hook cwd is the fallback', async () => {
    const { lines } = await run('tool.execute.after', {
      tool: 'edit',
      sessionID: 'oc-1',
      callID: 'call-2',
      title: 'a.ts',
      output: '',
      metadata: { filepath: '/w/a.ts' },
    });
    const line = lines[0] as ToolPost;
    expect(line.kind).toBe('edit');
    expect(line.in.path).toBe('/w/a.ts');
    expect(line.in.command).toBeUndefined();
    expect(line.cwd).toBe('/proj');
  });

  it('unknown tool names map to other, never a write', async () => {
    const { lines } = await run('tool.execute.after', { tool: 'wibble', sessionID: 'oc-1', callID: 'c', output: '' });
    expect((lines[0] as ToolPost).kind).toBe('other');
  });

  it('session.idle → stop{completed} with {} stdout', async () => {
    const { lines, stdout } = await run('session.idle', { sessionID: 'oc-1' });
    expect(JSON.stringify(stdout)).toBe('{}');
    expect(lines[0] as Stop).toMatchObject({ e: 'stop', status: 'completed', sid: 'oc-1' });
  });
});

describe('openclaw dialect', () => {
  const ctx = makeCtx({ harness: 'openclaw', event: 'after_tool_call' });

  async function run(event: string, input: Record<string, unknown>): Promise<{ lines: LedgerLine[]; stdout: object }> {
    const model = openclaw.parse(event, input, ctx);
    const out = await openclaw.handle(model, ctx);
    return { lines: out.ledgerLines ?? [], stdout: out.stdout };
  }

  it('after_tool_call → tool-post with the shell kind map and the hook cwd fallback', async () => {
    const { lines, stdout } = await run('after_tool_call', {
      tool_name: 'exec',
      tool_input: { command: 'make' },
      result: 'built',
      tool_call_id: 'x1',
      session_id: 'ocl-1',
    });
    expect(stdout).toEqual({});
    const line = lines[0] as ToolPost;
    expect(line).toMatchObject({ v: 1, t: T, h: 'openclaw', e: 'tool-post', sid: 'ocl-1', id: 'x1', tool: 'exec', kind: 'shell', cwd: '/proj' });
    expect(line.in.command).toBe('make');
    expect(line.out.text).toBe('built');
  });

  it('unknown tools map to other and an error payload marks out.error', async () => {
    const { lines } = await run('after_tool_call', { tool_name: 'wibble', input: { x: 1 }, output: 'nope', error: 'boom', session_id: 'ocl-1' });
    const line = lines[0] as ToolPost;
    expect(line.kind).toBe('other');
    expect(line.out.error).toBe(true);
  });

  it('agent_end → stop{completed, text}; session_start/session_end map through', async () => {
    const stop = await run('agent_end', { session_id: 'ocl-1', message: 'Done here.' });
    expect(stop.lines[0] as Stop).toMatchObject({ e: 'stop', status: 'completed', text: 'Done here.' });
    const start = await run('session_start', { session_id: 'ocl-1', model: 'claw-1' });
    expect(start.lines[0]).toMatchObject({ e: 'session-start', model: 'claw-1' });
    const end = await run('session_end', { session_id: 'ocl-1', reason: 'quit' });
    expect(end.lines[0]).toMatchObject({ e: 'session-end', reason: 'quit' });
    expect(JSON.stringify(stop.stdout)).toBe('{}');
  });
});
