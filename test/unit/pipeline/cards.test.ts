/**
 * S18 — `pipeline/cards.ts`: session-card composition (worst verdict across
 * done turns, `—` for `no-turns`/`no-final`) and the rate-row delegation.
 */
import { describe, expect, it } from 'vitest';
import type { Receipt } from '../../../src/model/types.js';
import { buildRateRows, buildSessionCard, sessionKey } from '../../../src/pipeline/cards.js';
import { claim, judgementOf, receipt, session, turn } from '../reconcile/harness.js';

function receiptsOf(...entries: [number, Receipt][]): Map<number, Receipt> {
  return new Map(entries);
}

describe('buildSessionCard', () => {
  it('takes the worst verdict across done turns', () => {
    const s = session();
    const card = buildSessionCard(
      s,
      receiptsOf(
        [0, receipt({ turnIndex: 0, verdict: 'VERIFIED', claimsRecognized: 2 })],
        [1, receipt({ turnIndex: 1, verdict: 'CONTRADICTED', claimsRecognized: 3 })],
      ),
    );
    expect(card.verdict).toBe('CONTRADICTED');
    expect(card.claims).toBe(5);
    expect(card.turns).toBe(2);
    expect(card.doneTurns).toBe(2);
    expect(card.kind).toBe('scored');
  });

  it('UNVERIFIED outranks VERIFIED but not CONTRADICTED', () => {
    const s = session();
    const card = buildSessionCard(
      s,
      receiptsOf([0, receipt({ turnIndex: 0, verdict: 'UNVERIFIED' })], [1, receipt({ turnIndex: 1, verdict: 'VERIFIED' })]),
    );
    expect(card.verdict).toBe('UNVERIFIED');
  });

  it('NO_CLAIMS-only sessions show NO_CLAIMS, sessions without receipts show —', () => {
    const s = session();
    const noClaims = buildSessionCard(s, receiptsOf([1, receipt({ turnIndex: 1, verdict: 'NO_CLAIMS', kind: 'no-claims' })]));
    expect(noClaims.verdict).toBe('NO_CLAIMS');
    expect(noClaims.kind).toBe('no-claims');

    const undone = session({ turns: [turn({ index: 0, isDone: false, finalText: null, finalSeq: null })] });
    const none = buildSessionCard(undone, new Map());
    expect(none.verdict).toBe('—');
    expect(none.kind).toBe('no-final');
    expect(none.doneTurns).toBe(0);
  });

  it('no-turns sessions show — with kind no-turns', () => {
    const s = session({ turns: [], kind: 'no-turns', records: 12 });
    const card = buildSessionCard(s, new Map());
    expect(card.verdict).toBe('—');
    expect(card.kind).toBe('no-turns');
    expect(card.turns).toBe(0);
  });

  it('carries the session-level cost and the ≈ flag from the receipts', () => {
    const s = session();
    const r = receipt({ turnIndex: 1, verdict: 'VERIFIED' });
    r.cost = { ...r.cost, usd: 1.25, unverified: true };
    const card = buildSessionCard(s, receiptsOf([1, r]));
    expect(card.costUsd).toBe(1.25);
    expect(card.unverified).toBe(true);
  });
});

describe('buildRateRows', () => {
  it('delegates to aggregateRate over the receipt index', () => {
    const s = session();
    const done = receipt({
      turnIndex: 1,
      kind: 'scored',
      claims: [claim({ id: 'c1' })],
      judgements: [judgementOf({ claimId: 'c1', verdict: 'CONTRADICTED', reason: 'last-run-red' })],
    });
    const rows = buildRateRows([s], new Map([[sessionKey(s), new Map([[1, done]])]]));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.doneTurns).toBe(1);
    expect(rows[0]?.contradictedTurns).toBe(1);
    expect(rows[0]?.turns).toBe(2);
  });
});
