/**
 * S29 — Cursor dialect (§9 Cursor row, Appendix C): per-event ledger line
 * shapes (`sid`/`tid`/`model`/`hv`/`cwd`/`exitSource`/kind), the harness
 * exit code from the `tool_output` JSON string, failure events → `tool-fail`
 * with a parsed exit, `workspace_roots[0]` + `ambiguousRoot`, and the stop
 * flow: `{}` stdout, receipt files, and the strict `followup_message` nudge
 * only when `loop_count === 0`.
 */
import fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HookContext } from '../../../src/hook/dialect.js';
import { dialect } from '../../../src/hook/dialects/cursor.js';
import type { LedgerLine } from '../../../src/model/types.js';
import { makeTempDir } from '../../helpers/tmp.js';

const T = '2026-08-29T12:00:00.000Z';
const dirs: string[] = [];

function tempDir(): string {
  const dir = makeTempDir('sr-cursor-');
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeCtx(over: Partial<HookContext> = {}): HookContext {
  return {
    harness: 'cursor',
    event: 'postToolUse',
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

const COMMON = { conversation_id: 'conv-1', generation_id: 'gen-1', model_id: 'gpt-5', cursor_version: '1.7.2' };

async function run(event: string, input: Record<string, unknown>, ctx = makeCtx()): Promise<{ lines: LedgerLine[]; stdout: object; state: unknown }> {
  const model = dialect.parse(event, input, ctx);
  const out = await dialect.handle(model, ctx);
  return { lines: out.ledgerLines ?? [], stdout: out.stdout, state: out.state };
}

type ToolPost = Extract<LedgerLine, { e: 'tool-post' }>;
type ToolFail = Extract<LedgerLine, { e: 'tool-fail' }>;
type Stop = Extract<LedgerLine, { e: 'stop' }>;

/**
 * Writes a cursor ledger whose only turn is `gen-1` — a session-start, one
 * ok Write (so a tests-pass claim contradicts as `no-test-run`, §4.8) and
 * the agent response — mtime backdated past the race window.
 */
function seedLedger(home: string, finalText: string): string {
  const dir = join(home, 'ledger', 'cursor');
  fs.mkdirSync(dir, { recursive: true });
  const path = join(dir, 'conv-1.jsonl');
  const lines = [
    { v: 1, t: T, h: 'cursor', e: 'session-start', sid: 'conv-1' },
    {
      v: 1,
      t: T,
      h: 'cursor',
      e: 'tool-post',
      sid: 'conv-1',
      tid: 'gen-1',
      cwd: '/w',
      id: 'tu_w',
      tool: 'Write',
      kind: 'write',
      in: { path: '/w/a.ts' },
      out: { text: 'ok', bytes: 2 },
    },
    { v: 1, t: T, h: 'cursor', e: 'agent-response', sid: 'conv-1', tid: 'gen-1', text: finalText },
  ];
  fs.writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const old = new Date(Date.now() - 5_000);
  fs.utimesSync(path, old, old);
  return path;
}

describe('cursor record events', () => {
  it('postToolUse: harness exit from the tool_output JSON string, full common fields', async () => {
    const { lines, stdout } = await run('postToolUse', {
      ...COMMON,
      cwd: '/w/repo',
      tool_name: 'Shell',
      tool_use_id: 'tu_9',
      duration: 1234,
      tool_input: JSON.stringify({ command: 'npm test' }),
      tool_output: JSON.stringify({ exitCode: 0, stdout: '42 passing' }),
    });
    expect(stdout).toEqual({});
    expect(lines).toHaveLength(1);
    const line = lines[0] as ToolPost;
    expect(line).toMatchObject({
      v: 1,
      t: T,
      h: 'cursor',
      e: 'tool-post',
      sid: 'conv-1',
      tid: 'gen-1',
      hv: '1.7.2',
      model: 'gpt-5',
      cwd: '/w/repo',
      exitSource: 'harness',
      id: 'tu_9',
      tool: 'Shell',
      kind: 'shell',
    });
    expect(line.in.command).toBe('npm test');
    expect(line.out.exit).toBe(0);
    expect(line.out.text).toBe('42 passing');
    expect(line.out.durationMs).toBe(1234);
  });

  it('model falls back from model_id to model', async () => {
    const { lines } = await run('postToolUse', {
      ...COMMON,
      model_id: undefined,
      model: 'auto',
      tool_name: 'Read',
      tool_use_id: 'tu_1',
      tool_input: JSON.stringify({ path: '/w/a.ts' }),
      tool_output: JSON.stringify({}),
      cwd: '/w',
    });
    expect((lines[0] as ToolPost).model).toBe('auto');
    expect((lines[0] as ToolPost).kind).toBe('read');
  });

  it('postToolUseFailure → tool-fail with a parsed exit from the error message', async () => {
    const { lines } = await run('postToolUseFailure', {
      ...COMMON,
      cwd: '/w',
      tool_name: 'Shell',
      tool_use_id: 'tu_2',
      tool_input: JSON.stringify({ command: 'npm test' }),
      error_message: 'Command failed with exit code 2',
      failure_type: 'error',
      duration: 50,
    });
    const line = lines[0] as ToolFail;
    expect(line.e).toBe('tool-fail');
    expect(line.error).toBe('Command failed with exit code 2');
    expect(line.failureType).toBe('error');
    expect(line.out?.exit).toBe(2);
    expect(line.exitSource).toBe('parsed');
    expect(line.durationMs).toBe(50);
    expect(line.id).toBe('tu_2');
  });

  it('afterFileEdit: cwd from workspace_roots[0]; ambiguousRoot only for several roots + a relative path', async () => {
    const base = {
      ...COMMON,
      file_path: 'src/a.ts',
      edits: [{ old_string: 'a', new_string: 'b' }],
      workspace_roots: ['/r1', '/r2'],
    };
    const { lines } = await run('afterFileEdit', base);
    const line = lines[0] as ToolPost;
    expect(line.tool).toBe('afterFileEdit');
    expect(line.kind).toBe('edit');
    expect(line.cwd).toBe('/r1');
    expect(line.ambiguousRoot).toBe(true);
    expect(line.in.path).toBe('src/a.ts');
    expect(line.in.edits).toEqual([{ old: 'a', new: 'b' }]);

    const absolute = await run('afterFileEdit', { ...base, file_path: '/r1/src/a.ts' });
    expect((absolute.lines[0] as ToolPost).ambiguousRoot).toBeUndefined();

    const single = await run('afterFileEdit', { ...base, workspace_roots: ['/r1'] });
    expect((single.lines[0] as ToolPost).ambiguousRoot).toBeUndefined();
  });

  it('afterMCPExecution → kind mcp with the result payload as text', async () => {
    const { lines } = await run('afterMCPExecution', {
      ...COMMON,
      tool_name: 'MCP:linear:createIssue',
      mcp_server_name: 'linear',
      tool_input: { title: 'bug' },
      result_json: '{"ok":true}',
      duration: 10,
    });
    const line = lines[0] as ToolPost;
    expect(line.kind).toBe('mcp');
    expect(line.tool).toBe('MCP:linear:createIssue');
    expect(line.out.text).toBe('{"ok":true}');
    expect(line.out.durationMs).toBe(10);
  });

  it('afterAgentResponse → agent-response; subagentStop → subagent-stop', async () => {
    const response = await run('afterAgentResponse', { ...COMMON, text: 'All wired up.' });
    expect(response.lines[0]).toMatchObject({ e: 'agent-response', text: 'All wired up.', tid: 'gen-1' });

    const sub = await run('subagentStop', {
      ...COMMON,
      subagent_type: 'explorer',
      status: 'completed',
      summary: 'looked around',
      modified_files: ['/w/a.ts'],
      agent_transcript_path: '/tmp/agent.jsonl',
    });
    expect(sub.lines[0]).toMatchObject({
      e: 'subagent-stop',
      agent: { type: 'explorer', status: 'completed', summary: 'looked around', modifiedFiles: ['/w/a.ts'], transcript: '/tmp/agent.jsonl' },
    });
  });

  it('sessionStart/sessionEnd → session-start/session-end', async () => {
    const start = await run('sessionStart', { ...COMMON, transcript_path: '/tmp/x.jsonl', composer_mode: 'agent' });
    expect(start.lines[0]).toMatchObject({ e: 'session-start', transcript: '/tmp/x.jsonl', source: 'agent', sid: 'conv-1' });
    const end = await run('sessionEnd', { ...COMMON, reason: 'closed' });
    expect(end.lines[0]).toMatchObject({ e: 'session-end', reason: 'closed' });
  });
});

describe('cursor stop', () => {
  it('answers {} and writes the receipt files from the ledger', async () => {
    const home = tempDir();
    const cwd = tempDir();
    seedLedger(home, 'Refactored the parser.');
    const ctx = makeCtx({ event: 'stop', eventClass: 'stop', home, cwd });
    const { lines, stdout } = await run('stop', { ...COMMON, status: 'completed', loop_count: 0 }, ctx);
    expect(stdout).toEqual({});
    const stop = lines[0] as Stop;
    expect(stop).toMatchObject({ e: 'stop', status: 'completed', tid: 'gen-1' });
    expect(stop.loop).toBeUndefined();
    expect(fs.existsSync(join(home, 'last', 'cursor', 'last-receipt.md'))).toBe(true);
    expect(fs.existsSync(join(home, 'last', 'cursor', 'last-receipt.json'))).toBe(true);
    expect(fs.readFileSync(join(home, 'receipts.log'), 'utf8').trimEnd().split('\n')).toHaveLength(1);
  });

  it('strict + loop_count 0 nudges with a followup_message and new state', async () => {
    const home = tempDir();
    const cwd = tempDir();
    seedLedger(home, 'Done. All tests pass.');
    const ctx = makeCtx({
      event: 'stop',
      eventClass: 'stop',
      home,
      cwd,
      flags: { strict: true, strictMax: 1, strictReasons: [], forceRecord: false, verbose: false, debug: false, noCache: false, tz: 'local' },
    });
    const { stdout, state } = await run('stop', { ...COMMON, status: 'completed', loop_count: 0 }, ctx);
    expect(stdout).toHaveProperty('followup_message');
    const message = (stdout as { followup_message: string }).followup_message;
    expect(message.startsWith('showreceipts:')).toBe(true);
    expect((state as { nudges: number }).nudges).toBe(1);
  });

  it('loop_count > 0 never nudges and marks the stop line loop:true', async () => {
    const home = tempDir();
    const cwd = tempDir();
    seedLedger(home, 'Done. All tests pass.');
    const ctx = makeCtx({
      event: 'stop',
      eventClass: 'stop',
      home,
      cwd,
      flags: { strict: true, strictMax: 1, strictReasons: [], forceRecord: false, verbose: false, debug: false, noCache: false, tz: 'local' },
    });
    const { lines, stdout, state } = await run('stop', { ...COMMON, status: 'completed', loop_count: 1 }, ctx);
    expect(stdout).toEqual({});
    expect(state).toBeUndefined();
    expect((lines[0] as Stop).loop).toBe(true);
  });

  it('maps aborted-ish statuses onto the Appendix C enum', async () => {
    const home = tempDir();
    seedLedger(home, 'partial');
    const ctx = makeCtx({ event: 'stop', eventClass: 'stop', home, cwd: tempDir() });
    const { lines } = await run('stop', { ...COMMON, status: 'cancelled', loop_count: 0 }, ctx);
    expect((lines[0] as Stop).status).toBe('aborted');
  });
});
