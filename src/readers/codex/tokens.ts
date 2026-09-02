/**
 * Codex `token_count` accounting (ARCHITECTURE §4.3.5, §8.3): delta-of-totals
 * over non-duplicate events.
 *
 * - `info: null` events are skipped (rate limits are still read by the
 *   caller).
 * - An event whose totals exactly equal the previous event's totals is a
 *   zero-delta duplicate — not an API call, no `TokenDelta` row.
 * - Any total below its predecessor means the counter reset (a resume):
 *   `prev := zeros`, then the normal delta (the caller notes it and counts
 *   `negativeDeltas`).
 * - `last_token_usage.input_tokens` is carried per delta for tier decisions;
 *   it is **never summed**.
 * - `cached ⊆ input`, `reasoning ⊆ output` — `usageFromDeltas` therefore
 *   reports `input − cached` as uncached input and keeps `output` whole with
 *   `reasoning` mirrored into `thinking`.
 */
import type { TokenDelta, UsageTotals } from '../../model/types.js';
import type { TokenTotals } from './records.js';

/** Position/attribution info for one `token_count` event. */
export interface TokenEventAt {
  seq: number;
  ts: string;
  /** `currentModel` at the event (§4.3.5). */
  model: string;
  /** The open turn's index; `-1` before the first turn. */
  turnIndex: number;
  /** `info.last_token_usage.input_tokens`; `null` when absent. */
  lastInput: number | null;
}

/** What {@link TokenTracker.feed} decided about one event. */
export interface TokenFeedResult {
  /** The delta row, or `null` for a zero-delta duplicate. */
  delta: TokenDelta | null;
  /** The totals exactly equalled the previous event's totals. */
  duplicate: boolean;
  /** A total went backwards — the counter reset (resume). */
  reset: boolean;
}

const ZEROS: TokenTotals = { input: 0, cached: 0, output: 0, reasoning: 0 };

/** Stateful delta-of-totals tracker for one rollout file. */
export class TokenTracker {
  private prev: TokenTotals = { ...ZEROS };

  /** Feeds one non-null `total_token_usage` snapshot (§4.3.5). */
  feed(totals: TokenTotals, at: TokenEventAt): TokenFeedResult {
    const p = this.prev;
    if (totals.input === p.input && totals.cached === p.cached && totals.output === p.output && totals.reasoning === p.reasoning) {
      return { delta: null, duplicate: true, reset: false };
    }
    let reset = false;
    if (totals.input < p.input || totals.cached < p.cached || totals.output < p.output || totals.reasoning < p.reasoning) {
      this.prev = { ...ZEROS };
      reset = true;
    }
    const base = this.prev;
    const delta: TokenDelta = {
      seq: at.seq,
      ts: at.ts,
      model: at.model,
      input: totals.input - base.input,
      cached: totals.cached - base.cached,
      output: totals.output - base.output,
      reasoning: totals.reasoning - base.reasoning,
      turnIndex: at.turnIndex,
      lastInput: at.lastInput,
    };
    this.prev = { ...totals };
    return { delta, duplicate: false, reset };
  }
}

function emptyTotals(): UsageTotals {
  return { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteOther: 0, output: 0, thinking: 0, calls: 0, byModel: {} };
}

function addDelta(into: UsageTotals, d: TokenDelta): void {
  into.input += d.input - d.cached;
  into.cacheRead += d.cached;
  into.output += d.output;
  into.thinking += d.reasoning;
  into.calls += 1;
}

/**
 * Aggregates deltas into a `UsageTotals` (`input` is the uncached share,
 * `cacheRead` the cached share, `thinking` mirrors `reasoning ⊆ output`),
 * with a per-model breakdown.
 */
export function usageFromDeltas(deltas: readonly TokenDelta[]): UsageTotals {
  const totals = emptyTotals();
  for (const d of deltas) {
    addDelta(totals, d);
    let per = totals.byModel[d.model];
    if (per === undefined) {
      per = emptyTotals();
      totals.byModel[d.model] = per;
    }
    addDelta(per, d);
  }
  return totals;
}
