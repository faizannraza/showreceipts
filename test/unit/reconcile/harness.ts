/**
 * S17 test harness: factories for synthetic sessions and the loader for the
 * `fixtures/reconcile/*.json` scenario files. Not a test file — imported by
 * the reconcile suites.
 *
 * Fixture shape (all sections optional except `claims`/`expect`):
 *
 *   { "name", "row",
 *     "session": Partial<Session>, "turn": Partial<Turn>, "turnIndex": 1,
 *     "toolCalls": [ Partial<ToolCall> & {seq} ],
 *     "ledger": { "writes": [...], "testRuns": [...], "checks": [...],
 *                  "git": [...], "commands": [...], "integrity": [...],
 *                  "incomplete", "incompleteReasons", "opaqueTestCapable" },
 *     "claims": [ Partial<Claim> & {id} ],
 *     "expect": [ { "claimId", "verdict", "reason", "evidence"?, "notes"?,
 *                   "integrity"?, "textIncludes"? } ] }
 *
 * Facts may carry `"at"` (ISO): the harness auto-creates the backing tool
 * call at that time (merged with `"call"` overrides); calls with seq ≤ 9
 * belong to turn 0, later ones to turn 1. Default turn 1: seq 10–99,
 * finalSeq 90, 17:00 → 23:58 UTC on 2026-03-01.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  CheckRun,
  Claim,
  CommandFact,
  Cost,
  Diagnostics,
  GitFact,
  IntegritySignal,
  Judgement,
  Ledger,
  Receipt,
  Session,
  ShellSegment,
  TestRun,
  ToolCall,
  Turn,
  UsageTotals,
  WriteFact,
} from '../../../src/model/types.js';

export const CWD = '/home/u/proj';
export const FIXTURES_DIR = fileURLToPath(new URL('../../../fixtures/reconcile/', import.meta.url));
/** Acceptance criterion S17: every evidence string carries a `(HH:MM[, HH:MM…])` time. */
export const TIME_RE = /\(\d\d:\d\d(, \d\d:\d\d)*\)/;

// --- factories (conventions shared with test/unit/ledger/index.test.ts) -----

export function totals(over: Partial<UsageTotals> = {}): UsageTotals {
  return { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteOther: 0, output: 0, thinking: 0, calls: 0, byModel: {}, ...over };
}

export function emptyCost(over: Partial<Cost> = {}): Cost {
  return {
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
    pricesVersion: '0',
    notes: [],
    ...over,
  };
}

export function diagnostics(over: Partial<Diagnostics> = {}): Diagnostics {
  return {
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
    ...over,
  };
}

export function emptyLedger(over: Partial<Ledger> = {}): Ledger {
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
    ...over,
  };
}

export function turn(over: Partial<Turn> = {}): Turn {
  return {
    index: 1,
    kind: 'human',
    promptId: 'p1',
    userText: 'do the thing',
    echoHashes: [],
    segments: [],
    seqStart: 10,
    seqEnd: 99,
    startedAt: '2026-03-01T17:00:00.000Z',
    endedAt: '2026-03-01T23:58:00.000Z',
    durationMs: null,
    finalText: 'Done.',
    finalSeq: 90,
    finalMessageId: null,
    finalTrigger: 'human',
    interimFinals: 0,
    harnessVersion: '2.1.215',
    model: 'claude-sonnet-4-5',
    isDone: true,
    interrupted: false,
    compactions: 0,
    opaqueWriteCommands: 0,
    opaqueTestCommands: 0,
    usage: totals(),
    costUsd: null,
    apiCalls: 0,
    finalStopReason: 'end_turn',
    ...over,
  };
}

export function call(seq: number, over: Partial<ToolCall> = {}): ToolCall {
  return {
    seq,
    id: `t${seq}`,
    tool: 'Bash',
    kind: 'shell',
    agentId: null,
    turnIndex: seq <= 9 ? 0 : 1,
    cwd: CWD,
    input: {},
    resultText: '',
    resultBytes: 0,
    isError: false,
    exitCode: 0,
    exitCodeSource: 'harness',
    interrupted: false,
    background: false,
    startedAt: '2026-03-01T17:30:00.000Z',
    endedAt: null,
    filesTouched: [],
    ...over,
  };
}

export function session(over: Partial<Session> = {}): Session {
  return {
    harness: 'claude-code',
    harnessVersion: '2.1.215',
    harnessVersions: ['2.1.215'],
    sessionId: 'ab12cd34-1111-4222-8333-444455556666',
    shortId: 'ab12cd34',
    source: 'transcript',
    transcriptPath: '/home/u/.claude/projects/-home-u-proj/ab12cd34-1111-4222-8333-444455556666.jsonl',
    cwd: CWD,
    cwds: [CWD],
    repoRoot: CWD,
    gitBranch: null,
    title: null,
    models: ['claude-sonnet-4-5'],
    primaryModel: 'claude-sonnet-4-5',
    startedAt: '2026-03-01T16:00:00.000Z',
    endedAt: '2026-03-02T00:00:00.000Z',
    durationMs: 28_800_000,
    activeMs: null,
    turns: [
      turn({
        index: 0,
        promptId: 'p0',
        seqStart: 1,
        seqEnd: 9,
        startedAt: '2026-03-01T16:00:00.000Z',
        endedAt: '2026-03-01T16:30:00.000Z',
        finalText: 'Earlier.',
        finalSeq: 8,
      }),
      turn(),
    ],
    preamble: [],
    toolCalls: [],
    ledger: emptyLedger(),
    usage: totals(),
    cost: emptyCost(),
    compactions: [],
    subagents: [],
    prRefs: [],
    apiErrors: [],
    refusalFallbacks: [],
    diagnostics: diagnostics(),
    usageRows: [],
    tokenDeltas: [],
    kind: 'normal',
    records: 0,
    spansDays: 1,
    editedFiles: [],
    ...over,
  };
}

export function claim(over: Partial<Claim> & { id: string }): Claim {
  return {
    kind: 'test',
    polarity: 'positive',
    attribution: 'agent',
    rule: 'test.pass',
    sentence: 'Tests pass.',
    clause: 'tests pass',
    position: 0,
    echoed: false,
    ...over,
  };
}

// --- fact factories ---------------------------------------------------------

export function write(over: Partial<WriteFact> & { seq: number }): WriteFact {
  const path = over.path ?? `${CWD}/src/app.py`;
  return {
    toolCallId: `t${over.seq}`,
    agentId: null,
    path,
    display: path.startsWith(`${CWD}/`) ? path.slice(CWD.length + 1) : path,
    verb: 'update',
    source: 'tool',
    status: 'ok',
    resolved: true,
    scope: 'repo',
    isTestFile: false,
    isDoc: false,
    ...over,
  };
}

export function testRun(over: Partial<TestRun> & { seq: number }): TestRun {
  return {
    toolCallId: `t${over.seq}`,
    agentId: null,
    runner: 'pytest',
    command: 'pytest',
    scope: 'full',
    targets: [],
    kind: 'run',
    exitCode: 0,
    exitCodeSource: 'harness',
    green: true,
    conclusive: true,
    truncated: false,
    ...over,
  };
}

export function check(over: Partial<CheckRun> & { seq: number }): CheckRun {
  return {
    toolCallId: `t${over.seq}`,
    family: 'lint',
    tool: 'ruff',
    scope: 'full',
    exitCode: 0,
    green: true,
    ...over,
  };
}

export function gitFact(over: Partial<GitFact> & { seq: number }): GitFact {
  return { op: 'commit', ok: true, source: 'command', ...over };
}

export function segment(over: Partial<ShellSegment> & { program: string }): ShellSegment {
  const raw = over.raw ?? [over.program, ...(over.argv ?? [])].join(' ');
  return {
    argv: [],
    cwd: CWD,
    exitCode: 0,
    exitCodeSource: 'harness',
    piped: false,
    suppressed: false,
    ran: true,
    redirects: [],
    scanTokens: [over.program, ...(over.argv ?? [])],
    ...over,
    raw,
  };
}

export function commandFact(over: Partial<CommandFact> & { seq: number }): CommandFact {
  return {
    toolCallId: `t${over.seq}`,
    agentId: null,
    raw: over.segments?.map((s) => s.raw).join(' && ') ?? '',
    segments: [],
    exitCode: 0,
    exitCodeSource: 'harness',
    chained: false,
    background: false,
    interrupted: false,
    ...over,
  };
}

// --- perTurn (mini S14, enough for the reconcile context) -------------------

/** Recomputes `Ledger.perTurn` counters from the fact arrays and tool calls. */
export function computePerTurn(ledger: Ledger, calls: readonly ToolCall[]): Ledger['perTurn'] {
  const bySeqId = new Map<string, ToolCall>();
  for (const c of calls) bySeqId.set(c.id, c);
  const perTurn: Ledger['perTurn'] = {};
  const entry = (toolCallId: string): Ledger['perTurn'][number] | null => {
    const index = bySeqId.get(toolCallId)?.turnIndex;
    if (index === undefined || index < 0) return null;
    perTurn[index] ??= { W: null, Wsrc: null, G: null, R: null, writes: 0, testRuns: 0, checks: 0, commands: 0 };
    return perTurn[index] as Ledger['perTurn'][number];
  };
  for (const f of ledger.commands) {
    const e = entry(f.toolCallId);
    if (e !== null) e.commands += 1;
  }
  for (const w of ledger.writes) {
    const e = entry(w.toolCallId);
    if (e === null) continue;
    e.writes += 1;
    if (w.status !== 'ok') continue;
    if (e.W === null || w.seq > e.W) e.W = w.seq;
    if (!w.isTestFile && !w.isDoc && (e.Wsrc === null || w.seq > e.Wsrc)) e.Wsrc = w.seq;
  }
  for (const r of ledger.testRuns) {
    const e = entry(r.toolCallId);
    if (e === null) continue;
    e.testRuns += 1;
    if (r.green === true && (e.G === null || r.seq > e.G)) e.G = r.seq;
    if (r.green === false && (e.R === null || r.seq > e.R)) e.R = r.seq;
  }
  for (const c of ledger.checks) {
    const e = entry(c.toolCallId);
    if (e !== null) e.checks += 1;
  }
  return perTurn;
}

// --- fixture loading --------------------------------------------------------

/** Expected outcome of one claim in a fixture. */
export interface FixtureExpectation {
  claimId: string;
  verdict: Judgement['verdict'];
  reason: Judgement['reason'];
  evidence?: string[] | undefined;
  notes?: string[] | undefined;
  integrity?: 'test-weakened' | undefined;
  textIncludes?: string | undefined;
}

/** A ledger fact in a fixture: partial, plus the time/call of its auto-created tool call. */
type FixtureFact<T> = Partial<T> & { seq: number; at?: string | undefined; call?: Partial<ToolCall> | undefined };

/** The fact arrays a fixture may declare (`| undefined` keeps spreads assignable). */
export interface FixtureLedger {
  writes?: FixtureFact<WriteFact>[] | undefined;
  testRuns?: FixtureFact<TestRun>[] | undefined;
  checks?: FixtureFact<CheckRun>[] | undefined;
  git?: FixtureFact<GitFact>[] | undefined;
  commands?: (Omit<FixtureFact<CommandFact>, 'segments'> & { segments?: (Partial<ShellSegment> & { program: string })[] | undefined })[] | undefined;
  integrity?: IntegritySignal[] | undefined;
  incomplete?: boolean | undefined;
  incompleteReasons?: string[] | undefined;
  opaqueTestCapable?: number | undefined;
}

/** One `fixtures/reconcile/*.json` scenario. */
export interface ReconcileFixture {
  name: string;
  row: number;
  turnIndex?: number | undefined;
  session?: Partial<Session> | undefined;
  turn?: Partial<Turn> | undefined;
  toolCalls?: (Partial<ToolCall> & { seq: number })[] | undefined;
  ledger?: FixtureLedger | undefined;
  claims: (Partial<Claim> & { id: string })[];
  expect: FixtureExpectation[];
}

/** Every fixture file name, sorted (the 48 scenarios). */
export function listReconcileFixtures(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

/** Parses one fixture file. */
export function readReconcileFixture(file: string): ReconcileFixture {
  return JSON.parse(readFileSync(`${FIXTURES_DIR}${file}`, 'utf8')) as ReconcileFixture;
}

type FactWithCall = { seq: number; at?: string | undefined; call?: Partial<ToolCall> | undefined };

/** Builds the synthetic `Session` a fixture describes. */
export function sessionOf(fix: ReconcileFixture): Session {
  const calls = new Map<number, ToolCall>();
  for (const c of fix.toolCalls ?? []) calls.set(c.seq, call(c.seq, c));
  const ensureCall = (fact: FactWithCall, over: Partial<ToolCall> = {}): void => {
    if (calls.has(fact.seq)) return;
    const extra: Partial<ToolCall> = { ...over, ...fact.call };
    if (fact.at !== undefined) extra.startedAt = fact.at;
    calls.set(fact.seq, call(fact.seq, extra));
  };
  const strip = <T extends FactWithCall>(fact: T): Omit<T, 'at' | 'call'> => {
    const { at: _at, call: _call, ...rest } = fact;
    return rest;
  };

  const lf = fix.ledger ?? {};
  const writes = (lf.writes ?? []).map((f) => {
    ensureCall(f, { tool: 'Edit', kind: 'edit' });
    return write(strip(f));
  });
  const testRuns = (lf.testRuns ?? []).map((f) => {
    ensureCall(f);
    return testRun(strip(f));
  });
  const checks = (lf.checks ?? []).map((f) => {
    ensureCall(f);
    return check(strip(f));
  });
  const git = (lf.git ?? []).map((f) => {
    ensureCall(f);
    return gitFact(strip(f));
  });
  const commands = (lf.commands ?? []).map((f) => {
    ensureCall(f);
    const { segments: partialSegments, ...rest } = strip(f);
    return commandFact({ ...rest, segments: (partialSegments ?? []).map((s) => segment(s)) });
  });

  const toolCalls = [...calls.values()].sort((a, b) => a.seq - b.seq);
  const ledger = emptyLedger({
    writes,
    testRuns,
    checks,
    git,
    commands,
    integrity: lf.integrity ?? [],
    incomplete: lf.incomplete ?? false,
    incompleteReasons: lf.incompleteReasons ?? (lf.incomplete === true ? ['1 subagent transcript not found'] : []),
    opaqueTestCapable: lf.opaqueTestCapable ?? 0,
  });
  ledger.perTurn = computePerTurn(ledger, toolCalls);

  const turnOver = fix.turn ?? {};
  const s = session({ ...fix.session, toolCalls, ledger });
  const index = fix.turnIndex ?? 1;
  s.turns = s.turns.map((t) => (t.index === index ? turn({ index, ...turnOver }) : t));
  return s;
}

/** The fixture's claims as full `Claim`s. */
export function claimsOf(fix: ReconcileFixture): Claim[] {
  return fix.claims.map((c) => claim(c));
}

// --- receipt factory (rate tests) -------------------------------------------

export function receipt(over: Partial<Receipt> & { turnIndex: number }): Receipt {
  return {
    schema: 'showreceipts.receipt/1',
    toolVersion: '0.1.0',
    rulesVersion: 'claims/1+reconcile/1',
    pricesVersion: '0',
    kind: 'scored',
    id: 'ab12cd34-1111-4222-8333-444455556666',
    shortId: 'ab12cd34',
    harness: 'claude-code',
    harnessLabel: 'Claude Code',
    harnessVersion: '2.1.215',
    model: 'claude-sonnet-4-5',
    cwd: CWD,
    branch: null,
    startedAt: '2026-03-01T17:00:00.000Z',
    endedAt: '2026-03-01T23:58:00.000Z',
    durationMs: 25_080_000,
    source: 'transcript',
    finalTrigger: 'human',
    turnsWithClaims: [],
    finalText: 'Done.',
    finalTextSource: 'transcript',
    claims: [],
    judgements: [],
    lines: [],
    alsoSaid: [],
    alsoDid: [],
    stats: { toolCalls: 0, filesChanged: 0, testRuns: 0, compactions: 0, subagents: 0, apiCalls: 0, sentencesScanned: 0 },
    cost: emptyCost(),
    verdict: 'VERIFIED',
    counts: { VERIFIED: 0, UNVERIFIED: 0, CONTRADICTED: 0, NOT_SCORED: 0 },
    turnActiveMs: null,
    claimsRecognized: 0,
    ...over,
  };
}

export function judgementOf(over: Partial<Judgement> & { claimId: string }): Judgement {
  return { verdict: 'VERIFIED', reason: 'ok', evidence: [], text: '', notes: [], ...over };
}
