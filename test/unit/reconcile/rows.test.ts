/**
 * S17 — the 48 `fixtures/reconcile` scenarios: each §4.8 row × positive /
 * negative, judged end-to-end through `reconcile()`. Also pins the S17
 * acceptance invariants over every fixture: every rendered evidence string
 * carries a `(HH:MM)` time, and neither `Judgement.text` nor an
 * `EvidenceRef.label` ever carries a formatted time (§4.8 vii).
 */
import { describe, expect, it } from 'vitest';
import type { Judgement } from '../../../src/model/types.js';
import { evidenceStrings } from '../../../src/reconcile/evidence.js';
import { reconcile } from '../../../src/reconcile/reconcile.js';
import { claimsOf, listReconcileFixtures, readReconcileFixture, sessionOf, TIME_RE } from './harness.js';

const files = listReconcileFixtures();

describe('fixtures/reconcile (§4.8 rows × positive/negative)', () => {
  it('ships 48 scenario fixtures (24 rows × 2)', () => {
    expect(files.length).toBe(48);
    const rows = new Set(files.map((f) => f.split('-')[0]));
    expect(rows.size).toBe(24);
  });

  for (const file of files) {
    const fix = readReconcileFixture(file);
    it(`${file} — ${fix.name}`, () => {
      const s = sessionOf(fix);
      const claims = claimsOf(fix);
      const judgements = reconcile(s, fix.turnIndex ?? 1, claims);
      expect(judgements.length).toBe(claims.length);

      const byId = new Map(judgements.map((j) => [j.claimId, j]));
      for (const exp of fix.expect) {
        const j = byId.get(exp.claimId) as Judgement;
        expect(j, `judgement for ${exp.claimId}`).toBeDefined();
        expect({ verdict: j.verdict, reason: j.reason }).toEqual({ verdict: exp.verdict, reason: exp.reason });
        const rendered = evidenceStrings(j, { subagents: s.subagents });
        if (exp.evidence !== undefined) expect(rendered).toEqual(exp.evidence);
        if (exp.notes !== undefined) expect(j.notes).toEqual(exp.notes);
        if (exp.integrity !== undefined) expect(j.integrity).toBe(exp.integrity);
        if (exp.textIncludes !== undefined) expect(j.text).toContain(exp.textIncludes);
      }

      for (const j of judgements) {
        // Acceptance: every evidence string carries a (HH:MM) time.
        for (const line of evidenceStrings(j, { subagents: s.subagents })) expect(line).toMatch(TIME_RE);
        // §4.8 vii: no formatted time in the judgement text or the raw labels.
        expect(j.text).not.toMatch(TIME_RE);
        for (const ref of j.evidence) {
          expect(ref.label).not.toMatch(TIME_RE);
          // Evidence never reaches past the final message.
          const finalSeq = s.turns.find((t) => t.index === (fix.turnIndex ?? 1))?.finalSeq ?? Infinity;
          expect(ref.seq).toBeLessThanOrEqual(finalSeq);
        }
      }
    });
  }
});
