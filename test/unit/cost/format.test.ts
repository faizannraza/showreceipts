import { describe, expect, it } from 'vitest';

import { formatPct, formatUsd } from '../../../src/cost/format.js';

describe('formatUsd (§8.3)', () => {
  it('null → n/a (hook-captured sessions)', () => {
    expect(formatUsd(null)).toBe('n/a');
    expect(formatUsd(Number.NaN)).toBe('n/a');
  });

  it('0 → $0.00', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0, true)).toBe('≈$0.00');
  });

  it('< 0.01 → four decimals', () => {
    expect(formatUsd(0.0042)).toBe('$0.0042');
    expect(formatUsd(0.004249)).toBe('$0.0042');
  });

  it('< 1000 → two decimals', () => {
    expect(formatUsd(18.42)).toBe('$18.42');
    expect(formatUsd(0.01)).toBe('$0.01');
  });

  it('≥ 1000 → whole dollars with thousands separators', () => {
    expect(formatUsd(1204.42)).toBe('$1,204');
    expect(formatUsd(1204567)).toBe('$1,204,567');
  });

  it('≈ prefixes when unverified: the §8.3 receipt pin', () => {
    expect(formatUsd(0.068394, true)).toBe('≈$0.07');
    expect(formatUsd(1204.42, true)).toBe('≈$1,204');
  });
});

describe('formatPct', () => {
  it('rounds to whole percent', () => {
    expect(formatPct(87.23)).toBe('87%');
    expect(formatPct(87.5)).toBe('88%');
    expect(formatPct(0)).toBe('0%');
  });

  it('null → n/a', () => {
    expect(formatPct(null)).toBe('n/a');
    expect(formatPct(Number.NaN)).toBe('n/a');
  });
});
