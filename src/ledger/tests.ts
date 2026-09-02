/**
 * Test-run extraction (§4.6.4). For every S11 segment with `family:'test'`
 * one `TestRun` is built with the tri-state `green`:
 *
 * - `true` only when a §7 parser matched with `failed === 0 && errors === 0
 *   && suites.failed === 0 && total > 0` and the segment exit is `0` or the
 *   exit is unknown (then `exitCodeSource:'parsed'`); or — with nothing
 *   parsed — for a single-segment, unpiped, unsuppressed command with a real
 *   exit 0 (`conclusive:false`, note `exit 0, no result line`).
 * - `false` when red: a non-null non-zero exit (never green, even with a
 *   parsed all-pass line), parsed failures/errors/suite failures, a
 *   `total: 0` parse (vitest `No test files found`), or a snapshot-update
 *   run (`kind:'snapshot-update'`, §4.5.6 — never evidence).
 * - `'unknown'` when nothing parsed and the command is sink-piped,
 *   redirected, multi-segment, persisted or truncated.
 *
 * Background, timed-out, denied, interrupted and short-circuited segments
 * create no `TestRun` at all (S17 renders "attempted, did not run"). The
 * parse is also stored on the call (`ToolCall.parsed` / `parsedFrom`; the
 * last test segment of a call wins). Exit `-1` arrives as `exitCode:null`
 * with `terminated:true` and is never green.
 */
import type { CommandFact, ShellSegment, TestRun, ToolCall } from '../model/types.js';
import { parseGeneric, parseOutput, prepareOutput, RUNNERS, type Parsed, type RunnerSpec } from './runners.js';

const ERROR_TS_RE = /error TS\d+/;

/**
 * §4.6.4: true when this segment can produce no `TestRun`/`CheckRun` at all —
 * the call ran in the background, timed out, was denied or blocked, was
 * interrupted, or the segment was short-circuited by an earlier failure.
 */
export function segmentProducedNoRun(fact: CommandFact, call: ToolCall | undefined, segment: ShellSegment): boolean {
  if (fact.background || call?.background === true || segment.ran === 'background') return true;
  if (fact.interrupted || call?.interrupted === true) return true;
  if (call?.denied !== undefined) return true;
  if (call?.timedOutAfterMs !== undefined) return true;
  return segment.ran === 'short-circuited';
}

/**
 * Extracts every `TestRun` from the session's command facts (§4.6.4), storing
 * each successful parse on the originating call (`parsed`, `parsedFrom`).
 */
export function extractTestRuns(commands: readonly CommandFact[], calls: readonly ToolCall[]): TestRun[] {
  const byId = new Map<string, ToolCall>();
  for (const call of calls) byId.set(call.id, call);
  const runs: TestRun[] = [];
  for (const fact of commands) {
    const call = byId.get(fact.toolCallId);
    let text: string | null = null;
    for (const segment of fact.segments) {
      if (segment.family !== 'test') continue;
      if (segmentProducedNoRun(fact, call, segment)) continue;
      text ??= prepareOutput(call?.resultText ?? '');
      runs.push(buildRun(fact, call, segment, text));
    }
  }
  return runs;
}

/**
 * Counts the commands that could have run tests opaquely (`mayRunTests`
 * scripts like `./scripts/test.sh`) without any parseable test segment —
 * `Ledger.opaqueTestCapable`, consumed by S14.
 */
export function countOpaqueTestCapable(commands: readonly CommandFact[]): number {
  let n = 0;
  for (const fact of commands) {
    if (fact.mayRunTests === true && !fact.segments.some((s) => s.family === 'test')) n += 1;
  }
  return n;
}

/** Finds the §7 row for a segment and runs its parser (generic rows chain). */
function parseFor(segment: ShellSegment, text: string): { parsed: Parsed; parsedFrom: string } | null {
  const spec = RUNNERS.find((r) => r.detect(segment)) ?? (RUNNERS[RUNNERS.length - 1] as RunnerSpec);
  if (spec.id === 'generic') return parseGeneric(text);
  const parsed = parseOutput(spec, text);
  return parsed === null ? null : { parsed, parsedFrom: spec.id };
}

function buildRun(fact: CommandFact, call: ToolCall | undefined, segment: ShellSegment, text: string): TestRun {
  const scope = segment.testScope ?? { scope: 'unknown' as const, targets: [] };
  const run: TestRun = {
    seq: fact.seq,
    toolCallId: fact.toolCallId,
    agentId: fact.agentId,
    runner: segment.runner ?? segment.program,
    command: segment.raw,
    scope: scope.scope,
    targets: scope.targets,
    kind: segment.snapshotUpdate === true ? 'snapshot-update' : 'run',
    exitCode: segment.exitCode,
    exitCodeSource: segment.exitCodeSource,
    green: 'unknown',
    conclusive: true,
    truncated: call?.truncated !== undefined || segment.suppressed,
  };
  const hit = parseFor(segment, text);
  if (hit !== null) {
    run.parsed = hit.parsed;
    run.parsedFrom = hit.parsedFrom;
    if (call !== undefined) {
      call.parsed = hit.parsed;
      call.parsedFrom = hit.parsedFrom;
    }
  }
  judge(run, fact, call, segment, text);
  return run;
}

/** The §4.6.4 tri-state judgement, mutating `green`/`conclusive`/`note`. */
function judge(run: TestRun, fact: CommandFact, call: ToolCall | undefined, segment: ShellSegment, text: string): void {
  if (run.kind === 'snapshot-update') {
    run.green = false;
    run.note = 'snapshot update run (not evidence)';
    return;
  }
  const exit = segment.exitCode;
  const parsed = run.parsed;
  if (parsed !== undefined) {
    if ((parsed.failed ?? 0) > 0 || (parsed.errors ?? 0) > 0 || (parsed.suites?.failed ?? 0) > 0) {
      run.green = false;
      if (parsed.ran === false && ERROR_TS_RE.test(text)) run.note = 'test file failed to load';
      return;
    }
    if (exit !== null && exit !== 0) {
      run.green = false; // a non-zero exit is never green, even with an all-pass line
      return;
    }
    if ((parsed.total ?? 0) === 0) {
      run.green = false; // vitest `No test files found` and friends are never green
      run.note = parsed.ran === false && ERROR_TS_RE.test(text) ? 'test file failed to load' : 'no tests ran';
      return;
    }
    if (exit === 0) {
      run.green = true;
      return;
    }
    if (call?.terminated === true) {
      run.green = 'unknown'; // exit −1: never green (§4.3.3)
      run.conclusive = false;
      run.note = 'exit unknown';
      return;
    }
    run.green = true; // exit unknown + parsed 0-failure summary (§4.6.4)
    run.exitCodeSource = 'parsed';
    return;
  }
  if (exit !== null && exit !== 0) {
    run.green = false;
    return;
  }
  if (exit === 0 && fact.segments.length === 1 && !segment.piped && !segment.suppressed && call?.truncated === undefined) {
    run.green = true;
    run.conclusive = false;
    run.note = 'exit 0, no result line';
    return;
  }
  run.green = 'unknown';
  run.conclusive = false;
  run.note = segment.suppressed || call?.truncated !== undefined ? 'output suppressed, no result line' : 'exit unknown';
}
