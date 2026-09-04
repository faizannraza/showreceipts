/**
 * S29 — `hook/ledger-stop.ts` (§9 "Ledger stops"): the race guard with a
 * fake clock (missing-tid evidence and the 100 ms mtime window both retry,
 * 150 ms × 3), `ledgerNote: 'stop raced a tool event'` when the race never
 * settles, receipt files written through S27 `receipt-files.ts` (spy),
 * `cost.usd: null`, and the no-home path that builds from pending lines
 * alone and writes nothing.
 */
import fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HookContext } from '../../../src/hook/dialect.js';
import { RACE_RETRIES, RACE_RETRY_DELAY_MS, RACED_NOTE, runLedgerStop, type LedgerStopSeams } from '../../../src/hook/ledger-stop.js';
import type { ReceiptFilesResult } from '../../../src/hook/receipt-files.js';
import type { LedgerLine } from '../../../src/model/types.js';
import { makeTempDir } from '../../helpers/tmp.js';

type WriteFilesFn = NonNullable<LedgerStopSeams['writeFiles']>;

const T = '2026-08-29T12:00:00.000Z';
const dirs: string[] = [];

function tempDir(): string {
  const dir = makeTempDir('sr-lstop-');
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeCtx(home: string, cwd = '/work/proj'): HookContext {
  return {
    harness: 'cursor',
    event: 'stop',
    eventClass: 'stop',
    now: new Date(T),
    home,
    cwd,
    env: { HOME: '/home/u' },
    flags: { strict: false, strictMax: 1, strictReasons: [], forceRecord: false, verbose: false, debug: false, noCache: false, tz: 'local' },
    salvage: {},
    stdinBytes: 0,
    overflow: false,
    debug: () => undefined,
  };
}

const agentResponse = (tid: string, text: string): string =>
  `${JSON.stringify({ v: 1, t: T, h: 'cursor', e: 'agent-response', sid: 's1', tid, text })}\n`;

function stopLine(text?: string): LedgerLine {
  const line: LedgerLine = { v: 1, t: T, h: 'cursor', e: 'stop', sid: 's1', tid: 'g1', status: 'completed' };
  if (text !== undefined) line.text = text;
  return line;
}

/** A fake receipt-files writer that records its inputs and touches nothing. */
function fakeWriter(): { fn: ReturnType<typeof vi.fn>; result: ReceiptFilesResult } {
  const result: ReceiptFilesResult = { dir: '/x', mdPath: '/x/last-receipt.md', jsonPath: '/x/last-receipt.json', logPath: '/x/receipts.log' };
  return { fn: vi.fn(() => result), result };
}

/** Seams with a fully fake clock: `sleep` advances `monotonicMs`, nothing waits. */
function fakeClockSeams(over: Partial<LedgerStopSeams> & { startMs?: number; mtime?: number }): {
  seams: LedgerStopSeams;
  sleeps: number[];
} {
  const sleeps: number[] = [];
  let nowMs = over.startMs ?? 10_000;
  const seams: LedgerStopSeams = {
    mtimeMs: () => over.mtime ?? 0,
    monotonicMs: () => nowMs,
    sleep: (ms: number): Promise<void> => {
      sleeps.push(ms);
      nowMs += ms;
      return Promise.resolve();
    },
    writeFiles: fakeWriter().fn as unknown as WriteFilesFn,
    ...over,
  };
  return { seams, sleeps };
}

describe('runLedgerStop race guard (fake clock)', () => {
  it('re-reads after 150 ms until the turn evidence appears', async () => {
    let reads = 0;
    const { seams, sleeps } = fakeClockSeams({
      readLedgerText: () => {
        reads += 1;
        return reads >= 3 ? agentResponse('g1', 'Done.') : '';
      },
    });
    const result = await runLedgerStop({ ctx: makeCtx(tempDir()), sid: 's1', tid: 'g1', pendingLines: [stopLine()], seams });
    expect(sleeps).toEqual([RACE_RETRY_DELAY_MS, RACE_RETRY_DELAY_MS]);
    expect(reads).toBe(3);
    expect(result.raced).toBe(false);
    expect(result.receipt.ledgerNote).toBeUndefined();
    expect(result.receipt.finalText).toBe('Done.');
  });

  it(`gives up after ${RACE_RETRIES} re-reads and renders with ledgerNote '${RACED_NOTE}'`, async () => {
    const { seams, sleeps } = fakeClockSeams({ readLedgerText: () => '' });
    const result = await runLedgerStop({ ctx: makeCtx(tempDir()), sid: 's1', tid: 'g1', pendingLines: [stopLine('All done.')], seams });
    expect(sleeps).toEqual([RACE_RETRY_DELAY_MS, RACE_RETRY_DELAY_MS, RACE_RETRY_DELAY_MS]);
    expect(result.raced).toBe(true);
    expect(result.receipt.ledgerNote).toBe(RACED_NOTE);
    // the receipt still renders from the pending stop line
    expect(result.receipt.finalText).toBe('All done.');
  });

  it('a ledger mtime inside the 100 ms window counts as racing until the window passes', async () => {
    const { seams, sleeps } = fakeClockSeams({
      readLedgerText: () => agentResponse('g1', 'Done.'),
      startMs: 1_000,
      mtime: 990, // 10 ms ago: racing; after one 150 ms wait it is 160 ms ago
    });
    const result = await runLedgerStop({ ctx: makeCtx(tempDir()), sid: 's1', tid: 'g1', pendingLines: [stopLine()], seams });
    expect(sleeps).toEqual([RACE_RETRY_DELAY_MS]);
    expect(result.raced).toBe(false);
    expect(result.receipt.ledgerNote).toBeUndefined();
  });

  it('without a tid only the mtime window can race', async () => {
    const { seams, sleeps } = fakeClockSeams({ readLedgerText: () => '' });
    const result = await runLedgerStop({ ctx: makeCtx(tempDir()), sid: 's1', pendingLines: [stopLine('Done.')], seams });
    expect(sleeps).toEqual([]);
    expect(result.raced).toBe(false);
  });
});

describe('runLedgerStop receipt and files', () => {
  it('writes the receipt files through receipt-files.ts (spy) with the §9 inputs', async () => {
    const home = tempDir();
    const cwd = tempDir();
    const writer = fakeWriter();
    const { seams } = fakeClockSeams({
      readLedgerText: () => agentResponse('g1', 'Done.'),
      writeFiles: writer.fn as unknown as WriteFilesFn,
    });
    const result = await runLedgerStop({ ctx: makeCtx(home, cwd), sid: 's1', tid: 'g1', pendingLines: [stopLine()], seams });
    expect(writer.fn).toHaveBeenCalledTimes(1);
    const call = writer.fn.mock.calls[0]?.[0] as { receipt: unknown; cwd: string; home: string; harness: string; safeSid: string };
    expect(call.receipt).toBe(result.receipt);
    expect(call.cwd).toBe(cwd);
    expect(call.home).toBe(home);
    expect(call.harness).toBe('cursor');
    expect(call.safeSid).toBe('s1');
    expect(result.files).toBe(writer.result);
  });

  it('builds a ledger receipt with cost.usd null', async () => {
    const { seams } = fakeClockSeams({ readLedgerText: () => agentResponse('g1', 'Done.') });
    const result = await runLedgerStop({ ctx: makeCtx(tempDir()), sid: 's1', tid: 'g1', pendingLines: [stopLine()], seams });
    expect(result.receipt.source).toBe('ledger');
    expect(result.receipt.cost.usd).toBeNull();
    expect(result.receipt.cost.pricesVersion).not.toBe('');
    expect(result.receipt.harness).toBe('cursor');
  });

  it('with no home it builds from the pending lines alone and writes nothing', async () => {
    const writer = fakeWriter();
    const read = vi.fn(() => null);
    const result = await runLedgerStop({
      ctx: makeCtx(''),
      sid: 's1',
      pendingLines: [stopLine('Wrapped up.')],
      seams: { readLedgerText: read, writeFiles: writer.fn as unknown as WriteFilesFn, sleep: () => Promise.resolve() },
    });
    expect(read).not.toHaveBeenCalled();
    expect(writer.fn).not.toHaveBeenCalled();
    expect(result.files).toBeNull();
    expect(result.receipt.finalText).toBe('Wrapped up.');
  });

  it('a stop with no recoverable final text is effects-only', async () => {
    const { seams } = fakeClockSeams({ readLedgerText: () => '' });
    const result = await runLedgerStop({ ctx: makeCtx(tempDir()), sid: 's1', pendingLines: [stopLine()], seams });
    expect(result.effectsOnly).toBe(true);
    expect(result.receipt.finalText).toBe('');
  });

  it('pending lines pass the Appendix C writer preparation (masking) before the receipt sees them', async () => {
    const { seams } = fakeClockSeams({ readLedgerText: () => '' });
    const secret = 'key sk-abcdefghijklmnopqrstuvwx used';
    const result = await runLedgerStop({ ctx: makeCtx(tempDir()), sid: 's1', pendingLines: [stopLine(`Done, ${secret}`)], seams });
    expect(result.receipt.finalText).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(result.receipt.finalText).toContain('«masked»');
  });
});
