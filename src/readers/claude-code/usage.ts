/**
 * Usage dedupe and per-attempt buckets (ARCHITECTURE §4.2.7, §8.3 lines
 * 1–4). One `UsageRow` per `message.id` (fallback `requestId`, then `uuid`)
 * per file; the last line with a non-null `stop_reason` wins (subagent
 * placeholder lines never override); if no line completed the max-
 * `output_tokens` line is kept with `incomplete: true`. No dollar amounts
 * anywhere here — buckets only.
 */
import type { RawUsage, UsageAttempt, UsageRow, UsageTotals } from '../../model/types.js';

/** The usage-bearing facet of a message group the builder maintains. */
export interface UsageGroupState {
  /** `message.id ?? requestId ?? uuid` (§4.2.7). */
  key: string;
  requestId: string | null;
  /** `message.model` of the winning line. */
  model: string;
  /** Usage object of the winning line. */
  usage: RawUsage | null;
  /** A line with a non-null `stop_reason` (and usage) has been seen. */
  completed: boolean;
  /** Highest `output_tokens` among incomplete lines (placeholder race). */
  maxOut: number;
  seq: number;
  ts: string;
  agentId: string | null;
  groupIndex: number;
}

/** One assistant line's usage-relevant fields. */
export interface UsageLine {
  usage: RawUsage;
  stopReason: string | null;
  model: string;
  seq: number;
  ts: string;
  agentId: string | null;
  groupIndex: number;
}

/**
 * Folds one assistant line into its message group (§4.2.7): a line with a
 * non-null `stop_reason` always wins (last such line); while none has
 * completed, the max-`output_tokens` line is kept (a later line wins ties).
 * Synthetic / API-error lines must be excluded by the caller.
 */
export function noteUsageLine(group: UsageGroupState, line: UsageLine): void {
  const out = line.usage.output_tokens ?? 0;
  if (line.stopReason !== null) {
    group.usage = line.usage;
    group.model = line.model;
    group.completed = true;
    group.seq = line.seq;
    group.ts = line.ts;
    group.agentId = line.agentId;
    group.groupIndex = line.groupIndex;
    return;
  }
  if (!group.completed && (group.usage === null || out >= group.maxOut)) {
    group.usage = line.usage;
    group.model = line.model;
    group.maxOut = out;
    group.seq = line.seq;
    group.ts = line.ts;
    group.agentId = line.agentId;
    group.groupIndex = line.groupIndex;
  }
}

/** Sum of the `ephemeral_*_input_tokens` buckets other than 5m and 1h. */
function otherEphemeral(cc: Record<string, number>): number {
  let sum = 0;
  for (const [key, value] of Object.entries(cc)) {
    if (key === 'ephemeral_5m_input_tokens' || key === 'ephemeral_1h_input_tokens') continue;
    if (/^ephemeral_.*_input_tokens$/.test(key) && typeof value === 'number' && Number.isFinite(value)) sum += value;
  }
  return sum;
}

/** A finite number, else 0 — `JSON.parse("1e999")` is `Infinity` and would poison every downstream sum. */
function fin(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function bucketise(a: RawUsage): Omit<UsageAttempt, 'model' | 'billed'> {
  const cc = a.cache_creation;
  const ccRecord = cc !== null && typeof cc === 'object' ? cc : null;
  return {
    in: fin(a.input_tokens),
    w5: fin(ccRecord?.['ephemeral_5m_input_tokens']),
    w1: fin(ccRecord?.['ephemeral_1h_input_tokens']),
    wX: ccRecord === null ? 0 : otherEphemeral(ccRecord),
    // Legacy path (§8.3): the undifferentiated bucket only when no breakdown exists.
    wU: ccRecord === null ? fin(a.cache_creation_input_tokens) : 0,
    rd: fin(a.cache_read_input_tokens),
    out: fin(a.output_tokens),
  };
}

/**
 * Builds the `UsageRow` for a completed message group per §8.3 lines 1–4:
 * `attempts` from `usage.iterations` (else `[usage]`); per attempt the model
 * is `a.model`, falling back — only on a multi-attempt `message` iteration —
 * to the `originalModel` of the `model_refusal_fallback` system line with
 * the same `requestId`, then to `message.model`; a non-final `message`
 * attempt with zero output tokens is `billed: false` (declined before
 * output). `promptTokens` is the last billed attempt's prompt-side sum.
 * `inherited` is left unset (S07/S18 set it).
 */
export function buildUsageRow(group: UsageGroupState, refusalOriginalModelByRequest: Readonly<Record<string, string>>): UsageRow | null {
  const usage = group.usage;
  if (usage === null) return null;
  const iterations = Array.isArray(usage.iterations) && usage.iterations.length > 0 ? usage.iterations : [usage as RawUsage & { type?: string; model?: string }];
  const attempts: UsageAttempt[] = [];
  for (let i = 0; i < iterations.length; i++) {
    const a = iterations[i];
    if (a === undefined || a === null || typeof a !== 'object') continue;
    const type = typeof a.type === 'string' ? a.type : 'message';
    const isFinal = i === iterations.length - 1;
    const buckets = bucketise(a);
    const memoModel = group.requestId !== null ? refusalOriginalModelByRequest[group.requestId] : undefined;
    const model =
      (typeof a.model === 'string' ? a.model : undefined) ?? (iterations.length > 1 && type === 'message' ? (memoModel ?? group.model) : group.model);
    const billed = !(type === 'message' && !isFinal && buckets.out === 0);
    attempts.push({ model, billed, ...buckets });
  }
  if (attempts.length === 0) return null;
  const lastBilled = [...attempts].reverse().find((a) => a.billed) ?? attempts[attempts.length - 1];
  const promptTokens = lastBilled === undefined ? 0 : lastBilled.in + lastBilled.w5 + lastBilled.w1 + lastBilled.wX + lastBilled.wU + lastBilled.rd;
  const row: UsageRow = {
    seq: group.seq,
    agentId: group.agentId,
    messageId: group.key,
    ts: group.ts,
    attempts,
    promptTokens,
  };
  if (typeof usage.speed === 'string') row.speed = usage.speed;
  if (typeof usage.service_tier === 'string') row.serviceTier = usage.service_tier;
  if (!group.completed) row.incomplete = true;
  return row;
}

/** A fresh all-zero `UsageTotals`. */
export function emptyTotals(): UsageTotals {
  return { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteOther: 0, output: 0, thinking: 0, calls: 0, byModel: {} };
}

function addBuckets(t: UsageTotals, a: UsageAttempt, thinking: number): void {
  t.input += a.in;
  t.cacheRead += a.rd;
  t.cacheWrite5m += a.w5;
  t.cacheWrite1h += a.w1;
  t.cacheWriteOther += a.wX + a.wU;
  t.output += a.out;
  t.thinking += thinking;
}

/**
 * Adds one row's billed attempts to `totals` (top level and `byModel`);
 * `calls` counts rows. `thinking` (from `output_tokens_details`) is
 * attributed to the last billed attempt's model.
 */
export function addRowToTotals(totals: UsageTotals, row: UsageRow, thinking: number): void {
  totals.calls += 1;
  const billed = row.attempts.filter((a) => a.billed);
  const lastBilled = billed[billed.length - 1];
  for (const a of billed) {
    const attemptThinking = a === lastBilled ? thinking : 0;
    addBuckets(totals, a, attemptThinking);
    let sub = totals.byModel[a.model];
    if (sub === undefined) {
      sub = emptyTotals();
      totals.byModel[a.model] = sub;
    }
    sub.calls += 1;
    addBuckets(sub, a, attemptThinking);
  }
}

/** The `thinking_tokens` of a usage object's `output_tokens_details`, else 0. */
export function thinkingOf(usage: RawUsage | null): number {
  const details = usage?.output_tokens_details;
  const value = details !== null && typeof details === 'object' ? details['thinking_tokens'] : undefined;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
