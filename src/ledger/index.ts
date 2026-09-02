/**
 * Ledger assembly (S14, §4.6): runs the S12/S13 extractors in `seq` order —
 * commands → writes → tests → checks → git → network → integrity → danger —
 * and computes the per-turn and per-session indices the reconciler (§4.8)
 * needs. Pure with respect to the environment: the repo-root resolver and
 * extra temp roots are injected by the pipeline (`makeRepoRootResolver()`,
 * `os.tmpdir()`); the defaults touch neither `node:fs` nor `node:os`.
 *
 * Hook-captured sessions need no special path: their shell `ToolCall`s carry
 * the ledger line's `in.command` and per-line `cwd`, so shell-write inference
 * re-runs over them through exactly the same extractors as transcripts.
 * Cross-session `inherited` usage rows are a cost concern and are ignored
 * here (the ledger never reads `usageRows`), but `ToolCall`s from forked
 * sessions are kept — they happened.
 */
import type { Ledger, Session, ToolCall, Turn } from '../model/types.js';
import { DEFAULT_TMP_ROOTS } from '../util/paths.js';
import { extractChecks } from './checks.js';
import { extractCommands, type LedgerContext } from './commands.js';
import { extractDanger } from './danger.js';
import { extractGit } from './git.js';
import { extractIntegrity } from './integrity.js';
import { extractNetwork } from './network.js';
import { countOpaqueTestCapable, extractTestRuns } from './tests.js';
import { extractWrites, filesChangedEligible } from './writes.js';

/** The injected environment of `buildLedger` (defaults are pure; the pipeline injects fs-backed values). */
export interface BuildLedgerOptions {
  /** Repo root of an arbitrary written path (S18 injects `util/gitroot.ts makeRepoRootResolver()`); default: none found. */
  repoRootOf?: (p: string) => string | null;
  /** Extra temp roots for the `scratch` scope (S18 injects `os.tmpdir()`); merged with the §4.6.1 defaults. */
  tmpRoots?: string[];
}

/** One `Ledger.perTurn` entry (S02 shape). */
type PerTurnEntry = Ledger['perTurn'][number];

/** `/Users/<u>`, `/home/<u>`, `/root` or `C:/Users/<u>` at the start of a path. */
const HOME_PREFIX_RE = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:\/Users\/[^/]+)(?=\/|$)/;
/** A harness config dir inside a transcript path names the directory above it as home. */
const CONFIG_DIR_RE = /^(.+?)\/\.(?:claude|codex|showreceipts)(?=\/)/;

/**
 * Derives the home directory `~` expands to from the session itself (`cwd`,
 * then every `cwds[]` entry, then the transcript path) — a pure string
 * operation, since the ledger never reads `node:os`. `''` (no `~` expansion,
 * no home-dotfile scope) when nothing looks like a home.
 */
function homeOf(session: Session): string {
  for (const p of [session.cwd, ...session.cwds]) {
    const m = HOME_PREFIX_RE.exec(p);
    if (m !== null) return m[1] as string;
  }
  const t = session.transcriptPath;
  if (t !== null) {
    const m = HOME_PREFIX_RE.exec(t) ?? CONFIG_DIR_RE.exec(t);
    if (m !== null) return m[1] as string;
  }
  return '';
}

/** The §4.6.1 default temp roots plus the injected ones, deduplicated in order. */
function mergeTmpRoots(extra: readonly string[] | undefined): string[] {
  const roots = [...DEFAULT_TMP_ROOTS];
  for (const r of extra ?? []) if (r !== '' && !roots.includes(r)) roots.push(r);
  return roots;
}

/** Stable ascending sort by `seq` (extractors emit in call order; sorting is made explicit so no iteration order leaks). */
function bySeq<T extends { seq: number }>(facts: T[]): T[] {
  return facts.sort((a, b) => a.seq - b.seq);
}

/**
 * The §4.8 definition of a complete ledger, inverted: the session is
 * `incomplete` iff subagent transcripts are missing, the hook ledger has gap
 * lines / partial coverage (the reader folds gaps, truncation and a missing
 * `session-start` within 60 s of the first tool event into
 * `ledgerCoverage:'partial'` with named reasons), — and **never** merely
 * because exit codes are unknown (cross-cutting rule (i), S17).
 */
function incompleteness(session: Session): { incomplete: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const missing = session.diagnostics.subagentFiles.missing;
  if (missing > 0) reasons.push(missing === 1 ? '1 subagent transcript not found' : `${missing} subagent transcripts not found`);
  const stored = session.ledger.incompleteReasons;
  for (const r of stored) if (!reasons.includes(r)) reasons.push(r);
  if (session.ledgerCoverage === 'partial' && stored.length === 0 && !reasons.includes('ledger coverage partial')) {
    reasons.push('ledger coverage partial');
  }
  return { incomplete: reasons.length > 0, reasons };
}

/** A zeroed `perTurn` entry. */
function emptyEntry(): PerTurnEntry {
  return { W: null, Wsrc: null, G: null, R: null, writes: 0, testRuns: 0, checks: 0, commands: 0 };
}

/**
 * Builds the session's `Ledger` (§4.6): every extractor runs over the
 * session's tool calls with one shared `LedgerContext`, every fact array is
 * explicitly sorted by `seq`, and the reconciler's indices are computed —
 * `filesChanged` (distinct canon paths of `ok` writes, sorted),
 * `lastWriteSeq` / `lastSourceWriteSeq` (not test, not doc) / `lastGreenSeq`
 * (test runs with `green === true` only), the S02 `perTurn` counters, and
 * `incomplete` per §4.8. As a side effect the session's turns get their
 * `opaqueWriteCommands` / `opaqueTestCommands` counters (reset first, so the
 * call is idempotent). The caller assigns the returned ledger to
 * `session.ledger`.
 */
export function buildLedger(session: Session, opts: BuildLedgerOptions = {}): Ledger {
  const repoRootOf = opts.repoRootOf ?? ((): null => null);
  const ctx: LedgerContext = {
    cwd: session.cwd,
    cwds: session.cwds.length > 0 ? [...session.cwds] : [session.cwd],
    repoRoot: session.repoRoot ?? repoRootOf(session.cwd),
    repoRootOf,
    home: homeOf(session),
    tmpRoots: mergeTmpRoots(opts.tmpRoots),
    harness: session.harness,
  };
  if (session.sandbox !== undefined) ctx.sandbox = session.sandbox;

  const calls = session.toolCalls;
  const commands = bySeq(extractCommands(calls, ctx));
  const writes = bySeq(extractWrites(calls, ctx, commands));
  const testRuns = bySeq(extractTestRuns(commands, calls));
  const checks = bySeq(extractChecks(commands, calls));
  const git = bySeq(extractGit(calls, ctx, commands));
  const network = bySeq(extractNetwork(calls, ctx, commands));
  const integrity = bySeq(extractIntegrity(writes, calls, testRuns));
  const danger = bySeq(extractDanger(calls, ctx, commands, writes, git));

  const filesChanged = [...new Set(writes.filter(filesChangedEligible).map((w) => w.path))].sort();

  // --- per-turn and per-session indices ------------------------------------
  const callById = new Map<string, ToolCall>();
  for (const call of calls) callById.set(call.id, call);
  const turnByIndex = new Map<number, Turn>();
  const entries = new Map<number, PerTurnEntry>();
  for (const turn of session.turns) {
    turnByIndex.set(turn.index, turn);
    entries.set(turn.index, emptyEntry());
    turn.opaqueWriteCommands = 0; // recomputed below (idempotent re-build)
    turn.opaqueTestCommands = 0;
  }
  const entryOf = (toolCallId: string): PerTurnEntry | null => {
    const index = callById.get(toolCallId)?.turnIndex;
    if (index === undefined || index < 0) return null;
    let entry = entries.get(index);
    if (entry === undefined) {
      entry = emptyEntry();
      entries.set(index, entry);
    }
    return entry;
  };

  let lastWriteSeq: number | null = null;
  let lastSourceWriteSeq: number | null = null;
  let lastGreenSeq: number | null = null;

  for (const fact of commands) {
    const entry = entryOf(fact.toolCallId);
    if (entry !== null) entry.commands += 1;
    const turn = turnByIndex.get(callById.get(fact.toolCallId)?.turnIndex ?? -1);
    if (turn !== undefined) {
      if (fact.opaqueWrite === true) turn.opaqueWriteCommands += 1;
      if (fact.mayRunTests === true && !fact.segments.some((s) => s.family === 'test')) turn.opaqueTestCommands += 1;
    }
  }
  for (const write of writes) {
    const entry = entryOf(write.toolCallId);
    if (entry !== null) entry.writes += 1;
    if (write.status !== 'ok') continue;
    if (lastWriteSeq === null || write.seq > lastWriteSeq) lastWriteSeq = write.seq;
    if (entry !== null && (entry.W === null || write.seq > entry.W)) entry.W = write.seq;
    if (write.isTestFile || write.isDoc) continue;
    if (lastSourceWriteSeq === null || write.seq > lastSourceWriteSeq) lastSourceWriteSeq = write.seq;
    if (entry !== null && (entry.Wsrc === null || write.seq > entry.Wsrc)) entry.Wsrc = write.seq;
  }
  for (const run of testRuns) {
    const entry = entryOf(run.toolCallId);
    if (entry !== null) entry.testRuns += 1;
    if (run.green === true) {
      if (lastGreenSeq === null || run.seq > lastGreenSeq) lastGreenSeq = run.seq;
      if (entry !== null && (entry.G === null || run.seq > entry.G)) entry.G = run.seq;
    } else if (run.green === false) {
      if (entry !== null && (entry.R === null || run.seq > entry.R)) entry.R = run.seq;
    }
  }
  for (const check of checks) {
    const entry = entryOf(check.toolCallId);
    if (entry !== null) entry.checks += 1;
  }

  const perTurn: Ledger['perTurn'] = {};
  for (const index of [...entries.keys()].sort((a, b) => a - b)) perTurn[index] = entries.get(index) as PerTurnEntry;

  const { incomplete, reasons } = incompleteness(session);

  return {
    writes,
    commands,
    testRuns,
    checks,
    git,
    network,
    integrity,
    danger,
    filesChanged,
    lastWriteSeq,
    lastSourceWriteSeq,
    lastGreenSeq,
    incomplete,
    incompleteReasons: reasons,
    opaqueTestCapable: countOpaqueTestCapable(commands),
    perTurn,
  };
}
