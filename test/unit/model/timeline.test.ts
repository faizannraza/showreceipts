/**
 * S07 — running-maximum timestamp envelope placement, seq renumbering,
 * per-turn windows and postFinal marking (`model/timeline.ts`, §4.2.6/§5.2).
 */
import { describe, expect, it } from 'vitest';
import { eventsBefore, markPostFinal, mergeTimeline, turnWindow } from '../../../src/model/timeline.js';
import type { Ledger, Session, ToolCall, Turn, UsageTotals } from '../../../src/model/types.js';

const iso = (s: number): string => new Date(Date.UTC(2026, 5, 1, 10, 0, s)).toISOString();

function emptyTotals(): UsageTotals {
  return { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteOther: 0, output: 0, thinking: 0, calls: 0, byModel: {} };
}

function emptyLedger(): Ledger {
  return {
    writes: [],
    commands: [],
    testRuns: [],
    checks: [],
    git: [],
    network: [],
    integrity: [],
    danger: [],
    filesChanged: [],
    lastWriteSeq: null,
    lastSourceWriteSeq: null,
    lastGreenSeq: null,
    incomplete: false,
    incompleteReasons: [],
    opaqueTestCapable: 0,
    perTurn: {},
  };
}

function makeSession(over: Partial<Session> = {}): Session {
  return {
    harness: 'claude-code',
    harnessVersion: null,
    harnessVersions: [],
    sessionId: 'sess',
    shortId: 'sess',
    source: 'transcript',
    transcriptPath: null,
    cwd: '/p',
    cwds: [],
    repoRoot: null,
    gitBranch: null,
    title: null,
    models: [],
    primaryModel: 'm',
    startedAt: '',
    endedAt: '',
    durationMs: 0,
    activeMs: null,
    turns: [],
    preamble: [],
    toolCalls: [],
    ledger: emptyLedger(),
    usage: emptyTotals(),
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
      pricesVersion: '',
      notes: [],
    },
    compactions: [],
    subagents: [],
    prRefs: [],
    apiErrors: [],
    refusalFallbacks: [],
    diagnostics: {
      unknownRecordTypes: {},
      unknownSubtypes: {},
      unknownToolShapes: {},
      unknownContentBlocks: {},
      unknownCodexPayloads: {},
      badLines: 0,
      lineSeparatorChars: 0,
      reorderedEvents: 0,
      duplicateUuids: 0,
      duplicateToolResults: 0,
      negativeDeltas: 0,
      orphanAssistantLines: 0,
      notificationPrompts: 0,
      localCommandPrompts: 0,
      incompleteMessages: 0,
      bashWithoutToolUseResult: 0,
      legacyShapes: {},
      subagentFiles: { direct: 0, workflow: 0, unlinked: 0, missing: 0 },
      notes: [],
      interimFinals: 0,
      emptySessions: 0,
      excludedSyntheticLines: 0,
      unknownAttachmentTypes: {},
      journals: 0,
      unrecognisedFiles: 0,
      orphanSessionDirs: 0,
      emptyProjects: 0,
      corruptCache: 0,
      copilotTranscriptUnparsed: 0,
      records: 0,
    },
    usageRows: [],
    tokenDeltas: [],
    kind: 'normal',
    records: 0,
    spansDays: 1,
    editedFiles: [],
    ...over,
  };
}

function call(seq: number, ts: string, over: Partial<ToolCall> = {}): ToolCall {
  return {
    seq,
    id: `t${seq}`,
    tool: 'Bash',
    kind: 'shell',
    agentId: null,
    turnIndex: -1,
    cwd: '/p',
    input: {},
    resultText: '',
    resultBytes: 0,
    isError: false,
    exitCode: 0,
    exitCodeSource: 'harness',
    interrupted: false,
    background: false,
    startedAt: ts,
    endedAt: null,
    filesTouched: [],
    ...over,
  };
}

function makeTurn(index: number, over: Partial<Turn> = {}): Turn {
  return {
    index,
    kind: 'human',
    promptId: `p${index}`,
    userText: 'go',
    echoHashes: [],
    segments: [],
    seqStart: 0,
    seqEnd: 0,
    startedAt: '',
    endedAt: '',
    durationMs: null,
    finalText: null,
    finalSeq: null,
    finalMessageId: null,
    finalTrigger: null,
    interimFinals: 0,
    harnessVersion: null,
    model: null,
    isDone: false,
    interrupted: false,
    compactions: 0,
    opaqueWriteCommands: 0,
    opaqueTestCommands: 0,
    usage: emptyTotals(),
    costUsd: null,
    apiCalls: 0,
    finalStopReason: null,
    ...over,
  };
}

describe('mergeTimeline — running-maximum envelope', () => {
  it('places subagent events after the last main event whose running max ≤ t and renumbers seq', () => {
    const s = makeSession({ toolCalls: [call(0, iso(0)), call(2, iso(100)), call(4, iso(200))] });
    const { subSeqMaps, mainSeqOf } = mergeTimeline(s, [
      {
        agentId: 'a1',
        events: [
          { seq: 0, tsMs: Date.UTC(2026, 5, 1, 10, 0, 50) }, // t=50s → between the 0s and 100s anchors
          { seq: 1, tsMs: Date.UTC(2026, 5, 1, 10, 2, 30) }, // t=150s → between the 100s and 200s anchors
          { seq: 2, tsMs: Date.UTC(2026, 5, 1, 11, 0, 0) }, // after everything
        ],
      },
    ]);
    // Main file order preserved, seqs shifted by the inserted events.
    expect(s.toolCalls.map((c) => c.seq)).toEqual([0, 3, 6]);
    expect(mainSeqOf(2)).toBe(3);
    const map = subSeqMaps[0];
    // ts 50s → before the ts-100s anchor (old seq 2) → merged seq 2.
    expect(map?.get(0)).toBe(2);
    // ts 150s → after the ts-100s anchor, before the ts-200s one.
    expect(map?.get(1)).toBe(5);
    // All merged seqs are unique and strictly increasing per placement order.
    const merged = [0, 3, 6, map?.get(0) ?? -1, map?.get(1) ?? -1, map?.get(2) ?? -1];
    expect(new Set(merged).size).toBe(merged.length);
    const subSeqs = [map?.get(0) ?? -1, map?.get(1) ?? -1, map?.get(2) ?? -1];
    expect([...subSeqs].sort((a, b) => a - b)).toEqual(subSeqs);
    // The last event (well past every anchor) lands after every main seq.
    expect(map?.get(2)).toBeGreaterThan(6);
  });

  it('breaks a timestamp tie with a main anchor main-first', () => {
    const s = makeSession({ toolCalls: [call(0, iso(0)), call(2, iso(100)), call(4, iso(200))] });
    const { subSeqMaps, mainSeqOf } = mergeTimeline(s, [{ agentId: 'a1', events: [{ seq: 0, tsMs: Date.UTC(2026, 5, 1, 10, 1, 40) }] }]);
    // t equals the ts-100s anchor: running max ≤ t includes it → the event goes after it.
    const sub = subSeqMaps[0]?.get(0) ?? -1;
    expect(sub).toBeGreaterThan(mainSeqOf(2));
    expect(sub).toBeLessThan(mainSeqOf(4));
  });

  it('orders events within a gap by timestamp, then agentId ascending, then file order', () => {
    const s = makeSession({ toolCalls: [call(0, iso(0)), call(2, iso(100))] });
    const t50 = Date.UTC(2026, 5, 1, 10, 0, 50);
    const { subSeqMaps } = mergeTimeline(s, [
      { agentId: 'b', events: [{ seq: 0, tsMs: t50 }, { seq: 1, tsMs: t50 }] },
      { agentId: 'a', events: [{ seq: 0, tsMs: t50 }] },
    ]);
    const b0 = subSeqMaps[0]?.get(0) ?? -1;
    const b1 = subSeqMaps[0]?.get(1) ?? -1;
    const a0 = subSeqMaps[1]?.get(0) ?? -1;
    expect(a0).toBeLessThan(b0); // agentId ascending
    expect(b0).toBeLessThan(b1); // same agent keeps file order
  });

  it('uses the running maximum, not raw timestamps, when main times regress', () => {
    const s = makeSession({ toolCalls: [call(0, iso(100)), call(2, iso(300)), call(4, iso(200))] });
    const { subSeqMaps, mainSeqOf } = mergeTimeline(s, [{ agentId: 'a1', events: [{ seq: 0, tsMs: Date.UTC(2026, 5, 1, 10, 4, 10) }] }]);
    // t = 250s: the running max first exceeds it at the ts-300s anchor (old
    // seq 2) even though a later main record (old seq 4) has ts 200s — the
    // envelope never re-orders main records by their timestamps.
    const sub = subSeqMaps[0]?.get(0) ?? -1;
    expect(sub).toBeLessThan(mainSeqOf(2));
    expect(sub).toBeGreaterThan(mainSeqOf(0));
  });

  it('places every event of an anchorless main session at the end, ordered by timestamp', () => {
    const s = makeSession();
    const { subSeqMaps } = mergeTimeline(s, [
      { agentId: 'a1', events: [{ seq: 5, tsMs: 2000 }, { seq: 7, tsMs: 1000 }] },
    ]);
    // ts orders inside the single gap: the later line with the earlier time first.
    expect(subSeqMaps[0]?.get(7)).toBe(0);
    expect(subSeqMaps[0]?.get(5)).toBe(1);
  });

  it('remaps every seq reference on the session (turns, segments, finalSeq, usage rows)', () => {
    const s = makeSession({
      toolCalls: [call(0, iso(0)), call(4, iso(100))],
      turns: [
        makeTurn(0, {
          seqStart: 0,
          seqEnd: 5,
          finalSeq: 5,
          startedAt: iso(0),
          endedAt: iso(110),
          segments: [{ trigger: 'human', promptId: 'p0', seqStart: 0, seqEnd: 5 }],
        }),
      ],
      usageRows: [{ seq: 5, agentId: null, messageId: 'm1', ts: iso(110), attempts: [], promptTokens: 0 }],
    });
    mergeTimeline(s, [{ agentId: 'a1', events: [{ seq: 0, tsMs: Date.UTC(2026, 5, 1, 10, 0, 50) }] }]);
    // The event (t=50s) inserts before the ts-100s anchor at old seq 4.
    const turn = s.turns[0];
    expect(turn?.seqEnd).toBe(6);
    expect(turn?.finalSeq).toBe(6);
    expect(turn?.segments[0]?.seqEnd).toBe(6);
    expect(s.usageRows[0]?.seq).toBe(6);
    expect(s.toolCalls.map((c) => c.seq)).toEqual([0, 5]);
  });
});

describe('turnWindow / eventsBefore / markPostFinal', () => {
  it('extends the window over tool calls attributed to the turn and keeps finalSeq', () => {
    const s = makeSession({
      turns: [makeTurn(0, { seqStart: 0, seqEnd: 4, finalSeq: 3 })],
      toolCalls: [call(1, iso(1), { turnIndex: 0 }), call(9, iso(9), { turnIndex: 0 }), call(12, iso(12), { turnIndex: 1 })],
    });
    expect(turnWindow(s, 0)).toEqual({ seqStart: 0, seqEnd: 9, finalSeq: 3 });
    expect(turnWindow(s, 5)).toBeNull();
  });

  it('eventsBefore is inclusive and seq-ordered', () => {
    const s = makeSession({ toolCalls: [call(5, iso(5)), call(1, iso(1)), call(3, iso(3))] });
    expect(eventsBefore(s, 3).map((c) => c.seq)).toEqual([1, 3]);
  });

  it('markPostFinal flags exactly the turn-attributed calls past the final', () => {
    const s = makeSession({
      turns: [makeTurn(0, { seqStart: 0, seqEnd: 6, finalSeq: 3 }), makeTurn(1, { seqStart: 7, seqEnd: 9, finalSeq: null })],
      toolCalls: [
        call(2, iso(2), { turnIndex: 0 }),
        call(4, iso(4), { turnIndex: 0 }),
        call(8, iso(8), { turnIndex: 1 }),
        call(9, iso(9), { turnIndex: -1 }),
      ],
    });
    markPostFinal(s);
    expect(s.toolCalls[0]?.postFinal).toBeUndefined();
    expect(s.toolCalls[1]?.postFinal).toBe(true);
    expect(s.toolCalls[2]?.postFinal).toBeUndefined(); // no final in that turn
    expect(s.toolCalls[3]?.postFinal).toBeUndefined(); // session-level
  });
});
