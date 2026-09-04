/**
 * S28 — Claude Code dialect (§9 Claude Code row): the Stop stdout contracts
 * (verdict `systemMessage` + `suppressOutput`, NO_CLAIMS `{}` with files
 * still written, `--verbose` forcing the message, the strict block, the
 * `stop_hook_active` suppression), the strict-only SessionStart context,
 * subagent Stops answering `{}` with no `last-receipt.*`, and the dsh
 * recording rule on `PostToolUse`/`PostToolUseFailure` (path prefix vs
 * `--force-record`; failures parse `out.exit`).
 */
import fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Dialect, HookContext, HookFlags } from '../../../src/hook/dialect.js';
import { dialect, SESSION_START_CONTEXT } from '../../../src/hook/dialects/claude-code.js';
import type { HookState } from '../../../src/hook/state.js';
import type { LedgerLine } from '../../../src/model/types.js';
import { cc, type CC } from '../../helpers/cc-lines.js';
import { makeTempDir } from '../../helpers/tmp.js';

const T = '2026-08-29T12:00:00.000Z';
const dirs: string[] = [];

function tempDir(): string {
  const dir = makeTempDir('sr-cc-dialect-');
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function flags(over: Partial<HookFlags> = {}): HookFlags {
  return { strict: false, strictMax: 1, strictReasons: [], forceRecord: false, verbose: false, debug: false, noCache: false, tz: 'local', ...over };
}

function makeCtx(over: Partial<HookContext> = {}): HookContext {
  return {
    harness: 'claude-code',
    event: 'Stop',
    eventClass: 'stop',
    now: new Date(T),
    home: tempDir(),
    cwd: tempDir(),
    env: { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/home/u/.claude' },
    flags: flags(),
    salvage: {},
    stdinBytes: 0,
    overflow: false,
    debug: () => undefined,
    ...over,
  };
}

async function run(
  d: Dialect,
  event: string,
  input: Record<string, unknown>,
  ctx: HookContext,
): Promise<{ stdout: Record<string, unknown>; lines: LedgerLine[]; state: Partial<HookState> | undefined }> {
  const model = d.parse(event, input, ctx);
  const out = await d.handle(model, ctx);
  return { stdout: out.stdout as Record<string, unknown>, lines: out.ledgerLines ?? [], state: out.state };
}

/** The transcript's current text. */
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
  fs.writeFileSync(path, ccText(t));
  return { path, sid: t.sid };
}

/** A flushed transcript whose final carries no claims. */
function noClaimsTranscript(dir: string): { path: string; sid: string } {
  const t = cc();
  t.human('thoughts?', { promptId: 'p1' });
  t.assistant({ text: 'That was an interesting discussion.', stop: 'end_turn' });
  const path = join(dir, `${t.sid}.jsonl`);
  fs.writeFileSync(path, ccText(t));
  return { path, sid: t.sid };
}

function stopInput(path: string, sid: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: sid,
    prompt_id: 'p1',
    transcript_path: path,
    cwd: '/home/u/proj',
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'Tests pass.',
    ...over,
  };
}

describe('Stop stdout contract (§9)', () => {
  it('answers the verdict systemMessage with suppressOutput and writes the receipt files', async () => {
    const dir = tempDir();
    const { path, sid } = contraTranscript(dir);
    const ctx = makeCtx();
    const { stdout } = await run(dialect, 'Stop', stopInput(path, sid), ctx);
    expect(stdout['suppressOutput']).toBe(true);
    expect(stdout['systemMessage']).toMatch(/^receipt: 1 contradicted/);
    expect(String(stdout['systemMessage'])).toContain('last-receipt.md');
    expect(fs.existsSync(join(ctx.home, 'last', 'claude-code', 'last-receipt.md'))).toBe(true);
    expect(fs.existsSync(join(ctx.home, 'receipts.log'))).toBe(true);
  });

  it('NO_CLAIMS with no danger/integrity flags answers {} — files still written', async () => {
    const dir = tempDir();
    const { path, sid } = noClaimsTranscript(dir);
    const ctx = makeCtx();
    const { stdout } = await run(dialect, 'Stop', stopInput(path, sid, { last_assistant_message: 'That was an interesting discussion.' }), ctx);
    expect(stdout).toEqual({});
    expect(fs.existsSync(join(ctx.home, 'last', 'claude-code', 'last-receipt.md'))).toBe(true);
  });

  it('--verbose forces the message for a NO_CLAIMS receipt', async () => {
    const dir = tempDir();
    const { path, sid } = noClaimsTranscript(dir);
    const ctx = makeCtx({ flags: flags({ verbose: true }) });
    const { stdout } = await run(dialect, 'Stop', stopInput(path, sid, { last_assistant_message: 'That was an interesting discussion.' }), ctx);
    expect(stdout['systemMessage']).toMatch(/^receipt: no claims/);
    expect(stdout['suppressOutput']).toBe(true);
  });

  it('strict + nudge reason + stop_hook_active !== true answers the block object', async () => {
    const dir = tempDir();
    const { path, sid } = contraTranscript(dir);
    const ctx = makeCtx({ flags: flags({ strict: true }) });
    const { stdout, state } = await run(dialect, 'Stop', stopInput(path, sid), ctx);
    expect(stdout['decision']).toBe('block');
    expect(stdout['reason']).toMatch(/^showreceipts: /);
    expect(stdout['systemMessage']).toBeUndefined();
    expect(state?.nudges).toBe(1);
  });

  it('stop_hook_active suppresses the nudge — the systemMessage answer stands', async () => {
    const dir = tempDir();
    const { path, sid } = contraTranscript(dir);
    const ctx = makeCtx({ flags: flags({ strict: true }) });
    const { stdout, state } = await run(dialect, 'Stop', stopInput(path, sid, { stop_hook_active: true }), ctx);
    expect(stdout['decision']).toBeUndefined();
    expect(stdout['systemMessage']).toMatch(/^receipt: /);
    expect(state).toBeUndefined();
  });

  it('a subagent Stop answers {} and never writes last-receipt.*', async () => {
    const ctx = makeCtx();
    const { stdout, lines } = await run(
      dialect,
      'Stop',
      stopInput('/tmp/proj/sess/subagents/agent-ab12.jsonl', 'sess-1', { agent_id: 'ab12' }),
      ctx,
    );
    expect(stdout).toEqual({});
    expect(lines).toEqual([]);
    expect(fs.existsSync(join(ctx.home, 'last'))).toBe(false);
    expect(fs.existsSync(join(ctx.home, 'receipts.log'))).toBe(false);
  });
});

describe('SessionStart (§9: strict only)', () => {
  it('answers the additionalContext object in strict mode', async () => {
    const ctx = makeCtx({ event: 'SessionStart', eventClass: 'session', flags: flags({ strict: true }) });
    const { stdout } = await run(dialect, 'SessionStart', { session_id: 's1', hook_event_name: 'SessionStart' }, ctx);
    expect(stdout).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: SESSION_START_CONTEXT },
    });
  });

  it('answers {} without strict', async () => {
    const ctx = makeCtx({ event: 'SessionStart', eventClass: 'session' });
    const { stdout } = await run(dialect, 'SessionStart', { session_id: 's1' }, ctx);
    expect(stdout).toEqual({});
  });
});

describe('the dsh recording rule (§9)', () => {
  const postInput = (transcript: string): Record<string, unknown> => ({
    session_id: 's1',
    transcript_path: transcript,
    cwd: '/work/proj',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_response: { stdout: 'ok', stderr: '' },
    tool_use_id: 'tu_1',
  });

  it('records nothing when transcript_path is under ~/.claude/projects/', async () => {
    const ctx = makeCtx({ event: 'PostToolUse', eventClass: 'record' });
    const { stdout, lines } = await run(dialect, 'PostToolUse', postInput('/home/u/.claude/projects/-home-u-proj/s1.jsonl'), ctx);
    expect(stdout).toEqual({});
    expect(lines).toEqual([]);
  });

  it('records nothing under $CLAUDE_CONFIG_DIR/projects/ either', async () => {
    const ctx = makeCtx({ event: 'PostToolUse', eventClass: 'record', env: { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/custom/claude' } });
    const { lines } = await run(dialect, 'PostToolUse', postInput('/custom/claude/projects/-x/s1.jsonl'), ctx);
    expect(lines).toEqual([]);
  });

  it('records a tool-post when the transcript lies elsewhere', async () => {
    const ctx = makeCtx({ event: 'PostToolUse', eventClass: 'record' });
    const { lines } = await run(dialect, 'PostToolUse', postInput('/work/dsh/transcript.jsonl'), ctx);
    expect(lines).toHaveLength(1);
    const line = lines[0] as Extract<LedgerLine, { e: 'tool-post' }>;
    expect(line.e).toBe('tool-post');
    expect(line.h).toBe('claude-code');
    expect(line.id).toBe('tu_1');
    expect(line.tool).toBe('Bash');
    expect(line.kind).toBe('shell');
    expect(line.in.command).toBe('npm test');
    expect(line.out.text).toBe('ok');
    expect(line.cwd).toBe('/work/proj');
  });

  it('--force-record records even under ~/.claude/projects/', async () => {
    const ctx = makeCtx({ event: 'PostToolUse', eventClass: 'record', flags: flags({ forceRecord: true }) });
    const { lines } = await run(dialect, 'PostToolUse', postInput('/home/u/.claude/projects/-home-u-proj/s1.jsonl'), ctx);
    expect(lines).toHaveLength(1);
  });

  it('PostToolUseFailure records a tool-fail with out.exit parsed from the error text', async () => {
    const ctx = makeCtx({ event: 'PostToolUseFailure', eventClass: 'record' });
    const { lines } = await run(
      dialect,
      'PostToolUseFailure',
      {
        session_id: 's1',
        transcript_path: '/work/dsh/transcript.jsonl',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: 'Error: Exit code 2\nnpm ERR! tests failed',
        tool_use_id: 'tu_2',
      },
      ctx,
    );
    expect(lines).toHaveLength(1);
    const line = lines[0] as Extract<LedgerLine, { e: 'tool-fail' }>;
    expect(line.e).toBe('tool-fail');
    expect(line.error).toContain('Exit code 2');
    expect(line.out?.exit).toBe(2);
    expect(line.exitSource).toBe('parsed');
    expect(line.failureType).toBe('error');
  });
});
