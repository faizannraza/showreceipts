/**
 * Closing-review regressions (Pass 1): every scenario here was a wrong
 * verdict or a false evidence line produced by the shipped rules —
 *
 *  - a TRUE "committed as <sha>" claim CONTRADICTED because the cited commit
 *    preceded later writes while a second commit followed;
 *  - a sha claim CONTRADICTED although the only commit's sha was never
 *    printed (`git commit -q`, sha:null);
 *  - "tests pass" / "ran the tests" CONTRADICTED `no-test-run` although a
 *    snapshot-update run (`vitest run -u`) was in the log;
 *  - "tests pass" VERIFIED off an earlier green run while a later conclusive
 *    red run existed in the same window;
 *  - the `git commit && git push` single-call idiom downgraded to
 *    `push-precedes-commit` (both facts share the call's seq);
 *  - "no git push in log" printed although a push existed (wrong branch);
 *  - a source file named `license_check.py` swallowed by the LICENSE
 *    staleness exemption, leaving a stale green run VERIFIED.
 */
import { describe, expect, it } from 'vitest';
import type { Claim, Session } from '../../../src/model/types.js';
import { reconcile } from '../../../src/reconcile/reconcile.js';
import { claim, CWD, sessionOf, type ReconcileFixture } from './harness.js';

const AT = (hhmm: string): string => `2026-03-01T${hhmm}:00.000Z`;

function build(ledger: NonNullable<ReconcileFixture['ledger']>, over: Partial<ReconcileFixture> = {}): Session {
  return sessionOf({ name: 'inline', row: 0, claims: [], expect: [], ...over, ledger });
}

function judge(s: Session, c: Claim | Claim[]): ReturnType<typeof reconcile> {
  return reconcile(s, 1, Array.isArray(c) ? c : [c]);
}

const commitClaim = (over: Partial<Claim> = {}): Claim =>
  claim({ id: 'c1', kind: 'git', rule: 'git.commit', op: 'commit', sentence: 'Committed.', clause: 'committed', ...over });
const pushClaim = (over: Partial<Claim> = {}): Claim =>
  claim({ id: 'c2', kind: 'git', rule: 'git.push', op: 'push', sentence: 'Pushed.', clause: 'pushed', ...over });

describe('git.commit sha claims need positive contrary evidence (row 15)', () => {
  const twoCommits = {
    writes: [
      { seq: 20, at: AT('17:31') },
      { seq: 40, at: AT('17:40'), path: `${CWD}/src/other.py` },
    ],
    git: [
      { seq: 30, at: AT('17:35'), op: 'commit' as const, ok: true, sha: 'aaaaaaa1111111' },
      { seq: 50, at: AT('17:45'), op: 'commit' as const, ok: true, sha: 'bbbbbbb2222222' },
    ],
  };

  it('a TRUE earlier-commit sha is never sha-mismatch — UNVERIFIED commit-precedes-edits citing the match', () => {
    const [j] = judge(build(twoCommits), commitClaim({ sha: 'aaaaaaa' }));
    expect(j?.verdict).toBe('UNVERIFIED');
    expect(j?.reason).toBe('commit-precedes-edits');
    expect(j?.text).toContain('commit matches but precedes');
    expect(j?.evidence[0]?.label).toBe('git commit → aaaaaaa');
  });

  it('the second sha of the same message verifies against its own commit', () => {
    const out = judge(build(twoCommits), [commitClaim({ sha: 'aaaaaaa', position: 0 }), commitClaim({ id: 'c2', sha: 'bbbbbbb', position: 1 })]);
    expect(out.map((j) => j.verdict)).toEqual(['UNVERIFIED', 'VERIFIED']);
  });

  it('an unprinted sha (git commit -q) is never a mismatch — UNVERIFIED "commit sha not printed"', () => {
    const s = build({
      writes: [{ seq: 20, at: AT('17:31') }],
      git: [{ seq: 50, at: AT('17:45'), op: 'commit', ok: true, sha: null }],
    });
    const [j] = judge(s, commitClaim({ sha: 'deadbee' }));
    expect(j?.verdict).toBe('UNVERIFIED');
    expect(j?.reason).toBe('exit-unknown');
    expect(j?.text).toBe('commit sha not printed');
  });

  it('a mixed known+unknown sha set still cannot contradict', () => {
    const s = build({
      writes: [{ seq: 20, at: AT('17:31') }],
      git: [
        { seq: 40, at: AT('17:40'), op: 'commit', ok: true, sha: 'ccccccc3333333' },
        { seq: 50, at: AT('17:45'), op: 'commit', ok: true, sha: null },
      ],
    });
    const [j] = judge(s, commitClaim({ sha: 'aaaaaaa' }));
    expect(j?.verdict).toBe('UNVERIFIED');
    expect(j?.reason).toBe('exit-unknown');
  });

  it('every sha known and none matching stays CONTRADICTED sha-mismatch', () => {
    const s = build({
      writes: [{ seq: 20, at: AT('17:31') }],
      git: [{ seq: 50, at: AT('17:45'), op: 'commit', ok: true, sha: 'bbbbbbb2222222' }],
    });
    const [j] = judge(s, commitClaim({ sha: 'aaaaaaa' }));
    expect(j?.verdict).toBe('CONTRADICTED');
    expect(j?.reason).toBe('sha-mismatch');
  });
});

describe('snapshot-update runs block the no-test-run contradiction (rows 1/3, §4.5.6)', () => {
  const snapshotOnly = {
    writes: [{ seq: 20, at: AT('17:31') }],
    testRuns: [
      {
        seq: 40,
        at: AT('17:40'),
        runner: 'vitest',
        command: 'vitest run -u',
        kind: 'snapshot-update' as const,
        exitCode: 0,
        green: false as const,
        note: 'snapshot update run (not evidence)',
      },
    ],
  };

  it('"tests pass" is UNVERIFIED citing the snapshot run, never CONTRADICTED', () => {
    const [j] = judge(build(snapshotOnly), claim({ id: 'c1' }));
    expect(j?.verdict).toBe('UNVERIFIED');
    expect(j?.reason).toBe('no-evidence');
    expect(j?.text).toBe('only a snapshot-update run in log');
    expect(j?.notes).toContain('snapshot update run (not evidence)');
    expect(j?.evidence[0]?.label).toContain('vitest run -u');
  });

  it('"ran the tests" gets the same treatment', () => {
    const [j] = judge(build(snapshotOnly), claim({ id: 'c1', kind: 'test-ran', rule: 'test.ran', sentence: 'Ran the tests.', clause: 'ran the tests' }));
    expect(j?.verdict).toBe('UNVERIFIED');
    expect(j?.reason).toBe('no-evidence');
    expect(j?.notes).toContain('snapshot update run (not evidence)');
  });

  it('with no run of any kind the guarded contradiction still fires', () => {
    const [j] = judge(build({ writes: [{ seq: 20, at: AT('17:31') }] }), claim({ id: 'c1' }));
    expect(j?.verdict).toBe('CONTRADICTED');
    expect(j?.reason).toBe('no-test-run');
  });
});

describe('a later red run wins over an earlier green run (row 1: R is the latest run)', () => {
  const runs = (later: object) => ({
    writes: [{ seq: 20, at: AT('17:31') }],
    testRuns: [{ seq: 40, at: AT('17:40'), exitCode: 0, parsed: { passed: 41, total: 41 } }, { seq: 50, at: AT('17:50'), ...later }],
  });

  it('green full run then red full run, no edits between → CONTRADICTED last-run-red citing the red run', () => {
    const [j] = judge(build(runs({ green: false, exitCode: 1, parsed: { failed: 2, passed: 39, total: 41 } })), claim({ id: 'c1' }));
    expect(j?.verdict).toBe('CONTRADICTED');
    expect(j?.reason).toBe('last-run-red');
    expect(j?.evidence[0]?.label).toContain('2 failed');
  });

  it('a later red subset run keeps VERIFIED but the note names the failure', () => {
    const [j] = judge(
      build(runs({ green: false, exitCode: 1, scope: 'subset', targets: ['tests/test_x.py'], parsed: { failed: 1, total: 1 } })),
      claim({ id: 'c1' }),
    );
    expect(j?.verdict).toBe('VERIFIED');
    expect(j?.notes).toEqual(['+1 later partial run (1 red)']);
  });

  it('a later non-red subset run keeps the neutral partial-run note', () => {
    // Unknown outcome so it is not itself selected as the evidence run.
    const [j] = judge(
      build(runs({ green: 'unknown', conclusive: false, exitCode: null, exitCodeSource: 'unknown', scope: 'subset', targets: ['tests/test_x.py'] })),
      claim({ id: 'c1' }),
    );
    expect(j?.verdict).toBe('VERIFIED');
    expect(j?.notes).toEqual(['+1 later partial run']);
  });

  it('a partial claim is never contradicted by the later red run (§4.8 v)', () => {
    const [j] = judge(build(runs({ green: false, exitCode: 1, parsed: { failed: 2, total: 41 } })), claim({ id: 'c1', partial: true }));
    expect(j?.verdict).toBe('VERIFIED');
  });
});

describe('git.push single-call idiom and mismatch wording (row 16)', () => {
  it('git add && git commit && git push in one call verifies both claims (seq tie broken by fact order)', () => {
    const s = build({
      writes: [{ seq: 20, at: AT('17:31') }],
      git: [
        { seq: 50, at: AT('17:45'), op: 'commit', ok: true, sha: 'abc1234' },
        { seq: 50, at: AT('17:45'), op: 'push', ok: true, remote: 'origin', branch: 'main' },
      ],
    });
    const out = judge(s, [commitClaim({ position: 0 }), pushClaim({ position: 1 })]);
    expect(out.map((j) => j.verdict)).toEqual(['VERIFIED', 'VERIFIED']);
    expect(out[1]?.text).toBe('push after the last commit');
  });

  it('a failed same-call push is a failed attempt, not "no git push in log"', () => {
    const s = build({
      writes: [{ seq: 20, at: AT('17:31') }],
      git: [
        { seq: 50, at: AT('17:45'), op: 'commit', ok: true, sha: 'abc1234' },
        { seq: 50, at: AT('17:45'), op: 'push', ok: false, remote: 'origin', branch: 'main' },
      ],
    });
    const [j] = judge(s, pushClaim());
    expect(j?.verdict).toBe('CONTRADICTED');
    expect(j?.reason).toBe('git-op-failed');
  });

  it('a push to a different branch names the mismatch instead of claiming absence', () => {
    const s = build({
      git: [
        { seq: 30, at: AT('17:35'), op: 'commit', ok: true, sha: 'abc1234' },
        { seq: 50, at: AT('17:45'), op: 'push', ok: true, remote: 'origin', branch: 'dev' },
      ],
    });
    const [j] = judge(s, pushClaim({ branch: 'main', remote: 'origin', sentence: 'Pushed to origin/main.', clause: 'pushed to origin/main' }));
    expect(j?.verdict).toBe('UNVERIFIED');
    expect(j?.reason).toBe('no-git-op');
    expect(j?.text).toBe('push went to origin/dev, not origin/main');
    expect(j?.evidence[0]?.label).toBe('git push → origin/dev');
  });
});

describe('the LICENSE staleness exemption is anchored to real license files', () => {
  const withEdit = (path: string) => ({
    writes: [
      { seq: 20, at: AT('17:31') },
      { seq: 50, at: AT('17:50'), path },
    ],
    testRuns: [{ seq: 40, at: AT('17:40'), exitCode: 0, parsed: { passed: 41, total: 41 } }],
  });

  it('editing src/license_check.py after the green run moves W → stale-run', () => {
    const [j] = judge(build(withEdit(`${CWD}/src/license_check.py`)), claim({ id: 'c1' }));
    expect(j?.verdict).toBe('UNVERIFIED');
    expect(j?.reason).toBe('stale-run');
  });

  it('editing LICENSE.md after the green run stays exempt → VERIFIED', () => {
    const [j] = judge(build(withEdit(`${CWD}/LICENSE.md`)), claim({ id: 'c1' }));
    expect(j?.verdict).toBe('VERIFIED');
  });

  it('editing LICENSE (no extension) stays exempt too', () => {
    const [j] = judge(build(withEdit(`${CWD}/LICENSE`)), claim({ id: 'c1' }));
    expect(j?.verdict).toBe('VERIFIED');
  });
});
