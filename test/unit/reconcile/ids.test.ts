/**
 * S17 — judgement identity and shape invariants over the 48 fixtures
 * (claim↔judgement 1:1, `Reason` enum membership, `EvidenceRef` targets,
 * deterministic ordering, stability), the §4.8 row dispatch numbers, and
 * `explain()` payloads (§5.1).
 */
import { describe, expect, it } from 'vitest';
import type { Claim, Reason, Verdict } from '../../../src/model/types.js';
import { explain } from '../../../src/reconcile/explain.js';
import { reconcile, rowNumberFor } from '../../../src/reconcile/reconcile.js';
import { claim, claimsOf, judgementOf, listReconcileFixtures, readReconcileFixture, session, sessionOf } from './harness.js';

const REASONS = new Set<Reason>([
  'ok',
  'ok-deleted-later',
  'no-evidence',
  'no-test-run',
  'last-run-red',
  'stale-run',
  'exit-unknown',
  'run-in-background',
  'count-short',
  'check-red',
  'no-check-run',
  'no-write-to-path',
  'write-failed',
  'ambiguous-path',
  'file-not-deleted',
  'no-git-op',
  'git-op-failed',
  'sha-mismatch',
  'commit-precedes-edits',
  'push-precedes-commit',
  'no-command',
  'command-failed',
  'no-run-after-write',
  'writes-despite-no-change',
  'echoed',
  'partial',
  'not-scored',
  'ledger-incomplete',
  'write-not-observable',
]);
const VERDICTS = new Set<Verdict>(['VERIFIED', 'UNVERIFIED', 'CONTRADICTED', 'NOT_SCORED']);

describe('judgement invariants over every fixture (§3, S17 review checklist)', () => {
  for (const file of listReconcileFixtures()) {
    const fix = readReconcileFixture(file);
    it(file, () => {
      const s = sessionOf(fix);
      const claims = claimsOf(fix);
      const judgements = reconcile(s, fix.turnIndex ?? 1, claims);

      // 1:1 with the claims, in position order.
      expect(judgements.map((j) => j.claimId).sort()).toEqual(claims.map((c) => c.id).sort());
      const positions = new Map(claims.map((c) => [c.id, c.position]));
      const seen = judgements.map((j) => positions.get(j.claimId) as number);
      expect([...seen]).toEqual([...seen].sort((a, b) => a - b));

      // Enum membership only — never free-form strings.
      const callIds = new Set(s.toolCalls.map((c) => c.id));
      for (const j of judgements) {
        expect(REASONS.has(j.reason)).toBe(true);
        expect(VERDICTS.has(j.verdict)).toBe(true);
        for (const ref of j.evidence) {
          if (ref.toolCallId !== undefined) expect(callIds.has(ref.toolCallId)).toBe(true);
        }
      }

      // Stable across runs.
      expect(reconcile(s, fix.turnIndex ?? 1, claims)).toEqual(judgements);
    });
  }

  it('orders judgements by claim position regardless of input order (ties by id)', () => {
    const s = session();
    const a = claim({ id: 'zz11', position: 2 });
    const b = claim({ id: 'aa22', position: 0 });
    const c = claim({ id: 'aa11', position: 2 });
    expect(reconcile(s, 1, [a, b, c]).map((j) => j.claimId)).toEqual(['aa22', 'aa11', 'zz11']);
  });

  it('an unknown turn index yields NOT_SCORED judgements, never a throw', () => {
    const s = session();
    const judgements = reconcile(s, 9, [claim({ id: 'c1' })]);
    expect(judgements).toEqual([{ claimId: 'c1', verdict: 'NOT_SCORED', reason: 'not-scored', evidence: [], text: 'turn not found', notes: [] }]);
  });

  it('a claim no row covers falls back to UNVERIFIED with the rule named', () => {
    const s = session();
    const [j] = reconcile(s, 1, [claim({ id: 'c1', kind: 'test', rule: 'future.rule' })]);
    expect(j?.verdict).toBe('UNVERIFIED');
    expect(j?.reason).toBe('no-evidence');
    expect(j?.notes).toContain('unhandled rule future.rule');
  });
});

describe('§4.8 row dispatch (rowNumberFor)', () => {
  const cases: [Partial<Claim> & { id: string }, number][] = [
    [{ id: 'c', kind: 'test', rule: 'test.pass' }, 1],
    [{ id: 'c', kind: 'test', rule: 'test.counts', count: 3 }, 2],
    [{ id: 'c', kind: 'test-ran', rule: 'test.ran' }, 3],
    [{ id: 'c', kind: 'test-added', rule: 'test.added' }, 4],
    [{ id: 'c', kind: 'check', rule: 'check.lint', family: 'lint', tool: 'ruff' }, 5],
    [{ id: 'c', kind: 'check', rule: 'check.lint', family: 'lint' }, 6],
    [{ id: 'c', kind: 'file', rule: 'file.verb', verb: 'create', subject: 'a.py' }, 7],
    [{ id: 'c', kind: 'file', rule: 'file.verb', verb: 'update', subject: 'a.py' }, 8],
    [{ id: 'c', kind: 'file', rule: 'file.implemented_in', verb: 'update', subject: 'a.py' }, 8],
    [{ id: 'c', kind: 'file', rule: 'file.verb', verb: 'delete', subject: 'a.py' }, 9],
    [{ id: 'c', kind: 'file', rule: 'file.verb', verb: 'rename', subject: 'b.py' }, 10],
    [{ id: 'c', kind: 'file-count', rule: 'file.count', count: 2 }, 11],
    [{ id: 'c', kind: 'command', rule: 'command.ran', subject: 'pytest' }, 12],
    [{ id: 'c', kind: 'command', rule: 'command.ran_bare', subject: 'build' }, 13],
    [{ id: 'c', kind: 'install', rule: 'install.pkg', subject: 'left-pad' }, 14],
    [{ id: 'c', kind: 'git', rule: 'git.commit', op: 'commit' }, 15],
    [{ id: 'c', kind: 'git', rule: 'git.push', op: 'push' }, 16],
    [{ id: 'c', kind: 'git', rule: 'git.pr', op: 'pr' }, 17],
    [{ id: 'c', kind: 'git', rule: 'git.branch', op: 'branch' }, 18],
    [{ id: 'c', kind: 'git', rule: 'git.tag', op: 'tag' }, 18],
    [{ id: 'c', kind: 'verification', rule: 'verify.generic' }, 19],
    [{ id: 'c', kind: 'verification', rule: 'verify.with_cmd', subject: 'pytest -q' }, 20],
    [{ id: 'c', kind: 'no-change', rule: 'nochange.marker' }, 21],
    [{ id: 'c', kind: 'completion', rule: 'done.marker' }, 22],
    [{ id: 'c', kind: 'test', rule: 'test.pass', polarity: 'negated' }, 23],
    [{ id: 'c', kind: 'test', rule: 'test.pass', attribution: 'other' }, 23],
    [{ id: 'c', kind: 'test', rule: 'test.pass', echoed: true }, 24],
    [{ id: 'c', kind: 'test', rule: 'future.rule' }, 0],
  ];
  for (const [partial, row] of cases) {
    it(`${partial.rule ?? partial.kind}${partial.echoed === true ? ' (echoed)' : ''}${partial.polarity === 'negated' ? ' (negated)' : ''}${
      partial.attribution === 'other' ? ' (other)' : ''
    } → row ${row}`, () => {
      expect(rowNumberFor(claim(partial))).toBe(row);
    });
  }
});

describe('explain (§5.1, S17 instruction 4)', () => {
  const c = claim({ id: 'c1' });
  const j = judgementOf({ claimId: 'c1', verdict: 'VERIFIED', reason: 'ok', text: 'conclusive green run after the last edit' });

  it('re-derives trigger and cue from the final text and names the §4.8 row', () => {
    const e = explain(c, j, { finalText: 'Tests pass.' });
    expect(e.claimId).toBe('c1');
    expect(e.rule).toBe('test.pass');
    expect(e.trigger).not.toBe('');
    expect(e.cue).toBe('');
    expect(e.polarity).toBe('positive');
    expect(e.attribution).toBe('agent');
    expect(e.row).toBe(1);
    expect(e.why).toBe('VERIFIED (ok) — conclusive green run after the last edit');
  });

  it('defaults factsExamined to the evidence labels and notes', () => {
    const withEvidence = judgementOf({
      claimId: 'c1',
      evidence: [{ seq: 40, label: 'uv run pytest → exit 0 · 41 passed', at: '2026-03-01T23:41:00.000Z' }],
      notes: ['+1 later partial run'],
    });
    const e = explain(c, withEvidence);
    expect(e.factsExamined).toEqual(['uv run pytest → exit 0 · 41 passed', '+1 later partial run']);
    expect(e.trigger).toBe('');
  });

  it('passes explicit factsExamined through and keeps the why terse without text', () => {
    const e = explain(c, judgementOf({ claimId: 'c1', reason: 'no-evidence', verdict: 'UNVERIFIED' }), { factsExamined: ['testRuns: 0 in scope'] });
    expect(e.factsExamined).toEqual(['testRuns: 0 in scope']);
    expect(e.why).toBe('UNVERIFIED (no-evidence)');
  });

  it('reports row 24 for an echoed claim', () => {
    const echoed = claim({ id: 'c2', echoed: true });
    expect(explain(echoed, judgementOf({ claimId: 'c2', reason: 'echoed', verdict: 'UNVERIFIED' })).row).toBe(24);
  });
});
