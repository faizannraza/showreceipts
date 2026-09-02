import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { loadPriceTable, PriceTableError, type PriceTable } from '../../../src/cost/resolve.js';
import { mergeTables, parsePriceTable, validateTable } from '../../../src/cost/validate.js';

const base = loadPriceTable();

function fixture(name: string): string {
  return readFileSync(new URL(`../../../fixtures/prices/${name}`, import.meta.url), 'utf8');
}

const ROW = { provider: 'openai', verified: false, confidence: 'estimate', source: 'test' };
const RATE = { from: null, until: null, input: 1, output: 2 };

describe('parsePriceTable / validateTable (§8.1 exact messages)', () => {
  it('reports invalid JSON with a line number', () => {
    expect(() => parsePriceTable('{\n  "unit": nope\n}', 'x.json')).toThrow(PriceTableError);
    expect(() => parsePriceTable('{\n  "unit": nope\n}', 'x.json')).toThrow(/^prices: x\.json: not valid JSON \(line \d+\)$/);
  });

  it('rejects a non-object table and a non-object models map', () => {
    expect(() => validateTable('[]', 'x.json')).toThrow('prices: x.json: expected an object');
    expect(() => validateTable({ models: 3 }, 'x.json')).toThrow('prices: x.json: "models" must be an object');
  });

  it('rejects an unsupported unit', () => {
    expect(() => validateTable({ unit: 'eur_per_token', models: {} }, 'x.json')).toThrow(
      'prices: unsupported unit "eur_per_token" (expected usd_per_million_tokens)',
    );
  });

  it('rejects a missing alias target', () => {
    expect(() => validateTable({ models: { a: { ...ROW, aliasOf: 'zzz' } } }, 'x.json')).toThrow(
      'prices: models["a"].aliasOf "zzz" not found',
    );
  });

  it('rejects an alias cycle with the chain in the message (fixture)', () => {
    expect(() => parsePriceTable(fixture('alias-cycle.json'), 'alias-cycle.json')).toThrow('prices: alias cycle a → b → a');
  });

  it('rejects an alias chain deeper than 3', () => {
    const models = {
      a: { ...ROW, aliasOf: 'b' },
      b: { ...ROW, aliasOf: 'c' },
      c: { ...ROW, aliasOf: 'd' },
      d: { ...ROW, aliasOf: 'e' },
      e: { ...ROW, rates: [RATE] },
    };
    expect(() => validateTable({ models }, 'x.json')).toThrow('prices: models["a"]: alias chain exceeds depth 3');
  });

  it('rejects an invalid regex row', () => {
    expect(() => validateTable({ models: { '[': { ...ROW, match: 'regex', unpriced: true } } }, 'x.json')).toThrow(
      /^prices: models\["\["\]: invalid regex: /,
    );
  });

  it('rejects a negative rate with the exact message (fixture)', () => {
    expect(() => parsePriceTable(fixture('override-invalid.json'), 'override-invalid.json')).toThrow(
      'prices: models["bad-model"].rates[0].input must be a finite number ≥ 0',
    );
  });

  it('rejects a malformed window date', () => {
    const models = { m: { ...ROW, rates: [{ ...RATE, from: '2026-13-01' }] } };
    expect(() => validateTable({ models }, 'x.json')).toThrow('prices: models["m"].rates[0].from must be YYYY-MM-DD or null');
  });

  it('rejects a bad tier threshold', () => {
    const models = { m: { ...ROW, rates: [RATE], tiers: [{ aboveInputTokens: 0, input: 1, output: 2 }] } };
    expect(() => validateTable({ models }, 'x.json')).toThrow(
      'prices: models["m"].tiers[0].aboveInputTokens must be a finite number > 0',
    );
  });

  it('rejects a bad off-peak range', () => {
    const models = { m: { ...ROW, rates: [RATE], windows: [{ utc: '16:30', input: 1, output: 2 }] } };
    expect(() => validateTable({ models }, 'x.json')).toThrow('prices: models["m"].windows[0].utc must be HH:MM-HH:MM');
  });

  it('rejects a bad speed entry', () => {
    const models = { m: { ...ROW, rates: [RATE], speeds: { fast: { input: 1 } } } };
    expect(() => validateTable({ models }, 'x.json')).toThrow('prices: models["m"].speeds["fast"].output must be a finite number ≥ 0');
  });

  it('rejects an unknown provider, match and confidence', () => {
    expect(() => validateTable({ models: { m: { ...ROW, provider: 'acme', rates: [RATE] } } }, 'x.json')).toThrow(
      'prices: models["m"].provider must be one of anthropic|openai|google|xai|deepseek|mistral',
    );
    expect(() => validateTable({ models: { m: { ...ROW, match: 'glob', rates: [RATE] } } }, 'x.json')).toThrow(
      'prices: models["m"].match must be one of exact|prefix|regex',
    );
    expect(() => validateTable({ models: { m: { ...ROW, confidence: 'high', rates: [RATE] } } }, 'x.json')).toThrow(
      'prices: models["m"].confidence must be one of verified|inferred|estimate',
    );
  });

  it('rejects a row with neither rates, aliasOf nor unpriced', () => {
    expect(() => validateTable({ models: { m: { ...ROW } } }, 'x.json')).toThrow('prices: models["m"] must have rates, aliasOf or unpriced');
  });

  it('rejects bad defaults', () => {
    expect(() => validateTable({ defaults: { acme: {} }, models: {} }, 'x.json')).toThrow('prices: defaults["acme"] is not a known provider');
    expect(() => validateTable({ defaults: { openai: { cacheRead: -1 } }, models: {} }, 'x.json')).toThrow(
      'prices: defaults["openai"].cacheRead must be a finite number ≥ 0',
    );
  });

  it('accepts the valid override fixture and an alias into the base table', () => {
    const override = parsePriceTable(fixture('override-valid.json'), 'override-valid.json', base);
    expect(Object.keys(override.models)).toContain('acme-lm-1');
    expect(() => validateTable({ models: { mine: { ...ROW, aliasOf: 'gpt-5.2' } } }, 'x.json', base)).not.toThrow();
  });

  it('accepts the bundled table', () => {
    const raw: unknown = JSON.parse(readFileSync(new URL('../../../src/cost/prices.json', import.meta.url), 'utf8'));
    expect(() => validateTable(raw, 'src/cost/prices.json')).not.toThrow();
  });
});

describe('mergeTables (§8.1)', () => {
  const override = parsePriceTable(fixture('override-valid.json'), 'override-valid.json', base);

  it('override rows replace base rows by key and new rows are added', () => {
    const merged = mergeTables(base, override);
    const gpt52 = merged.models['gpt-5.2'];
    expect(gpt52?.rates?.[0]?.input).toBe(1);
    expect(merged.models['acme-lm-1']).toBeDefined();
    expect(merged.models['claude-fable-5']).toBeDefined();
  });

  it('stamps version = base.version + "+" + sha256(override)[:8], deterministically', () => {
    const a = mergeTables(base, override);
    const b = mergeTables(base, override);
    expect(a.version).toMatch(/^2026-08-29\+[0-9a-f]{8}$/);
    expect(a.version).toBe(b.version);
    expect(a.overrideHash).toHaveLength(8);
    expect(a.version.endsWith(a.overrideHash as string)).toBe(true);
  });

  it('merges provider defaults per field', () => {
    const o: PriceTable = { version: 'override', unit: 'usd_per_million_tokens', defaults: { anthropic: { cacheRead: 0.2 } }, models: {} };
    const merged = mergeTables(base, o);
    expect(merged.defaults.anthropic?.cacheRead).toBe(0.2);
    expect(merged.defaults.anthropic?.cacheWrite5m).toBe(1.25);
  });

  it('re-checks alias cycles over the merged model set', () => {
    const o = validateTable(
      { models: { 'loop-a': { ...ROW, aliasOf: 'loop-b' }, 'loop-b': { ...ROW, rates: [RATE] } } },
      'o.json',
    );
    const cyclic: PriceTable = {
      ...o,
      models: { ...o.models, 'loop-b': { provider: 'openai', aliasOf: 'loop-a', verified: false, confidence: 'estimate', source: 'test' } },
    };
    expect(() => mergeTables(base, cyclic)).toThrow(/^prices: alias cycle loop-/);
  });
});
