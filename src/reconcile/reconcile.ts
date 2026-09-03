/**
 * The reconciler entry point (S17, §5.1): `reconcile(session, turnIndex,
 * claims)` runs the §4.8 table over the turn's evidence window — every event
 * with `seq ≤ finalSeq`, subagents included — and returns one `Judgement` per
 * claim in deterministic order (claim `position`, ties broken by id).
 *
 * Dispatch walks `RECONCILE_ROWS` front to back: NOT_SCORED claims (row 23)
 * and completion markers (row 22) never reach the evidence rows; echoed
 * scored claims route through row 24, which judges the underlying row and
 * downgrades a would-be CONTRADICTED to UNVERIFIED `echoed`.
 */
import type { Claim, Judgement, Session } from '../model/types.js';
import { buildFacts, EMPTY_PER_TURN, FALLBACK_ROW, RECONCILE_ROWS, type Row, type RowContext } from './rules.js';

/** The dispatch row for a claim (first `RECONCILE_ROWS` entry that applies). */
export function rowFor(claim: Claim): Row {
  for (const row of RECONCILE_ROWS) {
    if (row.appliesTo(claim)) return row;
  }
  return FALLBACK_ROW;
}

/** The §4.8 row number a claim is judged by (drives `Explanation.row`). */
export function rowNumberFor(claim: Claim): number {
  return rowFor(claim).row;
}

/** Deterministic claim order: message `position`, then id (§4.8, S17 instruction 3). */
function byPosition(a: Claim, b: Claim): number {
  if (a.position !== b.position) return a.position - b.position;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Judges every claim of one turn against the session's ledger (§4.8).
 * Evidence is scoped to `seq ≤ finalSeq` — events after the final message
 * (post-final subagent work, later test runs) never influence a verdict.
 * A `turnIndex` the session does not have yields NOT_SCORED judgements
 * rather than a throw (the pipeline never crashes on a bad receipt request).
 */
export function reconcile(session: Session, turnIndex: number, claims: readonly Claim[]): Judgement[] {
  const sorted = [...claims].sort(byPosition);
  const turn = session.turns.find((t) => t.index === turnIndex);
  if (turn === undefined) {
    return sorted.map((c) => ({ claimId: c.id, verdict: 'NOT_SCORED' as const, reason: 'not-scored' as const, evidence: [], text: 'turn not found', notes: [] }));
  }
  const facts = buildFacts(session, turn);
  const perTurn = session.ledger.perTurn[turnIndex] ?? { ...EMPTY_PER_TURN };
  return sorted.map((claim) => {
    const ctx: RowContext = { claim, claims: sorted, turn, session, ledger: session.ledger, perTurn, facts };
    return rowFor(claim).judge(ctx);
  });
}
