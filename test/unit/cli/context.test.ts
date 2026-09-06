/**
 * Closing-review regression (Pass 1): a malformed `SHOWRECEIPTS_NOW` used to
 * throw inside `createContext` — BEFORE the hook runtime loaded — so every
 * hook invocation silently recorded nothing ({} exit 0, no ledger line, no
 * hook.log). The hook now falls back to the wall clock; every other command
 * keeps the exit-2 contract.
 */
import { describe, expect, it } from 'vitest';
import type { ParsedArgs } from '../../../src/cli/args.js';
import { UsageError } from '../../../src/cli/args.js';
import { resolveNow } from '../../../src/cli/context.js';

function args(command: ParsedArgs['command']): ParsedArgs {
  return { command, commandGiven: true, positionals: [], flags: {}, unknown: [] };
}

describe('resolveNow with a malformed SHOWRECEIPTS_NOW', () => {
  const env = { SHOWRECEIPTS_NOW: 'not-a-date' };

  it('the hook falls back to the injected clock instead of dying', () => {
    const fallback = new Date('2026-08-29T12:00:00Z');
    expect(resolveNow(args('hook'), env, fallback)).toBe(fallback);
  });

  it('the hook falls back to the wall clock when nothing is injected', () => {
    const before = Date.now();
    const now = resolveNow(args('hook'), env).getTime();
    expect(now).toBeGreaterThanOrEqual(before - 1000);
    expect(now).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('every other command still raises the exit-2 usage error', () => {
    expect(() => resolveNow(args('audit'), env)).toThrow(UsageError);
    expect(() => resolveNow(args('session'), env)).toThrow(/SHOWRECEIPTS_NOW/);
  });

  it('a valid SHOWRECEIPTS_NOW still wins for the hook', () => {
    const now = resolveNow(args('hook'), { SHOWRECEIPTS_NOW: '2026-08-29T12:00:00Z' });
    expect(now.toISOString()).toBe('2026-08-29T12:00:00.000Z');
  });
});
