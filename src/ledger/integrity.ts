/**
 * Test-integrity signals (§4.6.7). Inputs are the session's writes (joined to
 * their `ToolCall.patch` added/removed lines by `toolCallId` — for Write
 * updates the reader already derived the patch from `originalFile` vs
 * `content`, so patch lines are authoritative here) and its test runs. Six
 * signals:
 *
 * - `test-file-deleted` — an ok delete of a test file.
 * - `test-file-edited-after-green` — a test-file write after the last
 *   `green:true` run (rendered "(not re-run)").
 * - `skip-added` / `only-added` — a §4.6.7(b) marker on an added patch line;
 *   a marker also present on a removed line of the same patch is a move, and
 *   conditional skips (`skipif`, `skipUnless`, `importorskip`) are
 *   informational, never signals.
 * - `assertion-removed` — a strictly positive net (`removed − added`)
 *   assertion count over the patch lines (adding 2 and removing 2 is no
 *   signal).
 * - `test-count-dropped` — consecutive parsed full runs of the same runner
 *   whose total dropped, unexplained by failures/errors (an `-x` stop), with
 *   a test-file edit in between.
 *
 * Marker and assertion scans are applied to test-file writes only — the
 * patterns are test constructs, and the signals feed test-claim reconciling.
 * Pure functions of their inputs: no fs, no env, no clock.
 */
import type { IntegritySignal, TestRun, ToolCall, WriteFact } from '../model/types.js';
import { isTestFile } from './testfiles.js';

interface Marker {
  re: RegExp;
  kind: 'skip-added' | 'only-added';
}

/** §4.6.7(b): only these added-line patterns raise skip/only signals. */
const MARKERS: readonly Marker[] = [
  { re: /\b(describe|it|test|suite|context)\.(skip|todo|fixme)\s*\(/, kind: 'skip-added' },
  { re: /\b(describe|it|test|suite|context)\.only\s*\(/, kind: 'only-added' },
  { re: /\bx(it|describe|test)\s*\(/, kind: 'skip-added' },
  { re: /\bf(it|describe|test)\s*\(/, kind: 'only-added' },
  { re: /@pytest\.mark\.(skip|xfail)\b/, kind: 'skip-added' },
  { re: /pytest\.skip\(/, kind: 'skip-added' },
  { re: /@unittest\.(skip|expectedFailure)\b/, kind: 'skip-added' },
  { re: /self\.skipTest\(/, kind: 'skip-added' },
  { re: /#\[ignore\]/, kind: 'skip-added' },
  { re: /\bt\.Skip\w*\(/, kind: 'skip-added' },
  { re: /@Disabled\b/, kind: 'skip-added' },
  { re: /@Ignore\b/, kind: 'skip-added' },
  { re: /Skip\s*=/, kind: 'skip-added' },
];

/** Conditional skips are informational (§4.6.7b) — the whole line is exempt. */
const INFORMATIONAL_RE = /skipif|skipUnless|importorskip/;

/** §4.6.7(a): anchored assertion patterns; one hit per line. */
const ASSERT_RES: readonly RegExp[] = [
  /^\s*(?:expect|assert)\s*\(/,
  /^\s*assert\b/,
  /\.(?:toBe|toEqual|toThrow|toMatch|toContain|toStrictEqual)\w*\(/,
  /\bassert[A-Z]\w*\(/,
  /\bt\.(?:Error|Fatal)\w*\(/,
  /assert(?:_eq|_ne)?!\(/,
];

/** Lines starting `import|from|//|#|*` never count as assertions (§4.6.7a). */
const ASSERT_LINE_SKIP_RE = /^\s*(?:import\b|from\b|\/\/|#|\*)/;

/**
 * Computes the §4.6.7 integrity signals from the session's writes (with
 * their calls' patch lines) and test runs, sorted by `seq`.
 */
export function extractIntegrity(
  writes: readonly WriteFact[],
  calls: readonly ToolCall[],
  testRuns: readonly TestRun[],
): IntegritySignal[] {
  const patches = new Map<string, NonNullable<ToolCall['patch']>>();
  for (const call of calls) {
    if (call.patch !== undefined) patches.set(call.id, call.patch);
  }
  let lastGreenSeq: number | null = null;
  for (const run of testRuns) {
    if (run.green === true && (lastGreenSeq === null || run.seq > lastGreenSeq)) lastGreenSeq = run.seq;
  }

  const signals: IntegritySignal[] = [];
  const testWrites: WriteFact[] = [];
  for (const write of writes) {
    if (write.status !== 'ok' || write.metadataOnly === true) continue;
    if (!(write.isTestFile || isTestFile(write.path))) continue;
    testWrites.push(write);
    if (write.verb === 'delete') {
      signals.push({ seq: write.seq, kind: 'test-file-deleted', path: write.path, detail: `deleted ${write.display}` });
      continue;
    }
    if (lastGreenSeq !== null && write.seq > lastGreenSeq) {
      signals.push({
        seq: write.seq,
        kind: 'test-file-edited-after-green',
        path: write.path,
        detail: `${write.display} edited after the last green run (not re-run)`,
      });
    }
    const patch = patches.get(write.toolCallId);
    if (patch === undefined) continue;
    scanMarkers(write, patch, signals);
    const net = countAsserts(patch.removed) - countAsserts(patch.added);
    if (net > 0) {
      signals.push({
        seq: write.seq,
        kind: 'assertion-removed',
        path: write.path,
        detail: `${net} assertion${net === 1 ? '' : 's'} removed in ${write.display}`,
      });
    }
  }
  scanCountDrops(testRuns, testWrites, signals);
  return signals.sort((a, b) => a.seq - b.seq);
}

/** One skip/only signal per kind per write; moved markers are suppressed. */
function scanMarkers(write: WriteFact, patch: { added: string[]; removed: string[] }, signals: IntegritySignal[]): void {
  const hits = new Map<Marker['kind'], string>();
  for (const marker of MARKERS) {
    const added = patch.added.find((line) => !INFORMATIONAL_RE.test(line) && marker.re.test(line));
    if (added === undefined) continue;
    if (patch.removed.some((line) => marker.re.test(line))) continue; // a move, not an addition
    if (!hits.has(marker.kind)) hits.set(marker.kind, added.trim());
  }
  for (const [kind, line] of hits) {
    signals.push({ seq: write.seq, kind, path: write.path, detail: `\`${snippet(line)}\` added in ${write.display}` });
  }
}

function snippet(line: string): string {
  return line.length <= 40 ? line : `${line.slice(0, 39)}…`;
}

function countAsserts(lines: readonly string[]): number {
  let n = 0;
  for (const line of lines) {
    if (ASSERT_LINE_SKIP_RE.test(line)) continue;
    if (ASSERT_RES.some((re) => re.test(line))) n += 1;
  }
  return n;
}

/**
 * §4.6.7(d): a dropped total between consecutive parsed `scope:'full'` runs
 * of the same runner (and targets), not explained by failures/errors, with a
 * test-file edit in between.
 */
function scanCountDrops(testRuns: readonly TestRun[], testWrites: readonly WriteFact[], signals: IntegritySignal[]): void {
  const byRunner = new Map<string, TestRun[]>();
  for (const run of testRuns) {
    if (run.kind !== 'run' || run.scope !== 'full' || run.parsed?.total === undefined) continue;
    const list = byRunner.get(run.runner) ?? [];
    list.push(run);
    byRunner.set(run.runner, list);
  }
  for (const list of byRunner.values()) {
    list.sort((a, b) => a.seq - b.seq);
    for (let i = 1; i < list.length; i += 1) {
      const prev = list[i - 1] as TestRun;
      const cur = list[i] as TestRun;
      const prevTotal = prev.parsed?.total as number;
      const curTotal = cur.parsed?.total as number;
      if (curTotal >= prevTotal) continue;
      if ((cur.parsed?.failed ?? 0) + (cur.parsed?.errors ?? 0) > 0) continue; // an -x stop explains the drop
      if (!sameTargets(prev.targets, cur.targets)) continue;
      if (!testWrites.some((w) => w.seq > prev.seq && w.seq < cur.seq)) continue;
      signals.push({
        seq: cur.seq,
        kind: 'test-count-dropped',
        detail: `test count dropped from ${prevTotal} to ${curTotal} (${cur.runner})`,
      });
    }
  }
}

function sameTargets(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}
