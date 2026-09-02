/**
 * S14 — ledger assembly (`ledger/index.ts`, §4.6, §4.8): extractors run in
 * `seq` order over one shared context; per-turn and per-session indices
 * (`W`/`Wsrc`/`G`/`R`, `lastWriteSeq`/`lastSourceWriteSeq`/`lastGreenSeq`,
 * `filesChanged`); opaque-command counters; the three §4.8 incompleteness
 * reasons independently; hook-captured sessions re-run shell-write inference
 * over `in.command` with the line's cwd; and `buildLedger` never throws over
 * any reader fixture.
 */
import { existsSync, rmSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildLedger } from '../../../src/ledger/index.js';
import type {
  Cost,
  Diagnostics,
  Harness,
  Ledger,
  Session,
  SessionRef,
  ToolCall,
  Turn,
  UsageTotals,
} from '../../../src/model/types.js';
import { readClaudeCodeSession } from '../../../src/readers/claude-code/reader.js';
import { readCodexSession } from '../../../src/readers/codex/reader.js';
import { readLedgerSession } from '../../../src/readers/ledger/reader.js';
import { fixtureHarness, listFixtureFiles, listFixtures, materialize, readFixtureBytes } from '../../helpers/fixtures.js';
import { makeTempDir } from '../../helpers/tmp.js';

const HOME = '/home/u';
const CWD = '/home/u/proj';
const LEDGER_FIXTURES = fileURLToPath(new URL('../../../fixtures/ledger/', import.meta.url));

// --- factories --------------------------------------------------------------

function totals(): UsageTotals {
  return { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteOther: 0, output: 0, thinking: 0, calls: 0, byModel: {} };
}

function emptyCost(): Cost {
  return { usd: null, apiCalls: 0, input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteOther: 0, output: 0, cacheHitPct: null, unverified: false, unpriced: [], apiEquivalent: true, pricesVersion: '0', notes: [] };
}

function diagnostics(over: Partial<Diagnostics> = {}): Diagnostics {
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

function emptyLedger(over: Partial<Ledger> = {}): Ledger {
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

function turn(index: number, seqStart: number, seqEnd: number): Turn {
  return {
    index,
    kind: 'human',
    promptId: `p${index}`,
    userText: 'do the thing',
    echoHashes: [],
    segments: [],
    seqStart,
    seqEnd,
    startedAt: '2026-02-10T10:00:00.000Z',
    endedAt: '2026-02-10T10:05:00.000Z',
    durationMs: null,
    finalText: 'Done.',
    finalSeq: null,
    finalMessageId: null,
    finalTrigger: 'human',
    interimFinals: 0,
    harnessVersion: null,
    model: null,
    isDone: true,
    interrupted: false,
    compactions: 0,
    opaqueWriteCommands: 0,
    opaqueTestCommands: 0,
    usage: totals(),
    costUsd: null,
    apiCalls: 0,
    finalStopReason: null,
  };
}

function call(seq: number, turnIndex: number, over: Partial<ToolCall> = {}): ToolCall {
  return {
    seq,
    id: `t${seq}`,
    tool: 'Bash',
    kind: 'shell',
    agentId: null,
    turnIndex,
    cwd: CWD,
    input: {},
    resultText: '',
    resultBytes: 0,
    isError: false,
    exitCode: 0,
    exitCodeSource: 'harness',
    interrupted: false,
    background: false,
    startedAt: '2026-02-10T10:00:10.000Z',
    endedAt: '2026-02-10T10:00:11.000Z',
    filesTouched: [],
    ...over,
  };
}

function session(over: Partial<Session> = {}): Session {
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
    startedAt: '2026-02-10T10:00:00.000Z',
    endedAt: '2026-02-10T10:30:00.000Z',
    durationMs: 1_800_000,
    activeMs: null,
    turns: [],
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

/** Structural invariants every built ledger upholds (used over the fixtures too). */
function checkInvariants(s: Session, ledger: Ledger): void {
  const byId = new Set(s.toolCalls.map((c) => c.id));
  const arrays: { seq: number }[][] = [ledger.writes, ledger.commands, ledger.testRuns, ledger.checks, ledger.git, ledger.network, ledger.integrity, ledger.danger];
  for (const facts of arrays) {
    const seqs = facts.map((f) => f.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  }
  for (const f of [...ledger.writes, ...ledger.commands, ...ledger.testRuns, ...ledger.checks]) {
    expect(byId.has((f as { toolCallId: string }).toolCallId)).toBe(true);
  }
  expect(ledger.filesChanged).toEqual([...new Set(ledger.filesChanged)].sort());
  for (const key of Object.keys(ledger.perTurn)) expect(Number.isInteger(Number(key))).toBe(true);
}

// --- the synthetic two-turn session (acceptance criterion 1) ----------------

const PYTEST_GREEN =
  'tests/test_api.py ....................                                   [100%]\n\n============================= 397 passed, 37 warnings in 33.70s ==============================\n';
const PYTEST_RED = '============================= 1 failed, 396 passed in 33.70s ==============================\n';
const PY_OPAQUE = 'python3 -c \'for i in range(3):\n    open(f"/tmp/x-{i}.json", "w").write(str(i))\'';

function twoTurnSession(): Session {
  const calls: ToolCall[] = [
    // Deliberately shuffled: the assembly must sort explicitly, never rely on input order.
    call(13, 1, { command: 'pytest tests/test_x.py', exitCode: 1, resultText: PYTEST_RED }),
    call(2, 0, { tool: 'Edit', kind: 'edit', input: { file_path: '/home/u/proj/src/app.ts' }, filesTouched: ['/home/u/proj/src/app.ts'] }),
    call(16, 1, { tool: 'Edit', kind: 'edit', input: { file_path: '/home/u/proj/src/core.ts' }, filesTouched: ['/home/u/proj/src/core.ts'] }),
    call(4, 0, { command: 'pytest', resultText: PYTEST_GREEN }),
    call(10, 1, { command: 'mkdir -p build' }),
    call(3, 0, { tool: 'Write', kind: 'write', input: { file_path: '/home/u/proj/test/app.test.ts' }, filesTouched: ['/home/u/proj/test/app.test.ts'], created: true }),
    call(12, 1, { command: 'pytest -q | tail -5', resultText: '....\n' }),
    call(5, 0, { command: 'ruff check .', resultText: 'All checks passed!\n' }),
    call(6, 0, { tool: 'Edit', kind: 'edit', input: { file_path: '/home/u/proj/src/bad.ts' }, isError: true, resultText: 'File has not been read yet' }),
    call(14, 1, { command: 'bash scripts/test.sh', resultText: 'ok\n' }),
    call(15, 1, { command: PY_OPAQUE }),
    call(11, 1, { tool: 'Edit', kind: 'edit', input: { file_path: '/home/u/proj/README.md' }, filesTouched: ['/home/u/proj/README.md'] }),
  ];
  return session({ turns: [turn(0, 1, 8), turn(1, 9, 17)], toolCalls: calls });
}

describe('buildLedger over a synthetic two-turn session', () => {
  const s = twoTurnSession();
  const ledger = buildLedger(s);

  it('sorts every fact array by seq regardless of input order', () => {
    checkInvariants(s, ledger);
    expect(ledger.commands.map((c) => c.seq)).toEqual([4, 5, 10, 12, 13, 14, 15]);
    expect(ledger.writes.map((w) => w.seq)).toEqual([2, 3, 6, 10, 11, 16]);
  });

  it('computes filesChanged sorted, unique, ok-only (no failed, metadata or /tmp interp targets)', () => {
    expect(ledger.filesChanged).toEqual([
      '/home/u/proj/README.md',
      '/home/u/proj/src/app.ts',
      '/home/u/proj/src/core.ts',
      '/home/u/proj/test/app.test.ts',
    ]);
  });

  it('computes the session indices; lastGreenSeq ignores unknown and red runs', () => {
    expect(ledger.lastWriteSeq).toBe(16);
    expect(ledger.lastSourceWriteSeq).toBe(16);
    expect(ledger.lastGreenSeq).toBe(4);
    const greens = ledger.testRuns.map((r) => [r.seq, r.green]);
    expect(greens).toEqual([
      [4, true],
      [12, 'unknown'],
      [13, false],
    ]);
  });

  it('fills perTurn with the S02 shape for both turns', () => {
    expect(Object.keys(ledger.perTurn)).toEqual(['0', '1']);
    expect(ledger.perTurn[0]).toEqual({ W: 3, Wsrc: 2, G: 4, R: null, writes: 3, testRuns: 1, checks: 1, commands: 2 });
    expect(ledger.perTurn[1]).toEqual({ W: 16, Wsrc: 16, G: null, R: 13, writes: 3, testRuns: 2, checks: 0, commands: 5 });
  });

  it('per-turn W excludes the failed write; Wsrc excludes the test-file and doc writes', () => {
    // Turn 0: W = the test-file write (3), Wsrc = the src write (2), never the failed Edit (6).
    expect(ledger.perTurn[0]?.W).toBe(3);
    expect(ledger.perTurn[0]?.Wsrc).toBe(2);
    // Turn 1: README.md (11) is a doc — Wsrc comes from core.ts (16).
    const readme = ledger.writes.find((w) => w.seq === 11);
    expect(readme?.isDoc).toBe(true);
  });

  it('counts opaque write/test commands on the turns and opaqueTestCapable on the ledger', () => {
    expect(s.turns[0]?.opaqueWriteCommands).toBe(0);
    expect(s.turns[0]?.opaqueTestCommands).toBe(0);
    expect(s.turns[1]?.opaqueWriteCommands).toBe(1); // the f-string python sink
    expect(s.turns[1]?.opaqueTestCommands).toBe(1); // bash scripts/test.sh
    expect(ledger.opaqueTestCapable).toBe(1);
  });

  it('is complete: unknown exits are never an incompleteness reason', () => {
    expect(ledger.incomplete).toBe(false);
    expect(ledger.incompleteReasons).toEqual([]);
  });

  it('is idempotent: a rebuild (after assigning the result) yields the same ledger and counters', () => {
    const again = twoTurnSession();
    const first = buildLedger(again);
    again.ledger = first;
    const second = buildLedger(again);
    expect(second).toEqual(first);
    expect(again.turns[1]?.opaqueWriteCommands).toBe(1); // not double-counted
    expect(again.turns[1]?.opaqueTestCommands).toBe(1);
  });

  it('ignores cross-session inherited usage rows (they never reach the ledger)', () => {
    const withRows = twoTurnSession();
    withRows.usageRows = [
      { seq: 1, agentId: null, messageId: 'm1', ts: '2026-02-10T10:00:01.000Z', attempts: [], promptTokens: 5, inherited: true },
    ];
    expect(buildLedger(withRows)).toEqual(ledger);
  });
});

// --- incompleteness (§4.8), each reason independently -----------------------

describe('incomplete per §4.8', () => {
  it('true when subagent transcripts are missing (with a counted reason)', () => {
    const s = session({ diagnostics: diagnostics({ subagentFiles: { direct: 2, workflow: 0, unlinked: 0, missing: 2 } }) });
    const ledger = buildLedger(s);
    expect(ledger.incomplete).toBe(true);
    expect(ledger.incompleteReasons).toEqual(['2 subagent transcripts not found']);
  });

  it('uses the singular form for one missing transcript', () => {
    const s = session({ diagnostics: diagnostics({ subagentFiles: { direct: 1, workflow: 0, unlinked: 0, missing: 1 } }) });
    expect(buildLedger(s).incompleteReasons).toEqual(['1 subagent transcript not found']);
  });

  it('true for gap lines / partial hook coverage (the reader stores the reason)', () => {
    const s = session({
      source: 'ledger',
      ledgerCoverage: 'partial',
      ledger: emptyLedger({ incomplete: true, incompleteReasons: ['gap lines in the ledger'] }),
    });
    const ledger = buildLedger(s);
    expect(ledger.incomplete).toBe(true);
    expect(ledger.incompleteReasons).toEqual(['gap lines in the ledger']);
  });

  it('true for a ledger session without a session-start within 60 s of its first tool event', () => {
    const s = session({
      source: 'ledger',
      ledgerCoverage: 'partial',
      ledger: emptyLedger({ incomplete: true, incompleteReasons: ['no session-start within 60s of the first tool event'] }),
    });
    const ledger = buildLedger(s);
    expect(ledger.incomplete).toBe(true);
    expect(ledger.incompleteReasons).toEqual(['no session-start within 60s of the first tool event']);
  });

  it('true for partial coverage even when no stored reason survived', () => {
    const s = session({ source: 'ledger', ledgerCoverage: 'partial' });
    const ledger = buildLedger(s);
    expect(ledger.incomplete).toBe(true);
    expect(ledger.incompleteReasons).toEqual(['ledger coverage partial']);
  });

  it('false otherwise — even when every exit code is unknown (cross-cutting rule i)', () => {
    const s = session({
      turns: [turn(0, 1, 3)],
      toolCalls: [
        call(1, 0, { command: 'pytest', exitCode: null, exitCodeSource: 'unknown', resultText: '' }),
        call(2, 0, { command: 'echo hi > out.txt', exitCode: null, exitCodeSource: 'unknown' }),
      ],
    });
    const ledger = buildLedger(s);
    expect(ledger.incomplete).toBe(false);
    expect(ledger.incompleteReasons).toEqual([]);
  });
});

// --- injected options (repoRootOf, tmpRoots) --------------------------------

describe('injected options', () => {
  it('resolves the session repo root through opts.repoRootOf when the session has none', () => {
    const s = session({
      repoRoot: null,
      turns: [turn(0, 1, 2)],
      toolCalls: [call(1, 0, { tool: 'Edit', kind: 'edit', input: { file_path: '/home/u/proj/src/x.ts' }, filesTouched: ['/home/u/proj/src/x.ts'] })],
    });
    const ledger = buildLedger(s, { repoRootOf: (p) => (p === CWD || p.startsWith(`${CWD}/`) ? CWD : null) });
    expect(ledger.writes[0]?.scope).toBe('repo');
  });

  it('classifies writes under a second root as other-repo via the resolver', () => {
    const s = session({
      turns: [turn(0, 1, 2)],
      toolCalls: [call(1, 0, { tool: 'Edit', kind: 'edit', input: { file_path: '/home/u/lib/z.ts' }, filesTouched: ['/home/u/lib/z.ts'] })],
    });
    const ledger = buildLedger(s, { repoRootOf: (p) => (p.startsWith('/home/u/lib') ? '/home/u/lib' : null) });
    expect(ledger.writes[0]?.scope).toBe('other-repo');
    expect(ledger.writes[0]?.otherRoot).toBe('/home/u/lib');
  });

  it('merges injected tmp roots with the pure defaults for the scratch scope', () => {
    const s = session({
      turns: [turn(0, 1, 3)],
      toolCalls: [call(1, 0, { command: 'echo x > /scratch2/out.txt' }), call(2, 0, { command: 'echo y > /private/tmp/y.txt' })],
    });
    const ledger = buildLedger(s, { tmpRoots: ['/scratch2'] });
    const scopes = ledger.writes.map((w) => [w.path, w.scope]);
    expect(scopes).toContainEqual(['/scratch2/out.txt', 'scratch']);
    expect(scopes).toContainEqual(['/tmp/y.txt', 'scratch']); // default root, canon-folded
  });
});

// --- derived home (homeOf fallbacks) and orphan turn indices ----------------

describe('derived home and orphan turns', () => {
  const shellWrite = (cwd: string): ToolCall => call(1, 0, { command: 'echo hi > ~/todo.txt', cwd });

  it('derives home from a home-shaped transcript path when no cwd matches', () => {
    const s = session({
      cwd: '/srv/proj',
      cwds: ['/srv/proj'],
      repoRoot: '/srv/proj',
      transcriptPath: '/home/u/.claude/projects/-srv-proj/ab12cd34-1111-4222-8333-444455556666.jsonl',
      turns: [turn(0, 1, 3)],
      toolCalls: [shellWrite('/srv/proj')],
    });
    expect(buildLedger(s).writes.map((w) => w.path)).toEqual(['/home/u/todo.txt']);
  });

  it('derives home from the directory above a harness config dir in the transcript path', () => {
    const s = session({
      cwd: '/srv/proj',
      cwds: ['/srv/proj'],
      repoRoot: '/srv/proj',
      transcriptPath: '/var/agents/.claude/projects/-srv-proj/ab12cd34-1111-4222-8333-444455556666.jsonl',
      turns: [turn(0, 1, 3)],
      toolCalls: [shellWrite('/srv/proj')],
    });
    expect(buildLedger(s).writes.map((w) => w.path)).toEqual(['/var/agents/todo.txt']);
  });

  it("uses home '' when nothing looks like a home: ~ collapses to /, never a guessed user", () => {
    const s = session({
      cwd: '/srv/proj',
      cwds: ['/srv/proj'],
      repoRoot: '/srv/proj',
      transcriptPath: null,
      turns: [turn(0, 1, 3)],
      toolCalls: [shellWrite('/srv/proj')],
    });
    expect(buildLedger(s).writes.map((w) => w.path)).toEqual(['/todo.txt']);
  });

  it('creates a perTurn entry for a turnIndex with no Turn and touches no Turn counters', () => {
    const s = session({
      turns: [turn(0, 1, 3)],
      toolCalls: [
        call(1, 0, { command: 'ls' }),
        call(5, 7, { tool: 'Edit', kind: 'edit', input: { file_path: '/home/u/proj/src/x.ts' }, filesTouched: ['/home/u/proj/src/x.ts'] }),
      ],
    });
    const ledger = buildLedger(s);
    checkInvariants(s, ledger);
    expect(Object.keys(ledger.perTurn)).toEqual(['0', '7']);
    expect(ledger.perTurn[7]).toEqual({ W: 5, Wsrc: 5, G: null, R: null, writes: 1, testRuns: 0, checks: 0, commands: 0 });
    expect(s.turns).toHaveLength(1); // no phantom Turn is invented for the orphan index
    expect(s.turns[0]?.opaqueWriteCommands).toBe(0);
  });
});

// --- hook-captured sessions: same inference code path as transcripts --------

describe('hook-captured sessions', () => {
  const sid = 'c1a2b3c4-0000-4000-8000-00000000c001';
  const lines = [
    { v: 1, t: '2026-03-05T10:00:00Z', h: 'cursor', e: 'session-start', sid, hv: '1.7.2', model: 'gpt-5', source: 'startup' },
    { v: 1, t: '2026-03-05T10:00:20Z', h: 'cursor', e: 'tool-post', sid, tid: 'gen-1', cwd: '/home/u/proj/sub', exitSource: 'harness', id: 'tu-1', tool: 'Shell', kind: 'shell', in: { command: 'printf hi > notes/log.txt' }, out: { text: '', bytes: 0, exit: 0 } },
    { v: 1, t: '2026-03-05T10:00:30Z', h: 'cursor', e: 'tool-post', sid, tid: 'gen-1', cwd: '/home/u/proj/other', exitSource: 'harness', id: 'tu-2', tool: 'Shell', kind: 'shell', in: { command: 'echo a > b.txt' }, out: { text: '', bytes: 0, exit: 0 } },
    { v: 1, t: '2026-03-05T10:00:40Z', h: 'cursor', e: 'stop', sid, tid: 'gen-1', status: 'completed' },
  ]
    .map((l) => JSON.stringify(l))
    .join('\n');
  const ref: SessionRef = { harness: 'cursor', sessionId: sid, path: '/x/led.jsonl', size: 0, mtimeMs: 0, subagentManifest: [], ledger: true };

  it('re-runs shell-write inference over in.command with each line own cwd', () => {
    const s = readLedgerSession(ref, { home: '/home/u/.showreceipts', lines: { kind: 'text', text: `${lines}\n`, name: 'led.jsonl' } });
    const ledger = buildLedger(s);
    checkInvariants(s, ledger);
    const shellWrites = ledger.writes.filter((w) => w.source === 'shell-inferred');
    expect(shellWrites.map((w) => [w.path, w.status])).toEqual([
      ['/home/u/proj/sub/notes/log.txt', 'ok'],
      ['/home/u/proj/other/b.txt', 'ok'],
    ]);
    expect(ledger.filesChanged).toEqual(['/home/u/proj/other/b.txt', '/home/u/proj/sub/notes/log.txt']);
  });
});

// --- every reader fixture: buildLedger never throws -------------------------

const REPO_ROOT_OF = (p: string): string | null => (p === CWD || p.startsWith(`${CWD}/`) ? CWD : null);

describe('buildLedger over every reader fixture', () => {
  const tmp = makeTempDir('s14-fixtures-');
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  for (const id of listFixtures()) {
    const harness = fixtureHarness(id);
    if (harness === 'claude-code') {
      it(`${id} (materialised, subagents merged)`, async () => {
        const m = materialize(id, tmp);
        const mains = m.paths.filter((p) => /projects\/[^/]+\/[^/]+\.jsonl$/.test(p.split(sep).join('/')));
        expect(mains.length).toBeGreaterThan(0);
        for (const main of mains) {
          const sessionId = basename(main, '.jsonl');
          const ref: SessionRef = { harness: 'claude-code', sessionId, path: main, size: 0, mtimeMs: 0, subagentManifest: [] };
          const subagentsDir = join(dirname(main), sessionId, 'subagents');
          const { session: s } = await readClaudeCodeSession(ref, {
            home: HOME,
            ...(existsSync(subagentsDir) ? { subagents: { kind: 'dir' as const, path: subagentsDir } } : {}),
          });
          const ledger = buildLedger(s, { repoRootOf: REPO_ROOT_OF, tmpRoots: ['/scratch'] });
          checkInvariants(s, ledger);
          expect(buildLedger(s)).toBeDefined(); // pure defaults too
        }
      });
    } else {
      it(`${id} (every rollout)`, async () => {
        const rollouts = listFixtureFiles(id)
          .map((f) => f.replace(/\.gz$/, ''))
          .filter((f) => /(^|\/)rollout-[^/]+\.jsonl$/.test(f));
        expect(rollouts.length).toBeGreaterThan(0);
        for (const rel of rollouts) {
          const text = readFixtureBytes(id, rel).toString('utf8');
          const uuid = /rollout-.*?-([0-9a-f-]{36})\.jsonl$/.exec(rel)?.[1] ?? 'unknown-session-id';
          const ref: SessionRef = { harness: 'codex', sessionId: uuid, path: `/home/u/.codex/${rel}`, size: text.length, mtimeMs: 0, subagentManifest: [] };
          const { session: s } = await readCodexSession(ref, { lines: { kind: 'text', text, name: rel }, home: HOME });
          const ledger = buildLedger(s, { repoRootOf: REPO_ROOT_OF });
          checkInvariants(s, ledger);
          expect(buildLedger(s)).toBeDefined();
        }
      });
    }
  }

  const HOOK_FIXTURES: { harness: Harness; sessionId: string; file: string }[] = [
    { harness: 'cursor', sessionId: 'c1a2b3c4-0000-4000-8000-00000000c001', file: 'cursor-basic.jsonl' },
    { harness: 'gemini', sessionId: 'gem-session-0001', file: 'gemini-basic.jsonl' },
    { harness: 'copilot', sessionId: 'copilot-sess-01', file: 'copilot-basic.jsonl' },
    { harness: 'hermes', sessionId: 'hermes-sess-9', file: 'hermes-basic.jsonl' },
    { harness: 'dsh', sessionId: '01900000-2222-7333-8444-555566667777', file: 'dsh-basic.jsonl' },
  ];

  for (const { harness, sessionId, file } of HOOK_FIXTURES) {
    it(`hook ledger fixture ${file}`, () => {
      const ref: SessionRef = { harness, sessionId, path: join(LEDGER_FIXTURES, file), size: 0, mtimeMs: 0, subagentManifest: [], ledger: true };
      const s = readLedgerSession(ref, { home: '/home/u/.showreceipts' });
      const ledger = buildLedger(s);
      checkInvariants(s, ledger);
    });
  }

  it('cursor-basic: the Edit tool-post write reaches filesChanged and npm test yields a run', () => {
    const ref: SessionRef = { harness: 'cursor', sessionId: 'c1a2b3c4-0000-4000-8000-00000000c001', path: join(LEDGER_FIXTURES, 'cursor-basic.jsonl'), size: 0, mtimeMs: 0, subagentManifest: [], ledger: true };
    const s = readLedgerSession(ref, { home: '/home/u/.showreceipts' });
    const ledger = buildLedger(s);
    expect(ledger.filesChanged).toEqual(['/home/u/proj/src/a.ts']);
    expect(ledger.testRuns).toHaveLength(1);
    expect(ledger.testRuns[0]?.runner).toBe('npm-script:test');
  });

  it('dsh-basic: subagent-list writes stay unknown-status and out of filesChanged; the red run is never green', () => {
    const ref: SessionRef = { harness: 'dsh', sessionId: '01900000-2222-7333-8444-555566667777', path: join(LEDGER_FIXTURES, 'dsh-basic.jsonl'), size: 0, mtimeMs: 0, subagentManifest: [], ledger: true };
    const s = readLedgerSession(ref, { home: '/home/u/.showreceipts' });
    const ledger = buildLedger(s);
    const subagentWrites = ledger.writes.filter((w) => w.source === 'subagent-list');
    expect(subagentWrites).toHaveLength(2);
    expect(subagentWrites.every((w) => w.status === 'unknown')).toBe(true);
    expect(ledger.filesChanged).toEqual(['/home/u/proj/src/b.ts']); // failed Edit and unknown subagent files excluded
    expect(ledger.lastGreenSeq).toBeNull();
    expect(ledger.testRuns[0]?.green).toBe(false);
  });
});
