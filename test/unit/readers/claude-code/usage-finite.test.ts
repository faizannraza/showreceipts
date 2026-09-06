/**
 * Closing-review regression (Pass 1): `JSON.parse("1e999")` is `Infinity`
 * and `isRawUsage` accepts it (`typeof Infinity === 'number'`), so a corrupt
 * usage row used to propagate Infinity through `bucketise` into the cost
 * engine — serialising as `"input": null` in `--json`, which violates the
 * receipt schema's non-nullable number. Every token bucket must degrade a
 * non-finite value to 0.
 */
import { describe, expect, it } from 'vitest';
import type { RawUsage } from '../../../../src/model/types.js';
import { buildUsageRow, type UsageGroupState } from '../../../../src/readers/claude-code/usage.js';

function group(usage: RawUsage): UsageGroupState {
  return { key: 'm1', requestId: null, model: 'claude-test-5', usage, completed: true, maxOut: 0, seq: 1, ts: '2026-02-10T10:00:00.000Z', agentId: null, groupIndex: 0 };
}

describe('bucketise finiteness guard', () => {
  it('Infinity input_tokens degrades to 0, finite fields survive', () => {
    const usage = {
      input_tokens: Number.POSITIVE_INFINITY,
      output_tokens: 42,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: Number.NEGATIVE_INFINITY },
    } as unknown as RawUsage;
    const row = buildUsageRow(group(usage), {});
    expect(row).not.toBeNull();
    const a = row?.attempts[0];
    expect(a?.in).toBe(0);
    expect(a?.out).toBe(42);
    expect(a?.rd).toBe(10);
    expect(a?.w5).toBe(3);
    expect(a?.w1).toBe(0);
    expect(Number.isFinite(row?.promptTokens ?? Number.NaN)).toBe(true);
  });

  it('NaN and non-number bucket values degrade to 0', () => {
    const usage = {
      input_tokens: Number.NaN,
      output_tokens: 5,
      cache_read_input_tokens: 'lots',
      cache_creation: null,
      cache_creation_input_tokens: Number.POSITIVE_INFINITY,
    } as unknown as RawUsage;
    const a = buildUsageRow(group(usage), {})?.attempts[0];
    expect(a?.in).toBe(0);
    expect(a?.rd).toBe(0);
    expect(a?.wU).toBe(0);
    expect(a?.out).toBe(5);
  });
});
