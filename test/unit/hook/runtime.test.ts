/**
 * S27/W5 close — the runtime's exactly-once counter flush and the in-process
 * exit seam: when the watchdog fires and the injected `exit` does not
 * terminate (the in-process caller contract, `commands/hook.ts`), the budget
 * answer `{}` is still the only stdout write and the counter delta is folded
 * into `counters.json` exactly once — never re-folded by the `finally` flush
 * when the stuck handler eventually settles.
 */
import fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Dialect } from '../../../src/hook/dialect.js';
import { EVENT_BUDGET_MS, runHook } from '../../../src/hook/runtime.js';
import { makeTempDir } from '../../helpers/tmp.js';

const T = '2026-08-29T12:00:00.000Z';
const dirs: string[] = [];

function tempDir(): string {
  const dir = makeTempDir('sr-hook-runtime-');
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A dialect whose handler outlives its `session` budget by 500 ms. */
const slow: Dialect = {
  harness: 'gemini',
  events: { Ping: 'session' },
  parse: (event, input) => ({
    event,
    eventClass: 'session',
    input: typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {},
    sid: 's1',
  }),
  handle: () =>
    new Promise((resolve) => {
      setTimeout(() => {
        resolve({ stdout: { late: true } });
      }, EVENT_BUDGET_MS.session + 500);
    }),
};

describe('runHook watchdog with an in-process (non-terminating) exit seam', () => {
  it('answers {} once and folds the counter delta into counters.json exactly once', async () => {
    vi.useFakeTimers();
    const home = tempDir();
    const writes: string[] = [];
    const exits: number[] = [];
    const promise = runHook(
      { positionals: ['gemini', 'Ping'], flags: {} },
      { env: { SHOWRECEIPTS_HOME: home }, cwd: '/x', now: new Date(T) },
      { gemini: slow },
      {
        stdin: { json: {}, salvage: {}, bytes: 0, overflow: false },
        write: (text) => {
          writes.push(text);
        },
        exit: (code) => {
          exits.push(code);
        },
      },
    );
    // The watchdog fires at the session budget: `{}` + counter flush + exit(0).
    await vi.advanceTimersByTimeAsync(EVENT_BUDGET_MS.session);
    // The stuck handler settles 500 ms later; `finally` must fold nothing new.
    await vi.advanceTimersByTimeAsync(500);
    expect(await promise).toBe(0);
    expect(writes).toEqual(['{}\n']); // the late stdout was suppressed
    expect(exits).toEqual([0]); // the seam absorbed it; process.exit untouched
    const counters = JSON.parse(fs.readFileSync(join(home, 'state', 'counters.json'), 'utf8')) as Record<string, number>;
    expect(counters['invocations']).toBe(1);
    expect(counters['stopBudgetExceeded']).toBe(1);
  });
});
