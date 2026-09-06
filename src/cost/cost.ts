/**
 * Cost engine (§8.3). Pure over its inputs: no `node:fs`/`node:os`, no
 * clock, no environment — timestamps come from the rows/deltas and the
 * price table is passed in (the bundled table is loaded by `resolve.ts`).
 *
 * Claude Code rows arrive fully bucketed from the reader (§4.2.7/S06):
 * attempts carry `model` (refusal-fallback already resolved), `billed`
 * (declined zero-output attempts are `billed: false`) and the
 * `in/w5/w1/wX/wU/rd/out` buckets — nothing is re-derived here. Codex
 * deltas arrive from the `token_count` tracker (§4.3.5).
 */
import type { Cost, TokenDelta, UsageRow } from '../model/types.js';
import { parseIso } from '../util/time.js';
import { loadPriceTable, resolveRates, type PriceTable, type RateMeta } from './resolve.js';

/** §8.3 scope note, added whenever the session has fetch/search calls or compactions. */
const NOT_COUNTED_NOTE = 'WebFetch/WebSearch sub-requests and compaction/title generation are not logged and not counted';
/** §8.3 Mistral rule: a model without a cache-read price reads at the input rate. */
const NO_CACHE_READ_NOTE = 'cache reads priced at input rate (no cache-read price)';
/** `wX` (unknown-TTL ephemeral buckets) price at the 1h rate with `≈` (§8.3). */
const UNKNOWN_TTL_NOTE = 'cache writes with unknown TTL priced at the 1h rate';
/** Legacy `wU` (no `cache_creation` breakdown) prices at the 5m rate with `≈` (§8.3). */
const NO_BREAKDOWN_NOTE = 'cache writes without TTL breakdown priced at the 5m rate';

export interface CostOpts {
  table: PriceTable;
  /** `--as-of YYYY-MM-DD`: price every call at that date's window. */
  asOf?: string | undefined;
  /** The session has WebFetch/WebSearch tool calls (adds the not-counted note). */
  fetchSearch?: boolean | undefined;
  /** The session's compaction count (adds the not-counted note when > 0). */
  compactions?: number | undefined;
}

export interface CodexCostOpts extends CostOpts {
  /** `primary.used_percent` of the last non-null `rate_limits` (§4.3.5). */
  planUsagePct?: number | undefined;
}

interface Acc {
  usd: number;
  apiCalls: number;
  input: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheWriteOther: number;
  output: number;
  hitNum: number;
  hitDen: number;
  unverified: boolean;
  unpriced: Set<string>;
  unverifiedModels: Set<string>;
  notes: Set<string>;
}

function newAcc(): Acc {
  return {
    usd: 0,
    apiCalls: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheWriteOther: 0,
    output: 0,
    hitNum: 0,
    hitDen: 0,
    unverified: false,
    unpriced: new Set(),
    unverifiedModels: new Set(),
    notes: new Set(),
  };
}

/** Folds a resolution's provenance into the accumulator (`≈` and notes). */
function noteMeta(acc: Acc, meta: RateMeta): void {
  if (meta.approx) {
    acc.unverified = true;
    // Unpriced ids live in `Cost.unpriced`; every other ≈-contributing model
    // is listed so `doctor` can name what the blanket warning is about.
    if (meta.unpriced === undefined) acc.unverifiedModels.add(meta.id);
  }
  for (const note of meta.notes) acc.notes.add(note);
}

/** Records an unpriced model: listed in `Cost.unpriced`, noted, and `≈` set. */
function noteUnpriced(acc: Acc, meta: RateMeta, reason: string): void {
  acc.unpriced.add(meta.id);
  acc.notes.add(`${meta.id}: ${reason}`);
}

/** Builds the final `Cost` (§8.3 rounding: `Math.round(usd·1e6)/1e6`). */
function finish(acc: Acc, opts: CostOpts, thinking: number | null): Cost {
  if (opts.fetchSearch === true || (opts.compactions ?? 0) > 0) acc.notes.add(NOT_COUNTED_NOTE);
  const cost: Cost = {
    usd: Math.round(acc.usd * 1e6) / 1e6,
    apiCalls: acc.apiCalls,
    input: acc.input,
    cacheRead: acc.cacheRead,
    cacheWrite5m: acc.cacheWrite5m,
    cacheWrite1h: acc.cacheWrite1h,
    cacheWriteOther: acc.cacheWriteOther,
    output: acc.output,
    cacheHitPct: acc.hitDen > 0 ? Math.round((acc.hitNum / acc.hitDen) * 10000) / 100 : null,
    unverified: acc.unverified,
    unpriced: [...acc.unpriced].sort(),
    apiEquivalent: true,
    pricesVersion: opts.table.version,
    notes: [...acc.notes],
  };
  if (acc.unverifiedModels.size > 0) cost.unverifiedModels = [...acc.unverifiedModels].sort();
  if (thinking !== null) cost.thinking = thinking;
  if (opts.table.overrideHash !== undefined) cost.overrideHash = opts.table.overrideHash;
  if (opts.asOf !== undefined) cost.asOf = opts.asOf;
  return cost;
}

/**
 * Prices Claude Code usage rows (§8.3): loops over `row.attempts`, skips
 * `inherited` rows, `billed: false` attempts (declined before output) and
 * `<synthetic>` attempts (never unpriced, §8.1); resolves rates per attempt
 * model at the row's timestamp (or `--as-of`); prices `wX` at the 1h and
 * `wU` at the 5m rate with `≈`; reprices the whole attempt at a tier when
 * `in+w5+w1+wX+wU+rd` exceeds its threshold; and prices cache reads at the
 * input rate with `≈` + note when the model has no cache-read price.
 */
export function priceClaudeCode(rows: readonly UsageRow[], opts: CostOpts): Cost {
  const acc = newAcc();
  let incomplete = 0;
  for (const row of rows) {
    if (row.inherited === true) continue;
    if (row.incomplete === true) incomplete += 1;
    const tsMs = parseIso(row.ts);
    for (const a of row.attempts) {
      if (!a.billed) continue;
      if (a.model === '<synthetic>') continue;
      acc.apiCalls += 1;
      acc.input += a.in;
      acc.cacheRead += a.rd;
      acc.cacheWrite5m += a.w5;
      acc.cacheWrite1h += a.w1;
      acc.cacheWriteOther += a.wX + a.wU;
      acc.output += a.out;
      acc.hitNum += a.rd;
      acc.hitDen += a.in + a.rd + a.w5 + a.w1 + a.wX + a.wU;
      const prompt = a.in + a.w5 + a.w1 + a.wX + a.wU + a.rd;
      const { rates, meta } = resolveRates(a.model, tsMs, {
        table: opts.table,
        asOf: opts.asOf,
        speed: row.speed,
        serviceTier: row.serviceTier,
        promptTokens: prompt,
      });
      noteMeta(acc, meta);
      if (meta.unpriced !== undefined) {
        noteUnpriced(acc, meta, meta.unpriced);
        continue;
      }
      if (a.wX > 0) {
        acc.unverified = true;
        acc.notes.add(UNKNOWN_TTL_NOTE);
      }
      if (a.wU > 0) {
        acc.unverified = true;
        acc.notes.add(NO_BREAKDOWN_NOTE);
      }
      let rdRate = rates.cacheRead;
      if (rdRate === null) {
        rdRate = rates.input;
        if (a.rd > 0) {
          acc.unverified = true;
          acc.notes.add(NO_CACHE_READ_NOTE);
        }
      }
      acc.usd +=
        (a.in * rates.input +
          a.w5 * rates.cacheWrite5m +
          a.w1 * rates.cacheWrite1h +
          a.wX * rates.cacheWrite1h +
          a.wU * rates.cacheWrite5m +
          a.rd * rdRate +
          a.out * rates.output) /
        1e6;
    }
  }
  if (incomplete > 0) {
    acc.notes.add(`${incomplete} response${incomplete === 1 ? '' : 's'} never completed in the log; their output tokens are unknown`);
  }
  return finish(acc, opts, null);
}

/**
 * Prices Codex token-count deltas (§8.3):
 * `usd = ((Δin−Δcd)·input + Δcd·cacheRead + Δout·output) / 1e6` per delta,
 * with tier repricing by `lastInput` (never summed) and `planUsagePct`
 * carried through. `reasoning ⊆ output` is reported as `thinking`.
 */
export function priceCodex(deltas: readonly TokenDelta[], opts: CodexCostOpts): Cost {
  const acc = newAcc();
  let thinking = 0;
  for (const d of deltas) {
    acc.apiCalls += 1;
    const uncached = d.input - d.cached;
    acc.input += uncached;
    acc.cacheRead += d.cached;
    acc.output += d.output;
    thinking += d.reasoning;
    acc.hitNum += d.cached;
    acc.hitDen += d.input;
    const { rates, meta } = resolveRates(d.model, parseIso(d.ts), {
      table: opts.table,
      asOf: opts.asOf,
      promptTokens: d.lastInput ?? undefined,
    });
    noteMeta(acc, meta);
    if (meta.unpriced !== undefined) {
      noteUnpriced(acc, meta, meta.unpriced);
      continue;
    }
    let rdRate = rates.cacheRead;
    if (rdRate === null) {
      rdRate = rates.input;
      if (d.cached > 0) {
        acc.unverified = true;
        acc.notes.add(NO_CACHE_READ_NOTE);
      }
    }
    acc.usd += (uncached * rates.input + d.cached * rdRate + d.output * rates.output) / 1e6;
  }
  const cost = finish(acc, opts, thinking);
  if (opts.planUsagePct !== undefined) cost.planUsagePct = opts.planUsagePct;
  return cost;
}

/**
 * Prices one Codex delta (§8.3 golden pin:
 * `codexDelta({Δin:94642, Δcd:82560, Δout:2343}, 'gpt-5.2') === 0.068394`).
 * With no `ts` the open-ended current window applies; `table` defaults to
 * the bundled one. Unpriced models yield 0.
 */
export function codexDelta(d: { Δin: number; Δcd: number; Δout: number }, model: string, ts?: string, table?: PriceTable): number {
  const t = table ?? loadPriceTable();
  const { rates, meta } = resolveRates(model, ts === undefined ? null : parseIso(ts), { table: t });
  if (meta.unpriced !== undefined) return 0;
  const rdRate = rates.cacheRead ?? rates.input;
  const usd = ((d.Δin - d.Δcd) * rates.input + d.Δcd * rdRate + d.Δout * rates.output) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}
