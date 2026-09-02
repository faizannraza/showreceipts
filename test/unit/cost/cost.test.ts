import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { codexDelta, priceClaudeCode, priceCodex, type CostOpts } from '../../../src/cost/cost.js';
import { loadPriceTable } from '../../../src/cost/resolve.js';
import { mergeTables, parsePriceTable } from '../../../src/cost/validate.js';
import type { TokenDelta, UsageAttempt, UsageRow } from '../../../src/model/types.js';
import { buildUsageRow, noteUsageLine, type UsageGroupState } from '../../../src/readers/claude-code/usage.js';

const table = loadPriceTable();

function attempt(model: string, o: Partial<UsageAttempt> = {}): UsageAttempt {
  return { model, in: 0, w5: 0, w1: 0, wX: 0, wU: 0, rd: 0, out: 0, billed: true, ...o };
}

let seq = 0;
function row(attempts: UsageAttempt[], o: Partial<UsageRow> = {}): UsageRow {
  seq += 1;
  return { seq, agentId: null, messageId: `msg_${seq}`, ts: '2026-08-10T09:00:00Z', attempts, promptTokens: 0, ...o };
}

function price(rows: UsageRow[], o: Partial<CostOpts> = {}): ReturnType<typeof priceClaudeCode> {
  return priceClaudeCode(rows, { table, ...o });
}

function delta(model: string, o: Partial<TokenDelta> = {}): TokenDelta {
  return { seq: 1, ts: '2026-08-10T09:00:00Z', model, input: 0, cached: 0, output: 0, reasoning: 0, turnIndex: 0, lastInput: null, ...o };
}

describe('priceClaudeCode buckets (§8.3)', () => {
  it('prices the 5m bucket with cache-read and output (verified, no ≈)', () => {
    const cost = price([row([attempt('claude-fable-5', { in: 1000, w5: 2000, rd: 3000, out: 500 })])]);
    expect(cost.usd).toBe(0.063);
    expect(cost.unverified).toBe(false);
    expect(cost.apiCalls).toBe(1);
    expect(cost.input).toBe(1000);
    expect(cost.cacheWrite5m).toBe(2000);
    expect(cost.cacheRead).toBe(3000);
    expect(cost.output).toBe(500);
    expect(cost.cacheHitPct).toBe(50);
    expect(cost.unpriced).toEqual([]);
    expect(cost.pricesVersion).toBe('2026-08-29');
    expect(cost.apiEquivalent).toBe(true);
  });

  it('prices the 1h bucket at 2× input', () => {
    const cost = price([row([attempt('claude-fable-5', { w1: 1000 })])]);
    expect(cost.usd).toBe(0.02);
    expect(cost.cacheWrite1h).toBe(1000);
  });

  it('prices mixed 5m + 1h buckets', () => {
    const cost = price([row([attempt('claude-fable-5', { w5: 1000, w1: 1000 })])]);
    expect(cost.usd).toBe(0.0325);
  });

  it('prices unknown-TTL buckets (wX) at the 1h rate with ≈ and a note', () => {
    const cost = price([row([attempt('claude-fable-5', { wX: 1000 })])]);
    expect(cost.usd).toBe(0.02);
    expect(cost.unverified).toBe(true);
    expect(cost.notes).toContain('cache writes with unknown TTL priced at the 1h rate');
    expect(cost.cacheWriteOther).toBe(1000);
  });

  it('prices the legacy no-breakdown bucket (wU) at the 5m rate with ≈ and a note', () => {
    const cost = price([row([attempt('claude-fable-5', { wU: 1000 })])]);
    expect(cost.usd).toBe(0.0125);
    expect(cost.unverified).toBe(true);
    expect(cost.notes).toContain('cache writes without TTL breakdown priced at the 5m rate');
    expect(cost.cacheWriteOther).toBe(1000);
  });
});

describe('speed and service tier (§8.3)', () => {
  it('prices fast speed when speeds.fast exists (claude-opus-5, verified)', () => {
    const cost = price([row([attempt('claude-opus-5', { in: 1000, out: 100 })], { speed: 'fast' })]);
    expect(cost.usd).toBe(0.015);
    expect(cost.unverified).toBe(false);
    expect(cost.notes).toEqual([]);
  });

  it('falls back to standard rates with a note and ≈ when the row has no such speed', () => {
    const cost = price([row([attempt('claude-fable-5', { in: 1000, out: 100 })], { speed: 'fast' })]);
    expect(cost.usd).toBe(0.015);
    expect(cost.unverified).toBe(true);
    expect(cost.notes).toContain("speed 'fast' not priced");
  });

  it('prices opus-4-8 fast at the estimate speed with ≈ and its note', () => {
    const cost = price([row([attempt('claude-opus-4-8', { in: 1000, out: 100 })], { speed: 'fast' })]);
    expect(cost.usd).toBe(0.015);
    expect(cost.unverified).toBe(true);
    expect(cost.notes).toContain('price not published in the docs consulted');
  });

  it('a speed of standard is not a speed lookup', () => {
    const cost = price([row([attempt('claude-fable-5', { in: 1000 })], { speed: 'standard' })]);
    expect(cost.usd).toBe(0.01);
    expect(cost.unverified).toBe(false);
  });

  it('notes a non-standard service tier and keeps standard rates with ≈', () => {
    const cost = price([row([attempt('claude-fable-5', { in: 1000 })], { serviceTier: 'priority' })]);
    expect(cost.usd).toBe(0.01);
    expect(cost.unverified).toBe(true);
    expect(cost.notes).toContain('service tier priority not priced');
  });
});

describe('attempt handling (§8.3, §4.2.7)', () => {
  it('skips <synthetic> attempts entirely — never unpriced', () => {
    const cost = price([row([attempt('<synthetic>', { in: 1000, out: 100 })])]);
    expect(cost.usd).toBe(0);
    expect(cost.apiCalls).toBe(0);
    expect(cost.input).toBe(0);
    expect(cost.unpriced).toEqual([]);
  });

  it('prices fallback iterations per attempt model — the 1h write at Fable 5 rates, not Opus', () => {
    const cost = price([
      row([attempt('claude-fable-5', { w1: 1000, out: 217 }), attempt('claude-opus-4-8', { in: 500, out: 300 })]),
    ]);
    // fable: 1000·20 + 217·50 = 30,850; opus: 500·5 + 300·25 = 10,000.
    expect(cost.usd).toBe(0.04085);
    expect(cost.apiCalls).toBe(2);
    expect(cost.unverified).toBe(false);
  });

  it('skips a retracted zero-usage attempt (billed: false)', () => {
    const cost = price([
      row([attempt('claude-fable-5', { billed: false }), attempt('claude-opus-5', { in: 1000, out: 100 })]),
    ]);
    expect(cost.usd).toBe(0.0075);
    expect(cost.apiCalls).toBe(1);
  });

  it('skips inherited rows entirely', () => {
    const cost = price([row([attempt('claude-fable-5', { in: 1000 })], { inherited: true })]);
    expect(cost.usd).toBe(0);
    expect(cost.apiCalls).toBe(0);
  });

  it('notes incomplete rows and still prices them', () => {
    const cost = price([row([attempt('claude-fable-5', { in: 1000 })], { incomplete: true })]);
    expect(cost.usd).toBe(0.01);
    expect(cost.notes).toContain('1 response never completed in the log; their output tokens are unknown');
  });

  it('pluralises the incomplete note', () => {
    const cost = price([
      row([attempt('claude-fable-5', { in: 1000 })], { incomplete: true }),
      row([attempt('claude-fable-5', { in: 1000 })], { incomplete: true }),
    ]);
    expect(cost.notes).toContain('2 responses never completed in the log; their output tokens are unknown');
  });

  it('empty input yields $0 with a null cache-hit rate', () => {
    const cost = price([]);
    expect(cost.usd).toBe(0);
    expect(cost.cacheHitPct).toBeNull();
    expect(cost.notes).toEqual([]);
  });
});

describe('dedupe pins (§4.2.7)', () => {
  function line(group: UsageGroupState, stopReason: string | null, out: number, lineSeq: number): void {
    noteUsageLine(group, {
      usage: { input_tokens: 100, output_tokens: out, cache_read_input_tokens: 0 },
      stopReason,
      model: 'claude-fable-5',
      seq: lineSeq,
      ts: '2026-08-10T09:00:00Z',
      agentId: null,
      groupIndex: 0,
    });
  }

  function freshGroup(): UsageGroupState {
    return { key: 'msg_x', requestId: null, model: 'claude-fable-5', usage: null, completed: false, maxOut: 0, seq: 0, ts: '', agentId: null, groupIndex: 0 };
  }

  it('a placeholder line never wins: the completed line is the one priced', () => {
    const group = freshGroup();
    line(group, null, 3, 1); // subagent placeholder
    line(group, 'end_turn', 200, 2); // the real completion
    line(group, null, 999, 3); // late placeholder must not override
    const built = buildUsageRow(group, {});
    expect(built).not.toBeNull();
    const cost = price([built as UsageRow]);
    expect(cost.usd).toBe(0.011); // 100·10 + 200·50
    expect(cost.output).toBe(200);
    expect(cost.apiCalls).toBe(1);
  });

  it('a 3-line message prices exactly once', () => {
    const group = freshGroup();
    line(group, 'end_turn', 200, 1);
    line(group, 'end_turn', 200, 2);
    line(group, 'end_turn', 200, 3);
    const built = buildUsageRow(group, {});
    const cost = price([built as UsageRow]);
    expect(cost.usd).toBe(0.011);
    expect(cost.apiCalls).toBe(1);
  });
});

describe('tier repricing (§8.3)', () => {
  it('gemini-2.5-pro: 200,000 prompt tokens stay on base rates; 200,001 reprices the whole attempt', () => {
    const at = price([row([attempt('gemini-2.5-pro', { in: 200000 })])]);
    expect(at.usd).toBe(0.25);
    const above = price([row([attempt('gemini-2.5-pro', { in: 200001 })])]);
    expect(above.usd).toBe(0.500003);
    expect(above.unverified).toBe(true); // inferred row
  });

  it('gpt-5.6-terra: 272,000 vs 272,001', () => {
    const at = price([row([attempt('gpt-5.6-terra', { in: 272000 })])]);
    expect(at.usd).toBe(0.544);
    const above = price([row([attempt('gpt-5.6-terra', { in: 272001 })])]);
    expect(above.usd).toBe(0.816003);
  });

  it('cache reads count toward the tier threshold', () => {
    const cost = price([row([attempt('gpt-5.6-terra', { in: 1, rd: 272000 })])]);
    // prompt = 272,001 > 272,000 ⇒ tier: 1·3.0 + 272,000·0.3 = 81,603.
    expect(cost.usd).toBe(0.081603);
  });
});

describe('dated windows and --as-of (§8.1, §8.3)', () => {
  const terra = (): UsageRow => row([attempt('gpt-5.6-terra', { in: 1000, out: 100 })]);

  it('--as-of 2026-07-15 selects the earlier gpt-5.6-terra window (2.50/15.00/0.25)', () => {
    const cost = price([terra()], { asOf: '2026-07-15' });
    expect(cost.usd).toBe(0.004);
    expect(cost.asOf).toBe('2026-07-15');
  });

  it('--as-of 2026-08-01 selects the current window (2.00/12.00/0.20)', () => {
    const cost = price([terra()], { asOf: '2026-08-01' });
    expect(cost.usd).toBe(0.0032);
  });

  it('a call before the first window prices with the earliest window at ≈ with a note', () => {
    const cost = price([row([attempt('gpt-5.6-terra', { in: 1000 })], { ts: '2026-07-01T10:00:00Z' })]);
    expect(cost.usd).toBe(0.0025);
    expect(cost.unverified).toBe(true);
    expect(cost.notes).toContain('priced with the earliest known window (from 2026-07-09)');
  });

  it('the on-boundary day 2026-07-30 belongs to the new window', () => {
    const boundary = price([row([attempt('gpt-5.6-terra', { in: 1000 })], { ts: '2026-07-30T00:00:00Z' })]);
    expect(boundary.usd).toBe(0.002);
    const before = price([row([attempt('gpt-5.6-terra', { in: 1000 })], { ts: '2026-07-29T23:59:59Z' })]);
    expect(before.usd).toBe(0.0025);
  });
});

describe('unpriced models and ≈ propagation', () => {
  it('an unknown model is listed and usd is computed over priced rows only, with ≈', () => {
    const cost = price([
      row([attempt('claude-fable-5', { in: 1000 })]),
      row([attempt('frontier-x1', { in: 1000 })]),
    ]);
    expect(cost.usd).toBe(0.01);
    expect(cost.unpriced).toEqual(['frontier-x1']);
    expect(cost.unverified).toBe(true);
    expect(cost.notes).toContain('frontier-x1: not in the price table');
    expect(cost.input).toBe(2000); // token totals still count real usage
    expect(cost.apiCalls).toBe(2);
  });

  it('a Vertex id is unpriced with the partner note', () => {
    const cost = price([row([attempt('claude-opus-5@20260801', { in: 1000 })])]);
    expect(cost.usd).toBe(0);
    expect(cost.unpriced).toEqual(['claude-opus-5']);
    expect(cost.notes).toContain('claude-opus-5: partner pricing differs (Vertex AI)');
  });

  it('claude-fable-5[1m] normalises to claude-fable-5 and prices normally', () => {
    const cost = price([row([attempt('claude-fable-5[1m]', { in: 1000 })])]);
    expect(cost.usd).toBe(0.01);
    expect(cost.unpriced).toEqual([]);
  });

  it('any unverified row sets ≈ (claude-3-opus is inferred)', () => {
    const cost = price([row([attempt('claude-3-opus', { in: 1000 })])]);
    expect(cost.usd).toBe(0.015);
    expect(cost.unverified).toBe(true);
  });

  it('a model with no cache-read price (Mistral) reads at the input rate with ≈ and a note', () => {
    const cost = price([row([attempt('mistral-medium-latest', { in: 1000, rd: 1000, out: 100 })])]);
    expect(cost.usd).toBe(0.00375);
    expect(cost.unverified).toBe(true);
    expect(cost.notes).toContain('cache reads priced at input rate (no cache-read price)');
  });

  it('a cache-less model without cache reads gets no cache-read note', () => {
    const cost = price([row([attempt('gpt-5.5-pro', { in: 1000 })])]);
    expect(cost.usd).toBe(0.03);
    expect(cost.notes).not.toContain('cache reads priced at input rate (no cache-read price)');
  });
});

describe('DeepSeek off-peak windows (§8.1)', () => {
  it('16:30 UTC is inside the off-peak window; 16:29 is not', () => {
    const off = price([row([attempt('deepseek-chat', { in: 1000000 })], { ts: '2026-05-10T16:30:00Z' })]);
    expect(off.usd).toBe(0.14);
    const std = price([row([attempt('deepseek-chat', { in: 1000000 })], { ts: '2026-05-10T16:29:00Z' })]);
    expect(std.usd).toBe(0.28);
    expect(off.unverified).toBe(true); // estimate row
  });

  it('the window wraps past midnight and uses the call time even under --as-of', () => {
    const wrapped = price([row([attempt('deepseek-chat', { in: 1000000 })], { ts: '2026-05-11T00:29:59Z' })], { asOf: '2026-05-01' });
    expect(wrapped.usd).toBe(0.14);
    const after = price([row([attempt('deepseek-chat', { in: 1000000 })], { ts: '2026-05-11T00:30:00Z' })]);
    expect(after.usd).toBe(0.28);
  });
});

describe('session-level notes', () => {
  const oneRow = (): UsageRow[] => [row([attempt('claude-fable-5', { in: 1000 })])];
  const NOT_COUNTED = 'WebFetch/WebSearch sub-requests and compaction/title generation are not logged and not counted';

  it('is added when the session has fetch/search calls', () => {
    expect(price(oneRow(), { fetchSearch: true }).notes).toContain(NOT_COUNTED);
  });

  it('is added when the session has compactions', () => {
    expect(price(oneRow(), { compactions: 2 }).notes).toContain(NOT_COUNTED);
  });

  it('is absent otherwise', () => {
    expect(price(oneRow()).notes).not.toContain(NOT_COUNTED);
  });
});

describe('override tables', () => {
  const overrideText = readFileSync(new URL('../../../fixtures/prices/override-valid.json', import.meta.url), 'utf8');

  it('merged override rows replace base rows and stamp the version + hash', () => {
    const override = parsePriceTable(overrideText, 'override-valid.json', table);
    const merged = mergeTables(table, override);
    expect(merged.version).toMatch(/^2026-08-29\+[0-9a-f]{8}$/);
    expect(merged.overrideHash).toBe(merged.version.slice('2026-08-29+'.length));
    const cost = priceClaudeCode([row([attempt('acme-lm-1', { in: 1000, out: 100 })])], { table: merged });
    expect(cost.usd).toBe(0.0039); // 3.00 + 0.9
    expect(cost.pricesVersion).toBe(merged.version);
    expect(cost.overrideHash).toBe(merged.overrideHash);
    // the replaced gpt-5.2 row prices at the negotiated rate
    expect(codexDelta({ Δin: 1000, Δcd: 0, Δout: 100 }, 'gpt-5.2', undefined, merged)).toBe(0.0018);
  });
});

describe('priceCodex (§8.3)', () => {
  it('prices the delta formula and reports cache hit, thinking and plan usage', () => {
    const cost = priceCodex(
      [delta('gpt-5.2', { input: 94642, cached: 82560, output: 2343, reasoning: 500, lastInput: 94642 })],
      { table, planUsagePct: 63 },
    );
    expect(cost.usd).toBe(0.068394);
    expect(cost.unverified).toBe(true); // OpenAI rows are inferred
    expect(cost.apiCalls).toBe(1);
    expect(cost.input).toBe(94642 - 82560);
    expect(cost.cacheRead).toBe(82560);
    expect(cost.thinking).toBe(500);
    expect(cost.cacheHitPct).toBe(87.23);
    expect(cost.planUsagePct).toBe(63);
  });

  it('reprices a delta by lastInput tier (never summed)', () => {
    const above = priceCodex([delta('gpt-5.6-terra', { input: 1000, lastInput: 272001 })], { table });
    expect(above.usd).toBe(0.003);
    const at = priceCodex([delta('gpt-5.6-terra', { input: 1000, lastInput: 272000 })], { table });
    expect(at.usd).toBe(0.002);
    const unknownLast = priceCodex([delta('gpt-5.6-terra', { input: 1000, lastInput: null })], { table });
    expect(unknownLast.usd).toBe(0.002);
  });

  it('lists unpriced codex models and prices cache reads at input when no cache-read price exists', () => {
    const cost = priceCodex(
      [delta('codex-auto-review', { input: 1000 }), delta('mistral-medium-latest', { input: 1000, cached: 500 })],
      { table },
    );
    expect(cost.unpriced).toEqual(['codex-auto-review']);
    expect(cost.usd).toBe(0.0015);
    expect(cost.notes).toContain('cache reads priced at input rate (no cache-read price)');
    expect(cost.notes).toContain('codex-auto-review: not priced');
  });

  it('a cache-less model without cached tokens gets no cache-read note', () => {
    const cost = priceCodex([delta('mistral-medium-latest', { input: 1000 })], { table });
    expect(cost.usd).toBe(0.0015);
    expect(cost.notes).not.toContain('cache reads priced at input rate (no cache-read price)');
  });
});

describe('codexDelta (§8.3 pin)', () => {
  it('codexDelta({Δin:94642, Δcd:82560, Δout:2343}, gpt-5.2) === 0.068394', () => {
    expect(codexDelta({ Δin: 94642, Δcd: 82560, Δout: 2343 }, 'gpt-5.2')).toBe(0.068394);
  });

  it('accepts a timestamp for window selection', () => {
    expect(codexDelta({ Δin: 1000, Δcd: 0, Δout: 100 }, 'gpt-5.6-terra', '2026-07-15T10:00:00Z')).toBe(0.004);
    expect(codexDelta({ Δin: 1000, Δcd: 0, Δout: 100 }, 'gpt-5.6-terra', '2026-08-10T10:00:00Z')).toBe(0.0032);
  });

  it('returns 0 for an unpriced model and prices reads at input when no cache-read price exists', () => {
    expect(codexDelta({ Δin: 1000, Δcd: 0, Δout: 0 }, 'codex-auto-review')).toBe(0);
    expect(codexDelta({ Δin: 1000, Δcd: 500, Δout: 0 }, 'mistral-medium-latest')).toBe(0.0015);
  });
});
