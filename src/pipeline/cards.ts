/**
 * Session cards and rate rows (ARCHITECTURE §5.3–§5.4, S18): the one-row
 * summary of a session for the `audit` table and the HTML session list, and
 * the false-done-rate aggregation (delegated to S17's `aggregateRate`).
 * A card's verdict is the worst verdict across the session's done turns;
 * `no-turns` and sessions without a done turn show `—`.
 */
import type { RateRow, Receipt, Session, SessionCard } from '../model/types.js';
import { HARNESS_LABELS } from '../model/types.js';
import { aggregateRate, sessionKey, type ReceiptIndex } from '../reconcile/rate.js';
import { harnessVersionLabel } from './receipt.js';

export { sessionKey, type ReceiptIndex };

/** Worst-first order of scored receipt verdicts. */
const SCORED_ORDER: readonly Receipt['verdict'][] = ['CONTRADICTED', 'UNVERIFIED', 'VERIFIED'];

/** The worst verdict across a session's done-turn receipts, or `—` when none is scored or `NO_CLAIMS`-only. */
function worstVerdict(receipts: readonly Receipt[]): SessionCard['verdict'] {
  let worst: Receipt['verdict'] | null = null;
  let sawClaims = false;
  for (const r of receipts) {
    if (r.verdict === 'NO_CLAIMS') {
      sawClaims = true;
      continue;
    }
    if (!SCORED_ORDER.includes(r.verdict)) continue;
    if (worst === null || SCORED_ORDER.indexOf(r.verdict) < SCORED_ORDER.indexOf(worst)) worst = r.verdict;
  }
  if (worst !== null) return worst;
  return sawClaims ? 'NO_CLAIMS' : '—';
}

/**
 * Builds the session's card (§5.2) from its per-turn receipts (as
 * `buildTurnReceipts` produced them). `verdict` is the worst across done
 * turns; a `no-turns` session, and a session whose turns never finished,
 * carry `—`. Cost is the session-level cost every receipt shares.
 */
export function buildSessionCard(session: Session, receipts: ReadonlyMap<number, Receipt>): SessionCard {
  const list = [...receipts.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
  const latest = list[list.length - 1];
  const noTurns = session.kind !== 'normal';
  const card: SessionCard = {
    id: session.sessionId,
    shortId: session.shortId,
    harness: session.harness,
    harnessLabel: HARNESS_LABELS[session.harness],
    harnessVersion: harnessVersionLabel(session),
    model: session.primaryModel,
    cwd: session.cwd,
    title: session.title,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    turns: session.turns.length,
    doneTurns: session.turns.filter((t) => t.isDone).length,
    claims: list.reduce((sum, r) => sum + r.claimsRecognized, 0),
    verdict: noTurns || latest === undefined ? '—' : worstVerdict(list),
    costUsd: latest?.cost.usd ?? null,
    unverified: latest?.cost.unverified ?? false,
    kind: noTurns ? 'no-turns' : (latest?.kind ?? 'no-final'),
  };
  return card;
}

/**
 * The false-done rate rows over the scanned sessions (§5.4): a thin
 * delegation to S17's `aggregateRate`, keyed by `sessionKey(session)` and
 * turn index exactly as `buildTurnReceipts` returns them.
 */
export function buildRateRows(sessions: readonly Session[], receipts: ReceiptIndex): RateRow[] {
  return aggregateRate(sessions, receipts);
}
