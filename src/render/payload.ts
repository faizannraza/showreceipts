/**
 * The HTML report's embedded data (ARCHITECTURE §11.1, S22): builds the
 * `ReportPayload` — meta, rate rows, session cards, receipts and positional
 * timelines — keyed by `harness:sessionId` (the same key
 * `reconcile/rate.ts sessionKey` uses). Timeline rows are positional arrays
 * under `cols`, with millisecond offsets from the session's `startedAt`, so
 * 400 calls stay near 60 KB instead of 400 objects with repeated keys.
 *
 * `finalText` policy (§11.1): the `--full` sessions (default: the 50 most
 * recent by `endedAt`) embed the full text capped at 16 KB; every other
 * session carries a 600-character head. Byte-budget degradation on top of
 * this baseline lives in `render/budget.ts`.
 *
 * Pure and deterministic: no fs, no env, no clock — `generatedAt` comes from
 * the injected `--now`.
 */
import type { RateRow, Receipt, ReportPayload, SessionCard, TimelineEntry } from '../model/types.js';
import { truncateBytes } from '../cache/cache.js';
import { parseIso } from '../util/time.js';

/** Column order of every positional timeline row (§11.1). */
export const TIMELINE_COLS: readonly string[] = ['ms', 'seq', 'tool', 'kind', 'summary', 'exit', 'usd', 'agent', 'flags', 'files'];

/** Default `--full` count: the N most recent sessions keep full text and timelines. */
export const FULL_DEFAULT = 50;

/** `finalText` cap inside a `--full` session (bytes of UTF-8). */
export const FINAL_TEXT_FULL_BYTES = 16 * 1024;

/** `finalText` head kept outside the `--full` set (characters). */
export const FINAL_TEXT_BRIEF_CHARS = 600;

/** One session's report inputs, as the pipeline produced them (S18). */
export interface ReportSessionInput {
  card: SessionCard;
  /** The receipt of the session's selected turn. */
  receipt: Receipt;
  /** The turn's evidence timeline (`pipeline/timeline.ts`); omitted ⇒ no timeline embedded. */
  timeline?: TimelineEntry[] | undefined;
}

export interface PayloadOptions {
  /** The command clock (`--now`) — becomes `meta.generatedAt`. */
  now: Date;
  /** `--full N` (default {@link FULL_DEFAULT}). */
  full?: number | undefined;
  /** The false-done rate rows (S17/S18). */
  rows: RateRow[];
  /** Version stamps; default: taken from the first receipt, `''` when there is none. */
  toolVersion?: string | undefined;
  rulesVersion?: string | undefined;
  pricesVersion?: string | undefined;
  /** `meta.hashPaths` — set by the renderer when the §11.2 pass will run. */
  hashPaths?: boolean | undefined;
}

export interface BuiltPayload {
  payload: ReportPayload;
  /** The `--full` session keys (most recent first) — `render/budget.ts` degrades around them. */
  fullKeys: Set<string>;
}

/** The payload key of a session (§11.1): `harness:sessionId`. */
export function payloadKey(card: Pick<SessionCard, 'harness' | 'id'>): string {
  return `${card.harness}:${card.id}`;
}

/** One positional timeline row in {@link TIMELINE_COLS} order; `ms` is the offset from `startMs`. */
export function timelineRow(entry: TimelineEntry, startMs: number | null): unknown[] {
  const atMs = parseIso(entry.at);
  const ms = startMs !== null && atMs !== null ? atMs - startMs : null;
  return [ms, entry.seq, entry.tool, entry.kind, entry.summary, entry.exit, entry.usd, entry.agentId, entry.flags, entry.files];
}

/** UTF-8 bytes of the truncation ellipsis `…` (U+2026). */
const ELLIPSIS_BYTES = 3;

/**
 * `finalText` under the §11.1 policy: for `--full` sessions the full text,
 * truncated so that text *plus ellipsis* stays within the 16 KB cap; a
 * 600-char head with the §11.1 `…show full in session <id>` trailer
 * elsewhere.
 */
function capFinalText(text: string, full: boolean, shortId: string): string {
  if (full) {
    if (truncateBytes(text, FINAL_TEXT_FULL_BYTES) === text) return text;
    return `${truncateBytes(text, FINAL_TEXT_FULL_BYTES - ELLIPSIS_BYTES)}…`;
  }
  if (text.length <= FINAL_TEXT_BRIEF_CHARS) return text;
  return `${text.slice(0, FINAL_TEXT_BRIEF_CHARS)}…show full in session ${shortId}`;
}

/** The `--full` set: the N most recent sessions by `endedAt` desc, `sessionId` asc (the pipeline sort). */
function pickFullKeys(inputs: readonly ReportSessionInput[], full: number): Set<string> {
  const order = [...inputs].sort((a, b) => {
    if (a.card.endedAt !== b.card.endedAt) return a.card.endedAt < b.card.endedAt ? 1 : -1;
    return a.card.id < b.card.id ? -1 : a.card.id > b.card.id ? 1 : 0;
  });
  return new Set(order.slice(0, full).map((i) => payloadKey(i.card)));
}

/**
 * Builds the §11.1 `ReportPayload` from per-session pipeline outputs. Order
 * of `sessions` is preserved from `inputs` (the pipeline already sorts by
 * recency); receipts and timelines are keyed `harness:sessionId`. The
 * baseline `finalText` caps are applied here; byte-budget degradation
 * (timelines beyond `--full`, the 500-row cap, dropping brief text) is
 * `render/budget.ts applyBudget`, which callers run on the result.
 */
export function buildReportPayload(inputs: readonly ReportSessionInput[], opts: PayloadOptions): BuiltPayload {
  const full = Math.max(0, opts.full ?? FULL_DEFAULT);
  const fullKeys = pickFullKeys(inputs, full);

  const sessions: SessionCard[] = [];
  const receipts: Record<string, Receipt> = {};
  const timelines: Record<string, { cols: string[]; rows: unknown[][] }> = {};

  for (const input of inputs) {
    const key = payloadKey(input.card);
    const isFull = fullKeys.has(key);
    sessions.push(input.card);
    receipts[key] = { ...input.receipt, finalText: capFinalText(input.receipt.finalText, isFull, input.card.shortId) };
    if (input.timeline !== undefined) {
      const startMs = parseIso(input.card.startedAt);
      timelines[key] = { cols: [...TIMELINE_COLS], rows: input.timeline.map((e) => timelineRow(e, startMs)) };
    }
  }

  const first = inputs[0]?.receipt;
  const payload: ReportPayload = {
    meta: {
      toolVersion: opts.toolVersion ?? first?.toolVersion ?? '',
      rulesVersion: opts.rulesVersion ?? first?.rulesVersion ?? '',
      pricesVersion: opts.pricesVersion ?? first?.pricesVersion ?? '',
      generatedAt: opts.now.toISOString(),
      hashPaths: opts.hashPaths === true,
    },
    rows: opts.rows,
    sessions,
    receipts,
    timelines,
  };
  return { payload, fullKeys };
}
