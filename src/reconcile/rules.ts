/**
 * The §4.8 reconcile-rule table as data (S17): one `Row` per table row, each
 * with an `appliesTo` predicate over the claim and a `judge` function over the
 * scoped facts. Pure functions — no fs, no os, no env, no wall clock; every
 * timestamp comes from the session's own records.
 *
 * Scoping (§4.8 definitions): `F` = the turn's `finalSeq`; every fact array in
 * `ScopedFacts` is pre-filtered to `seq ≤ F` (subagent events included), and
 * the write boundaries are computed as
 *   `W`    = last `ok` source write `seq < F` — not a test file, not a doc,
 *            not `metadataOnly`, not a non-executable file (`.md .txt .rst
 *            .json .yml .yaml .toml .lock LICENSE*` — the §4.8 stale-run
 *            refinement; decision recorded in docs/decisions.md S17),
 *   `Wall` = last `ok` write of any kind `seq < F`, still ignoring
 *            `metadataOnly` (a `touch`/`mkdir` never makes a commit stale).
 *
 * Precision doctrine (§1): CONTRADICTED always cites a positive contrary fact
 * except the four-guard `no-test-run`; every absence-based contradiction
 * degrades to UNVERIFIED `ledger-incomplete` when the ledger is incomplete
 * (rule iv); red evidence with `exitCodeSource:'unknown'` and nothing parsed
 * can never contradict (rule i).
 */
import type {
  CheckRun,
  Claim,
  CommandFact,
  EvidenceRef,
  GitFact,
  Judgement,
  Ledger,
  Reason,
  Session,
  ShellSegment,
  TestRun,
  ToolCall,
  Turn,
  Verdict,
  WriteFact,
} from '../model/types.js';
import { resolveSubject, type SubjectResolution } from '../claims/paths.js';
import { filesChangedEligible } from '../ledger/writes.js';
import { basename } from '../util/paths.js';
import { absenceRef, callRef, evidenceLabel, makeRef, writeRefs } from './evidence.js';

/**
 * Version stamp of the reconcile table (folded into `Receipt.rulesVersion`
 * by the pipeline). `reconcile/2` (S35 accuracy gate, §14.3): the row-9
 * edited-not-deleted and row-21 path-less writes-despite-no-change
 * contradictions are demoted to UNVERIFIED — both misfired on the
 * hand-labelled real-session sample (see `docs/accuracy.md`).
 */
export const RECONCILE_RULES_VERSION = 'reconcile/2';

/** The note added to every echoed claim (§4.8 row 24). */
export const ECHO_NOTE = "echoes the user's message";

/** Cross-cutting note ii — a verifying write the user touched afterwards. */
export const USER_MODIFIED_NOTE = 'file changed outside the agent';

/** Non-executable files ignored by the staleness boundary (S17 instruction 2). */
const NONEXEC_RE = /\.(?:md|txt|rst|json|ya?ml|toml|lock)$|(?:^|\/)license[^/]*$/i;

/** Programs that inspect rather than exercise the change (§4.8 row 19). */
const INSPECTION_FREE = new Set(['echo', 'ls', 'cd', 'pwd', 'mkdir', 'touch', 'cp', 'mv', 'rm', 'sleep', 'printf', 'true', 'cat']);

/** Added lines that look like inline tests (§4.8 row 4). */
const TEST_ADD_RE = /#\[test\]|#\[cfg\(test\)\]|\bdef test_|\b(?:it|test|describe)\(|func Test[A-Z]|@Test\b|>>> /;

/** `command.ran_bare` noun → segment family (§4.8 row 13; `command` matches any segment). */
const NOUN_FAMILY: Readonly<Record<string, string>> = {
  migration: 'migrate',
  migrations: 'migrate',
  build: 'build',
  linter: 'lint',
  formatter: 'format',
  script: 'script',
  'smoke test': 'test',
  benchmark: 'script',
};

/** One `Ledger.perTurn` entry (S02 shape). */
type PerTurnEntry = Ledger['perTurn'][number];

/** A zeroed `perTurn` entry for turns the ledger never saw. */
export const EMPTY_PER_TURN: Readonly<PerTurnEntry> = Object.freeze({
  W: null,
  Wsrc: null,
  G: null,
  R: null,
  writes: 0,
  testRuns: 0,
  checks: 0,
  commands: 0,
});

/** The evidence window of one turn: every fact with `seq ≤ finalSeq`, plus the §4.8 boundaries. */
export interface ScopedFacts {
  finalSeq: number;
  writes: WriteFact[];
  testRuns: TestRun[];
  checks: CheckRun[];
  git: GitFact[];
  commands: CommandFact[];
  callById: ReadonlyMap<string, ToolCall>;
  callBySeq: ReadonlyMap<number, ToolCall>;
  /** Stale boundary: last `ok` source write `seq < F` (see module doc). */
  W: number | null;
  /** Last `ok` non-`metadataOnly` write of any kind `seq < F`. */
  Wall: number | null;
  incomplete: boolean;
  incompleteNote: string;
}

/** What a row's `judge` sees (S17 instruction 1). */
export interface RowContext {
  claim: Claim;
  /** Every claim of the message (row 21 needs its siblings). */
  claims: readonly Claim[];
  turn: Turn;
  session: Session;
  ledger: Ledger;
  perTurn: PerTurnEntry;
  facts: ScopedFacts;
}

/** One §4.8 table row. */
export interface Row {
  /** §4.8 row number (drives `Explanation.row`). */
  row: number;
  id: string;
  appliesTo(claim: Claim): boolean;
  judge(ctx: RowContext): Judgement;
}

// ---------------------------------------------------------------------------
// Scope construction
// ---------------------------------------------------------------------------

/** True for a write that moves the staleness boundary `W`. */
function isStaleSource(w: WriteFact): boolean {
  return w.status === 'ok' && !w.isTestFile && !w.isDoc && w.metadataOnly !== true && !NONEXEC_RE.test(w.path);
}

/** True for a write that moves `Wall` (any kind, still no `metadataOnly`). */
function isStaleAny(w: WriteFact): boolean {
  return w.status === 'ok' && w.metadataOnly !== true;
}

/** Builds the `seq ≤ finalSeq` window over the session's ledger (§4.8; subagents included). */
export function buildFacts(session: Session, turn: Turn): ScopedFacts {
  const F = turn.finalSeq ?? turn.seqEnd;
  const inScope = <T extends { seq: number }>(facts: readonly T[]): T[] => facts.filter((f) => f.seq <= F);
  const callById = new Map<string, ToolCall>();
  const callBySeq = new Map<number, ToolCall>();
  for (const call of session.toolCalls) {
    callById.set(call.id, call);
    callBySeq.set(call.seq, call);
  }
  const writes = inScope(session.ledger.writes);
  let W: number | null = null;
  let Wall: number | null = null;
  for (const w of writes) {
    if (w.seq >= F) continue;
    if (isStaleAny(w) && (Wall === null || w.seq > Wall)) Wall = w.seq;
    if (isStaleSource(w) && (W === null || w.seq > W)) W = w.seq;
  }
  const reasons = session.ledger.incompleteReasons;
  return {
    finalSeq: F,
    writes,
    testRuns: inScope(session.ledger.testRuns),
    checks: inScope(session.ledger.checks),
    git: inScope(session.ledger.git),
    commands: inScope(session.ledger.commands),
    callById,
    callBySeq,
    W,
    Wall,
    incomplete: session.ledger.incomplete,
    incompleteNote: reasons.length > 0 ? reasons.join('; ') : 'ledger incomplete',
  };
}

// ---------------------------------------------------------------------------
// Judgement helpers
// ---------------------------------------------------------------------------

/** Judgement constructor (`text` carries no formatted time — §4.8 vii). */
function judgement(
  claim: Claim,
  verdict: Verdict,
  reason: Reason,
  evidence: EvidenceRef[],
  text: string,
  notes: string[] = []
): Judgement {
  return { claimId: claim.id, verdict, reason, evidence, text, notes };
}

/**
 * An absence-based contradiction, degraded to UNVERIFIED `ledger-incomplete`
 * when the ledger cannot see every effect (§4.8 iv).
 */
function absenceContradiction(
  ctx: RowContext,
  reason: Reason,
  evidence: EvidenceRef[],
  text: string,
  notes: string[] = []
): Judgement {
  if (ctx.facts.incomplete) {
    return judgement(ctx.claim, 'UNVERIFIED', 'ledger-incomplete', evidence, text, [...notes, ctx.facts.incompleteNote]);
  }
  return judgement(ctx.claim, 'CONTRADICTED', reason, evidence, text, notes);
}

/** The `exit codes unknown (ledger)` note for hook-captured sessions (S17 instruction 2). */
function ledgerExitNote(ctx: RowContext, notes: string[]): string[] {
  return ctx.session.source === 'ledger' ? [...notes, 'exit codes unknown (ledger)'] : notes;
}

/** Cross-cutting rule ii: notes a verifying write the user touched before `F`. */
function userModifiedNotes(ctx: RowContext, verifying: readonly WriteFact[]): string[] {
  const edited = ctx.session.editedFiles;
  for (const w of verifying) {
    if (w.userModified === true) return [USER_MODIFIED_NOTE];
    if (edited.some((e) => e.path === w.path && e.seq > w.seq && e.seq <= ctx.facts.finalSeq)) return [USER_MODIFIED_NOTE];
  }
  return [];
}

/** The turn a fact's tool call belongs to (`-1` when the call is unknown). */
function turnOf(facts: ScopedFacts, toolCallId: string): number {
  return facts.callById.get(toolCallId)?.turnIndex ?? -1;
}

/** ISO time of the tool call behind a fact (falls back to the turn end). */
function atOf(facts: ScopedFacts, toolCallId: string, turn: Turn): string {
  return facts.callById.get(toolCallId)?.startedAt ?? turn.endedAt;
}

/** Ref for one ledger fact via its tool call (`CheckRun` carries no agentId of its own). */
function factRef(facts: ScopedFacts, fact: { seq: number; toolCallId: string; agentId?: string | null }, turn: Turn, label: string): EvidenceRef {
  const call = facts.callById.get(fact.toolCallId);
  if (call !== undefined) return callRef(call, label);
  return makeRef(fact.seq, turn.endedAt, label, { agentId: fact.agentId ?? null });
}

// ---------------------------------------------------------------------------
// Test evidence (rows 1–3)
// ---------------------------------------------------------------------------

/** True when a run was launched in the background (§1: background calls are not runs). */
function isBackgroundRun(facts: ScopedFacts, run: TestRun): boolean {
  if (facts.callById.get(run.toolCallId)?.background === true) return true;
  return facts.commands.some((c) => c.toolCallId === run.toolCallId && c.background);
}

/** Parsed failures per §1 *red*. */
function parsedFailures(run: TestRun): boolean {
  const p = run.parsed;
  return p !== undefined && ((p.failed ?? 0) > 0 || (p.errors ?? 0) > 0 || (p.suites?.failed ?? 0) > 0);
}

/** Rule i: red evidence with an unknown exit source and nothing parsed cannot contradict. */
function redCanContradict(run: TestRun): boolean {
  return run.exitCodeSource !== 'unknown' || parsedFailures(run);
}

/** `uv run pytest → exit 0 · 41 passed` (time appended by `evidenceStrings`). */
function runLabel(run: TestRun): string {
  const cmd = evidenceLabel(run.command !== '' ? run.command : run.runner);
  const exit = run.exitCode === null ? '?' : String(run.exitCode);
  let label = `${cmd} → exit ${exit}`;
  const p = run.parsed;
  if (p !== undefined) {
    if ((p.failed ?? 0) > 0) label += ` · ${p.failed as number} failed`;
    else if (p.passed !== undefined) label += ` · ${p.passed} passed`;
  }
  return label;
}

/**
 * The guarded `no-test-run` contradiction shared by rows 1–3: no test run at
 * all before `F`. Each §4.8 guard independently downgrades to UNVERIFIED:
 * no `ok` tool/patch write → `no-evidence`; echoed → `echoed`; incomplete
 * ledger → `ledger-incomplete`; opaque test-capable commands → `no-test-run`
 * with the "may have run tests" note.
 */
function noTestRunJudgement(ctx: RowContext): Judgement {
  const { claim, turn, facts } = ctx;
  const absent = absenceRef(turn, 'no test run in log');
  const okWrites = facts.writes.filter((w) => w.status === 'ok' && (w.source === 'tool' || w.source === 'patch'));
  if (okWrites.length === 0) return judgement(claim, 'UNVERIFIED', 'no-evidence', [absent], 'no test run and no writes in log');
  if (claim.echoed) return judgement(claim, 'UNVERIFIED', 'echoed', [absent], 'no test run in log', [ECHO_NOTE]);
  if (facts.incomplete) {
    return judgement(claim, 'UNVERIFIED', 'ledger-incomplete', [absent], 'no test run in log', [ctx.facts.incompleteNote]);
  }
  const opaque = ctx.ledger.opaqueTestCapable;
  if (opaque > 0) {
    return judgement(claim, 'UNVERIFIED', 'no-test-run', [absent], 'no test run in log', [
      `${opaque} command${opaque === 1 ? '' : 's'} may have run tests`,
    ]);
  }
  const last = okWrites[okWrites.length - 1] as WriteFact;
  const evidence = [absent, ...writeRefs([last], facts.callById, turn.endedAt)];
  return judgement(claim, 'CONTRADICTED', 'no-test-run', evidence, 'no test run in log despite writes');
}

/**
 * Rows 1–2: `test.pass` and friends; `count` set for `test.counts` (row 2 —
 * the evidence run must satisfy `(parsed.passed ?? parsed.total) ≥ count`).
 */
function judgeTestPass(ctx: RowContext, count?: number): Judgement {
  const { claim, turn, facts } = ctx;
  const runs = facts.testRuns.filter((r) => r.kind === 'run');
  const inWindow = runs.filter((r) => r.seq < facts.finalSeq && (facts.W === null || r.seq > facts.W));
  const foreground = inWindow.filter((r) => !isBackgroundRun(facts, r));
  const conclusive = foreground.filter((r) => r.green === true && r.conclusive);
  const satisfying =
    count === undefined ? conclusive : conclusive.filter((r) => ((r.parsed?.passed ?? r.parsed?.total) ?? -1) >= count);
  const evRun = satisfying[satisfying.length - 1];
  if (evRun !== undefined) {
    const laterTestWrites = facts.writes.filter((w) => w.status === 'ok' && w.isTestFile && w.seq > evRun.seq);
    if (laterTestWrites.length === 0) {
      const laterPartial = foreground.filter((r) => r.seq > evRun.seq && r.scope === 'subset').length;
      const notes = laterPartial > 0 ? [`+${laterPartial} later partial run${laterPartial === 1 ? '' : 's'}`] : [];
      return judgement(claim, 'VERIFIED', 'ok', [factRef(facts, evRun, turn, runLabel(evRun))], 'conclusive green run after the last edit', notes);
    }
    const weakened = ctx.ledger.integrity.some((s) => s.kind === 'test-weakened' && s.seq > evRun.seq && s.seq <= facts.finalSeq);
    const j = judgement(
      claim,
      'UNVERIFIED',
      'stale-run',
      [factRef(facts, evRun, turn, runLabel(evRun)), ...writeRefs(laterTestWrites, facts.callById, turn.endedAt)],
      'test file edited after the last run',
      ['test file edited after last run']
    );
    if (weakened) j.integrity = 'test-weakened';
    return j;
  }
  if (count !== undefined && conclusive.length > 0) {
    const last = conclusive[conclusive.length - 1] as TestRun;
    const max = Math.max(...conclusive.map((r) => (r.parsed?.passed ?? r.parsed?.total) ?? 0));
    return judgement(claim, 'UNVERIFIED', 'count-short', [factRef(facts, last, turn, runLabel(last))], `largest run since last edit: ${max} passed`);
  }
  const latest = foreground[foreground.length - 1];
  if (latest !== undefined) {
    const ref = factRef(facts, latest, turn, runLabel(latest));
    if (latest.green === false) {
      if (claim.partial === true) {
        const failed = latest.parsed?.failed;
        return judgement(claim, 'UNVERIFIED', 'partial', [ref], 'claim excludes some tests', [
          failed === undefined ? 'last run had failures' : `last run had ${failed} failure${failed === 1 ? '' : 's'}`,
        ]);
      }
      if (redCanContradict(latest)) return judgement(claim, 'CONTRADICTED', 'last-run-red', [ref], 'last run red');
      return judgement(claim, 'UNVERIFIED', 'exit-unknown', [ref], 'last run has no conclusive result', ledgerExitNote(ctx, []));
    }
    return judgement(claim, 'UNVERIFIED', 'exit-unknown', [ref], 'last run has no conclusive result', ledgerExitNote(ctx, []));
  }
  if (inWindow.length > 0) {
    const last = inWindow[inWindow.length - 1] as TestRun;
    return judgement(claim, 'UNVERIFIED', 'run-in-background', [factRef(facts, last, turn, runLabel(last))], 'only background runs since the last edit');
  }
  const older = runs.filter((r) => r.seq < facts.finalSeq);
  if (older.length > 0) {
    const last = older[older.length - 1] as TestRun;
    const editedAfter = new Set(facts.writes.filter((w) => isStaleSource(w) && w.seq > last.seq && w.seq < facts.finalSeq).map((w) => w.path)).size;
    return judgement(
      claim,
      'UNVERIFIED',
      'stale-run',
      [factRef(facts, last, turn, runLabel(last))],
      `${editedAfter} file${editedAfter === 1 ? '' : 's'} edited after the last run`
    );
  }
  return noTestRunJudgement(ctx);
}

/** Row 3: `test.ran` — any test run in the turn, any exit. */
function judgeTestRan(ctx: RowContext): Judgement {
  const { claim, turn, facts } = ctx;
  const runs = facts.testRuns.filter((r) => r.kind === 'run' && r.parsed?.ran !== false);
  const inTurn = runs.filter((r) => turnOf(facts, r.toolCallId) === turn.index);
  if (inTurn.length > 0) {
    const last = inTurn[inTurn.length - 1] as TestRun;
    return judgement(claim, 'VERIFIED', 'ok', [factRef(facts, last, turn, runLabel(last))], 'test run in this turn');
  }
  if (runs.length > 0) {
    const last = runs[runs.length - 1] as TestRun;
    const idx = turnOf(facts, last.toolCallId);
    return judgement(claim, 'UNVERIFIED', 'no-evidence', [factRef(facts, last, turn, runLabel(last))], `last run was in turn ${idx}`);
  }
  return noTestRunJudgement(ctx);
}

/** Row 4: `test.added`. */
function judgeTestAdded(ctx: RowContext): Judgement {
  const { claim, turn, facts } = ctx;
  const testWrites = facts.writes.filter((w) => w.status === 'ok' && w.isTestFile);
  const inTurn = testWrites.filter((w) => turnOf(facts, w.toolCallId) === turn.index);
  if (inTurn.length > 0) {
    return judgement(claim, 'VERIFIED', 'ok', writeRefs(inTurn, facts.callById, turn.endedAt), 'test-file write in this turn', userModifiedNotes(ctx, inTurn));
  }
  if (testWrites.length > 0) {
    const last = testWrites[testWrites.length - 1] as WriteFact;
    return judgement(
      claim,
      'UNVERIFIED',
      'no-evidence',
      writeRefs([last], facts.callById, turn.endedAt),
      `test file written in turn ${turnOf(facts, last.toolCallId)}`
    );
  }
  const others = facts.writes.filter((w) => w.status === 'ok');
  const absent = absenceRef(turn, 'no test-file write in log');
  if (others.length === 0) return judgement(claim, 'UNVERIFIED', 'no-evidence', [absent], 'no writes in log');
  const inline = others.some((w) => facts.callById.get(w.toolCallId)?.patch?.added.some((l) => TEST_ADD_RE.test(l)) === true);
  if (inline) {
    return judgement(claim, 'UNVERIFIED', 'no-write-to-path', [absent], 'no test-file write in log', ['inline tests possible']);
  }
  const last = others[others.length - 1] as WriteFact;
  return absenceContradiction(
    ctx,
    'no-write-to-path',
    [absent, ...writeRefs([last], facts.callById, turn.endedAt)],
    'no test-file write in log while other files were written'
  );
}

// ---------------------------------------------------------------------------
// Checks (rows 5–6)
// ---------------------------------------------------------------------------

/** Loose tool match: `mypy` claim tokens vs the check's recorded tool. */
function toolMatches(checkTool: string, claimTool: string): boolean {
  const a = checkTool.toLowerCase();
  const b = claimTool.toLowerCase();
  const head = b.split(/\s+/)[0] as string;
  return a === b || a === head || a.startsWith(`${head} `) || b.startsWith(`${a} `);
}

/** The shell segment behind a check, for a command-shaped label (`ruff check . → exit 0`). */
function checkSegment(facts: ScopedFacts, check: CheckRun): ShellSegment | undefined {
  const fact = facts.commands.find((c) => c.toolCallId === check.toolCallId);
  return fact?.segments.find((s) => s.family === check.family) ?? fact?.segments[0];
}

function checkLabel(facts: ScopedFacts, check: CheckRun): string {
  const seg = checkSegment(facts, check);
  const cmd = evidenceLabel(seg?.raw ?? check.tool);
  const exit = check.exitCode === null ? '?' : String(check.exitCode);
  return `${cmd} → exit ${exit}`;
}

/** Rows 5–6: `check.*` — tool-specific match preferred, family fallback. */
function judgeCheck(ctx: RowContext): Judgement {
  const { claim, turn, facts } = ctx;
  const family = claim.family;
  let pool = family === undefined ? facts.checks : facts.checks.filter((c) => c.family === family);
  if (claim.tool !== undefined) {
    const toolPool = pool.filter((c) => toolMatches(c.tool, claim.tool as string));
    if (toolPool.length > 0) pool = toolPool;
  }
  if (pool.length === 0) {
    const what = evidenceLabel(claim.tool ?? family ?? 'check');
    return judgement(claim, 'UNVERIFIED', 'no-check-run', [absenceRef(turn, `no ${what} run in log`)], `no ${what} run in log`);
  }
  const last = pool[pool.length - 1] as CheckRun;
  const ref = factRef(facts, last, turn, checkLabel(facts, last));
  if (last.green === true) {
    if (facts.W === null || last.seq > facts.W) {
      return judgement(claim, 'VERIFIED', 'ok', [ref], 'green run after the last edit');
    }
    return judgement(claim, 'UNVERIFIED', 'stale-run', [ref], 'last green run precedes later edits');
  }
  if (last.green === false) {
    const source = facts.callById.get(last.toolCallId)?.exitCodeSource ?? 'unknown';
    const summary = last.summary === undefined || last.summary === '' ? undefined : evidenceLabel(last.summary);
    if (source === 'unknown' && summary === undefined) {
      return judgement(claim, 'UNVERIFIED', 'exit-unknown', [ref], 'red run with no conclusive result', ledgerExitNote(ctx, []));
    }
    const notes = [summary === undefined ? 'never re-run' : `${summary}, never re-run`];
    return judgement(claim, 'CONTRADICTED', 'check-red', [ref], `last ${family ?? 'check'} run red`, notes);
  }
  return judgement(claim, 'UNVERIFIED', 'exit-unknown', [ref], 'run has no conclusive result', ledgerExitNote(ctx, []));
}

// ---------------------------------------------------------------------------
// File claims (rows 7–11)
// ---------------------------------------------------------------------------

/** Resolves the claim's subject against the scoped write paths, trying every session cwd. */
function resolveFileSubject(ctx: RowContext): SubjectResolution {
  const subject = ctx.claim.subject ?? '';
  const paths = [...new Set(ctx.facts.writes.map((w) => w.path))];
  let res = resolveSubject(subject, paths, ctx.session.cwd);
  if (res.status === 'unresolved') {
    for (const cwd of ctx.session.cwds) {
      const other = resolveSubject(subject, paths, cwd);
      if (other.status !== 'unresolved') {
        res = other;
        break;
      }
    }
  }
  return res;
}

/** The first opaque write-capable command of the turn, as evidence for `write-not-observable`. */
function opaqueCommandRef(ctx: RowContext): EvidenceRef {
  const { turn, facts } = ctx;
  const fact = facts.commands.find((c) => c.opaqueWrite === true && turnOf(facts, c.toolCallId) === turn.index);
  if (fact === undefined) return absenceRef(turn, 'script ran');
  const program = fact.segments.find((s) => s.heredoc !== undefined || s.mayWrite === true)?.program ?? fact.segments[0]?.program ?? 'script';
  const name = /^python[\d.]*$/.test(program) ? 'python' : program;
  return factRef(facts, fact, turn, `${evidenceLabel(name)} script ran`);
}

/** Shared unresolved/ambiguous handling for rows 7–10. */
function unresolvedJudgement(ctx: RowContext, res: SubjectResolution, absenceLabel: string): Judgement {
  const { claim, turn, facts } = ctx;
  if (res.status === 'ambiguous') {
    return judgement(
      claim,
      'UNVERIFIED',
      'ambiguous-path',
      [absenceRef(turn, `${res.candidates.length} candidate paths in log`)],
      `${res.candidates.length} candidates`
    );
  }
  if (ctx.turn.opaqueWriteCommands > 0) {
    return judgement(claim, 'UNVERIFIED', 'write-not-observable', [opaqueCommandRef(ctx)], 'write not observable', ['write not observable']);
  }
  const opaque = facts.commands.filter((c) => c.opaqueWrite === true).length;
  const notes = opaque > 0 ? [`${opaque} opaque write-capable command${opaque === 1 ? '' : 's'} ran`] : [];
  return judgement(claim, 'UNVERIFIED', 'no-write-to-path', [absenceRef(turn, absenceLabel)], absenceLabel, notes);
}

/** Rows 7–8: `file.verb` create/update, `file.new_file`, `file.implemented_in`. */
function judgeFileWrite(ctx: RowContext, mode: 'create' | 'update'): Judgement {
  const { claim, turn, facts } = ctx;
  const subject = evidenceLabel(claim.subject ?? '');
  const res = resolveFileSubject(ctx);
  if (res.canon === undefined) return unresolvedJudgement(ctx, res, `no write to ${subject} in log`);
  const path = res.canon;
  const pathWrites = facts.writes.filter((w) => w.path === path);
  const ok = pathWrites.filter((w) => w.status === 'ok' && w.verb !== 'delete');
  if (ok.length > 0 && ok.every((w) => w.source === 'interp-inferred')) {
    return judgement(claim, 'UNVERIFIED', 'write-not-observable', [opaqueCommandRef(ctx)], 'write not observable', ['write not observable']);
  }
  const live = ok.filter((w) => w.reverted === undefined);
  if (live.length > 0) {
    const lastLive = live[live.length - 1] as WriteFact;
    const evidence = mode === 'create' ? writeRefs([live.find((w) => w.verb === 'create') ?? lastLive], facts.callById, turn.endedAt) : writeRefs(live, facts.callById, turn.endedAt);
    const notes = userModifiedNotes(ctx, live);
    const deletion = pathWrites.find((w) => w.verb === 'delete' && w.status === 'ok' && w.seq > lastLive.seq);
    if (deletion !== undefined) {
      return judgement(
        claim,
        'VERIFIED',
        'ok-deleted-later',
        [...evidence, factRef(facts, deletion, turn, 'deleted later')],
        'deleted later',
        notes
      );
    }
    return judgement(claim, 'VERIFIED', 'ok', evidence, `${mode === 'create' ? 'created' : 'written'} in log`, notes);
  }
  if (ok.length > 0) {
    return judgement(claim, 'UNVERIFIED', 'no-write-to-path', writeRefs(ok, facts.callById, turn.endedAt), 'write later reverted', ['write later reverted']);
  }
  const failed = pathWrites.filter((w) => w.status === 'failed');
  if (failed.length > 0) {
    const refs = failed.map((w) => factRef(facts, w, turn, `${evidenceLabel(facts.callById.get(w.toolCallId)?.tool ?? 'write')} failed`));
    if (claim.explicitVerb === true && pathWrites.every((w) => w.status === 'failed')) {
      return judgement(claim, 'CONTRADICTED', 'write-failed', refs, 'every write to the path failed');
    }
    return judgement(claim, 'UNVERIFIED', 'write-failed', refs, 'writes to the path failed');
  }
  return judgement(
    claim,
    'UNVERIFIED',
    'no-write-to-path',
    writeRefs(pathWrites, facts.callById, turn.endedAt),
    'write status unknown',
    ['write status unknown']
  );
}

/** Row 8 wrapper: `file.implemented_in` is UNVERIFIED-only (Appendix E). */
function judgeFileUpdate(ctx: RowContext): Judgement {
  const base = judgeFileWrite(ctx, 'update');
  if (ctx.claim.rule === 'file.implemented_in' && base.verdict === 'VERIFIED') {
    return { ...base, verdict: 'UNVERIFIED', reason: 'no-evidence', notes: [...base.notes, 'location claims are never auto-verified'] };
  }
  return base;
}

/** Row 9: `file.verb` delete. */
function judgeFileDelete(ctx: RowContext): Judgement {
  const { claim, turn, facts } = ctx;
  const subject = evidenceLabel(claim.subject ?? '');
  const res = resolveFileSubject(ctx);
  if (res.canon === undefined) {
    if (res.status === 'ambiguous') return unresolvedJudgement(ctx, res, `no delete of ${subject} in log`);
    return judgement(claim, 'UNVERIFIED', 'no-evidence', [absenceRef(turn, `nothing about ${subject} in log`)], 'nothing about the path in log');
  }
  const pathWrites = facts.writes.filter((w) => w.path === res.canon);
  const deletion = pathWrites.find((w) => w.verb === 'delete' && w.status === 'ok');
  if (deletion !== undefined) {
    return judgement(claim, 'VERIFIED', 'ok', [factRef(facts, deletion, turn, 'file deleted')], 'delete in log');
  }
  const edits = pathWrites.filter((w) => w.status === 'ok');
  if (edits.length > 0) {
    // Demoted in reconcile/2 (S35 accuracy gate): "removed `x.py`'s manual
    // check" parses as a delete of `x.py` with a direct object, so the
    // edited-not-deleted contradiction misfired on possessive phrasing.
    // UNVERIFIED regardless of `directObject` until the extractor can tell
    // "removed the file" from "removed something inside the file".
    const refs = writeRefs(edits, facts.callById, turn.endedAt);
    return judgement(claim, 'UNVERIFIED', 'file-not-deleted', refs, 'file was edited, not deleted');
  }
  return judgement(claim, 'UNVERIFIED', 'no-evidence', [absenceRef(turn, `nothing about ${subject} in log`)], 'nothing about the path in log');
}

/** Row 10: `file.verb` rename — rename fact, or delete(from) + create(to). */
function judgeFileRename(ctx: RowContext): Judgement {
  const { claim, turn, facts } = ctx;
  const res = resolveFileSubject(ctx);
  if (res.canon !== undefined) {
    const toWrites = facts.writes.filter((w) => w.path === res.canon && w.status === 'ok');
    const rename = toWrites.find((w) => w.verb === 'rename');
    if (rename !== undefined) {
      return judgement(claim, 'VERIFIED', 'ok', [factRef(facts, rename, turn, 'renamed')], 'rename in log');
    }
    const created = toWrites.find((w) => w.verb === 'create');
    const from = claim.fromPath;
    if (created !== undefined && from !== undefined) {
      const fromDeleted = facts.writes.find(
        (w) => w.verb === 'delete' && w.status === 'ok' && (w.path === from || basename(w.path) === basename(from))
      );
      if (fromDeleted !== undefined) {
        return judgement(
          claim,
          'VERIFIED',
          'ok',
          [factRef(facts, fromDeleted, turn, 'file deleted'), factRef(facts, created, turn, 'file created')],
          'delete + create in log'
        );
      }
    }
  }
  return judgement(claim, 'UNVERIFIED', 'no-write-to-path', [absenceRef(turn, 'no rename in log')], 'no rename in log');
}

/** Row 11: `file.count` — turn first, then session. */
function judgeFileCount(ctx: RowContext): Judgement {
  const { claim, turn, facts } = ctx;
  const wanted = claim.count ?? 0;
  const eligible = facts.writes.filter(filesChangedEligible);
  const turnPaths = new Set(eligible.filter((w) => turnOf(facts, w.toolCallId) === turn.index).map((w) => w.path));
  const sessionPaths = new Set(eligible.map((w) => w.path));
  if (turnPaths.size >= wanted || sessionPaths.size >= wanted) {
    const have = turnPaths.size >= wanted ? turnPaths.size : sessionPaths.size;
    const last = eligible[eligible.length - 1] as WriteFact;
    return judgement(claim, 'VERIFIED', 'ok', [factRef(facts, last, turn, `${have} files changed`)], `${have} files changed in log`);
  }
  if (sessionPaths.size === 0 && ctx.turn.opaqueWriteCommands > 0) {
    return judgement(claim, 'UNVERIFIED', 'write-not-observable', [opaqueCommandRef(ctx)], 'write not observable', ['write not observable']);
  }
  return judgement(
    claim,
    'UNVERIFIED',
    'count-short',
    [absenceRef(turn, `${sessionPaths.size} files changed in log`)],
    `log shows ${sessionPaths.size}`
  );
}

// ---------------------------------------------------------------------------
// Commands and installs (rows 12–14)
// ---------------------------------------------------------------------------

interface SegmentHit {
  fact: CommandFact;
  seg: ShellSegment;
}

/** True when a segment ran the claimed command (program + leading argv, or raw prefix). */
function segMatches(seg: ShellSegment, want: string): boolean {
  if (want === '') return false;
  const raw = sanitizeSpaces(seg.raw);
  if (raw === want || raw.startsWith(`${want} `)) return true;
  const tokens = want.split(' ');
  const have = [seg.program, ...seg.argv];
  return tokens.length <= have.length && tokens.every((t, i) => have[i] === t);
}

function sanitizeSpaces(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Every ran segment matching a predicate, in seq order. */
function segmentHits(facts: ScopedFacts, match: (fact: CommandFact, seg: ShellSegment) => boolean): SegmentHit[] {
  const hits: SegmentHit[] = [];
  for (const fact of facts.commands) {
    for (const seg of fact.segments) {
      if (seg.ran === true && match(fact, seg)) hits.push({ fact, seg });
    }
  }
  return hits;
}

/** `uv run scripts/bench.py → exit 0 (chained) (output suppressed)`. */
function hitLabel(hit: SegmentHit): string {
  const exit = hit.seg.exitCode === null ? '?' : String(hit.seg.exitCode);
  let label = `${evidenceLabel(sanitizeSpaces(hit.seg.raw))} → exit ${exit}`;
  if (hit.fact.chained) label += ' (chained)';
  if (hit.seg.suppressed) label += ' (output suppressed)';
  return label;
}

function hitRef(facts: ScopedFacts, hit: SegmentHit, turn: Turn): EvidenceRef {
  return factRef(facts, hit.fact, turn, hitLabel(hit));
}

/** Shared judge for rows 12–14 and 20 once the matching hits are known. */
function judgeCommandHits(
  ctx: RowContext,
  hits: SegmentHit[],
  opts: { requireSuccess: boolean; afterSeq?: number | null; noneLabel: string }
): Judgement {
  const { claim, turn, facts } = ctx;
  if (hits.length === 0) {
    return judgement(claim, 'UNVERIFIED', 'no-command', [absenceRef(turn, opts.noneLabel)], opts.noneLabel);
  }
  const after = opts.afterSeq ?? null;
  const succeeded = hits.filter((h) => h.seg.exitCode === 0 && (after === null || h.fact.seq > after));
  if (succeeded.length > 0) {
    const last = succeeded[succeeded.length - 1] as SegmentHit;
    return judgement(claim, 'VERIFIED', 'ok', [hitRef(facts, last, turn)], 'command ran');
  }
  if (!opts.requireSuccess) {
    const last = hits[hits.length - 1] as SegmentHit;
    return judgement(claim, 'VERIFIED', 'ok', [hitRef(facts, last, turn)], 'command ran');
  }
  const staleGreen = hits.filter((h) => h.seg.exitCode === 0);
  if (staleGreen.length > 0) {
    const last = staleGreen[staleGreen.length - 1] as SegmentHit;
    return judgement(claim, 'UNVERIFIED', 'stale-run', [hitRef(facts, last, turn)], 'last green run precedes later edits');
  }
  const allFailedKnown = hits.every((h) => h.seg.exitCode !== null && h.seg.exitCode !== 0 && h.seg.exitCodeSource !== 'unknown');
  const last = hits[hits.length - 1] as SegmentHit;
  if (allFailedKnown) {
    return absenceContradiction(ctx, 'command-failed', [hitRef(facts, last, turn)], 'every matching run failed');
  }
  return judgement(claim, 'UNVERIFIED', 'exit-unknown', [hitRef(facts, last, turn)], 'no conclusive exit', ledgerExitNote(ctx, []));
}

/** Row 12: `command.ran`. */
function judgeCommandRan(ctx: RowContext): Judgement {
  const want = sanitizeSpaces(ctx.claim.subject ?? '');
  const hits = segmentHits(ctx.facts, (_f, seg) => segMatches(seg, want));
  return judgeCommandHits(ctx, hits, {
    requireSuccess: ctx.claim.successPredicate === true,
    noneLabel: 'no matching command in log',
  });
}

/** Row 13: `command.ran_bare` — a segment of the noun's family. */
function judgeCommandBare(ctx: RowContext): Judgement {
  const noun = (ctx.claim.subject ?? '').toLowerCase();
  const family = NOUN_FAMILY[noun];
  const hits = segmentHits(ctx.facts, (_f, seg) => (family === undefined ? true : seg.family === family));
  return judgeCommandHits(ctx, hits, {
    requireSuccess: ctx.claim.successPredicate === true,
    noneLabel: 'no matching command in log',
  });
}

/** Row 14: `install.pkg` — an install segment naming the package, exit 0. */
function judgeInstall(ctx: RowContext): Judgement {
  const raw = ctx.claim.subject ?? '';
  const pkg = raw.replace(/(?!^)@[^@]*$/, '');
  const hits = segmentHits(ctx.facts, (_f, seg) => {
    if (seg.family !== 'install') return false;
    const tokens = [...seg.argv, ...seg.scanTokens];
    return tokens.some((t) => t === raw || t === pkg || t.replace(/(?!^)@[^@]*$/, '') === pkg);
  });
  return judgeCommandHits(ctx, hits, { requireSuccess: true, noneLabel: 'no matching install in log' });
}

// ---------------------------------------------------------------------------
// Git (rows 15–18)
// ---------------------------------------------------------------------------

/** Ref for a git fact: the tool call at the same seq carries the time. */
function gitRef(facts: ScopedFacts, fact: GitFact, turn: Turn, label: string): EvidenceRef {
  const call = facts.callBySeq.get(fact.seq);
  if (call !== undefined) return callRef(call, label);
  return makeRef(fact.seq, turn.endedAt, label);
}

/** Exit code of the command behind a git fact, when the ledger knows it. */
function gitExit(facts: ScopedFacts, fact: GitFact): number | null {
  const cmd = facts.commands.find((c) => c.seq === fact.seq);
  return cmd?.exitCode ?? null;
}

/** Row 15: `git.commit`. */
function judgeGitCommit(ctx: RowContext): Judgement {
  const { claim, turn, facts } = ctx;
  const commits = facts.git.filter((g) => g.op === 'commit');
  const shaMatches = (g: GitFact): boolean => {
    if (claim.sha === undefined) return true;
    const sha = g.sha ?? '';
    return sha !== '' && (sha.startsWith(claim.sha) || claim.sha.startsWith(sha));
  };
  const okCommits = commits.filter((g) => g.ok === true);
  const afterWall = okCommits.filter((g) => facts.Wall === null || g.seq > facts.Wall);
  const noLaterWrites = (g: GitFact): boolean =>
    facts.callBySeq.get(g.seq)?.turnIndex === turn.index && !facts.writes.some((w) => isStaleAny(w) && w.seq > g.seq);
  const eligible = [...afterWall, ...okCommits.filter((g) => !afterWall.includes(g) && noLaterWrites(g))];
  const matched = eligible.filter(shaMatches);
  if (matched.length > 0) {
    const last = matched[matched.length - 1] as GitFact;
    const sha = last.sha ?? undefined;
    const label = sha === undefined || sha === '' ? 'git commit' : `git commit → ${evidenceLabel(sha.slice(0, 7))}`;
    return judgement(claim, 'VERIFIED', 'ok', [gitRef(facts, last, turn, label)], 'commit after the last write');
  }
  if (claim.sha !== undefined && eligible.length > 0) {
    const last = eligible[eligible.length - 1] as GitFact;
    const actual = (last.sha ?? '').slice(0, 7);
    return judgement(
      claim,
      'CONTRADICTED',
      'sha-mismatch',
      [gitRef(facts, last, turn, actual === '' ? 'git commit' : `git commit → ${evidenceLabel(actual)}`)],
      'no commit matches the claimed sha'
    );
  }
  const attempts = commits.filter((g) => g.ok === false && (facts.Wall === null || g.seq > facts.Wall));
  if (attempts.length > 0) {
    const last = attempts[attempts.length - 1] as GitFact;
    const exit = gitExit(facts, last);
    const label = `git commit → exit ${exit === null ? '?' : exit}`;
    return absenceContradiction(ctx, 'git-op-failed', [gitRef(facts, last, turn, label)], 'commit failed');
  }
  if (okCommits.length > 0) {
    const last = okCommits[okCommits.length - 1] as GitFact;
    const later = new Set(facts.writes.filter((w) => isStaleAny(w) && w.seq > last.seq).map((w) => w.path)).size;
    return judgement(
      claim,
      'UNVERIFIED',
      'commit-precedes-edits',
      [gitRef(facts, last, turn, 'git commit')],
      `last commit precedes ${later} later edit${later === 1 ? '' : 's'}`
    );
  }
  if (commits.length > 0) {
    const last = commits[commits.length - 1] as GitFact;
    return judgement(claim, 'UNVERIFIED', 'exit-unknown', [gitRef(facts, last, turn, 'git commit')], 'commit outcome unknown', ledgerExitNote(ctx, []));
  }
  return judgement(claim, 'UNVERIFIED', 'no-git-op', [absenceRef(turn, 'no git commit in log')], 'no git commit in log');
}

/** Row 16: `git.push` — the push must follow the last `ok` commit. */
function judgeGitPush(ctx: RowContext): Judgement {
  const { claim, turn, facts } = ctx;
  const pushes = facts.git.filter((g) => g.op === 'push' || g.op === 'force-push');
  const lastOkCommit = facts.git.filter((g) => g.op === 'commit' && g.ok === true).pop();
  const commitSeq = lastOkCommit?.seq ?? null;
  const detailMatches = (g: GitFact): boolean =>
    (claim.branch === undefined || g.branch === undefined || g.branch === claim.branch) &&
    (claim.remote === undefined || g.remote === undefined || g.remote === claim.remote);
  const okPushes = pushes.filter((g) => g.ok === true && detailMatches(g));
  const current = okPushes.filter((g) => commitSeq === null || g.seq > commitSeq);
  if (current.length > 0) {
    const last = current[current.length - 1] as GitFact;
    const where = last.branch === undefined ? '' : ` → ${evidenceLabel(`${last.remote ?? 'origin'}/${last.branch}`)}`;
    return judgement(claim, 'VERIFIED', 'ok', [gitRef(facts, last, turn, `git push${where}`)], 'push after the last commit');
  }
  const attempts = pushes.filter((g) => g.ok === false && (commitSeq === null || g.seq > commitSeq));
  if (attempts.length > 0) {
    const last = attempts[attempts.length - 1] as GitFact;
    const exit = gitExit(facts, last);
    const label = `git push → exit ${exit === null ? '?' : exit}`;
    return absenceContradiction(ctx, 'git-op-failed', [gitRef(facts, last, turn, label)], exit === null ? 'push failed' : `push exited ${exit}`);
  }
  if (okPushes.length > 0) {
    const last = okPushes[okPushes.length - 1] as GitFact;
    return judgement(claim, 'UNVERIFIED', 'push-precedes-commit', [gitRef(facts, last, turn, 'git push')], 'push precedes the last commit');
  }
  return judgement(claim, 'UNVERIFIED', 'no-git-op', [absenceRef(turn, 'no git push in log')], 'no git push in log');
}

/** Row 17: `git.pr` — `pr-created` facts only; `prRefs` never verify or contradict. */
function judgeGitPr(ctx: RowContext): Judgement {
  const { claim, turn, facts } = ctx;
  const created = facts.git.filter((g) => g.op === 'pr-created');
  const matching = created.filter((g) => g.ok !== false && (claim.prNumber === undefined || g.prNumber === undefined || g.prNumber === claim.prNumber));
  if (matching.length > 0) {
    const last = matching[matching.length - 1] as GitFact;
    const num = last.prNumber === undefined ? '' : ` → #${last.prNumber}`;
    return judgement(claim, 'VERIFIED', 'ok', [gitRef(facts, last, turn, `gh pr create${num}`)], 'PR created in log');
  }
  const failed = created.filter((g) => g.ok === false);
  if (failed.length > 0) {
    const last = failed[failed.length - 1] as GitFact;
    return absenceContradiction(ctx, 'git-op-failed', [gitRef(facts, last, turn, 'gh pr create failed')], 'PR creation failed');
  }
  const evidence: EvidenceRef[] = [absenceRef(turn, 'no gh pr create in log')];
  const seen = ctx.session.prRefs.filter((p) => p.seq <= facts.finalSeq && (claim.prNumber === undefined || p.prNumber === claim.prNumber));
  const lastSeen = seen[seen.length - 1];
  if (lastSeen !== undefined) evidence.push(makeRef(lastSeen.seq, lastSeen.time, `pr-link #${lastSeen.prNumber}`));
  return judgement(claim, 'UNVERIFIED', 'no-git-op', evidence, 'no gh pr create in log');
}

/** Row 18: `git.branch` / `git.tag`. */
function judgeGitBranchTag(ctx: RowContext): Judgement {
  const { claim, turn, facts } = ctx;
  const op = claim.op === 'tag' ? 'tag' : 'branch';
  const matching = facts.git.filter(
    (g) => g.op === op && g.ok !== false && (claim.branch === undefined || g.branch === undefined || g.branch === claim.branch)
  );
  if (matching.length > 0) {
    const last = matching[matching.length - 1] as GitFact;
    const name = last.branch ?? claim.branch;
    const label = name === undefined ? `git ${op}` : `git ${op} ${evidenceLabel(name)}`;
    return judgement(claim, 'VERIFIED', 'ok', [gitRef(facts, last, turn, label)], `${op} in log`);
  }
  return judgement(claim, 'UNVERIFIED', 'no-git-op', [absenceRef(turn, `no git ${op} in log`)], `no git ${op} in log`);
}

// ---------------------------------------------------------------------------
// Verification and no-change (rows 19–21)
// ---------------------------------------------------------------------------

/** Row 19: `verify.generic` — any exercise of the change after `W`; never contradicted. */
function judgeVerifyGeneric(ctx: RowContext): Judgement {
  const { claim, turn, facts } = ctx;
  const after = (seq: number): boolean => facts.W === null || seq > facts.W;
  const greenRun = facts.testRuns.filter((r) => r.kind === 'run' && r.green === true && after(r.seq)).pop();
  if (greenRun !== undefined) {
    return judgement(claim, 'VERIFIED', 'ok', [factRef(facts, greenRun, turn, runLabel(greenRun))], 'green run after the last write');
  }
  const greenCheck = facts.checks.filter((c) => c.green === true && after(c.seq)).pop();
  if (greenCheck !== undefined) {
    return judgement(claim, 'VERIFIED', 'ok', [factRef(facts, greenCheck, turn, checkLabel(facts, greenCheck))], 'green check after the last write');
  }
  const hits = segmentHits(facts, (fact, seg) => after(fact.seq) && seg.exitCode === 0 && !INSPECTION_FREE.has(seg.program));
  const lastHit = hits[hits.length - 1];
  if (lastHit !== undefined) {
    return judgement(claim, 'VERIFIED', 'ok', [hitRef(facts, lastHit, turn)], 'command ran after the last write');
  }
  if (facts.writes.some((w) => w.status === 'ok')) {
    return judgement(
      claim,
      'UNVERIFIED',
      'no-run-after-write',
      [absenceRef(turn, 'nothing ran after the last write')],
      'nothing ran after the last write'
    );
  }
  return judgement(claim, 'UNVERIFIED', 'no-evidence', [absenceRef(turn, 'no runs or writes in log')], 'no runs or writes in log');
}

/** Row 20: `verify.with_cmd` — the named command, exit 0, after `W`. */
function judgeVerifyWithCmd(ctx: RowContext): Judgement {
  const want = sanitizeSpaces(ctx.claim.subject ?? '');
  const hits = segmentHits(ctx.facts, (_f, seg) => segMatches(seg, want));
  return judgeCommandHits(ctx, hits, { requireSuccess: true, afterSeq: ctx.facts.W, noneLabel: 'no matching command in log' });
}

/** Row 21: `no-change`. */
function judgeNoChange(ctx: RowContext): Judgement {
  const { claim, claims, turn, facts } = ctx;
  const turnWrites = facts.writes.filter((w) => w.status === 'ok' && w.metadataOnly !== true && turnOf(facts, w.toolCallId) === turn.index);
  if (claim.subject !== undefined) {
    const res = resolveFileSubject(ctx);
    const pathWrites = res.canon === undefined ? [] : turnWrites.filter((w) => w.path === res.canon);
    if (pathWrites.length > 0) {
      return absenceContradiction(ctx, 'writes-despite-no-change', writeRefs(pathWrites, facts.callById, turn.endedAt), 'the named file was written');
    }
    return judgement(claim, 'VERIFIED', 'ok', [absenceRef(turn, 'no writes to the path in this turn')], 'no writes to the path');
  }
  if (turnWrites.length === 0) {
    return judgement(claim, 'VERIFIED', 'ok', [absenceRef(turn, 'no writes in this turn')], 'no writes in this turn');
  }
  const otherFileClaims = claims.some(
    (c) => c.id !== claim.id && (c.kind === 'file' || c.kind === 'file-count') && c.polarity === 'positive' && c.attribution === 'agent'
  );
  if (otherFileClaims) {
    return judgement(claim, 'UNVERIFIED', 'partial', writeRefs(turnWrites, facts.callById, turn.endedAt), 'other files were changed', [
      'other files were changed',
    ]);
  }
  // Demoted in reconcile/2 (S35 accuracy gate): a path-less no-change marker
  // can sit in a hypothetical ("type 800 instead — nothing to change
  // anywhere") that the cue scoping does not catch, so writes in the turn are
  // not a safe contrary fact. The named-file branch above keeps its
  // contradiction — "no changes to X" plus a write to X stays positive.
  return judgement(claim, 'UNVERIFIED', 'writes-despite-no-change', writeRefs(turnWrites, facts.callById, turn.endedAt), 'writes in this turn despite "no changes"');
}

// ---------------------------------------------------------------------------
// NOT_SCORED and the echo downgrade (rows 22–24)
// ---------------------------------------------------------------------------

/** Row 22: `done.marker` — marks a done turn, never scored. */
function judgeDoneMarker(ctx: RowContext): Judgement {
  return judgement(ctx.claim, 'NOT_SCORED', 'not-scored', [], 'completion marker');
}

/** Row 23: negated/deferred/other-attributed claims. */
function judgeNotScored(ctx: RowContext): Judgement {
  const { claim } = ctx;
  const text = claim.attribution === 'other' ? 'attributed to someone else' : `${claim.polarity} claim`;
  return judgement(claim, 'NOT_SCORED', 'not-scored', [], text);
}

/** Row 24: the echo downgrade — a would-be CONTRADICTED becomes UNVERIFIED `echoed`. */
export function applyEchoDowngrade(j: Judgement): Judgement {
  const notes = j.notes.includes(ECHO_NOTE) ? j.notes : [...j.notes, ECHO_NOTE];
  if (j.verdict === 'CONTRADICTED') return { ...j, verdict: 'UNVERIFIED', reason: 'echoed', notes };
  return { ...j, notes };
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

const TEST_PASS_RULES = new Set(['test.pass', 'test.nofail', 'test.green_marker', 'test.gate', 'test.count_clean']);

/**
 * `RECONCILE_ROWS` — the §4.8 table, one entry per row, in dispatch order:
 * rows 23 (not scored) and 22 (done marker) match first, row 24 (echo) wraps
 * the scored row it delegates to, then rows 1–21 in table order. Callers use
 * `reconcile.ts`'s `rowFor`, which walks this array front to back.
 */
export const RECONCILE_ROWS: readonly Row[] = [
  {
    row: 23,
    id: 'not-scored',
    appliesTo: (c) => c.polarity !== 'positive' || c.attribution === 'other',
    judge: judgeNotScored,
  },
  {
    row: 22,
    id: 'done-marker',
    appliesTo: (c) => c.rule === 'done.marker' || c.kind === 'completion',
    judge: judgeDoneMarker,
  },
  {
    row: 24,
    id: 'echoed',
    appliesTo: (c) => c.echoed,
    judge: (ctx) => applyEchoDowngrade(scoredRowFor(ctx.claim).judge(ctx)),
  },
  { row: 1, id: 'test-pass', appliesTo: (c) => c.kind === 'test' && TEST_PASS_RULES.has(c.rule), judge: (ctx) => judgeTestPass(ctx) },
  { row: 2, id: 'test-counts', appliesTo: (c) => c.rule === 'test.counts', judge: (ctx) => judgeTestPass(ctx, ctx.claim.count ?? 0) },
  { row: 3, id: 'test-ran', appliesTo: (c) => c.kind === 'test-ran', judge: judgeTestRan },
  { row: 4, id: 'test-added', appliesTo: (c) => c.kind === 'test-added', judge: judgeTestAdded },
  { row: 5, id: 'check-tool', appliesTo: (c) => c.kind === 'check' && c.tool !== undefined, judge: judgeCheck },
  { row: 6, id: 'check-family', appliesTo: (c) => c.kind === 'check', judge: judgeCheck },
  { row: 7, id: 'file-create', appliesTo: (c) => c.kind === 'file' && c.verb === 'create', judge: (ctx) => judgeFileWrite(ctx, 'create') },
  { row: 8, id: 'file-update', appliesTo: (c) => c.kind === 'file' && (c.verb === 'update' || c.verb === undefined), judge: judgeFileUpdate },
  { row: 9, id: 'file-delete', appliesTo: (c) => c.kind === 'file' && c.verb === 'delete', judge: judgeFileDelete },
  { row: 10, id: 'file-rename', appliesTo: (c) => c.kind === 'file' && c.verb === 'rename', judge: judgeFileRename },
  { row: 11, id: 'file-count', appliesTo: (c) => c.kind === 'file-count', judge: judgeFileCount },
  { row: 12, id: 'command-ran', appliesTo: (c) => c.rule === 'command.ran', judge: judgeCommandRan },
  { row: 13, id: 'command-bare', appliesTo: (c) => c.kind === 'command', judge: judgeCommandBare },
  { row: 14, id: 'install', appliesTo: (c) => c.kind === 'install', judge: judgeInstall },
  { row: 15, id: 'git-commit', appliesTo: (c) => c.kind === 'git' && c.op === 'commit', judge: judgeGitCommit },
  { row: 16, id: 'git-push', appliesTo: (c) => c.kind === 'git' && c.op === 'push', judge: judgeGitPush },
  { row: 17, id: 'git-pr', appliesTo: (c) => c.kind === 'git' && c.op === 'pr', judge: judgeGitPr },
  { row: 18, id: 'git-branch-tag', appliesTo: (c) => c.kind === 'git' && (c.op === 'branch' || c.op === 'tag'), judge: judgeGitBranchTag },
  { row: 19, id: 'verify-generic', appliesTo: (c) => c.kind === 'verification' && c.rule !== 'verify.with_cmd', judge: judgeVerifyGeneric },
  { row: 20, id: 'verify-with-cmd', appliesTo: (c) => c.rule === 'verify.with_cmd', judge: judgeVerifyWithCmd },
  { row: 21, id: 'no-change', appliesTo: (c) => c.kind === 'no-change', judge: judgeNoChange },
];

/** Fallback for a claim no row covers (future rule ids): UNVERIFIED, never guessed. */
export const FALLBACK_ROW: Row = {
  row: 0,
  id: 'fallback',
  appliesTo: () => true,
  judge: (ctx) =>
    judgement(ctx.claim, 'UNVERIFIED', 'no-evidence', [absenceRef(ctx.turn, 'no reconcile rule for this claim')], 'no reconcile rule for this claim', [
      `unhandled rule ${evidenceLabel(ctx.claim.rule)}`,
    ]),
};

/** The scored row (1–21) for a claim, used by the row-24 wrapper. */
export function scoredRowFor(claim: Claim): Row {
  for (const row of RECONCILE_ROWS) {
    if (row.row >= 1 && row.row <= 21 && row.appliesTo(claim)) return row;
  }
  return FALLBACK_ROW;
}
