/**
 * S17 — `reconcile/rate.ts` (§5.4): done-turn accounting, trigger splits,
 * percentage hiding below 10 done turns, effects-only ledger exclusion,
 * cost-per-done-turn statistics and per-row session aggregates.
 */
import { describe, expect, it } from 'vitest';
import type { Receipt, Session } from '../../../src/model/types.js';
import { aggregateRate, formatRate, sessionKey } from '../../../src/reconcile/rate.js';
import { claim, emptyCost, emptyLedger, judgementOf, receipt, session, testRun, totals, turn } from './harness.js';

/** A receipts index for one session. */
function indexOf(s: Session, receipts: Receipt[]): Map<string, Map<number, Receipt>> {
  return new Map([[sessionKey(s), new Map(receipts.map((r) => [r.turnIndex, r]))]]);
}

/** A session with `n` done-looking turns and one test run. */
function sessionWithTurns(n: number, over: Partial<Session> = {}): Session {
  return session({
    turns: Array.from({ length: n }, (_v, i) =>
      turn({ index: i, promptId: `p${i}`, seqStart: i * 10 + 1, seqEnd: i * 10 + 9, finalSeq: i * 10 + 8 })
    ),
    ledger: emptyLedger({ testRuns: [testRun({ seq: 5 })] }),
    usage: totals({ input: 800, cacheRead: 200 }),
    ...over,
  });
}

describe('aggregateRate (§5.4)', () => {
  it('accounts done turns, verdict buckets, reasons, cost and cache hit', () => {
    const s = sessionWithTurns(12);
    const receipts = Array.from({ length: 12 }, (_v, i) =>
      receipt({
        turnIndex: i,
        claims: [claim({ id: `c${i}` })],
        judgements: [
          judgementOf({
            claimId: `c${i}`,
            verdict: i < 3 ? 'CONTRADICTED' : i < 9 ? 'VERIFIED' : 'UNVERIFIED',
            reason: i < 3 ? 'last-run-red' : i < 9 ? 'ok' : 'stale-run',
          }),
        ],
        cost: emptyCost({ usd: 0.5 + 0.1 * i }),
      })
    );
    const rows = aggregateRate([s], indexOf(s, receipts));
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row?.model).toBe('claude-sonnet-4-5');
    expect(row?.harness).toBe('claude-code');
    expect(row?.harnessVersion).toBe('2.1.215');
    expect(row?.sessions).toBe(1);
    expect(row?.turns).toBe(12);
    expect(row?.doneTurns).toBe(12);
    expect(row?.doneTurnsByTrigger).toEqual({ claims: 12, markerOnly: 0 });
    expect(row?.contradictedTurns).toBe(3);
    expect(row?.cleanTurns).toBe(6);
    expect(row?.unverifiedTurns).toBe(3);
    expect(row?.claims.total).toBe(12);
    expect(row?.claims.byKind.test).toBe(12);
    const kindSum = Object.values(row?.claims.byKind ?? {}).reduce((a, b) => a + b, 0);
    expect(kindSum).toBe(row?.claims.total);
    expect(row?.contradictionReasons).toEqual({ 'last-run-red': 3 });
    expect(row?.testRunRate).toBe(1);
    expect(row?.costPerDoneTurnUsd?.median).toBeCloseTo(1.05, 10);
    expect(row?.costPerDoneTurnUsd?.mean).toBeCloseTo(1.05, 10);
    expect(row?.cacheHitPct).toBeCloseTo(20, 10);
    expect(row?.ledgerIncompleteSessions).toBe(0);
  });

  it('byTrigger sums equal doneTurns and record notification finals (acceptance)', () => {
    const s = sessionWithTurns(12);
    s.turns = s.turns.map((t) => (t.index >= 10 ? { ...t, finalTrigger: 'notification' as const } : t));
    const receipts = s.turns.map((t) =>
      receipt({ turnIndex: t.index, claims: [claim({ id: 'c1' })], judgements: [judgementOf({ claimId: 'c1' })] })
    );
    const [row] = aggregateRate([s], indexOf(s, receipts));
    expect(row?.byTrigger).toEqual({ human: 10, notification: 2 });
    expect((row?.byTrigger.human ?? 0) + (row?.byTrigger.notification ?? 0)).toBe(row?.doneTurns);
    expect((row?.doneTurnsByTrigger.claims ?? 0) + (row?.doneTurnsByTrigger.markerOnly ?? 0)).toBe(row?.doneTurns);
  });

  it('turns without receipts, no-claims receipts and NOT_SCORED-only receipts are not done turns', () => {
    const s = sessionWithTurns(3);
    const receipts = [
      receipt({ turnIndex: 1, kind: 'no-claims' }),
      receipt({
        turnIndex: 2,
        claims: [claim({ id: 'c1', polarity: 'negated' })],
        judgements: [judgementOf({ claimId: 'c1', verdict: 'NOT_SCORED', reason: 'not-scored' })],
      }),
    ];
    const [row] = aggregateRate([s], indexOf(s, receipts));
    expect(row?.turns).toBe(3);
    expect(row?.doneTurns).toBe(0);
  });

  it('a completion marker alone makes a markerOnly done turn, counted unverified', () => {
    const s = sessionWithTurns(1);
    const receipts = [
      receipt({
        turnIndex: 0,
        claims: [claim({ id: 'c1', kind: 'completion', rule: 'done.marker' })],
        judgements: [judgementOf({ claimId: 'c1', verdict: 'NOT_SCORED', reason: 'not-scored' })],
      }),
    ];
    const [row] = aggregateRate([s], indexOf(s, receipts));
    expect(row?.doneTurns).toBe(1);
    expect(row?.doneTurnsByTrigger).toEqual({ claims: 0, markerOnly: 1 });
    expect(row?.unverifiedTurns).toBe(1);
    expect(row?.cleanTurns).toBe(0);
  });

  it('effects-only ledger sessions are excluded from the rate and counted (acceptance)', () => {
    const effectsOnly = session({
      source: 'ledger',
      sessionId: 'ledger-1',
      transcriptPath: null,
      turns: [turn({ finalText: null })],
    });
    const partial = session({
      source: 'ledger',
      sessionId: 'ledger-2',
      transcriptPath: null,
      ledgerCoverage: 'partial',
      turns: [turn()],
    });
    const rows = aggregateRate([effectsOnly, partial], new Map());
    expect(rows.length).toBe(1);
    expect(rows[0]?.ledgerIncompleteSessions).toBe(2);
    expect(rows[0]?.turns).toBe(0);
    expect(rows[0]?.doneTurns).toBe(0);
    expect(rows[0]?.sessions).toBe(0);
    expect(rows[0]?.testRunRate).toBeNull();
  });

  it('an included ledger session never contributes cost (§5.4: null for ledger sessions)', () => {
    const s = session({
      source: 'ledger',
      sessionId: 'ledger-3',
      transcriptPath: null,
      ledgerCoverage: 'all-tools',
      turns: [turn({ costUsd: 2 })],
    });
    const receipts = [
      receipt({ turnIndex: 1, claims: [claim({ id: 'c1' })], judgements: [judgementOf({ claimId: 'c1' })], cost: emptyCost({ usd: 2 }) }),
    ];
    const [row] = aggregateRate([s], indexOf(s, receipts));
    expect(row?.doneTurns).toBe(1);
    expect(row?.costPerDoneTurnUsd).toBeNull();
  });

  it('falls back to Turn.costUsd when the receipt has no priced cost', () => {
    const s = sessionWithTurns(1);
    s.turns = [{ ...(s.turns[0] as Session['turns'][number]), costUsd: 3.5 }];
    const receipts = [receipt({ turnIndex: 0, claims: [claim({ id: 'c1' })], judgements: [judgementOf({ claimId: 'c1' })] })];
    const [row] = aggregateRate([s], indexOf(s, receipts));
    expect(row?.costPerDoneTurnUsd).toEqual({ median: 3.5, mean: 3.5 });
  });

  it('groups by the turn-dominant model (output tokens) and sorts rows deterministically', () => {
    const s = sessionWithTurns(2);
    s.turns = s.turns.map((t, i) =>
      i === 0
        ? { ...t, usage: totals({ byModel: { 'claude-opus-4-1': totals({ output: 900 }), 'claude-haiku-4-5': totals({ output: 20 }) } }) }
        : t
    );
    const receipts = s.turns.map((t) =>
      receipt({ turnIndex: t.index, claims: [claim({ id: 'c1' })], judgements: [judgementOf({ claimId: 'c1' })] })
    );
    const rows = aggregateRate([s], indexOf(s, receipts));
    expect(rows.map((r) => r.model)).toEqual(['claude-opus-4-1', 'claude-sonnet-4-5']);
    expect(rows.map((r) => r.doneTurns)).toEqual([1, 1]);
    // the session counts once per row it contributes turns to
    expect(rows.map((r) => r.sessions)).toEqual([1, 1]);
  });

  it('counts integrity signals once per contributing session, not per turn', () => {
    const s = sessionWithTurns(3, {
      ledger: emptyLedger({
        integrity: [
          { seq: 5, kind: 'skip-added', detail: 'skip added' },
          { seq: 6, kind: 'only-added', detail: 'only added' },
        ],
      }),
    });
    const [row] = aggregateRate([s], new Map());
    expect(row?.integritySignals).toBe(2);
  });

  it('cacheHitPct is null without tokens', () => {
    const s = sessionWithTurns(1, { usage: totals() });
    const [row] = aggregateRate([s], new Map());
    expect(row?.cacheHitPct).toBeNull();
  });
});

describe('formatRate (§5.4 display)', () => {
  it('hides the percentage below 10 done turns (acceptance)', () => {
    const s = sessionWithTurns(4);
    const receipts = s.turns.map((t) =>
      receipt({
        turnIndex: t.index,
        claims: [claim({ id: 'c1' })],
        judgements: [judgementOf({ claimId: 'c1', verdict: t.index < 3 ? 'CONTRADICTED' : 'VERIFIED', reason: t.index < 3 ? 'last-run-red' : 'ok' })],
      })
    );
    const [row] = aggregateRate([s], indexOf(s, receipts));
    expect(formatRate(row!)).toBe('—  (3 of 4)');
  });

  it('prints the §5.4 sentence at 10+ done turns and rounds the percentage', () => {
    const s = sessionWithTurns(12);
    const receipts = s.turns.map((t) =>
      receipt({
        turnIndex: t.index,
        claims: [claim({ id: 'c1' })],
        judgements: [judgementOf({ claimId: 'c1', verdict: t.index < 3 ? 'CONTRADICTED' : 'VERIFIED', reason: t.index < 3 ? 'last-run-red' : 'ok' })],
      })
    );
    const [row] = aggregateRate([s], indexOf(s, receipts));
    expect(formatRate(row!)).toBe('3 of 12 done turns contradicted (25%)');
  });

  it('pads to cols without truncating', () => {
    const s = sessionWithTurns(4);
    const receipts = s.turns.map((t) =>
      receipt({ turnIndex: t.index, claims: [claim({ id: 'c1' })], judgements: [judgementOf({ claimId: 'c1' })] })
    );
    const [row] = aggregateRate([s], indexOf(s, receipts));
    const padded = formatRate(row!, 24);
    expect(padded.length).toBe(24);
    expect(padded.trimEnd()).toBe('—  (0 of 4)');
    expect(formatRate(row!, 3)).toBe('—  (0 of 4)');
  });
});
