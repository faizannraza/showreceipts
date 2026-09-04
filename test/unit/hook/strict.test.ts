/**
 * S27 — `hook/strict.ts` (§9, 100 % line coverage): every guard blocks the
 * nudge independently, the per-turn and per-session caps hold, the
 * `--strict-reasons` filter applies, the reason priority is fixed and every
 * reason has one deterministic message ≤ 200 chars.
 */
import { describe, expect, it } from 'vitest';
import type { Judgement, Receipt } from '../../../src/model/types.js';
import { freshHookState, type HookState } from '../../../src/hook/state.js';
import { decideNudge, NUDGE_REASONS, SESSION_NUDGE_CAP, type NudgeInput, type NudgeReason } from '../../../src/hook/strict.js';
import { sha256 } from '../../../src/util/hash.js';

function judgement(reason: Judgement['reason'], integrity?: 'test-weakened'): Judgement {
  const j: Judgement = { claimId: 'c1', verdict: 'CONTRADICTED', reason, evidence: [], text: '', notes: [] };
  if (integrity !== undefined) j.integrity = integrity;
  return j;
}

function makeReceipt(over: Partial<Receipt> = {}): Receipt {
  return {
    schema: 'showreceipts.receipt/1',
    toolVersion: '0.1.0',
    rulesVersion: 'claims/1',
    pricesVersion: '2026-08-29',
    kind: 'scored',
    id: 'sess-1',
    shortId: 'abcd1234',
    harness: 'claude-code',
    harnessLabel: 'Claude Code',
    harnessVersion: '2.1.251',
    model: 'claude-x',
    cwd: '/home/u/proj',
    branch: 'main',
    startedAt: '2026-08-29T11:00:00.000Z',
    endedAt: '2026-08-29T11:30:00.000Z',
    durationMs: 1_800_000,
    source: 'transcript',
    turnIndex: 3,
    finalTrigger: 'human',
    turnsWithClaims: [3],
    finalText: 'All tests pass.',
    finalTextSource: 'transcript',
    claims: [],
    judgements: [judgement('no-test-run')],
    lines: [],
    alsoSaid: [],
    alsoDid: [],
    stats: { toolCalls: 4, filesChanged: 2, testRuns: 1, compactions: 0, subagents: 0, apiCalls: 5, sentencesScanned: 3 },
    cost: {
      usd: null,
      apiCalls: 0,
      input: 0,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheWriteOther: 0,
      output: 0,
      cacheHitPct: null,
      unverified: false,
      unpriced: [],
      apiEquivalent: true,
      pricesVersion: '2026-08-29',
      notes: [],
    },
    verdict: 'CONTRADICTED',
    counts: { VERIFIED: 0, UNVERIFIED: 0, CONTRADICTED: 1, NOT_SCORED: 0 },
    turnActiveMs: null,
    claimsRecognized: 1,
    ...over,
  };
}

function makeInput(over: Partial<NudgeInput> = {}): NudgeInput {
  return {
    receipt: makeReceipt(),
    strict: true,
    max: 1,
    loopFlag: false,
    state: freshHookState(),
    effectsOnly: false,
    ...over,
  };
}

const EXPECTED_MESSAGES: Readonly<Record<NudgeReason, string>> = {
  'no-test-run': 'showreceipts: you said tests pass but no test command ran after your last edit — run them',
  'last-run-red': 'showreceipts: you said tests pass but the last test run before your message exited red — re-run them',
  'stale-run': 'showreceipts: the last test run predates your latest edits (or the tests were weakened) — re-run them',
  'check-red': 'showreceipts: you said a check passes but its last run exited non-zero — re-run it',
  'git-op-failed': 'showreceipts: you reported a git operation as done but it failed — check git status and retry',
};

describe('decideNudge: guards (each blocks independently)', () => {
  it('nudges when strict is on and a qualifying judgement exists', () => {
    const input = makeInput();
    const d = decideNudge(input);
    expect(d.nudge).toBe(true);
    expect(d.reason).toBe('no-test-run');
    expect(d.message).toBe(EXPECTED_MESSAGES['no-test-run']);
    expect(d.newState).toEqual({
      lastNudgeFinalHash: sha256('All tests pass.'),
      nudges: 1,
      turnIds: ['3'],
    });
  });

  it('never without --strict', () => {
    const state = freshHookState();
    expect(decideNudge(makeInput({ strict: false, state }))).toEqual({ nudge: false, message: '', newState: state });
  });

  it('never for effects-only sessions', () => {
    expect(decideNudge(makeInput({ effectsOnly: true })).nudge).toBe(false);
  });

  it('never when the loop flag is set', () => {
    expect(decideNudge(makeInput({ loopFlag: true })).nudge).toBe(false);
  });

  it('never when lastNudgeFinalHash equals the final text hash', () => {
    const state: HookState = { lastNudgeFinalHash: sha256('All tests pass.'), nudges: 1, turnIds: ['0'] };
    expect(decideNudge(makeInput({ state })).nudge).toBe(false);
  });

  it('never past the session cap of 5', () => {
    const state: HookState = { nudges: SESSION_NUDGE_CAP, turnIds: ['0', '1', '2', '4', '5'] };
    expect(decideNudge(makeInput({ state })).nudge).toBe(false);
    expect(decideNudge(makeInput({ state: { nudges: SESSION_NUDGE_CAP - 1, turnIds: [] } })).nudge).toBe(true);
  });

  it('never past the per-turn --strict-max cap (default turn key = turnIndex)', () => {
    expect(decideNudge(makeInput({ state: { nudges: 1, turnIds: ['3'] } })).nudge).toBe(false);
    expect(decideNudge(makeInput({ state: { nudges: 1, turnIds: ['2'] } })).nudge).toBe(true);
    expect(decideNudge(makeInput({ state: { nudges: 1, turnIds: ['3'] }, max: 2 })).nudge).toBe(true);
    expect(decideNudge(makeInput({ max: 0 })).nudge).toBe(false);
  });

  it('uses the explicit turnId for the per-turn cap when given', () => {
    expect(decideNudge(makeInput({ turnId: 't9', state: { nudges: 1, turnIds: ['t9'] } })).nudge).toBe(false);
    const d = decideNudge(makeInput({ turnId: 't10', state: { nudges: 1, turnIds: ['t9'] } }));
    expect(d.nudge).toBe(true);
    expect(d.newState.turnIds).toEqual(['t9', 't10']);
  });
});

describe('decideNudge: reasons', () => {
  it('each nudge reason has its deterministic message (≤ 200 chars)', () => {
    for (const reason of NUDGE_REASONS) {
      const d = decideNudge(makeInput({ receipt: makeReceipt({ judgements: [judgement(reason)] }) }));
      expect(d.nudge).toBe(true);
      expect(d.reason).toBe(reason);
      expect(d.message).toBe(EXPECTED_MESSAGES[reason]);
      expect(d.message.length).toBeLessThanOrEqual(200);
    }
  });

  it('test-weakened integrity counts as stale-run even on a non-nudge reason', () => {
    const weakened = judgement('ok', 'test-weakened');
    weakened.verdict = 'VERIFIED';
    const d = decideNudge(makeInput({ receipt: makeReceipt({ judgements: [weakened] }) }));
    expect(d.nudge).toBe(true);
    expect(d.reason).toBe('stale-run');
  });

  it('non-nudge reasons never fire', () => {
    const receipt = makeReceipt({ judgements: [judgement('no-evidence'), judgement('echoed'), judgement('command-failed')] });
    expect(decideNudge(makeInput({ receipt })).nudge).toBe(false);
  });

  it('no judgements at all never fires', () => {
    expect(decideNudge(makeInput({ receipt: makeReceipt({ judgements: [] }) })).nudge).toBe(false);
  });

  it('picks the first reason in the fixed priority order', () => {
    const receipt = makeReceipt({ judgements: [judgement('git-op-failed'), judgement('check-red'), judgement('no-test-run')] });
    expect(decideNudge(makeInput({ receipt })).reason).toBe('no-test-run');
    const later = makeReceipt({ judgements: [judgement('git-op-failed'), judgement('check-red')] });
    expect(decideNudge(makeInput({ receipt: later })).reason).toBe('check-red');
  });

  it('--strict-reasons filters; an empty filter means all; unknown entries are ignored', () => {
    const receipt = makeReceipt({ judgements: [judgement('no-test-run')] });
    expect(decideNudge(makeInput({ receipt, reasons: ['check-red'] })).nudge).toBe(false);
    expect(decideNudge(makeInput({ receipt, reasons: ['no-test-run', 'bogus'] })).nudge).toBe(true);
    expect(decideNudge(makeInput({ receipt, reasons: [] })).nudge).toBe(true);
    expect(decideNudge(makeInput({ receipt, reasons: ['bogus'] })).nudge).toBe(false);
  });
});

describe('decideNudge: state transitions', () => {
  it('a decline returns the input state untouched with an empty message and no reason', () => {
    const state = freshHookState();
    const d = decideNudge(makeInput({ strict: false, state }));
    expect(d).toEqual({ nudge: false, message: '', newState: state });
    expect(d.newState).toBe(state);
    expect(d.reason).toBeUndefined();
  });

  it('a nudge re-run against its own newState is blocked by the final-hash guard', () => {
    const first = decideNudge(makeInput());
    expect(first.nudge).toBe(true);
    expect(decideNudge(makeInput({ state: first.newState })).nudge).toBe(false);
  });

  it('turnIds are bounded at 100 entries', () => {
    const state: HookState = { nudges: 0, turnIds: Array.from({ length: 100 }, (_, i) => `x${i}`) };
    const d = decideNudge(makeInput({ state }));
    expect(d.nudge).toBe(true);
    expect(d.newState.turnIds).toHaveLength(100);
    expect(d.newState.turnIds[0]).toBe('x1');
    expect(d.newState.turnIds[99]).toBe('3');
  });
});
