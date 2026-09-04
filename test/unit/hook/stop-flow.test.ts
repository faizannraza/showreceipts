/**
 * S28 — `hook/stop.ts` (§9 stop-time flow): `prompt_id` turn selection and
 * the last-turn fallback, the flush guard (`end_turn`, synthetic
 * `stop_sequence`, interrupt, trailing `tool_use` ⇒ 3 × 150 ms re-reads on a
 * fake clock, then `incompleteAtStop` with the stdin final text), subagent
 * detection (path regex, `agent_id`, first-record `agentId`) answering with
 * no receipt and no files, receipt files in the git-worktree vs home
 * location with one `receipts.log` line per Stop, the S27b incremental
 * resume (a spy sees `offset === entry.bytesParsed` and `bytesParsed`
 * advances; warm equals cold), and the Codex tail guard + rollout-by-suffix
 * lookup (`archived_sessions` included).
 */
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createCache } from '../../../src/cache/cache.js';
import { resumeSession } from '../../../src/readers/claude-code/reader.js';
import {
  buildStopReceipt,
  CODEX_USAGE_NOTE,
  REREAD_DELAY_MS,
  STALE_NOTE,
  type StopReceiptInput,
  type StopSeams,
} from '../../../src/hook/stop.js';
import type { ReceiptFilesResult } from '../../../src/hook/receipt-files.js';
import { stableStringify } from '../../../src/util/json.js';
import { TOOL_VERSION } from '../../../src/version.js';
import { cc, TEST_SID, type CC } from '../../helpers/cc-lines.js';
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
import { makeTempDir, withTempDir } from '../../helpers/tmp.js';

const T = '2026-08-29T12:00:00.000Z';

/** The transcript's current text (CC sources are always `kind: 'text'`). */
function ccText(t: CC): string {
  const src = t.src();
  if (src.kind !== 'text') throw new Error('CC.src() is always a text source');
  return src.text;
}

/** Writes the transcript as `<sid>.jsonl` under `dir` and returns its path. */
function writeCc(dir: string, t: CC): string {
  const path = join(dir, `${t.sid}.jsonl`);
  fs.writeFileSync(path, ccText(t));
  return path;
}

/** One full turn: human prompt → Bash round-trip → final message. */
function pushTurn(t: CC, n: number): void {
  t.human(`request ${n}`, { promptId: `p${n}` });
  t.assistant({ stop: 'tool_use', tools: [{ id: `tu-${n}`, name: 'Bash', input: { command: 'echo hi' } }] });
  t.toolResult(`tu-${n}`, 'hi');
  t.assistant({ text: `done with request ${n}`, stop: 'end_turn' });
}

/** A fake clock: `sleep` records the waits and never actually waits. */
function fakeSleep(): { sleep: (ms: number) => Promise<void>; sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: (ms: number): Promise<void> => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
}

interface Env {
  home: string;
  cwd: string;
}

function makeEnv(root: string): Env {
  const home = join(root, 'sr-home');
  const cwd = join(root, 'work');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  return { home, cwd };
}

function input(env: Env, over: Partial<StopReceiptInput> & { transcriptPath: string | null }): StopReceiptInput {
  return {
    harness: 'claude-code',
    sessionId: TEST_SID,
    cwd: env.cwd,
    home: env.home,
    userHome: '/home/u',
    now: new Date(T),
    ...over,
  };
}

describe('turn selection (§9)', () => {
  it('picks the turn whose promptId equals prompt_id', () =>
    withTempDir(async (root) => {
      const env = makeEnv(root);
      const t = cc();
      pushTurn(t, 1);
      pushTurn(t, 2);
      const path = writeCc(root, t);
      const { sleep, sleeps } = fakeSleep();
      const result = await buildStopReceipt(
        input(env, { transcriptPath: path, promptId: 'p1', lastAssistantMessage: 'done with request 1', seams: { sleep } }),
      );
      expect(result.subagent).toBe(false);
      expect(result.incompleteAtStop).toBe(false);
      expect(sleeps).toEqual([]);
      expect(result.receipt?.finalText).toBe('done with request 1');
    }));

  it('falls back to the last turn for an unknown prompt_id', () =>
    withTempDir(async (root) => {
      const env = makeEnv(root);
      const t = cc();
      pushTurn(t, 1);
      pushTurn(t, 2);
      const path = writeCc(root, t);
      const result = await buildStopReceipt(
        input(env, { transcriptPath: path, promptId: 'p-unknown', lastAssistantMessage: 'done with request 2', seams: fakeSleep() }),
      );
      expect(result.receipt?.finalText).toBe('done with request 2');
      expect(result.incompleteAtStop).toBe(false);
    }));
});

describe('flush guard (§9)', () => {
  it('end_turn whose text ends with last_assistant_message is flushed — no re-reads', () =>
    withTempDir(async (root) => {
      const env = makeEnv(root);
      const t = cc();
      pushTurn(t, 1);
      const path = writeCc(root, t);
      const { sleep, sleeps } = fakeSleep();
      const result = await buildStopReceipt(
        input(env, { transcriptPath: path, lastAssistantMessage: 'done with request 1', seams: { sleep } }),
      );
      expect(sleeps).toEqual([]);
      expect(result.incompleteAtStop).toBe(false);
      expect(result.receipt?.finalTextSource).toBe('transcript');
      expect(result.receipt?.incompleteAtStop).toBeUndefined();
    }));

  it('a synthetic stop_sequence final is terminal even when the text does not match', () =>
    withTempDir(async (root) => {
      const env = makeEnv(root);
      const t = cc();
      t.human('request 1', { promptId: 'p1' });
      t.assistant({ text: 'Done.', stop: 'stop_sequence' });
      const path = writeCc(root, t);
      const { sleep, sleeps } = fakeSleep();
      const result = await buildStopReceipt(
        input(env, { transcriptPath: path, lastAssistantMessage: 'something entirely different', seams: { sleep } }),
      );
      expect(sleeps).toEqual([]);
      expect(result.incompleteAtStop).toBe(false);
      // A `stop_sequence` message is never an eligible final (§4.2.3), so the
      // receipt renders as the transcript stands — without the stop-hook text.
      expect(result.receipt?.kind).toBe('no-final');
      expect(result.receipt?.finalText).toBe('');
      expect(result.receipt?.incompleteAtStop).toBeUndefined();
    }));

  it('a max_tokens-cut final is terminal — no re-reads, no stop-hook override', () =>
    withTempDir(async (root) => {
      const env = makeEnv(root);
      const t = cc();
      t.human('request 1', { promptId: 'p1' });
      t.assistant({ text: 'Done unti', stop: 'max_tokens' });
      const path = writeCc(root, t);
      const { sleep, sleeps } = fakeSleep();
      const result = await buildStopReceipt(
        input(env, { transcriptPath: path, lastAssistantMessage: 'Done unti', seams: { sleep } }),
      );
      expect(sleeps).toEqual([]);
      expect(result.incompleteAtStop).toBe(false);
      // Like `stop_sequence`, a `max_tokens` final is never an eligible final
      // (§4.2.3): the receipt renders as the transcript stands, with no
      // spurious stale-ledger override and no needless re-reads.
      expect(result.receipt?.kind).toBe('no-final');
      expect(result.receipt?.incompleteAtStop).toBeUndefined();
    }));

  it('an interrupt line is terminal — no re-reads, receipt renders as the transcript stands', () =>
    withTempDir(async (root) => {
      const env = makeEnv(root);
      const t = cc();
      t.human('request 1', { promptId: 'p1' });
      t.assistant({ stop: 'tool_use', tools: [{ id: 'tu-1', name: 'Bash', input: { command: 'sleep 60' } }] });
      t.toolResult('tu-1', 'interrupted');
      t.interrupt();
      const path = writeCc(root, t);
      const { sleep, sleeps } = fakeSleep();
      const result = await buildStopReceipt(input(env, { transcriptPath: path, lastAssistantMessage: 'never sent', seams: { sleep } }));
      expect(sleeps).toEqual([]);
      expect(result.incompleteAtStop).toBe(false);
      expect(result.receipt?.kind).toBe('no-final');
    }));

  it('a trailing tool_use re-reads 3 × 150 ms then builds with the stdin final text', () =>
    withTempDir(async (root) => {
      const env = makeEnv(root);
      const t = cc();
      t.human('request 1', { promptId: 'p1' });
      t.assistant({ stop: 'tool_use', tools: [{ id: 'tu-1', name: 'Bash', input: { command: 'npm test' } }] });
      const path = writeCc(root, t);
      const { sleep, sleeps } = fakeSleep();
      const result = await buildStopReceipt(input(env, { transcriptPath: path, lastAssistantMessage: 'All done.', seams: { sleep } }));
      expect(sleeps).toEqual([REREAD_DELAY_MS, REREAD_DELAY_MS, REREAD_DELAY_MS]);
      expect(result.incompleteAtStop).toBe(true);
      expect(result.receipt?.finalText).toBe('All done.');
      expect(result.receipt?.finalTextSource).toBe('stop-hook');
      expect(result.receipt?.incompleteAtStop).toBe(true);
      expect(result.receipt?.ledgerNote).toContain(STALE_NOTE);
    }));
});

describe('subagent stops (§9): {} and never touch last-receipt.*', () => {
  const spyWriter = (): { fn: ReturnType<typeof vi.fn>; seams: StopSeams } => {
    const fn = vi.fn(
      (): ReceiptFilesResult => ({ dir: '/x', mdPath: '/x/last-receipt.md', jsonPath: '/x/last-receipt.json', logPath: '/x/receipts.log' }),
    );
    return { fn, seams: { writeFiles: fn as unknown as NonNullable<StopSeams['writeFiles']>, ...fakeSleep() } };
  };

  it('a /subagents/agent-*.jsonl transcript path is a subagent stop', () =>
    withTempDir(async (root) => {
      const env = makeEnv(root);
      const { fn, seams } = spyWriter();
      const result = await buildStopReceipt(
        input(env, { transcriptPath: join(root, 'subagents', 'agent-ab12cd.jsonl'), lastAssistantMessage: 'done', seams }),
      );
      expect(result.subagent).toBe(true);
      expect(result.receipt).toBeNull();
      expect(result.files).toBeNull();
      expect(fn).not.toHaveBeenCalled();
      expect(fs.existsSync(join(env.home, 'last'))).toBe(false);
    }));

  it('a present agent_id is a subagent stop even for a normal transcript path', () =>
    withTempDir(async (root) => {
      const env = makeEnv(root);
      const t = cc();
      pushTurn(t, 1);
      const path = writeCc(root, t);
      const { fn, seams } = spyWriter();
      const result = await buildStopReceipt(input(env, { transcriptPath: path, agentId: 'agent-1', seams }));
      expect(result.subagent).toBe(true);
      expect(result.receipt).toBeNull();
      expect(fn).not.toHaveBeenCalled();
    }));

  it('a first record carrying agentId is a subagent stop', () =>
    withTempDir(async (root) => {
      const env = makeEnv(root);
      const path = join(root, 'main.jsonl');
      fs.writeFileSync(path, `${JSON.stringify({ agentId: 'ab12', type: 'user' })}\n`);
      const { fn, seams } = spyWriter();
      const result = await buildStopReceipt(input(env, { transcriptPath: path, seams }));
      expect(result.subagent).toBe(true);
      expect(fn).not.toHaveBeenCalled();
    }));
});

describe('receipt files (§9, through S27 receipt-files.ts)', () => {
  it('lands in <gitRoot>/.showreceipts when the hook cwd is inside a worktree', () =>
    withTempDir(async (root) => {
      const env = makeEnv(root);
      fs.mkdirSync(join(env.cwd, '.git'));
      const t = cc();
      pushTurn(t, 1);
      const path = writeCc(root, t);
      const result = await buildStopReceipt(
        input(env, { transcriptPath: path, lastAssistantMessage: 'done with request 1', seams: fakeSleep() }),
      );
      expect(result.files?.dir).toBe(join(env.cwd, '.showreceipts'));
      expect(fs.existsSync(result.files?.mdPath ?? '')).toBe(true);
      expect(fs.existsSync(result.files?.jsonPath ?? '')).toBe(true);
    }));

  it('lands in <home>/last/<harness>/ outside a repo, one receipts.log line per Stop', () =>
    withTempDir(async (root) => {
      const env = makeEnv(root);
      const t = cc();
      pushTurn(t, 1);
      const path = writeCc(root, t);
      const args = input(env, { transcriptPath: path, lastAssistantMessage: 'done with request 1', seams: fakeSleep() });
      const first = await buildStopReceipt(args);
      expect(first.files?.dir).toBe(join(env.home, 'last', 'claude-code'));
      await buildStopReceipt(args);
      const log = fs.readFileSync(join(env.home, 'receipts.log'), 'utf8');
      expect(log.split('\n').filter((line) => line !== '')).toHaveLength(2);
    }));
});

describe('incremental parse (S27b: lookupByPath + resumeSession)', () => {
  it('resumes from entry.bytesParsed, advances it, and matches a cold parse', async () => {
    const root = makeTempDir('sr-stop-inc-');
    try {
      const env = makeEnv(root);
      const t = cc();
      pushTurn(t, 1);
      const path = writeCc(root, t);
      const first = await buildStopReceipt(
        input(env, { transcriptPath: path, lastAssistantMessage: 'done with request 1', seams: fakeSleep() }),
      );
      expect(first.receipt).not.toBeNull();
      const cache = createCache({ dir: join(env.home, 'cache'), toolVersion: TOOL_VERSION });
      const entry1 = cache.lookupByPath(path);
      if (entry1 === null) throw new Error('first Stop stored no cache entry');
      expect(entry1.bytesParsed).toBeGreaterThan(0);
      expect(typeof entry1.builderState).toBe('string');

      // 50 appended lines: 12 four-line turns + a final human/assistant pair.
      const before = t.lineCount();
      for (let n = 2; n <= 13; n += 1) pushTurn(t, n);
      t.human('wrap up', { promptId: 'p-last' });
      t.assistant({ text: 'all wrapped up', stop: 'end_turn' });
      expect(t.lineCount() - before).toBe(50);
      fs.writeFileSync(path, ccText(t));

      const resumeSpy = vi.fn(resumeSession);
      const second = await buildStopReceipt(
        input(env, {
          transcriptPath: path,
          lastAssistantMessage: 'all wrapped up',
          seams: { ...fakeSleep(), resumeClaudeCode: resumeSpy },
        }),
      );
      expect(resumeSpy).toHaveBeenCalledTimes(1);
      expect(resumeSpy.mock.calls[0]?.[1]?.bytesParsed).toBe(entry1.bytesParsed);
      const entry2 = cache.lookupByPath(path);
      if (entry2 === null) throw new Error('second Stop stored no cache entry');
      expect(entry2.bytesParsed).toBeGreaterThan(entry1.bytesParsed);

      // The warm receipt equals a cold parse's, byte for byte.
      const coldEnv = makeEnv(join(root, 'cold'));
      const cold = await buildStopReceipt(
        input({ home: coldEnv.home, cwd: env.cwd }, { transcriptPath: path, lastAssistantMessage: 'all wrapped up', noCache: true, seams: fakeSleep() }),
      );
      expect(stableStringify(second.receipt)).toBe(stableStringify(cold.receipt));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('codex stops (§9 Codex row)', () => {
  const SID = TEST_SESSION_ID;

  function writeRollout(codexHome: string, lines: readonly string[], base = 'sessions'): string {
    const path = join(codexHome, base, '2026', '03', '02', `rollout-2026-03-02T10-00-00-${SID}.jsonl`);
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, `${lines.join('\n')}\n`);
    return path;
  }

  function flushedLines(finalText: string): string[] {
    return [
      sessionMeta(),
      userMessage('please fix the tests'),
      fnCall('exec_command', { cmd: 'npm test' }, 'c1'),
      fnOut('c1', unifiedOutput({ exit: 1, body: '1 failing' })),
      agentMessage(finalText),
      assistantItem(finalText),
      tokenCount({ input: 10, cached: 0, output: 5 }),
    ];
  }

  it('locates the rollout by -<session_id>.jsonl suffix and detects the flushed tail', () =>
    withTempDir(async (root) => {
      const env = makeEnv(root);
      const codexHome = join(root, 'codex');
      writeRollout(codexHome, flushedLines('Tests pass.'));
      const { sleep, sleeps } = fakeSleep();
      const result = await buildStopReceipt(
        input(env, { harness: 'codex', sessionId: SID, transcriptPath: null, codexHome, lastAssistantMessage: 'Tests pass.', seams: { sleep } }),
      );
      expect(sleeps).toEqual([]);
      expect(result.incompleteAtStop).toBe(false);
      expect(result.receipt?.finalText).toBe('Tests pass.');
      expect(result.receipt?.harness).toBe('codex');
    }));

  it('searches archived_sessions too', () =>
    withTempDir(async (root) => {
      const env = makeEnv(root);
      const codexHome = join(root, 'codex');
      writeRollout(codexHome, flushedLines('Tests pass.'), 'archived_sessions');
      const result = await buildStopReceipt(
        input(env, { harness: 'codex', sessionId: SID, transcriptPath: null, codexHome, lastAssistantMessage: 'Tests pass.', seams: fakeSleep() }),
      );
      expect(result.receipt).not.toBeNull();
    }));

  it('a missing token_count tail re-reads then flags incompleteAtStop with the usage note', () =>
    withTempDir(async (root) => {
      const env = makeEnv(root);
      const codexHome = join(root, 'codex');
      const path = writeRollout(codexHome, [sessionMeta(), userMessage('please fix'), agentMessage('Tests pass.')]);
      const { sleep, sleeps } = fakeSleep();
      const result = await buildStopReceipt(
        input(env, { harness: 'codex', sessionId: SID, transcriptPath: path, lastAssistantMessage: 'Tests pass.', seams: { sleep } }),
      );
      expect(sleeps).toEqual([REREAD_DELAY_MS, REREAD_DELAY_MS, REREAD_DELAY_MS]);
      expect(result.incompleteAtStop).toBe(true);
      expect(result.receipt?.incompleteAtStop).toBe(true);
      expect(result.receipt?.finalTextSource).toBe('stop-hook');
      expect(result.receipt?.cost.notes).toContain(CODEX_USAGE_NOTE);
      expect(result.receipt?.ledgerNote).toContain(STALE_NOTE);
    }));
});
