/**
 * S08: `token_count` accounting (§4.3.5) — delta-of-totals, duplicate
 * skipping, counter resets, and the delta → `UsageTotals` aggregation.
 * `last_token_usage` is never summed; it rides along per delta.
 */
import { describe, expect, it } from 'vitest';
import type { TokenDelta } from '../../../../src/model/types.js';
import { TokenTracker, usageFromDeltas } from '../../../../src/readers/codex/tokens.js';

const at = (seq: number, over: Partial<Parameters<TokenTracker['feed']>[1]> = {}): Parameters<TokenTracker['feed']>[1] => ({
  seq,
  ts: '2026-03-02T10:00:00.000Z',
  model: 'gpt-5.2-codex',
  turnIndex: 0,
  lastInput: null,
  ...over,
});

describe('TokenTracker', () => {
  it('computes the first delta from zeros', () => {
    const t = new TokenTracker();
    const r = t.feed({ input: 100, cached: 40, output: 9, reasoning: 2 }, at(1, { lastInput: 100 }));
    expect(r.duplicate).toBe(false);
    expect(r.reset).toBe(false);
    expect(r.delta).toMatchObject({ seq: 1, input: 100, cached: 40, output: 9, reasoning: 2, lastInput: 100, turnIndex: 0 });
  });

  it('skips exact duplicate totals as zero-delta (not an API call)', () => {
    const t = new TokenTracker();
    t.feed({ input: 100, cached: 40, output: 9, reasoning: 2 }, at(1));
    const r = t.feed({ input: 100, cached: 40, output: 9, reasoning: 2 }, at(2));
    expect(r.duplicate).toBe(true);
    expect(r.delta).toBeNull();
    // The next real event still deltas against the same baseline.
    const r3 = t.feed({ input: 150, cached: 60, output: 12, reasoning: 2 }, at(3));
    expect(r3.delta).toMatchObject({ input: 50, cached: 20, output: 3, reasoning: 0 });
  });

  it('resets to zeros when any total goes backwards (resume), then deltas normally', () => {
    const t = new TokenTracker();
    t.feed({ input: 100, cached: 40, output: 9, reasoning: 0 }, at(1));
    const r = t.feed({ input: 30, cached: 10, output: 2, reasoning: 0 }, at(2));
    expect(r.reset).toBe(true);
    expect(r.delta).toMatchObject({ input: 30, cached: 10, output: 2 });
    const r3 = t.feed({ input: 40, cached: 12, output: 3, reasoning: 0 }, at(3));
    expect(r3.reset).toBe(false);
    expect(r3.delta).toMatchObject({ input: 10, cached: 2, output: 1 });
  });

  it('resets when only one counter regresses (reasoning included)', () => {
    const t = new TokenTracker();
    t.feed({ input: 100, cached: 40, output: 9, reasoning: 5 }, at(1));
    const r = t.feed({ input: 120, cached: 50, output: 12, reasoning: 4 }, at(2));
    expect(r.reset).toBe(true);
    expect(r.delta).toMatchObject({ input: 120, cached: 50, output: 12, reasoning: 4 });
  });

  it('carries lastInput per delta without summing it', () => {
    const t = new TokenTracker();
    const a = t.feed({ input: 100, cached: 0, output: 1, reasoning: 0 }, at(1, { lastInput: 100 }));
    const b = t.feed({ input: 300, cached: 0, output: 2, reasoning: 0 }, at(2, { lastInput: 200 }));
    expect(a.delta?.lastInput).toBe(100);
    expect(b.delta?.lastInput).toBe(200); // never 300, never a sum
  });
});

describe('usageFromDeltas', () => {
  const d = (over: Partial<TokenDelta>): TokenDelta => ({
    seq: 0,
    ts: '2026-03-02T10:00:00.000Z',
    model: 'gpt-5.2-codex',
    input: 0,
    cached: 0,
    output: 0,
    reasoning: 0,
    turnIndex: 0,
    lastInput: null,
    ...over,
  });

  it('splits cached from input, mirrors reasoning into thinking, and counts calls', () => {
    const totals = usageFromDeltas([
      d({ input: 100, cached: 40, output: 10, reasoning: 3 }),
      d({ input: 50, cached: 10, output: 5, reasoning: 0 }),
    ]);
    expect(totals.input).toBe(100); // (100-40) + (50-10)
    expect(totals.cacheRead).toBe(50);
    expect(totals.output).toBe(15);
    expect(totals.thinking).toBe(3);
    expect(totals.calls).toBe(2);
  });

  it('breaks totals down by model', () => {
    const totals = usageFromDeltas([
      d({ model: 'gpt-5.2-codex', input: 10, cached: 0, output: 1 }),
      d({ model: 'gpt-5.6-sol', input: 20, cached: 5, output: 2 }),
    ]);
    expect(totals.byModel['gpt-5.2-codex']?.output).toBe(1);
    expect(totals.byModel['gpt-5.6-sol']?.input).toBe(15);
    expect(totals.byModel['gpt-5.6-sol']?.cacheRead).toBe(5);
  });

  it('returns an empty shape for no deltas', () => {
    const totals = usageFromDeltas([]);
    expect(totals.calls).toBe(0);
    expect(totals.byModel).toEqual({});
  });
});
