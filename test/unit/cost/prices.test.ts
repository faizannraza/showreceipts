import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { loadPriceTable } from '../../../src/cost/resolve.js';

const table = loadPriceTable();
const srcUrl = new URL('../../../src/cost/prices.json', import.meta.url);
const goldenUrl = new URL('../../../fixtures/prices/prices.golden.json', import.meta.url);

describe('prices.json provenance (§8.1, §8.2)', () => {
  it('has the pinned version and unit', () => {
    expect(table.version).toBe('2026-08-29');
    expect(table.unit).toBe('usd_per_million_tokens');
  });

  it('fixtures/prices/prices.golden.json is byte-identical to src/cost/prices.json', () => {
    expect(readFileSync(goldenUrl).equals(readFileSync(srcUrl))).toBe(true);
  });

  it('carries the §8.1 provider defaults (mistral deliberately has no cache-read default — §8.3 prices its reads at input)', () => {
    expect(table.defaults.anthropic).toEqual({ cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2.0 });
    expect(table.defaults.openai).toEqual({ cacheWriteMult: 1.0 });
    expect(table.defaults.google).toEqual({ cacheRead: 0.1 });
    expect(table.defaults.mistral).toEqual({});
  });

  it('every anthropic priced row is sourced and dated; every other provider is unverified', () => {
    for (const [id, row] of Object.entries(table.models)) {
      if (row.provider === 'anthropic') {
        expect(row.source, id).toMatch(/^https:\/\/platform\.claude\.com\//);
        if (row.unpriced !== true) expect(row.checkedAt, id).toBe('2026-08-23');
        expect(row.verified, id).toBe(row.confidence === 'verified');
      } else {
        expect(row.verified, id).toBe(false);
        expect(row.confidence, id).not.toBe('verified');
        expect(row.source, id).toMatch(/^brief/);
      }
    }
  });

  it('carries every §8.2 row at the stated current-window rates', () => {
    const expected: Record<string, [number, number, number | null]> = {
      'claude-fable-5': [10, 50, null],
      'claude-mythos-5': [10, 50, null],
      'claude-opus-5': [5, 25, null],
      'claude-opus-4-8': [5, 25, null],
      'claude-opus-4-7': [5, 25, null],
      'claude-opus-4-6': [5, 25, null],
      'claude-opus-4-5': [5, 25, null],
      'claude-opus-4-1': [15, 75, null],
      'claude-opus-4-2025': [15, 75, null],
      'claude-opus-4-0': [15, 75, null],
      'claude-3-opus': [15, 75, null],
      'claude-sonnet-5': [2, 10, null],
      'claude-sonnet-4-6': [3, 15, null],
      'claude-sonnet-4-5': [3, 15, null],
      'claude-sonnet-4': [3, 15, null],
      'claude-3-7-sonnet': [3, 15, null],
      'claude-3-5-sonnet': [3, 15, null],
      'claude-haiku-4-5': [1, 5, null],
      'claude-3-5-haiku': [0.8, 4, null],
      'claude-3-haiku': [0.25, 1.25, null],
      'gpt-5.6-sol': [5, 30, 0.5],
      'gpt-5.6-terra': [2, 12, 0.2],
      'gpt-5.6-luna': [0.2, 1.2, 0.02],
      'gpt-5.5': [5, 30, 0.5],
      'gpt-5.5-pro': [30, 180, null],
      'gpt-5.4': [2.5, 15, 0.25],
      'gpt-5.4-mini': [0.75, 4.5, 0.075],
      'gpt-5.4-nano': [0.2, 1.25, 0.02],
      'gpt-5.2': [1.75, 14, 0.175],
      'gpt-5.1': [1.25, 10, 0.125],
      'gpt-5': [1.25, 10, 0.125],
      'gpt-5-mini': [0.25, 2, 0.025],
      'gpt-5-nano': [0.05, 0.4, 0.005],
      'gpt-4.1': [2, 8, 0.5],
      'gpt-4.1-mini': [0.4, 1.6, 0.1],
      'gpt-4.1-nano': [0.1, 0.4, 0.025],
      'gpt-4o': [2.5, 10, 1.25],
      'gpt-4o-mini': [0.15, 0.6, 0.075],
      'gemini-3.7-flash': [0.75, 3.75, 0.075],
      'gemini-3.6-flash': [1.5, 7.5, 0.15],
      'gemini-3.5-flash': [1.5, 9, 0.15],
      'gemini-3.5-flash-lite': [0.3, 2.5, 0.03],
      'gemini-3.1-pro-preview': [2, 12, 0.2],
      'gemini-3-flash-preview': [0.5, 3, 0.05],
      'gemini-2.5-pro': [1.25, 10, 0.31],
      'gemini-2.5-flash': [0.3, 2.5, 0.075],
      'gemini-2.5-flash-lite': [0.1, 0.4, 0.025],
      'grok-4.6': [2, 6, 0.5],
      'grok-4.5': [2, 6, 0.3],
      'grok-4.3': [1.25, 2.5, 0.2],
      'grok-4.20-': [1.25, 2.5, 0.2],
      'grok-build-0.1': [1, 2, 0.2],
      'deepseek-chat': [0.28, 0.42, 0.028],
      'deepseek-reasoner': [0.28, 0.42, 0.028],
      'mistral-medium-latest': [1.5, 7.5, null],
      'mistral-large-latest': [0.5, 1.5, null],
      'mistral-small-latest': [0.15, 0.6, null],
      'codestral-latest': [0.3, 0.9, null],
    };
    for (const [id, [input, output, cacheRead]] of Object.entries(expected)) {
      const row = table.models[id];
      expect(row, id).toBeDefined();
      const current = row?.rates?.find((w) => w.until === null);
      expect(current, id).toBeDefined();
      expect(current?.input, id).toBe(input);
      expect(current?.output, id).toBe(output);
      if (cacheRead === null) expect(current?.cacheRead, id).toBeUndefined();
      else expect(current?.cacheRead, id).toBe(cacheRead);
    }
  });

  it('gpt-5.6-terra and -luna carry the dated 2026-07-09..07-29 windows', () => {
    expect(table.models['gpt-5.6-terra']?.rates).toEqual([
      { from: '2026-07-30', until: null, input: 2.0, output: 12.0, cacheRead: 0.2 },
      { from: '2026-07-09', until: '2026-07-29', input: 2.5, output: 15.0, cacheRead: 0.25 },
    ]);
    expect(table.models['gpt-5.6-luna']?.rates).toEqual([
      { from: '2026-07-30', until: null, input: 0.2, output: 1.2, cacheRead: 0.02 },
      { from: '2026-07-09', until: '2026-07-29', input: 1.0, output: 6.0, cacheRead: 0.1 },
    ]);
  });

  it('the gpt-5.6 family carries the ×1.5 estimate tier above 272,000 input tokens', () => {
    expect(table.models['gpt-5.6-sol']?.tiers).toEqual([{ aboveInputTokens: 272000, input: 7.5, output: 45.0, cacheRead: 0.75, confidence: 'estimate' }]);
    expect(table.models['gpt-5.6-terra']?.tiers).toEqual([{ aboveInputTokens: 272000, input: 3.0, output: 18.0, cacheRead: 0.3, confidence: 'estimate' }]);
    expect(table.models['gpt-5.6-luna']?.tiers).toEqual([{ aboveInputTokens: 272000, input: 0.3, output: 1.8, cacheRead: 0.03, confidence: 'estimate' }]);
  });

  it('carries the stated notes', () => {
    expect(table.models['gpt-5.6-sol']?.note).toBe('reported 50 % cut unreconciled (brief §7.1)');
    expect(table.models['gemini-3.7-flash']?.note).toBe('introductory price; end date unannounced');
    expect(table.models['claude-fable-5']?.note).toBe('thinking billed as output; fast mode is not offered');
    expect(table.models['claude-sonnet-5']?.note).toBe('launch price made permanent');
    expect(table.models['claude-opus-4-0']?.note).toBe('retired');
    expect(table.models['gemini-2.5-pro']?.note).toMatch(/0\.25× input; verify at ai\.google\.dev\/pricing$/);
  });

  it('fable/mythos have no speeds; opus-5 fast is verified; opus-4-8 fast is an estimate with a note', () => {
    expect(table.models['claude-fable-5']?.speeds).toBeUndefined();
    expect(table.models['claude-mythos-5']?.speeds).toBeUndefined();
    expect(table.models['claude-opus-5']?.speeds).toEqual({ fast: { input: 10.0, output: 50.0 } });
    expect(table.models['claude-opus-4-8']?.speeds?.['fast']).toEqual({
      input: 10.0,
      output: 50.0,
      confidence: 'estimate',
      note: 'price not published in the docs consulted',
    });
  });

  it('google 3.1-pro and 2.5-pro carry their >200,000 tiers', () => {
    expect(table.models['gemini-3.1-pro-preview']?.tiers).toEqual([{ aboveInputTokens: 200000, input: 4.0, output: 18.0, cacheRead: 0.4 }]);
    expect(table.models['gemini-2.5-pro']?.tiers).toEqual([{ aboveInputTokens: 200000, input: 2.5, output: 15.0, cacheRead: 0.625 }]);
  });

  it('xai rows double above 200,000', () => {
    for (const id of ['grok-4.6', 'grok-4.5', 'grok-4.3', 'grok-4.20-', 'grok-build-0.1']) {
      const row = table.models[id];
      const current = row?.rates?.[0];
      const tier = row?.tiers?.[0];
      expect(tier?.aboveInputTokens, id).toBe(200000);
      expect(tier?.input, id).toBe((current?.input as number) * 2);
      expect(tier?.output, id).toBe((current?.output as number) * 2);
      expect(tier?.cacheRead, id).toBe((current?.cacheRead as number) * 2);
    }
  });

  it('deepseek rows carry the 16:30–00:30 UTC off-peak window at 50 %', () => {
    for (const id of ['deepseek-chat', 'deepseek-reasoner']) {
      expect(table.models[id]?.windows).toEqual([{ utc: '16:30-00:30', input: 0.14, output: 0.21, cacheRead: 0.014 }]);
      expect(table.models[id]?.confidence).toBe('estimate');
    }
    expect(table.models['deepseek-v4-pro']?.aliasOf).toBe('deepseek-chat');
    expect(table.models['deepseek-v4-flash']?.aliasOf).toBe('deepseek-chat');
  });

  it('mistral windows never carry a cacheRead price', () => {
    for (const id of ['mistral-medium-latest', 'mistral-large-latest', 'mistral-small-latest', 'codestral-latest']) {
      for (const w of table.models[id]?.rates ?? []) expect(w.cacheRead, id).toBeUndefined();
    }
  });

  it('the codex regex aliases appear in the §8.2 order, before the unpriced fallbacks', () => {
    const keys = Object.keys(table.models);
    const mini = keys.indexOf('^gpt-(5(?:\\.\\d+)?)-codex-mini$');
    const generic = keys.indexOf('^gpt-(5(?:\\.\\d+)?)-codex(?:-max)?$');
    const family = keys.indexOf('^gpt-5\\.6-codex-(sol|terra|luna)$');
    expect(mini).toBeGreaterThan(-1);
    expect(generic).toBeGreaterThan(mini);
    expect(family).toBeGreaterThan(generic);
    expect(table.models['^claude-']?.unpriced).toBe(true);
    expect(table.models['codex-auto-review']?.unpriced).toBe(true);
  });
});
