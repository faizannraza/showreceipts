/**
 * S17 — cross-cutting reconcile rules (§4.8 i–vii and the S17 lead note):
 * the four `no-test-run` guards flip independently; incompleteness degrades
 * absence-based contradictions only; the echo downgrade; the `userModified`
 * note; subagent/workflow evidence labels; `git-op-failed` both ways; the
 * `metadataOnly` staleness decision (docs/decisions.md S17); post-final
 * events never influencing a verdict; and the observability reasons.
 */
import { describe, expect, it } from 'vitest';
import type { Claim, Session } from '../../../src/model/types.js';
import { evidenceStrings } from '../../../src/reconcile/evidence.js';
import { reconcile } from '../../../src/reconcile/reconcile.js';
import { ECHO_NOTE, USER_MODIFIED_NOTE } from '../../../src/reconcile/rules.js';
import { claim, CWD, sessionOf, type ReconcileFixture } from './harness.js';

const AT = (hhmm: string): string => `2026-03-01T${hhmm}:00.000Z`;

/** Session builder over the fixture loader (claims live outside the fixture here). */
function build(ledger: NonNullable<ReconcileFixture['ledger']>, over: Partial<ReconcileFixture> = {}): Session {
  return sessionOf({ name: 'inline', row: 0, claims: [], expect: [], ...over, ledger });
}

function judge(s: Session, c: Claim | Claim[]): ReturnType<typeof reconcile> {
  return reconcile(s, 1, Array.isArray(c) ? c : [c]);
}

const testClaim = (over: Partial<Claim> = {}): Claim => claim({ id: 'c1', ...over });

describe('no-test-run guards (§4.8 row 1, S17)', () => {
  const base = { writes: [{ seq: 20, at: AT('17:31') }] };

  it('all guards pass → CONTRADICTED no-test-run with a positive write cited', () => {
    const [j] = judge(build(base), testClaim());
    expect(j?.verdict).toBe('CONTRADICTED');
    expect(j?.reason).toBe('no-test-run');
    expect(j?.evidence.map((e) => e.label)).toEqual(['no test run in log', 'Edit']);
  });

  it('no ok tool/patch write → UNVERIFIED no-evidence', () => {
    const [j] = judge(build({}), testClaim());
    expect(j?.verdict).toBe('UNVERIFIED');
    expect(j?.reason).toBe('no-evidence');
  });

  it('a shell-inferred write does not satisfy the tool/patch-write guard', () => {
    const [j] = judge(build({ writes: [{ seq: 20, at: AT('17:31'), source: 'shell-inferred' }] }), testClaim());
    expect(j?.verdict).toBe('UNVERIFIED');
    expect(j?.reason).toBe('no-evidence');
  });

  it('echoed → UNVERIFIED echoed, note added exactly once', () => {
    const [j] = judge(build(base), testClaim({ echoed: true }));
    expect(j?.verdict).toBe('UNVERIFIED');
    expect(j?.reason).toBe('echoed');
    expect(j?.notes.filter((n) => n === ECHO_NOTE).length).toBe(1);
  });

  it('incomplete ledger → UNVERIFIED ledger-incomplete with the named reason', () => {
    const [j] = judge(build({ ...base, incomplete: true, incompleteReasons: ['2 subagent transcripts not found'] }), testClaim());
    expect(j?.verdict).toBe('UNVERIFIED');
    expect(j?.reason).toBe('ledger-incomplete');
    expect(j?.notes).toContain('2 subagent transcripts not found');
  });

  it('opaque test-capable commands → UNVERIFIED no-test-run with the may-have-run note', () => {
    const [j] = judge(build({ ...base, opaqueTestCapable: 2 }), testClaim());
    expect(j?.verdict).toBe('UNVERIFIED');
    expect(j?.reason).toBe('no-test-run');
    expect(j?.notes).toContain('2 commands may have run tests');
  });
});

describe('incompleteness degrades absence-based contradictions only (§4.8 iv)', () => {
  it('test.added no-write-to-path degrades to ledger-incomplete', () => {
    const s = build({ writes: [{ seq: 20, at: AT('17:31') }], incomplete: true });
    const [j] = judge(s, claim({ id: 'c1', kind: 'test-added', rule: 'test.added' }));
    expect(j?.verdict).toBe('UNVERIFIED');
    expect(j?.reason).toBe('ledger-incomplete');
  });

  it('git-op-failed ("no later success") degrades to ledger-incomplete', () => {
    const s = build({
      writes: [{ seq: 20, at: AT('17:31') }],
      git: [{ seq: 50, at: AT('22:30'), op: 'commit', ok: false }],
      incomplete: true,
    });
    const [j] = judge(s, claim({ id: 'c1', kind: 'git', rule: 'git.commit', op: 'commit' }));
    expect(j?.verdict).toBe('UNVERIFIED');
    expect(j?.reason).toBe('ledger-incomplete');
  });

  it('command-failed degrades to ledger-incomplete', () => {
    const s = build({
      commands: [{ seq: 50, at: AT('21:00'), exitCode: 2, segments: [{ program: 'pytest', exitCode: 2 }] }],
      incomplete: true,
    });
    const [j] = judge(s, claim({ id: 'c1', kind: 'command', rule: 'command.ran', subject: 'pytest', successPredicate: true }));
    expect(j?.verdict).toBe('UNVERIFIED');
    expect(j?.reason).toBe('ledger-incomplete');
  });

  it('last-run-red is a positive contrary fact and survives an incomplete ledger', () => {
    const s = build({
      writes: [{ seq: 20, at: AT('17:31') }],
      testRuns: [{ seq: 40, at: AT('23:41'), exitCode: 1, green: false, conclusive: false, parsed: { failed: 2 } }],
      incomplete: true,
    });
    const [j] = judge(s, testClaim());
    expect(j?.verdict).toBe('CONTRADICTED');
    expect(j?.reason).toBe('last-run-red');
  });

  it('check-red survives an incomplete ledger', () => {
    const s = build({
      writes: [{ seq: 20, at: AT('17:31') }],
      checks: [{ seq: 40, at: AT('23:44'), exitCode: 1, green: false, summary: '2 errors' }],
      incomplete: true,
    });
    const [j] = judge(s, claim({ id: 'c1', kind: 'check', rule: 'check.lint', family: 'lint', tool: 'ruff' }));
    expect(j?.verdict).toBe('CONTRADICTED');
    expect(j?.reason).toBe('check-red');
  });
});

describe('echo downgrade edge (§4.8 row 24)', () => {
  it('negated + echoed stays NOT_SCORED (row 23 wins)', () => {
    const [j] = judge(build({}), testClaim({ polarity: 'negated', echoed: true }));
    expect(j?.verdict).toBe('NOT_SCORED');
    expect(j?.reason).toBe('not-scored');
  });
});

describe('userModified note (§4.8 ii)', () => {
  const fileClaim = claim({ id: 'c1', kind: 'file', rule: 'file.verb', verb: 'update', subject: 'src/app.py', explicitVerb: true });

  it('a verifying write with userModified:true gets the note', () => {
    const s = build({ writes: [{ seq: 20, at: AT('17:31'), userModified: true }] });
    const [j] = judge(s, fileClaim);
    expect(j?.verdict).toBe('VERIFIED');
    expect(j?.notes).toContain(USER_MODIFIED_NOTE);
  });

  it('an edited_text_file attachment between the write and F gets the note', () => {
    const s = build({ writes: [{ seq: 20, at: AT('17:31') }] }, { session: { editedFiles: [{ seq: 25, path: `${CWD}/src/app.py` }] } });
    const [j] = judge(s, fileClaim);
    expect(j?.verdict).toBe('VERIFIED');
    expect(j?.notes).toContain(USER_MODIFIED_NOTE);
  });

  it('an attachment after F does not', () => {
    const s = build({ writes: [{ seq: 20, at: AT('17:31') }] }, { session: { editedFiles: [{ seq: 95, path: `${CWD}/src/app.py` }] } });
    const [j] = judge(s, fileClaim);
    expect(j?.notes).not.toContain(USER_MODIFIED_NOTE);
  });
});

describe('subagent evidence labels (§4.8 iii)', () => {
  it('agent-attributed evidence carries agent:<id>', () => {
    const s = build({
      writes: [{ seq: 20, at: AT('17:31'), agentId: 'a271fd7deadbeef', call: { agentId: 'a271fd7deadbeef' } }],
    });
    const [j] = judge(s, claim({ id: 'c1', kind: 'file', rule: 'file.verb', verb: 'update', subject: 'src/app.py', explicitVerb: true }));
    expect(j?.verdict).toBe('VERIFIED');
    expect(evidenceStrings(j!, { subagents: s.subagents })[0]).toMatch(/^Edit agent:a271fd7 \(17:31\)$/);
  });

  it('a Workflow-spawned agent renders workflow:<runId>', () => {
    const s = build(
      { writes: [{ seq: 20, at: AT('17:31'), agentId: 'wfagent01', call: { agentId: 'wfagent01' } }] },
      {
        session: {
          subagents: [
            {
              agentId: 'wfagent01',
              parentAgentId: null,
              spawnedBy: { tool: 'Workflow', runId: 'wf_42' },
              toolCalls: 1,
              startedAt: AT('17:30'),
              endedAt: AT('17:35'),
              finished: true,
            },
          ],
        },
      }
    );
    const [j] = judge(s, claim({ id: 'c1', kind: 'file', rule: 'file.verb', verb: 'update', subject: 'src/app.py', explicitVerb: true }));
    expect(evidenceStrings(j!, { subagents: s.subagents })[0]).toMatch(/^Edit workflow:wf_42 \(17:31\)$/);
  });
});

describe('git-op-failed (S17 acceptance)', () => {
  it('positive: failed commit after W_all, no later success → CONTRADICTED', () => {
    const s = build({
      writes: [{ seq: 20, at: AT('17:31') }],
      git: [{ seq: 50, at: AT('22:30'), op: 'commit', ok: false }],
      commands: [{ seq: 50, exitCode: 1, segments: [{ program: 'git', argv: ['commit'], family: 'git', exitCode: 1 }] }],
    });
    const [j] = judge(s, claim({ id: 'c1', kind: 'git', rule: 'git.commit', op: 'commit' }));
    expect(j?.verdict).toBe('CONTRADICTED');
    expect(j?.reason).toBe('git-op-failed');
  });

  it('negative: a later successful commit clears the failure → VERIFIED', () => {
    const s = build({
      writes: [{ seq: 20, at: AT('17:31') }],
      git: [
        { seq: 50, at: AT('22:30'), op: 'commit', ok: false },
        { seq: 60, at: AT('22:40'), op: 'commit', ok: true, sha: 'abc1234' },
      ],
    });
    const [j] = judge(s, claim({ id: 'c1', kind: 'git', rule: 'git.commit', op: 'commit' }));
    expect(j?.verdict).toBe('VERIFIED');
    expect(j?.reason).toBe('ok');
  });
});

describe('staleness boundary (docs/decisions.md S17: metadataOnly and non-executable writes)', () => {
  const green = { seq: 40, at: AT('23:41'), exitCode: 0, parsed: { passed: 41 } };

  it('a metadataOnly touch after the run does not make it stale', () => {
    const s = build({
      writes: [
        { seq: 20, at: AT('17:31') },
        { seq: 50, at: AT('23:50'), metadataOnly: true, path: `${CWD}/src` },
      ],
      testRuns: [green],
    });
    const [j] = judge(s, testClaim());
    expect(j?.verdict).toBe('VERIFIED');
    expect(j?.reason).toBe('ok');
  });

  it('a non-executable .json write after the run does not make it stale', () => {
    const s = build({
      writes: [
        { seq: 20, at: AT('17:31') },
        { seq: 50, at: AT('23:50'), path: `${CWD}/config.json` },
      ],
      testRuns: [green],
    });
    const [j] = judge(s, testClaim());
    expect(j?.verdict).toBe('VERIFIED');
  });

  it('a source write after the run does make it stale', () => {
    const s = build({
      writes: [
        { seq: 20, at: AT('17:31') },
        { seq: 50, at: AT('23:50'), path: `${CWD}/src/other.py` },
      ],
      testRuns: [green],
    });
    const [j] = judge(s, testClaim());
    expect(j?.verdict).toBe('UNVERIFIED');
    expect(j?.reason).toBe('stale-run');
    expect(j?.text).toContain('1 file edited after the last run');
  });

  it('a metadataOnly write never bumps W_all for git.commit', () => {
    const s = build({
      writes: [
        { seq: 20, at: AT('17:31') },
        { seq: 55, at: AT('22:35'), metadataOnly: true, path: `${CWD}/build` },
      ],
      git: [{ seq: 50, at: AT('22:30'), op: 'commit', ok: true, sha: 'abc1234' }],
    });
    const [j] = judge(s, claim({ id: 'c1', kind: 'git', rule: 'git.commit', op: 'commit' }));
    expect(j?.verdict).toBe('VERIFIED');
  });
});

describe('evidence scope stops at finalSeq (S17 review checklist)', () => {
  it('a test run after the final message never rescues the claim', () => {
    const s = build({
      writes: [{ seq: 20, at: AT('17:31') }],
      testRuns: [{ seq: 95, at: AT('23:59'), exitCode: 0, parsed: { passed: 41 } }],
    });
    const [j] = judge(s, testClaim());
    expect(j?.verdict).toBe('CONTRADICTED');
    expect(j?.reason).toBe('no-test-run');
    for (const ref of j?.evidence ?? []) expect(ref.seq).toBeLessThanOrEqual(90);
  });
});

describe('observability and exit-code guards (§4.8 i, S17)', () => {
  it('only a background run in the window → UNVERIFIED run-in-background', () => {
    const s = build({
      writes: [{ seq: 20, at: AT('17:31') }],
      testRuns: [{ seq: 40, at: AT('23:41'), exitCode: null, exitCodeSource: 'unknown', green: 'unknown', conclusive: false, call: { background: true } }],
    });
    const [j] = judge(s, testClaim());
    expect(j?.verdict).toBe('UNVERIFIED');
    expect(j?.reason).toBe('run-in-background');
  });

  it('a red run with unknown exit source and nothing parsed cannot contradict', () => {
    const s = build({
      writes: [{ seq: 20, at: AT('17:31') }],
      testRuns: [{ seq: 40, at: AT('23:41'), exitCode: null, exitCodeSource: 'unknown', green: false, conclusive: false }],
    });
    const [j] = judge(s, testClaim());
    expect(j?.verdict).toBe('UNVERIFIED');
    expect(j?.reason).toBe('exit-unknown');
  });

  it('the same red run in a ledger session carries the ledger note', () => {
    const s = build(
      {
        writes: [{ seq: 20, at: AT('17:31') }],
        testRuns: [{ seq: 40, at: AT('23:41'), exitCode: null, exitCodeSource: 'unknown', green: false, conclusive: false }],
      },
      { session: { source: 'ledger' } }
    );
    const [j] = judge(s, testClaim());
    expect(j?.reason).toBe('exit-unknown');
    expect(j?.notes).toContain('exit codes unknown (ledger)');
  });

  it('parsed failures let an unknown-exit red run contradict', () => {
    const s = build({
      writes: [{ seq: 20, at: AT('17:31') }],
      testRuns: [{ seq: 40, at: AT('23:41'), exitCode: null, exitCodeSource: 'unknown', green: false, conclusive: false, parsed: { failed: 3 } }],
    });
    const [j] = judge(s, testClaim());
    expect(j?.verdict).toBe('CONTRADICTED');
    expect(j?.reason).toBe('last-run-red');
  });

  it('unresolved file claim + opaque write commands in the turn → write-not-observable', () => {
    const s = build(
      { commands: [{ seq: 45, at: AT('19:58'), opaqueWrite: true, segments: [{ program: 'python3', heredoc: { delimiter: 'EOF', bytes: 120 } }] }] },
      { turn: { opaqueWriteCommands: 1 } }
    );
    const [j] = judge(s, claim({ id: 'c1', kind: 'file', rule: 'file.verb', verb: 'create', subject: 'notes/report.ipynb', explicitVerb: true }));
    expect(j?.verdict).toBe('UNVERIFIED');
    expect(j?.reason).toBe('write-not-observable');
    expect(evidenceStrings(j!)[0]).toBe('python script ran (19:58) · write not observable');
  });

  it('a file claim resolved only to an interp-inferred write → write-not-observable', () => {
    const s = build({
      writes: [{ seq: 45, at: AT('19:58'), path: `${CWD}/out.csv`, source: 'interp-inferred', resolved: false }],
      commands: [{ seq: 45, opaqueWrite: true, segments: [{ program: 'python3', heredoc: { delimiter: 'EOF', bytes: 120 } }] }],
    });
    const [j] = judge(s, claim({ id: 'c1', kind: 'file', rule: 'file.verb', verb: 'create', subject: 'out.csv', explicitVerb: true }));
    expect(j?.verdict).toBe('UNVERIFIED');
    expect(j?.reason).toBe('write-not-observable');
  });
});

describe('test-weakened integrity flag (§4.8 row 1)', () => {
  it('a test-file edit after the evidence run with a test-weakened signal', () => {
    const s = build({
      writes: [
        { seq: 20, at: AT('17:31') },
        { seq: 50, at: AT('23:50'), path: `${CWD}/tests/test_app.py`, isTestFile: true },
      ],
      testRuns: [{ seq: 40, at: AT('23:41'), exitCode: 0, parsed: { passed: 41 } }],
      integrity: [{ seq: 50, kind: 'test-weakened', detail: 'assertion removed after green' }],
    });
    const [j] = judge(s, testClaim());
    expect(j?.verdict).toBe('UNVERIFIED');
    expect(j?.reason).toBe('stale-run');
    expect(j?.integrity).toBe('test-weakened');
    expect(j?.notes).toContain('test file edited after last run');
  });
});

describe('git ordering reasons (§4.8 rows 15–16)', () => {
  it('sha-mismatch when commits after W_all never match the claimed sha', () => {
    const s = build({
      writes: [{ seq: 20, at: AT('17:31') }],
      git: [{ seq: 50, at: AT('22:30'), op: 'commit', ok: true, sha: '9999999ff' }],
    });
    const [j] = judge(s, claim({ id: 'c1', kind: 'git', rule: 'git.commit', op: 'commit', sha: 'abcdef1' }));
    expect(j?.verdict).toBe('CONTRADICTED');
    expect(j?.reason).toBe('sha-mismatch');
  });

  it('commit-precedes-edits when writes follow the last ok commit', () => {
    const s = build({
      writes: [{ seq: 40, at: AT('22:40') }],
      git: [{ seq: 30, at: AT('22:30'), op: 'commit', ok: true, sha: 'abc1234' }],
    });
    const [j] = judge(s, claim({ id: 'c1', kind: 'git', rule: 'git.commit', op: 'commit' }));
    expect(j?.verdict).toBe('UNVERIFIED');
    expect(j?.reason).toBe('commit-precedes-edits');
    expect(j?.text).toContain('precedes 1 later edit');
  });

  it('push-precedes-commit when the push predates the last ok commit', () => {
    const s = build({
      git: [
        { seq: 40, at: AT('22:20'), op: 'push', ok: true },
        { seq: 50, at: AT('22:30'), op: 'commit', ok: true, sha: 'abc1234' },
      ],
    });
    const [j] = judge(s, claim({ id: 'c1', kind: 'git', rule: 'git.push', op: 'push' }));
    expect(j?.verdict).toBe('UNVERIFIED');
    expect(j?.reason).toBe('push-precedes-commit');
  });
});

describe('partial and sibling-claim guards (§4.8 v, row 21)', () => {
  it('partial:true is never contradicted by a red run', () => {
    const s = build({
      writes: [{ seq: 20, at: AT('17:31') }],
      testRuns: [{ seq: 40, at: AT('23:41'), exitCode: 1, green: false, conclusive: false, parsed: { failed: 2 } }],
    });
    const [j] = judge(s, testClaim({ partial: true }));
    expect(j?.verdict).toBe('UNVERIFIED');
    expect(j?.reason).toBe('partial');
    expect(j?.notes).toContain('last run had 2 failures');
  });

  it('path-less no-change with other positive file claims → UNVERIFIED partial', () => {
    const s = build({ writes: [{ seq: 20, at: AT('17:31') }] });
    const noChange = claim({ id: 'c1', kind: 'no-change', rule: 'nochange.marker', position: 0 });
    const fileClaim = claim({ id: 'c2', kind: 'file', rule: 'file.verb', verb: 'update', subject: 'src/app.py', explicitVerb: true, position: 1 });
    const [j1, j2] = judge(s, [noChange, fileClaim]);
    expect(j1?.verdict).toBe('UNVERIFIED');
    expect(j1?.reason).toBe('partial');
    expect(j1?.notes).toContain('other files were changed');
    expect(j2?.verdict).toBe('VERIFIED');
  });
});

describe('command evidence suffixes (S17 evidence strings)', () => {
  it('chained commands and suppressed output are flagged', () => {
    const s = build({
      commands: [
        { seq: 50, at: AT('21:00'), chained: true, segments: [{ program: 'pytest', argv: ['-q'], suppressed: true }] },
      ],
    });
    const [j] = judge(s, claim({ id: 'c1', kind: 'command', rule: 'command.ran', subject: 'pytest -q' }));
    expect(j?.verdict).toBe('VERIFIED');
    expect(evidenceStrings(j!)[0]).toBe('pytest -q → exit 0 (chained) (output suppressed) (21:00)');
  });
});

describe('file create/update extras (§4.8 rows 7–8)', () => {
  it('deleted-later create claim → VERIFIED ok-deleted-later with a timed delete ref', () => {
    const s = build({
      writes: [
        { seq: 30, at: AT('18:05'), path: `${CWD}/tmp_probe.py`, verb: 'create', call: { tool: 'Write', kind: 'write' } },
        { seq: 60, at: AT('19:02'), path: `${CWD}/tmp_probe.py`, verb: 'delete', source: 'shell-inferred' },
      ],
    });
    const [j] = judge(s, claim({ id: 'c1', kind: 'file', rule: 'file.verb', verb: 'create', subject: 'tmp_probe.py', explicitVerb: true }));
    expect(j?.verdict).toBe('VERIFIED');
    expect(j?.reason).toBe('ok-deleted-later');
    expect(evidenceStrings(j!)).toEqual(['Write (18:05)', 'deleted later (19:02)']);
  });

  it('ambiguous subject → UNVERIFIED ambiguous-path with the candidate count', () => {
    const s = build({
      writes: [
        { seq: 20, at: AT('17:31'), path: `${CWD}/a/util.py` },
        { seq: 21, at: AT('17:32'), path: `${CWD}/b/util.py` },
      ],
    });
    const [j] = judge(s, claim({ id: 'c1', kind: 'file', rule: 'file.verb', verb: 'update', subject: 'util.py', explicitVerb: true }));
    expect(j?.verdict).toBe('UNVERIFIED');
    expect(j?.reason).toBe('ambiguous-path');
    expect(j?.text).toBe('2 candidates');
  });

  it('only reverted writes → UNVERIFIED with the reverted note', () => {
    const s = build({
      writes: [{ seq: 20, at: AT('17:31'), reverted: { seq: 60, by: 'git checkout' } }],
    });
    const [j] = judge(s, claim({ id: 'c1', kind: 'file', rule: 'file.verb', verb: 'update', subject: 'src/app.py', explicitVerb: true }));
    expect(j?.verdict).toBe('UNVERIFIED');
    expect(j?.notes).toContain('write later reverted');
  });
});

describe('stale runs before the boundary (§4.8 row 1)', () => {
  it('runs exist only before W → UNVERIFIED stale-run naming the edit count', () => {
    const s = build({
      writes: [{ seq: 30, at: AT('18:00') }],
      testRuns: [{ seq: 15, at: AT('17:40'), exitCode: 0, parsed: { passed: 12 } }],
    });
    const [j] = judge(s, testClaim());
    expect(j?.verdict).toBe('UNVERIFIED');
    expect(j?.reason).toBe('stale-run');
    expect(j?.text).toBe('1 file edited after the last run');
  });
});
