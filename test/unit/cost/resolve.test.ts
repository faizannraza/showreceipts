import { describe, expect, it } from 'vitest';

import {
  loadPriceTable,
  normalizeModelId,
  PriceTableError,
  resolveRates,
  type PriceRow,
  type PriceTable,
} from '../../../src/cost/resolve.js';
import { parseIso } from '../../../src/util/time.js';

const table = loadPriceTable();

function at(ts: string): number {
  const ms = parseIso(ts);
  if (ms === null) throw new Error(`bad ts ${ts}`);
  return ms;
}

function tiny(models: Record<string, PriceRow>): PriceTable {
  return { version: 'test', unit: 'usd_per_million_tokens', defaults: {}, models };
}

describe('normalizeModelId (§8.1)', () => {
  it('lowercases and trims', () => {
    expect(normalizeModelId(' Claude-Fable-5 ')).toEqual({ id: 'claude-fable-5' });
  });

  it('strips a trailing [1m] context marker', () => {
    expect(normalizeModelId('claude-fable-5[1m]')).toEqual({ id: 'claude-fable-5' });
  });

  it('strips a trailing -1m context marker', () => {
    expect(normalizeModelId('claude-fable-5-1m')).toEqual({ id: 'claude-fable-5' });
  });

  it('marks Bedrock ids unpriced', () => {
    expect(normalizeModelId('us.anthropic.claude-opus-5-20260801-v1:0').unpriced).toBe('partner pricing differs (Bedrock)');
    expect(normalizeModelId('anthropic.claude-3-5-sonnet-20241022-v2:0').unpriced).toBe('partner pricing differs (Bedrock)');
    expect(normalizeModelId('eu.anthropic.claude-opus-5-v1:0').unpriced).toBe('partner pricing differs (Bedrock)');
  });

  it('marks a Vertex @YYYYMMDD id unpriced and strips the suffix', () => {
    expect(normalizeModelId('claude-opus-5@20260801')).toEqual({ id: 'claude-opus-5', unpriced: 'partner pricing differs (Vertex AI)' });
  });
});

describe('lookup: exact → longest prefix → regex (§8.1)', () => {
  it('longest prefix wins: sonnet-4-5 goes to its own row, not claude-sonnet-4', () => {
    const r = resolveRates('claude-sonnet-4-5-20260101', at('2026-08-10T09:00:00Z'), { table });
    expect(r.rates.input).toBe(3);
    expect(r.meta.verified).toBe(true);
  });

  it('claude-opus-4-20250514 matches the claude-opus-4-2025 legacy prefix row', () => {
    const r = resolveRates('claude-opus-4-20250514', at('2026-08-10T09:00:00Z'), { table });
    expect(r.rates.input).toBe(15);
    expect(r.rates.output).toBe(75);
  });

  it('a dated variant of an exact row falls back to the undated id', () => {
    const r = resolveRates('gpt-4o-20240806', at('2026-08-10T09:00:00Z'), { table });
    expect(r.rates.input).toBe(2.5);
  });

  it('an unknown claude id falls to the ^claude- regex row and is unpriced', () => {
    const r = resolveRates('claude-unknown-9', at('2026-08-10T09:00:00Z'), { table });
    expect(r.meta.unpriced).toBe('unknown Claude model');
  });

  it('a fully unknown id is unpriced as not in the price table', () => {
    const r = resolveRates('frontier-x1', at('2026-08-10T09:00:00Z'), { table });
    expect(r.meta.unpriced).toBe('not in the price table');
    expect(r.meta.id).toBe('frontier-x1');
    expect(r.meta.approx).toBe(true);
  });
});

describe('codex regex aliases (§8.2, file order)', () => {
  const ts = at('2026-08-10T09:00:00Z');

  it('gpt-5-codex-mini ⇒ gpt-5-mini', () => {
    const r = resolveRates('gpt-5-codex-mini', ts, { table });
    expect(r.meta.aliasOf).toBe('gpt-5-mini');
    expect(r.rates.input).toBe(0.25);
    expect(r.meta.confidence).toBe('inferred');
  });

  it('gpt-5.2-codex-mini ⇒ gpt-5-mini (the -mini rule fires before the generic one)', () => {
    expect(resolveRates('gpt-5.2-codex-mini', ts, { table }).meta.aliasOf).toBe('gpt-5-mini');
  });

  it('gpt-5.2-codex ⇒ gpt-5.2 via $1 substitution', () => {
    const r = resolveRates('gpt-5.2-codex', ts, { table });
    expect(r.meta.aliasOf).toBe('gpt-5.2');
    expect(r.rates.input).toBe(1.75);
  });

  it('gpt-5.2-codex-max ⇒ gpt-5.2', () => {
    expect(resolveRates('gpt-5.2-codex-max', ts, { table }).meta.aliasOf).toBe('gpt-5.2');
  });

  it('gpt-5.6-codex-terra ⇒ gpt-5.6-terra', () => {
    const r = resolveRates('gpt-5.6-codex-terra', ts, { table });
    expect(r.meta.aliasOf).toBe('gpt-5.6-terra');
    expect(r.rates.input).toBe(2);
  });

  it('an unknown codex suffix stays unpriced (alias target missing)', () => {
    expect(resolveRates('gpt-5.9-codex', ts, { table }).meta.unpriced).toBe('not in the price table');
  });

  it('a static alias inherits the worse of inferred and the target confidence', () => {
    const r = resolveRates('deepseek-v4-pro', ts, { table });
    expect(r.meta.aliasOf).toBe('deepseek-chat');
    expect(r.meta.confidence).toBe('estimate');
    expect(r.rates.input).toBe(0.28);
  });
});

describe('alias cycles and depth (resolve-time, PriceTableError)', () => {
  const aliasRow = (target: string): PriceRow => ({ provider: 'openai', aliasOf: target, verified: false, confidence: 'inferred', source: 'test' });
  const ratesRow = (): PriceRow => ({
    provider: 'openai',
    rates: [{ from: null, until: null, input: 1, output: 2 }],
    verified: false,
    confidence: 'inferred',
    source: 'test',
  });

  it('throws on a cycle with the chain in the message', () => {
    const t = tiny({ a: aliasRow('b'), b: aliasRow('a') });
    expect(() => resolveRates('a', null, { table: t })).toThrow(PriceTableError);
    expect(() => resolveRates('a', null, { table: t })).toThrow('prices: alias cycle a → b → a');
  });

  it('throws when a chain exceeds depth 3', () => {
    const t = tiny({ a: aliasRow('b'), b: aliasRow('c'), c: aliasRow('d'), d: aliasRow('e'), e: ratesRow() });
    expect(() => resolveRates('a', null, { table: t })).toThrow(/alias chain exceeds depth 3/);
  });

  it('a depth-3 chain resolves', () => {
    const t = tiny({ a: aliasRow('b'), b: aliasRow('c'), c: ratesRow() });
    expect(resolveRates('a', null, { table: t }).rates.input).toBe(1);
  });
});

describe('windows, defaults, speeds and tiers', () => {
  it('reports the selected dated window in meta', () => {
    const r = resolveRates('gpt-5.6-terra', at('2026-08-10T09:00:00Z'), { table, asOf: '2026-07-15' });
    expect(r.meta.window).toEqual({ from: '2026-07-09', until: '2026-07-29' });
    expect(r.rates.input).toBe(2.5);
  });

  it('a null timestamp picks the open-ended current window', () => {
    const r = resolveRates('gpt-5.6-terra', null, { table });
    expect(r.rates.input).toBe(2);
    expect(r.meta.window).toEqual({ from: '2026-07-30', until: null });
  });

  it('anthropic cache rates derive from the input multipliers', () => {
    const r = resolveRates('claude-fable-5', at('2026-08-10T09:00:00Z'), { table });
    expect(r.rates.cacheRead).toBe(1);
    expect(r.rates.cacheWrite5m).toBe(12.5);
    expect(r.rates.cacheWrite1h).toBe(20);
    expect(r.rates.reasoning).toBe(50);
    expect(r.meta.verified).toBe(true);
    expect(r.meta.approx).toBe(false);
  });

  it('openai cache writes use cacheWriteMult × input; mistral has no cache-read price', () => {
    expect(resolveRates('gpt-5.2', null, { table }).rates.cacheWrite5m).toBe(1.75);
    expect(resolveRates('mistral-medium-latest', null, { table }).rates.cacheRead).toBeNull();
  });

  it('a priced speed recomputes cache rates from the speed input', () => {
    const r = resolveRates('claude-opus-5', at('2026-08-10T09:00:00Z'), { table, speed: 'fast' });
    expect(r.meta.speed).toBe('fast');
    expect(r.rates.input).toBe(10);
    expect(r.rates.cacheWrite1h).toBe(20);
    expect(r.meta.approx).toBe(false);
  });

  it('tier repricing sets meta.tier', () => {
    const r = resolveRates('gemini-2.5-pro', at('2026-08-10T09:00:00Z'), { table, promptTokens: 200001 });
    expect(r.meta.tier).toBe(200000);
    expect(r.rates.input).toBe(2.5);
    expect(r.rates.cacheRead).toBe(0.625);
  });

  it('the gpt-5.6 tier is an estimate and forces ≈ even beyond inferred', () => {
    const r = resolveRates('gpt-5.6-terra', at('2026-08-10T09:00:00Z'), { table, promptTokens: 300000 });
    expect(r.meta.tier).toBe(272000);
    expect(r.meta.confidence).toBe('estimate');
    expect(r.meta.approx).toBe(true);
  });

  it('off-peak boundaries: start inclusive, end exclusive, wraps midnight', () => {
    expect(resolveRates('deepseek-chat', at('2026-05-10T16:30:00Z'), { table }).meta.offPeak).toBe(true);
    expect(resolveRates('deepseek-chat', at('2026-05-10T16:29:59Z'), { table }).meta.offPeak).toBeUndefined();
    expect(resolveRates('deepseek-chat', at('2026-05-11T00:29:59Z'), { table }).meta.offPeak).toBe(true);
    expect(resolveRates('deepseek-chat', at('2026-05-11T00:30:00Z'), { table }).meta.offPeak).toBeUndefined();
  });

  it('an unpriced row keeps zero rates and a null window', () => {
    const r = resolveRates('codex-auto-review', at('2026-08-10T09:00:00Z'), { table });
    expect(r.meta.unpriced).toBe('not priced');
    expect(r.rates.input).toBe(0);
    expect(r.meta.window).toBeNull();
  });
});
