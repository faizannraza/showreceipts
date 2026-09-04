/**
 * S28 — Codex dialect (§9 Codex row): Stop-only events, the
 * `{"systemMessage": …, "suppressOutput": true}` answer under the 8 KiB
 * (~2,500 token) cap, the strict top-level block object, `stop_hook_active`
 * never nudging, the `turn_id` per-turn cap, NO_CLAIMS `{}`, and the
 * rollout located by `-<session_id>.jsonl` suffix when `transcript_path`
 * is null.
 */
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Dialect, HookContext, HookFlags } from '../../../src/hook/dialect.js';
import { capStdout, CODEX_STDOUT_MAX_BYTES, dialect } from '../../../src/hook/dialects/codex.js';
import { writeHookState, type HookState } from '../../../src/hook/state.js';
import type { LedgerLine } from '../../../src/model/types.js';
import {
  agentMessage,
  assistantItem,
  fnCall,
  fnOut,
  sessionMeta,
  tokenCount,
  unifiedOutput,
  userMessage,
  TEST_SESSION_ID,
} from '../../helpers/codex-lines.js';
import { makeTempDir } from '../../helpers/tmp.js';

const T = '2026-08-29T12:00:00.000Z';
const dirs: string[] = [];

function tempDir(): string {
  const dir = makeTempDir('sr-codex-dialect-');
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
    harness: 'codex',
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

/** A flushed rollout whose final claims "Tests pass." after a red `npm test` (CONTRADICTED `last-run-red`). */
function contraRollout(dir: string): string {
  const lines = [
    sessionMeta(),
    userMessage('please fix the tests'),
    fnCall('exec_command', { cmd: 'npm test' }, 'c1'),
    fnOut('c1', unifiedOutput({ exit: 1, body: '1 failing' })),
    agentMessage('Tests pass.'),
    assistantItem('Tests pass.'),
    tokenCount({ input: 10, cached: 0, output: 5 }),
  ];
  const path = join(dir, 'sessions', '2026', '03', '02', `rollout-2026-03-02T10-00-00-${TEST_SESSION_ID}.jsonl`);
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

/** A flushed rollout whose final carries no claims. */
function noClaimsRollout(dir: string): string {
  const lines = [sessionMeta(), userMessage('hi'), agentMessage('Hello there.'), assistantItem('Hello there.'), tokenCount({ input: 5, cached: 0, output: 2 })];
  const path = join(dir, 'sessions', '2026', '03', '02', `rollout-2026-03-02T10-00-00-${TEST_SESSION_ID}.jsonl`);
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

function stopInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: TEST_SESSION_ID,
    transcript_path: null,
    cwd: '/home/u/proj',
    hook_event_name: 'Stop',
    model: 'gpt-5.2-codex',
    permission_mode: 'default',
    turn_id: 't-1',
    stop_hook_active: false,
    last_assistant_message: 'Tests pass.',
    ...over,
  };
}

describe('codex Stop stdout contract (§9)', () => {
  it('answers systemMessage + suppressOutput under the 8 KiB cap, rollout found by suffix', async () => {
    const codexHome = tempDir();
    contraRollout(codexHome);
    const ctx = makeCtx({ env: { HOME: '/home/u', CODEX_HOME: codexHome } });
    const { stdout, lines } = await run('Stop', stopInput(), ctx);
    expect(lines).toEqual([]);
    expect(stdout['suppressOutput']).toBe(true);
    expect(stdout['systemMessage']).toMatch(/^receipt: 1 contradicted/);
    expect(Buffer.byteLength(JSON.stringify(stdout), 'utf8')).toBeLessThan(CODEX_STDOUT_MAX_BYTES);
  });

  it('a direct transcript_path skips the lookup', async () => {
    const codexHome = tempDir();
    const path = contraRollout(codexHome);
    const ctx = makeCtx(); // no CODEX_HOME in env
    const { stdout } = await run('Stop', stopInput({ transcript_path: path }), ctx);
    expect(stdout['systemMessage']).toMatch(/^receipt: 1 contradicted/);
  });

  it('NO_CLAIMS answers {} (files still written)', async () => {
    const codexHome = tempDir();
    noClaimsRollout(codexHome);
    const ctx = makeCtx({ env: { HOME: '/home/u', CODEX_HOME: codexHome } });
    const { stdout } = await run('Stop', stopInput({ last_assistant_message: 'Hello there.' }), ctx);
    expect(stdout).toEqual({});
    expect(fs.existsSync(join(ctx.home, 'last', 'codex', 'last-receipt.md'))).toBe(true);
  });

  it('an unknown event answers {}', async () => {
    const ctx = makeCtx({ event: 'SessionEnd' });
    const { stdout } = await run('SessionEnd', { session_id: 'x' }, ctx);
    expect(stdout).toEqual({});
  });
});

describe('codex strict mode (§9)', () => {
  it('answers the top-level block object only', async () => {
    const codexHome = tempDir();
    contraRollout(codexHome);
    const ctx = makeCtx({ env: { HOME: '/home/u', CODEX_HOME: codexHome }, flags: flags({ strict: true }) });
    const { stdout, state } = await run('Stop', stopInput(), ctx);
    expect(stdout['decision']).toBe('block');
    expect(stdout['reason']).toMatch(/^showreceipts: /);
    expect(stdout['reason']).toContain('red');
    expect(stdout['systemMessage']).toBeUndefined();
    expect(stdout['suppressOutput']).toBeUndefined();
    expect(state?.nudges).toBe(1);
    expect(state?.turnIds).toContain('t-1');
  });

  it('stop_hook_active means never nudge', async () => {
    const codexHome = tempDir();
    contraRollout(codexHome);
    const ctx = makeCtx({ env: { HOME: '/home/u', CODEX_HOME: codexHome }, flags: flags({ strict: true }) });
    const { stdout, state } = await run('Stop', stopInput({ stop_hook_active: true }), ctx);
    expect(stdout['decision']).toBeUndefined();
    expect(stdout['systemMessage']).toMatch(/^receipt: /);
    expect(state).toBeUndefined();
  });

  it('the turn_id state caps a second nudge for the same turn', async () => {
    const codexHome = tempDir();
    contraRollout(codexHome);
    const ctx = makeCtx({ env: { HOME: '/home/u', CODEX_HOME: codexHome }, flags: flags({ strict: true }) });
    // A previous stop of the same turn already nudged (with a different final).
    writeHookState(ctx.home, 'codex', TEST_SESSION_ID, { nudges: 1, turnIds: ['t-1'], lastNudgeFinalHash: '0'.repeat(64) });
    const { stdout, state } = await run('Stop', stopInput(), ctx);
    expect(stdout['decision']).toBeUndefined();
    expect(stdout['systemMessage']).toMatch(/^receipt: /);
    expect(state).toBeUndefined();
  });
});

describe('capStdout (§9 8 KiB serialised cap)', () => {
  it('re-serialises to at most CODEX_STDOUT_MAX_BYTES and keeps the ellipsis', () => {
    const ascii = capStdout({ systemMessage: 'a'.repeat(9_000), suppressOutput: true }) as { systemMessage: string };
    expect(Buffer.byteLength(JSON.stringify(ascii), 'utf8')).toBeLessThanOrEqual(CODEX_STDOUT_MAX_BYTES);
    expect(ascii.systemMessage.endsWith('…')).toBe(true);

    // A multi-byte + escape-heavy tail: escaping inflates the removed
    // suffix's serialised share, which only leaves more headroom.
    const noisy = capStdout({ systemMessage: `${'é'.repeat(5_000)}"${'\\'.repeat(50)}`, suppressOutput: true }) as {
      systemMessage: string;
    };
    expect(Buffer.byteLength(JSON.stringify(noisy), 'utf8')).toBeLessThanOrEqual(CODEX_STDOUT_MAX_BYTES);
    expect(noisy.systemMessage.endsWith('…')).toBe(true);
  });

  it('leaves an under-cap answer untouched', () => {
    const short = { systemMessage: 'receipt: ok', suppressOutput: true };
    expect(capStdout(short)).toBe(short);
  });
});
