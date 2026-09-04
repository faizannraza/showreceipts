/**
 * S29 — Copilot CLI dialect (§9 Copilot row, Appendix C): camel and Pascal
 * key-form parity, the ms `timestamp` → ISO `t`, the kind map (unknown →
 * `other`, never a write), the parsed `/exit code (\d+)/i` exit, the stable
 * fallback tool id, `sessionStart.initialPrompt` → `prompt`, `agentStop` →
 * `stop{transcript}` with the best-effort transcript final text
 * (`copilotTranscriptUnparsed` when unrecognisable), and never-strict `{}`
 * stdout.
 */
import fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HookContext } from '../../../src/hook/dialect.js';
import { dialect } from '../../../src/hook/dialects/copilot.js';
import type { LedgerLine, Receipt } from '../../../src/model/types.js';
import { makeTempDir } from '../../helpers/tmp.js';

const T = '2026-08-29T12:00:00.000Z';
const TS_MS = Date.parse('2026-08-29T11:58:00.000Z');
const dirs: string[] = [];

function tempDir(): string {
  const dir = makeTempDir('sr-copilot-');
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeCtx(over: Partial<HookContext> = {}): HookContext {
  return {
    harness: 'copilot',
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

async function run(
  event: string,
  input: Record<string, unknown>,
  ctx = makeCtx(),
): Promise<{ lines: LedgerLine[]; stdout: object; counters: Record<string, number> | undefined }> {
  const model = dialect.parse(event, input, ctx);
  const out = await dialect.handle(model, ctx);
  return { lines: out.ledgerLines ?? [], stdout: out.stdout, counters: out.counters as Record<string, number> | undefined };
}

type ToolPost = Extract<LedgerLine, { e: 'tool-post' }>;
type ToolFail = Extract<LedgerLine, { e: 'tool-fail' }>;
type Stop = Extract<LedgerLine, { e: 'stop' }>;

const CAMEL = {
  sessionId: 'cp-1',
  timestamp: TS_MS,
  cwd: '/w',
  toolName: 'bash',
  toolArgs: { command: 'npm test' },
  toolResult: { resultType: 'success', textResultForLlm: 'ran fine, exit code 0' },
};

const SNAKE = {
  session_id: 'cp-1',
  timestamp: TS_MS,
  cwd: '/w',
  tool_name: 'bash',
  tool_args: { command: 'npm test' },
  tool_result: { result_type: 'success', text_result_for_llm: 'ran fine, exit code 0' },
};

describe('copilot postToolUse', () => {
  it('camel form: ms timestamp → ISO t, parsed exit, shell kind, stable fallback id', async () => {
    const { lines, stdout } = await run('postToolUse', CAMEL);
    expect(stdout).toEqual({});
    const line = lines[0] as ToolPost;
    expect(line).toMatchObject({
      v: 1,
      t: '2026-08-29T11:58:00.000Z',
      h: 'copilot',
      e: 'tool-post',
      sid: 'cp-1',
      cwd: '/w',
      tool: 'bash',
      kind: 'shell',
      exitSource: 'parsed',
    });
    expect(line.in.command).toBe('npm test');
    expect(line.out.exit).toBe(0);
    expect(line.out.text).toBe('ran fine, exit code 0');
    expect(line.id).toMatch(/^h[0-9a-f]{12}$/);
    const again = (await run('postToolUse', CAMEL)).lines[0] as ToolPost;
    expect(again.id).toBe(line.id);
  });

  it('Pascal/snake form parity: the same event in the other spelling maps to an identical line', async () => {
    const camel = (await run('postToolUse', CAMEL)).lines[0];
    const snake = (await run('postToolUse', SNAKE)).lines[0];
    expect(snake).toEqual(camel);
  });

  it('kind map: create→write, view→read, unknown→other (never a write)', async () => {
    const create = await run('postToolUse', { ...CAMEL, toolName: 'create', toolArgs: { path: '/w/a.ts' }, toolResult: { textResultForLlm: 'created' } });
    expect((create.lines[0] as ToolPost).kind).toBe('write');
    expect((create.lines[0] as ToolPost).in.path).toBe('/w/a.ts');
    const view = await run('postToolUse', { ...CAMEL, toolName: 'view', toolArgs: { path: '/w/a.ts' }, toolResult: { textResultForLlm: 'x' } });
    expect((view.lines[0] as ToolPost).kind).toBe('read');
    const unknown = await run('postToolUse', { ...CAMEL, toolName: 'zap', toolArgs: {}, toolResult: { textResultForLlm: 'x' } });
    expect((unknown.lines[0] as ToolPost).kind).toBe('other');
  });

  it('a failed resultType marks out.error on the tool-post', async () => {
    const { lines } = await run('postToolUse', { ...CAMEL, toolResult: { resultType: 'failure', textResultForLlm: 'nope, exit code 3' } });
    const line = lines[0] as ToolPost;
    expect(line.out.error).toBe(true);
    expect(line.out.exit).toBe(3);
  });
});

describe('copilot postToolUseFailure', () => {
  it('→ tool-fail with the parsed exit from the error text', async () => {
    const { lines } = await run('postToolUseFailure', {
      sessionId: 'cp-1',
      timestamp: TS_MS,
      cwd: '/w',
      toolName: 'bash',
      toolArgs: { command: 'npm test' },
      error: 'command failed with exit code 4',
    });
    const line = lines[0] as ToolFail;
    expect(line.e).toBe('tool-fail');
    expect(line.error).toBe('command failed with exit code 4');
    expect(line.failureType).toBe('error');
    expect(line.out?.exit).toBe(4);
    expect(line.exitSource).toBe('parsed');
  });
});

describe('copilot session and stop events', () => {
  it('sessionStart records source and the initial prompt', async () => {
    const { lines } = await run('sessionStart', { sessionId: 'cp-1', timestamp: TS_MS, source: 'cli', initialPrompt: 'fix the flaky test' });
    expect(lines[0]).toMatchObject({ e: 'session-start', source: 'cli', sid: 'cp-1' });
    expect(lines[1]).toMatchObject({ e: 'prompt', text: 'fix the flaky test' });
  });

  it('agentStop: transcriptPath → stop.transcript; a parseable transcript feeds the receipt final text', async () => {
    const home = tempDir();
    const cwd = tempDir();
    const transcript = join(cwd, 'transcript.jsonl');
    fs.writeFileSync(transcript, `${JSON.stringify({ role: 'user', content: 'do it' })}\n${JSON.stringify({ role: 'assistant', content: 'Shipped the fix.' })}\n`);
    const ctx = makeCtx({ event: 'agentStop', eventClass: 'stop', home, cwd });
    const { lines, stdout, counters } = await run('agentStop', { sessionId: 'cp-1', timestamp: TS_MS, cwd, transcriptPath: transcript }, ctx);
    expect(stdout).toEqual({});
    expect(lines[0] as Stop).toMatchObject({ e: 'stop', transcript });
    expect((lines[0] as Stop).text).toBeUndefined();
    expect(counters).toBeUndefined();
    const receipt = JSON.parse(fs.readFileSync(join(home, 'last', 'copilot', 'last-receipt.json'), 'utf8')) as Receipt;
    expect(receipt.finalText).toBe('Shipped the fix.');
    expect(receipt.finalTextSource).toBe('copilot-transcript');
  });

  it('an unrecognisable transcript bumps copilotTranscriptUnparsed', async () => {
    const home = tempDir();
    const cwd = tempDir();
    const transcript = join(cwd, 'transcript.bin');
    fs.writeFileSync(transcript, 'this is not json at all\nnor jsonl\n');
    const ctx = makeCtx({ event: 'agentStop', eventClass: 'stop', home, cwd });
    const { counters } = await run('agentStop', { sessionId: 'cp-1', timestamp: TS_MS, cwd, transcriptPath: transcript }, ctx);
    expect(counters).toEqual({ copilotTranscriptUnparsed: 1 });
  });

  it('never strict: strict flags still answer {}', async () => {
    const home = tempDir();
    const cwd = tempDir();
    const ctx = makeCtx({
      event: 'agentStop',
      eventClass: 'stop',
      home,
      cwd,
      flags: { strict: true, strictMax: 1, strictReasons: [], forceRecord: false, verbose: false, debug: false, noCache: false, tz: 'local' },
    });
    const { stdout } = await run('agentStop', { sessionId: 'cp-1', timestamp: TS_MS, cwd }, ctx);
    expect(JSON.stringify(stdout)).toBe('{}');
  });

  it('sessionEnd → session-end; an out-of-range timestamp falls back to the invocation clock', async () => {
    const { lines } = await run('sessionEnd', { sessionId: 'cp-1', timestamp: 12, reason: 'exit' });
    expect(lines[0]).toMatchObject({ e: 'session-end', reason: 'exit', t: T });
  });
});
