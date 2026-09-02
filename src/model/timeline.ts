/**
 * Timeline merge and per-turn windows (ARCHITECTURE §4.2.6, §5.2).
 *
 * Subagent events are inserted into the main sequence by the
 * **running-maximum timestamp envelope**: main records keep file order and
 * define a running maximum timestamp (anchored at every main entity that
 * carries a time — tool calls, usage rows, turn boundaries, PR refs); a
 * subagent event at time `t` is inserted after the last main event whose
 * running max is ≤ `t`. Ties break main first (the ≤ comparison), then by
 * timestamp within a gap, then `agentId` ascending, then file order; the
 * merge is a stable sort and `seq` is renumbered over the merged sequence
 * (unique per line, strictly increasing). Timestamps place only subagent
 * events — main-file order is never changed by timestamps, and `seq` is the
 * only ordering later code uses.
 *
 * Nested agents are placed by the same rule: their envelope position comes
 * from their own timestamps, not their parent agent's.
 */
import type { Session, ToolCall } from './types.js';
import { parseIso } from '../util/time.js';

/** One subagent transcript line that carries entities, at its epoch-ms time. */
export interface SubagentEvent {
  /** The line's seq inside its own file (pre-merge). */
  seq: number;
  /** Epoch ms of the line (inherited from the previous line when absent). */
  tsMs: number;
}

/** One subagent file's placeable events, in file order (ascending `seq`). */
export interface SubagentTimeline {
  agentId: string;
  events: SubagentEvent[];
}

/** What {@link mergeTimeline} returns: old → new seq maps for the callers' entities. */
export interface TimelineMerge {
  /** Per input file (same order): the file's old line seq → merged seq. */
  subSeqMaps: Map<number, number>[];
  /** Old main seq → merged seq (already applied to `main`; exposed for callers holding old seqs). */
  mainSeqOf: (seq: number) => number;
}

/** Applies `f` to every seq reference stored on the session (mutating). */
function remapSeqs(session: Session, f: (seq: number) => number): void {
  for (const call of session.toolCalls) call.seq = f(call.seq);
  for (const row of session.usageRows) row.seq = f(row.seq);
  for (const c of session.compactions) c.seq = f(c.seq);
  for (const p of session.prRefs) p.seq = f(p.seq);
  for (const e of session.editedFiles) e.seq = f(e.seq);
  for (const r of session.refusalFallbacks) r.seq = f(r.seq);
  for (const d of session.tokenDeltas) d.seq = f(d.seq);
  for (const seg of session.preamble) {
    seg.seqStart = f(seg.seqStart);
    seg.seqEnd = f(seg.seqEnd);
  }
  for (const turn of session.turns) {
    turn.seqStart = f(turn.seqStart);
    turn.seqEnd = f(turn.seqEnd);
    if (turn.finalSeq !== null) turn.finalSeq = f(turn.finalSeq);
    for (const seg of turn.segments) {
      seg.seqStart = f(seg.seqStart);
      seg.seqEnd = f(seg.seqEnd);
    }
  }
  const ledger = session.ledger;
  for (const w of ledger.writes) w.seq = f(w.seq);
  for (const c of ledger.commands) c.seq = f(c.seq);
  for (const t of ledger.testRuns) t.seq = f(t.seq);
  for (const c of ledger.checks) c.seq = f(c.seq);
  for (const g of ledger.git) g.seq = f(g.seq);
  for (const n of ledger.network) n.seq = f(n.seq);
  for (const i of ledger.integrity) i.seq = f(i.seq);
  for (const d of ledger.danger) d.seq = f(d.seq);
  if (ledger.lastWriteSeq !== null) ledger.lastWriteSeq = f(ledger.lastWriteSeq);
  if (ledger.lastSourceWriteSeq !== null) ledger.lastSourceWriteSeq = f(ledger.lastSourceWriteSeq);
  if (ledger.lastGreenSeq !== null) ledger.lastGreenSeq = f(ledger.lastGreenSeq);
}

/** A main-sequence position that carries a timestamp, with the running max applied. */
interface Anchor {
  seq: number;
  runningMax: number;
}

/**
 * The main session's timestamp anchors in seq order, with the running
 * maximum applied. Anchors come from the entities that carry both a seq and
 * a time: tool calls (`startedAt`), usage rows (`ts`), turn boundaries
 * (`startedAt` at `seqStart`, `endedAt` at `seqEnd`) and PR refs. Lines
 * between anchors inherit the previous running max, so inserting "after the
 * last main event whose running max ≤ t" means inserting immediately before
 * the first anchor whose running max exceeds `t`.
 */
function anchorsOf(session: Session): Anchor[] {
  const points: { seq: number; ts: number }[] = [];
  const add = (seq: number, iso: string): void => {
    if (iso === '') return;
    const ms = parseIso(iso);
    if (ms !== null) points.push({ seq, ts: ms });
  };
  for (const call of session.toolCalls) add(call.seq, call.startedAt);
  for (const row of session.usageRows) add(row.seq, row.ts);
  for (const turn of session.turns) {
    add(turn.seqStart, turn.startedAt);
    add(turn.seqEnd, turn.endedAt);
  }
  for (const p of session.prRefs) add(p.seq, p.time);
  points.sort((a, b) => a.seq - b.seq || a.ts - b.ts);
  const anchors: Anchor[] = [];
  let max = -Infinity;
  for (const p of points) {
    if (p.ts > max) max = p.ts;
    const last = anchors[anchors.length - 1];
    if (last !== undefined && last.seq === p.seq) last.runningMax = max;
    else anchors.push({ seq: p.seq, runningMax: max });
  }
  return anchors;
}

/**
 * Merges subagent events into the main session's sequence by the
 * running-maximum timestamp envelope (§4.2.6) and renumbers `seq` over the
 * merged sequence. The main session's seq fields are remapped **in place**
 * (order preserved — main order never changes); the returned maps tell the
 * caller where each subagent line landed so it can renumber and append its
 * entities. Events of one file must be passed in file order.
 */
export function mergeTimeline(main: Session, subagents: readonly SubagentTimeline[]): TimelineMerge {
  const anchors = anchorsOf(main);
  let maxSeq = -1;
  remapSeqs(main, (s) => {
    if (s > maxSeq) maxSeq = s;
    return s;
  });
  const afterAll = maxSeq + 1;

  /** The main seq the event is inserted before: first anchor with running max > t. */
  const gapOf = (t: number): number => {
    let lo = 0;
    let hi = anchors.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const a = anchors[mid];
      if (a !== undefined && a.runningMax > t) hi = mid;
      else lo = mid + 1;
    }
    const first = anchors[lo];
    return first === undefined ? afterAll : Math.min(first.seq, afterAll);
  };

  interface Placed {
    file: number;
    order: number;
    agentId: string;
    oldSeq: number;
    ts: number;
    gap: number;
  }
  const placed: Placed[] = [];
  subagents.forEach((sub, file) => {
    sub.events.forEach((event, order) => {
      placed.push({ file, order, agentId: sub.agentId, oldSeq: event.seq, ts: event.tsMs, gap: gapOf(event.tsMs) });
    });
  });
  // Stable order inside a gap: timestamp, then agentId ascending, then file order.
  placed.sort(
    (a, b) =>
      a.gap - b.gap ||
      a.ts - b.ts ||
      (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0) ||
      a.file - b.file ||
      a.order - b.order,
  );

  const gaps = placed.map((p) => p.gap); // ascending after the sort
  /** Number of subagent events inserted at main positions ≤ `s`. */
  const insertedUpTo = (s: number): number => {
    let lo = 0;
    let hi = gaps.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((gaps[mid] ?? Infinity) <= s) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const mainSeqOf = (s: number): number => s + insertedUpTo(s);
  remapSeqs(main, mainSeqOf);

  const subSeqMaps: Map<number, number>[] = subagents.map(() => new Map<number, number>());
  placed.forEach((p, i) => {
    subSeqMaps[p.file]?.set(p.oldSeq, p.gap + i);
  });
  return { subSeqMaps, mainSeqOf };
}

/**
 * The evidence window of one turn (§5.2): `seqStart` from the turn itself,
 * `seqEnd` extended over every tool call attributed to the turn (merged
 * subagent events may run past the transcript group's own range), and the
 * turn's `finalSeq`. Returns `null` for an out-of-range index.
 */
export function turnWindow(session: Session, turnIndex: number): { seqStart: number; seqEnd: number; finalSeq: number | null } | null {
  const turn = session.turns[turnIndex];
  if (turn === undefined) return null;
  let seqEnd = turn.seqEnd;
  for (const call of session.toolCalls) {
    if (call.turnIndex === turnIndex && call.seq > seqEnd) seqEnd = call.seq;
  }
  return { seqStart: turn.seqStart, seqEnd, finalSeq: turn.finalSeq };
}

/**
 * The session's tool calls at or before `seq`, in seq order. The boundary is
 * inclusive so the §5.2 evidence window is `eventsBefore(session, finalSeq)`.
 */
export function eventsBefore(session: Session, seq: number): ToolCall[] {
  return session.toolCalls.filter((call) => call.seq <= seq).sort((a, b) => a.seq - b.seq);
}

/**
 * Marks every tool call whose `turnIndex` is a turn with a final but whose
 * `seq` exceeds that turn's `finalSeq` as `postFinal: true` (§5.2 — async
 * subagents still running after the final message). Derived purely from
 * `seq > finalSeq`; `turnIndex` itself always comes from the stamped
 * promptId, never from placement.
 */
export function markPostFinal(session: Session): void {
  for (const call of session.toolCalls) {
    const turn = session.turns[call.turnIndex];
    if (turn !== undefined && turn.finalSeq !== null && call.seq > turn.finalSeq) call.postFinal = true;
  }
}
