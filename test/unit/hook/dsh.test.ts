/**
 * S28 — dsh dialect (§9 dsh row): reuses the Claude Code dialect with
 * `harness: 'dsh'` — the recording rule (path prefix vs `--force-record`)
 * writes `h: 'dsh'` lines with the CC tool-name kind map, failures parse
 * `out.exit`, and `Stop` stores `last_assistant_message` as the Appendix C
 * `stop.text`, builds the receipt from the dsh ledger and answers the CC
 * stdout contract (systemMessage / NO_CLAIMS `{}` / strict block /
 * `stop_hook_active` suppression).
 */
import fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Dialect, HookContext, HookFlags } from '../../../src/hook/dialect.js';
import { dialect } from '../../../src/hook/dialects/dsh.js';
import type { HookState } from '../../../src/hook/state.js';
import type { LedgerLine } from '../../../src/model/types.js';
import { makeTempDir } from '../../helpers/tmp.js';

const T = '2026-08-29T12:00:00.000Z';
const dirs: string[] = [];

function tempDir(): string {
  const dir = makeTempDir('sr-dsh-dialect-');
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
    harness: 'dsh',
    event: 'Stop',
    eventClass: 'stop',
    now: new Date(T),
    home: tempDir(),
    cwd: tempDir(),
    env: { HOME: '/home/u' },
    flags: flags(),
    salvage: {},
    stdinBytes: 0,
    overflow: false,
    debug: () => undefined,
    ...over,
  };
}

async function run(
  event: string,
  input: Record<string, unknown>,
  ctx: HookContext,
): Promise<{ stdout: Record<string, unknown>; lines: LedgerLine[]; state: Partial<HookState> | undefined }> {
  const d: Dialect = dialect;
  const model = d.parse(event, input, ctx);
  const out = await d.handle(model, ctx);
  return { stdout: out.stdout as Record<string, unknown>, lines: out.ledgerLines ?? [], state: out.state };
}

/**
 * Seeds a dsh ledger whose only turn ran `npm test` red — a "Tests pass."
 * stop final contradicts as `last-run-red` (§4.8 row 1). The mtime is
 * backdated past the §9 race window.
 */
function seedLedger(home: string, sid = 'sess-1'): string {
  const dir = join(home, 'ledger', 'dsh');
  fs.mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sid}.jsonl`);
  const lines = [
    { v: 1, t: T, h: 'dsh', e: 'session-start', sid },
    {
      v: 1,
      t: T,
      h: 'dsh',
      e: 'tool-post',
      sid,
      cwd: '/w',
      id: 'tu_t',
      tool: 'Bash',
      kind: 'shell',
      in: { command: 'npm test' },
      out: { text: '1 failing', bytes: 9, exit: 1 },
      exitSource: 'parsed',
    },
  ];
  fs.writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const old = new Date(Date.now() - 5_000);
  fs.utimesSync(path, old, old);
  return path;
}

function stopInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: 'sess-1',
    prompt_id: 'p1',
    transcript_path: '/work/dsh/transcript.jsonl',
    cwd: '/w',
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'Tests pass.',
    ...over,
  };
}

describe('dsh Stop (§9 dsh row)', () => {
  it('stores last_assistant_message as stop.text and answers the verdict systemMessage', async () => {
    const ctx = makeCtx();
    seedLedger(ctx.home);
    const { stdout, lines } = await run('Stop', stopInput(), ctx);
    expect(lines).toHaveLength(1);
    const stop = lines[0] as Extract<LedgerLine, { e: 'stop' }>;
    expect(stop.e).toBe('stop');
    expect(stop.h).toBe('dsh');
    expect(stop.text).toBe('Tests pass.');
    expect(stop.transcript).toBe('/work/dsh/transcript.jsonl');
    expect(stop.status).toBe('completed');
    expect(stdout['suppressOutput']).toBe(true);
    expect(stdout['systemMessage']).toMatch(/^receipt: 1 contradicted/);
    expect(fs.existsSync(join(ctx.home, 'last', 'dsh', 'last-receipt.md'))).toBe(true);
  });

  it('NO_CLAIMS answers {} (files still written)', async () => {
    const ctx = makeCtx();
    seedLedger(ctx.home);
    const { stdout } = await run('Stop', stopInput({ last_assistant_message: 'That was an interesting discussion.' }), ctx);
    expect(stdout).toEqual({});
    expect(fs.existsSync(join(ctx.home, 'last', 'dsh', 'last-receipt.md'))).toBe(true);
  });

  it('strict answers the CC block object and bumps the nudge state', async () => {
    const ctx = makeCtx({ flags: flags({ strict: true }) });
    seedLedger(ctx.home);
    const { stdout, state } = await run('Stop', stopInput(), ctx);
    expect(stdout['decision']).toBe('block');
    expect(stdout['reason']).toMatch(/^showreceipts: /);
    expect(state?.nudges).toBe(1);
  });

  it('stop_hook_active suppresses the nudge and marks the stop line', async () => {
    const ctx = makeCtx({ flags: flags({ strict: true }) });
    seedLedger(ctx.home);
    const { stdout, lines } = await run('Stop', stopInput({ stop_hook_active: true }), ctx);
    expect(stdout['decision']).toBeUndefined();
    expect(stdout['systemMessage']).toMatch(/^receipt: /);
    const stop = lines[0] as Extract<LedgerLine, { e: 'stop' }>;
    expect(stop.loop).toBe(true);
  });
});

describe('dsh recording rule (§9)', () => {
  const postInput = (transcript: string): Record<string, unknown> => ({
    session_id: 'sess-1',
    transcript_path: transcript,
    cwd: '/w',
    tool_name: 'Edit',
    tool_input: { file_path: '/w/a.ts' },
    tool_response: { stdout: '' },
    tool_use_id: 'tu_9',
  });

  it('records nothing when the transcript is under ~/.claude/projects/', async () => {
    const ctx = makeCtx({ event: 'PostToolUse', eventClass: 'record' });
    const { lines } = await run('PostToolUse', postInput('/home/u/.claude/projects/-w/s.jsonl'), ctx);
    expect(lines).toEqual([]);
  });

  it('records h:dsh tool-post lines with the CC kind map elsewhere', async () => {
    const ctx = makeCtx({ event: 'PostToolUse', eventClass: 'record' });
    const { lines } = await run('PostToolUse', postInput('/work/dsh/transcript.jsonl'), ctx);
    expect(lines).toHaveLength(1);
    const line = lines[0] as Extract<LedgerLine, { e: 'tool-post' }>;
    expect(line.h).toBe('dsh');
    expect(line.kind).toBe('edit');
    expect(line.in.path).toBe('/w/a.ts');
  });

  it('--force-record overrides the prefix rule', async () => {
    const ctx = makeCtx({ event: 'PostToolUse', eventClass: 'record', flags: flags({ forceRecord: true }) });
    const { lines } = await run('PostToolUse', postInput('/home/u/.claude/projects/-w/s.jsonl'), ctx);
    expect(lines).toHaveLength(1);
  });

  it('failures parse the exit code into a tool-fail line', async () => {
    const ctx = makeCtx({ event: 'PostToolUseFailure', eventClass: 'record' });
    const { lines } = await run(
      'PostToolUseFailure',
      {
        session_id: 'sess-1',
        transcript_path: '/work/dsh/transcript.jsonl',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: 'Exit code 3',
        tool_use_id: 'tu_f',
      },
      ctx,
    );
    const line = lines[0] as Extract<LedgerLine, { e: 'tool-fail' }>;
    expect(line.e).toBe('tool-fail');
    expect(line.out?.exit).toBe(3);
    expect(line.exitSource).toBe('parsed');
  });
});
