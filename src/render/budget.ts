/**
 * The HTML report's byte budget (ARCHITECTURE §11.1, S22): per-section byte
 * measurement, a soft warning at 8 MB, a hard cap at 16 MB, and the fixed
 * degradation order applied only while the payload is over the hard cap:
 *
 *   1. `timelines-beyond-full` — drop the timelines of sessions outside the
 *      `--full` set;
 *   2. `timeline-rows-capped`  — cap every remaining timeline at 500 rows,
 *      NEVER dropping a row that receipt evidence references or that carries
 *      a `test|check|git|write|danger` flag; hidden runs leave a positional
 *      gap row (`+N hidden`, flag `gap`) and are counted in
 *      `hiddenRows[key]`;
 *   3. `final-text-dropped`    — drop `finalText` outside the `--full` set.
 *
 * The input payload is never mutated; every degraded structure is a copy.
 * Pure: no fs, no env, no clock.
 */
import type { Receipt, ReportPayload } from '../model/types.js';
import { stableStringify } from '../util/json.js';

/** Soft warning threshold (§11.1). */
export const SOFT_LIMIT_BYTES = 8 * 1024 * 1024;
/** Hard cap — degradation runs only while the payload serialises above this. */
export const HARD_LIMIT_BYTES = 16 * 1024 * 1024;
/** Per-session timeline row cap of degradation stage 2. */
export const TIMELINE_ROW_CAP = 500;

/** Degradation stage names, in the §11.1 order. */
export const DEGRADE_TIMELINES = 'timelines-beyond-full';
export const DEGRADE_ROWS = 'timeline-rows-capped';
export const DEGRADE_FINAL_TEXT = 'final-text-dropped';

/** Timeline flags whose rows are always embedded (never capped away). */
const PROTECTED_FLAGS: readonly string[] = ['test', 'check', 'git', 'write', 'danger'];

export interface BudgetLimits {
  soft: number;
  hard: number;
  rowCap: number;
}

export interface BudgetSections {
  meta: number;
  rows: number;
  sessions: number;
  receipts: number;
  timelines: number;
  total: number;
}

export interface BudgetReport {
  /** Bytes per §11.1 section of the final (possibly degraded) payload. */
  sections: BudgetSections;
  /** Final size exceeds the soft limit (a warning, not a failure). */
  softExceeded: boolean;
  /** Still above the hard cap after every degradation stage (renderers warn). */
  overCap: boolean;
  /** The stages that actually changed the payload, in applied order. */
  degraded: string[];
  /** Rows hidden by stage 2, per `harness:sessionId` key. */
  hiddenRows: Record<string, number>;
}

const DEFAULT_LIMITS: BudgetLimits = { soft: SOFT_LIMIT_BYTES, hard: HARD_LIMIT_BYTES, rowCap: TIMELINE_ROW_CAP };

function bytesOf(value: unknown): number {
  return Buffer.byteLength(stableStringify(value), 'utf8');
}

/** Byte size of every §11.1 payload section plus the serialised total. */
export function measureSections(payload: ReportPayload): BudgetSections {
  return {
    meta: bytesOf(payload.meta),
    rows: bytesOf(payload.rows),
    sessions: bytesOf(payload.sessions),
    receipts: bytesOf(payload.receipts),
    timelines: bytesOf(payload.timelines),
    total: bytesOf(payload),
  };
}

/** Every `seq` the receipt's evidence references (lines, ALSO DID, judgements). */
export function referencedSeqs(receipt: Receipt | undefined): Set<number> {
  const seqs = new Set<number>();
  if (receipt === undefined) return seqs;
  for (const line of receipt.lines) for (const ref of line.refs) seqs.add(ref.seq);
  for (const did of receipt.alsoDid) for (const ref of did.refs) seqs.add(ref.seq);
  for (const j of receipt.judgements) for (const ref of j.evidence) seqs.add(ref.seq);
  return seqs;
}

interface Timeline {
  cols: string[];
  rows: unknown[][];
}

/** A positional gap row (`+n hidden`, flag `gap`) shaped by `cols`. */
function gapRow(cols: readonly string[], n: number): unknown[] {
  return cols.map((col) => {
    if (col === 'summary') return `+${n} hidden`;
    if (col === 'flags') return ['gap'];
    if (col === 'files') return [];
    if (col === 'tool' || col === 'kind') return '';
    return null;
  });
}

/**
 * Caps one timeline at `cap` rows (§11.1 stage 2). Rows whose `seq` is in
 * `mustKeep` or whose flags intersect `test|check|git|write|danger` are
 * always kept (even when they alone exceed the cap); the remaining budget is
 * filled with the most recent other rows. Hidden runs become gap rows
 * (excluded from the cap count) so the renderer can band them.
 */
export function capTimeline(timeline: Timeline, mustKeep: ReadonlySet<number>, cap: number): { timeline: Timeline; hidden: number } {
  const seqAt = timeline.cols.indexOf('seq');
  const flagsAt = timeline.cols.indexOf('flags');
  const rows = timeline.rows;
  if (rows.length <= cap) return { timeline, hidden: 0 };

  const protectedRow = (row: unknown[]): boolean => {
    const seq = seqAt === -1 ? null : row[seqAt];
    if (typeof seq === 'number' && mustKeep.has(seq)) return true;
    const flags = flagsAt === -1 ? null : row[flagsAt];
    return Array.isArray(flags) && flags.some((f) => PROTECTED_FLAGS.includes(f as string));
  };

  const keep = new Array<boolean>(rows.length).fill(false);
  let kept = 0;
  for (let i = 0; i < rows.length; i++) {
    if (protectedRow(rows[i] as unknown[])) {
      keep[i] = true;
      kept++;
    }
  }
  for (let i = rows.length - 1; i >= 0 && kept < cap; i--) {
    if (!keep[i]) {
      keep[i] = true;
      kept++;
    }
  }

  const out: unknown[][] = [];
  let hidden = 0;
  let run = 0;
  for (let i = 0; i < rows.length; i++) {
    if (keep[i]) {
      if (run > 0) {
        out.push(gapRow(timeline.cols, run));
        run = 0;
      }
      out.push(rows[i] as unknown[]);
    } else {
      run++;
      hidden++;
    }
  }
  if (run > 0) out.push(gapRow(timeline.cols, run));
  return { timeline: { cols: timeline.cols, rows: out }, hidden };
}

/**
 * Applies the §11.1 budget to a payload: measures it, and — only while it
 * serialises above the hard cap — applies the degradation stages in order,
 * stopping as soon as the payload fits. Returns the (possibly copied and
 * degraded) payload plus the report; the input is never mutated.
 */
export function applyBudget(
  payload: ReportPayload,
  fullKeys: ReadonlySet<string>,
  limits: Partial<BudgetLimits> = {},
): { payload: ReportPayload; report: BudgetReport } {
  const { soft, hard, rowCap } = { ...DEFAULT_LIMITS, ...limits };
  const degraded: string[] = [];
  const hiddenRows: Record<string, number> = {};
  let current = payload;
  let total = bytesOf(current);

  // Stage 1: drop timelines beyond the --full set.
  if (total > hard) {
    const kept: Record<string, Timeline> = {};
    let dropped = 0;
    for (const [key, tl] of Object.entries(current.timelines)) {
      if (fullKeys.has(key)) kept[key] = tl;
      else dropped++;
    }
    if (dropped > 0) {
      current = { ...current, timelines: kept };
      degraded.push(DEGRADE_TIMELINES);
      total = bytesOf(current);
    }
  }

  // Stage 2: cap every remaining timeline at rowCap, keeping referenced/flagged rows.
  if (total > hard) {
    const capped: Record<string, Timeline> = {};
    let changed = false;
    for (const [key, tl] of Object.entries(current.timelines)) {
      const { timeline, hidden } = capTimeline(tl, referencedSeqs(current.receipts[key]), rowCap);
      capped[key] = timeline;
      if (hidden > 0) {
        hiddenRows[key] = hidden;
        changed = true;
      }
    }
    if (changed) {
      current = { ...current, timelines: capped };
      degraded.push(DEGRADE_ROWS);
      total = bytesOf(current);
    }
  }

  // Stage 3: drop finalText outside the --full set.
  if (total > hard) {
    const receipts: Record<string, Receipt> = {};
    let changed = false;
    for (const [key, receipt] of Object.entries(current.receipts)) {
      if (!fullKeys.has(key) && receipt.finalText !== '') {
        receipts[key] = { ...receipt, finalText: '' };
        changed = true;
      } else {
        receipts[key] = receipt;
      }
    }
    if (changed) {
      current = { ...current, receipts };
      degraded.push(DEGRADE_FINAL_TEXT);
      total = bytesOf(current);
    }
  }

  const sections = measureSections(current);
  return {
    payload: current,
    report: {
      sections,
      softExceeded: sections.total > soft,
      overCap: sections.total > hard,
      degraded,
      hiddenRows,
    },
  };
}
