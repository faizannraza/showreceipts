/**
 * The §7 test-runner table as data: 23 rows of `{ id, detect, parse }` in
 * table order. Detection runs on the S11 segment (`runner` was already set by
 * `ledger/shell/families.ts` from the unwrapped program + argv); parsers run
 * on `stripAnsi(stdout + '\n' + stderr)` — the caller prepares the text with
 * `prepareOutput` (§4.6.4). The generic runner (#23) tries every parser above
 * it, first match wins, and reports which one matched (`parsedFrom`). All
 * regexes are the §7 table's, carry their `m` flag, and are linear-time (no
 * stacked `\s*` across lines beyond the table's own).
 */
import type { ShellSegment, TestRun } from '../model/types.js';

/** The §4.6.4 parse result stored on `TestRun.parsed` and `ToolCall.parsed`. */
export type Parsed = NonNullable<TestRun['parsed']>;

/** One §7 table row: a runner id, its segment detector, and its output parser. */
export interface RunnerSpec {
  id: string;
  detect(segment: ShellSegment): boolean;
  parse(text: string): Parsed | null;
}

// --- output preparation (§4.6.4) -------------------------------------------

/** `stripAnsi` exactly as §4.6.4 defines it. */
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** The Claude Code cwd-reset trailer (§4.5.3) — defensively re-stripped. */
const CWD_RESET_RE = /\n?Shell cwd was reset to [^\n]*$/;

/** A Codex `…N tokens truncated…` marker line (§4.3.3) — removed before parsing. */
const TOKENS_TRUNCATED_LINE_RE = /^[^\n]*…\d+ tokens truncated…[^\n]*\n?/gm;

/** Removes every ANSI escape sequence (§4.6.4's `stripAnsi`). */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/**
 * Prepares a logged tool output for the runner/check parsers (§4.6.4): ANSI
 * stripped, the cwd-reset trailer and Codex truncation-marker lines removed
 * (the readers already strip both; this is a cheap second guard).
 */
export function prepareOutput(text: string): string {
  return stripAnsi(text).replace(CWD_RESET_RE, '').replace(TOKENS_TRUNCATED_LINE_RE, '');
}

// --- small helpers ----------------------------------------------------------

const num = (s: string | undefined): number => (s === undefined || s === '' ? 0 : Number(s));

function globalOf(re: RegExp): RegExp {
  return re.flags.includes('g') ? re : new RegExp(re.source, `${re.flags}g`);
}

function lastMatch(re: RegExp, text: string): RegExpMatchArray | null {
  let last: RegExpMatchArray | null = null;
  for (const m of text.matchAll(globalOf(re))) last = m;
  return last;
}

/**
 * The generic `N <token>` scanner shared by the pytest, jest, vitest and
 * playwright parsers: sums every `(count, token)` pair `re` finds in `list`,
 * folding a trailing `s` (`errors` → `error`, `warnings` → `warning`).
 */
function scanTokens(list: string, re: RegExp): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of list.matchAll(globalOf(re))) {
    const token = (m[2] as string).replace(/s$/, '');
    counts.set(token, (counts.get(token) ?? 0) + num(m[1]));
  }
  return counts;
}

// --- row 1: pytest ----------------------------------------------------------

const PYTEST_RESULT_RE = /^(?:=+ )?((?:\d+ (?:passed|failed|errors?|skipped|xfailed|xpassed|deselected|warnings?|rerun)(?:, )?)+) in [\d.]+s/m;
const PYTEST_NO_TESTS_RE = /^(?:=+ )?no tests ran in [\d.]+s/m;
const PYTEST_TOKEN_RE = /(\d+) (passed|failed|errors?|skipped|xfailed|xpassed|deselected|warnings?|rerun)/m;

function parsePytest(text: string): Parsed | null {
  const last = lastMatch(PYTEST_RESULT_RE, text);
  if (last === null) return PYTEST_NO_TESTS_RE.test(text) ? { total: 0 } : null;
  const c = scanTokens(last[1] as string, PYTEST_TOKEN_RE);
  const passed = (c.get('passed') ?? 0) + (c.get('xpassed') ?? 0);
  const failed = c.get('failed') ?? 0;
  const errors = c.get('error') ?? 0;
  const skipped = (c.get('skipped') ?? 0) + (c.get('xfailed') ?? 0);
  return { passed, failed, errors, skipped, total: passed + failed + errors + skipped };
}

// --- row 2: unittest --------------------------------------------------------

const UNITTEST_RE = /^Ran (\d+) tests? in [\d.]+s\s*\n+\s*(OK|FAILED)(?: \((?:failures=(\d+))?,? ?(?:errors=(\d+))?,? ?(?:skipped=(\d+))?\))?/m;

function parseUnittest(text: string): Parsed | null {
  const m = lastMatch(UNITTEST_RE, text);
  if (m === null) return null;
  const total = num(m[1]);
  const failed = num(m[3]);
  const errors = num(m[4]);
  const skipped = num(m[5]);
  return { passed: Math.max(0, total - failed - errors - skipped), failed, errors, skipped, total };
}

// --- row 3: jest (writes to stderr; the caller passes combined text) --------

const JEST_TESTS_RE = /^Tests:\s+((?:\d+ (?:failed|skipped|todo|passed)(?:, )?)+)(\d+) total/m;
const JEST_SUITES_RE = /^Test Suites:\s+((?:\d+ (?:failed|skipped|todo|passed)(?:, )?)+)(\d+) total/m;
const JEST_TOKEN_RE = /(\d+) (failed|skipped|todo|passed)/m;

function parseJest(text: string): Parsed | null {
  const m = lastMatch(JEST_TESTS_RE, text);
  if (m === null) return null;
  const c = scanTokens(m[1] as string, JEST_TOKEN_RE);
  const parsed: Parsed = {
    passed: c.get('passed') ?? 0,
    failed: c.get('failed') ?? 0,
    skipped: (c.get('skipped') ?? 0) + (c.get('todo') ?? 0),
    total: num(m[2]),
  };
  const sm = lastMatch(JEST_SUITES_RE, text);
  if (sm !== null) {
    const sc = scanTokens(sm[1] as string, JEST_TOKEN_RE);
    parsed.suites = { passed: sc.get('passed') ?? 0, failed: sc.get('failed') ?? 0, total: num(sm[2]) };
  }
  return parsed;
}

// --- row 4: vitest ----------------------------------------------------------

const VITEST_TESTS_RE = /^(?:.*?\s)?Tests\s+((?:\d+ (?:failed|passed|skipped|todo)(?: \| )?)+)\s*\((\d+)\)\s*$/m;
const VITEST_FILES_RE = /^(?:.*?\s)?Test Files\s+((?:\d+ (?:failed|passed|skipped)(?: \| )?)+)\s*\((\d+)\)/m;
const VITEST_NO_TESTS_RE = /^(?:.*?\s)?Tests\s+no tests\b/m;
const VITEST_NO_FILES_RE = /No test files found/m;
const VITEST_TOKEN_RE = /(\d+) (failed|passed|skipped|todo)/m;

function parseVitest(text: string): Parsed | null {
  let suites: Parsed['suites'];
  const fm = lastMatch(VITEST_FILES_RE, text);
  if (fm !== null) {
    const fc = scanTokens(fm[1] as string, VITEST_TOKEN_RE);
    suites = { passed: fc.get('passed') ?? 0, failed: fc.get('failed') ?? 0, total: num(fm[2]) };
  }
  const tm = lastMatch(VITEST_TESTS_RE, text);
  if (tm !== null) {
    const c = scanTokens(tm[1] as string, VITEST_TOKEN_RE);
    const parsed: Parsed = {
      passed: c.get('passed') ?? 0,
      failed: c.get('failed') ?? 0,
      skipped: (c.get('skipped') ?? 0) + (c.get('todo') ?? 0),
      total: num(tm[2]),
    };
    if (suites !== undefined) parsed.suites = suites;
    return parsed;
  }
  if (VITEST_NO_TESTS_RE.test(text)) {
    const parsed: Parsed = { total: 0, ran: false };
    if (suites !== undefined) parsed.suites = suites;
    return parsed;
  }
  if (VITEST_NO_FILES_RE.test(text)) return { total: 0 };
  return null;
}

// --- row 5: mocha -----------------------------------------------------------

const MOCHA_RE = /^\s*(\d+) passing(?: \([^)]*\))?(?:\n\s*(\d+) pending)?(?:\n\s*(\d+) failing)?/m;

function parseMocha(text: string): Parsed | null {
  const m = lastMatch(MOCHA_RE, text);
  if (m === null) return null;
  const passed = num(m[1]);
  const skipped = num(m[2]);
  const failed = num(m[3]);
  return { passed, skipped, failed, total: passed + skipped + failed };
}

// --- row 6: ava (bounded, linear) ------------------------------------------

const AVA_PASSED_RE = /^[ \t]*(?:[✔✘] )?(\d+) tests? passed/m;
const AVA_FAILED_RE = /^[ \t]*(?:[✔✘] )?(\d+) tests? failed/m;
const AVA_SKIPPED_RE = /^[ \t]*(\d+) (?:tests? )?skipped/m;

function parseAva(text: string): Parsed | null {
  const p = AVA_PASSED_RE.exec(text);
  const f = AVA_FAILED_RE.exec(text);
  if (p === null && f === null) return null;
  const passed = p === null ? 0 : num(p[1]);
  const failed = f === null ? 0 : num(f[1]);
  const s = AVA_SKIPPED_RE.exec(text);
  const skipped = s === null ? 0 : num(s[1]);
  return { passed, failed, skipped, total: passed + failed + skipped };
}

// --- row 7: node --test (TAP `#` and spec `ℹ` reporters) --------------------

const NODE_TEST_RE = /^(?:#|ℹ) (tests|pass|fail|cancelled|skipped|todo) (\d+)/gm;

function parseNodeTest(text: string): Parsed | null {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(NODE_TEST_RE)) counts.set(m[1] as string, num(m[2]));
  if (!counts.has('tests') && !counts.has('pass') && !counts.has('fail')) return null;
  const passed = counts.get('pass') ?? 0;
  const failed = counts.get('fail') ?? 0;
  const errors = counts.get('cancelled') ?? 0;
  const skipped = counts.get('skipped') ?? 0;
  const total = counts.get('tests') ?? passed + failed + errors + skipped;
  return { passed, failed, errors, skipped, total };
}

// --- row 8: bun test --------------------------------------------------------

const BUN_RE = /^\s*(\d+) pass\n(?:\s*(\d+) skip\n)?(?:\s*(\d+) todo\n)?\s*(\d+) fail/m;

function parseBun(text: string): Parsed | null {
  const m = lastMatch(BUN_RE, text);
  if (m === null) return null;
  const passed = num(m[1]);
  const skipped = num(m[2]) + num(m[3]);
  const failed = num(m[4]);
  return { passed, skipped, failed, total: passed + skipped + failed };
}

// --- row 9: playwright ------------------------------------------------------

const PLAYWRIGHT_TOKEN_RE = /^[ \t]{0,8}(\d+) (failed|flaky|skipped|passed|did not run|interrupted)\b/m;

function parsePlaywright(text: string): Parsed | null {
  const c = scanTokens(text, PLAYWRIGHT_TOKEN_RE);
  if (c.size === 0) return null;
  const failed = (c.get('failed') ?? 0) + (c.get('interrupted') ?? 0) + (c.get('did not run') ?? 0);
  const passed = (c.get('passed') ?? 0) + (c.get('flaky') ?? 0);
  const skipped = c.get('skipped') ?? 0;
  return { passed, failed, skipped, total: passed + failed + skipped };
}

// --- row 10: cypress --------------------------------------------------------

const CYPRESS_TESTS_RE = /Tests:\s+(\d+)/m;
const CYPRESS_PASSING_RE = /Passing:\s+(\d+)/m;
const CYPRESS_FAILING_RE = /Failing:\s+(\d+)/m;
const CYPRESS_PENDING_RE = /Pending:\s+(\d+)/m;
const CYPRESS_ALL_PASSED_RE = /All specs passed!/m;
const CYPRESS_OF_FAILED_RE = /(\d+) of (\d+) failed/m;

function parseCypress(text: string): Parsed | null {
  const t = lastMatch(CYPRESS_TESTS_RE, text);
  const of = lastMatch(CYPRESS_OF_FAILED_RE, text);
  if (t === null && of === null && !CYPRESS_ALL_PASSED_RE.test(text)) return null;
  const f = lastMatch(CYPRESS_FAILING_RE, text);
  const failed = f !== null ? num(f[1]) : of !== null ? num(of[1]) : 0;
  const p = lastMatch(CYPRESS_PASSING_RE, text);
  const passed = p === null ? 0 : num(p[1]);
  const pen = lastMatch(CYPRESS_PENDING_RE, text);
  const skipped = pen === null ? 0 : num(pen[1]);
  const total = t !== null ? num(t[1]) : passed + failed + skipped;
  return { passed, failed, skipped, total };
}

// --- row 11: go test --------------------------------------------------------

// §7 writes `\s+` here, but in JS that would let a bare `FAIL` line swallow
// the next package line across the newline — horizontal whitespace only.
const GO_PKG_RE = /^(ok|FAIL)[ \t]+\S+/m;
const GO_VERBOSE_RE = /^--- (PASS|FAIL|SKIP): /m;
const GO_FAIL_LINE_RE = /^FAIL$/m;
const GO_BUILD_FAILED_RE = /\[build failed\]/m;

function parseGoTest(text: string): Parsed | null {
  let suitesPassed = 0;
  let suitesFailed = 0;
  for (const m of text.matchAll(globalOf(GO_PKG_RE))) {
    if (m[1] === 'ok') suitesPassed += 1;
    else suitesFailed += 1;
  }
  let vp = 0;
  let vf = 0;
  let vs = 0;
  for (const m of text.matchAll(globalOf(GO_VERBOSE_RE))) {
    if (m[1] === 'PASS') vp += 1;
    else if (m[1] === 'FAIL') vf += 1;
    else vs += 1;
  }
  const failLine = GO_FAIL_LINE_RE.test(text) || GO_BUILD_FAILED_RE.test(text);
  if (suitesPassed + suitesFailed === 0 && vp + vf + vs === 0 && !failLine) return null;
  let failed = vf > 0 ? vf : suitesFailed;
  const passed = vp > 0 ? vp : suitesPassed;
  if (failLine && failed === 0) failed = 1;
  const parsed: Parsed = { passed, failed, skipped: vs, total: passed + failed + vs };
  if (suitesPassed + suitesFailed > 0) parsed.suites = { passed: suitesPassed, failed: suitesFailed };
  return parsed;
}

// --- row 12: cargo test / nextest (summed across crates) --------------------

const CARGO_RE = /^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out/m;
const NEXTEST_RE = /Summary \[[^\]]*\] (\d+) tests run: (\d+) passed(?:, (\d+) failed)?(?:, (\d+) skipped)?/m;

function parseCargoTest(text: string): Parsed | null {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let matched = false;
  for (const m of text.matchAll(globalOf(CARGO_RE))) {
    matched = true;
    passed += num(m[2]);
    failed += num(m[3]);
    skipped += num(m[4]);
  }
  if (matched) return { passed, failed, skipped, total: passed + failed };
  const n = NEXTEST_RE.exec(text);
  if (n === null) return null;
  return { total: num(n[1]), passed: num(n[2]), failed: num(n[3]), skipped: num(n[4]) };
}

// --- row 13: maven / gradle -------------------------------------------------

const MAVEN_RE = /^(?:\[(?:INFO|WARNING|ERROR)\] )?Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)\s*$/m;
const GRADLE_RE = /(\d+) tests completed, (\d+) failed(?:, (\d+) skipped)?/m;
const GRADLE_BUILD_RE = /BUILD (SUCCESSFUL|FAILED)/m;

function parseMavenGradle(text: string): Parsed | null {
  const m = lastMatch(MAVEN_RE, text);
  if (m !== null) {
    const total = num(m[1]);
    const failed = num(m[2]);
    const errors = num(m[3]);
    const skipped = num(m[4]);
    return { passed: Math.max(0, total - failed - errors - skipped), failed, errors, skipped, total };
  }
  const g = lastMatch(GRADLE_RE, text);
  if (g === null) return null;
  const total = num(g[1]);
  const failed = num(g[2]);
  const skipped = num(g[3]);
  const parsed: Parsed = { passed: Math.max(0, total - failed - skipped), failed, skipped, total };
  const b = GRADLE_BUILD_RE.exec(text);
  if (b !== null && b[1] === 'FAILED' && failed === 0) parsed.errors = 1;
  return parsed;
}

// --- row 14: dotnet test ----------------------------------------------------

const DOTNET_PF_RE = /^(?:Passed!|Failed!)\s+-\s+Failed:\s+(\d+),\s+Passed:\s+(\d+),\s+Skipped:\s+(\d+),\s+Total:\s+(\d+)/m;
const DOTNET_TOTAL_RE = /Total tests: (\d+)\n\s*Passed: (\d+)\n\s*Failed: (\d+)(?:\n\s*Skipped: (\d+))?/m;
const DOTNET_SUMMARY_RE = /^Test summary: total: (\d+), failed: (\d+), succeeded: (\d+), skipped: (\d+)/m;

function parseDotnet(text: string): Parsed | null {
  const pf = DOTNET_PF_RE.exec(text);
  if (pf !== null) return { failed: num(pf[1]), passed: num(pf[2]), skipped: num(pf[3]), total: num(pf[4]) };
  const t = DOTNET_TOTAL_RE.exec(text);
  if (t !== null) return { total: num(t[1]), passed: num(t[2]), failed: num(t[3]), skipped: num(t[4]) };
  const s = DOTNET_SUMMARY_RE.exec(text);
  if (s === null) return null;
  return { total: num(s[1]), failed: num(s[2]), passed: num(s[3]), skipped: num(s[4]) };
}

// --- row 15: rspec ----------------------------------------------------------

const RSPEC_RE = /^(\d+) examples?, (\d+) failures?(?:, (\d+) pending)?(?:, (\d+) errors? occurred outside of examples)?/m;

function parseRspec(text: string): Parsed | null {
  const m = lastMatch(RSPEC_RE, text);
  if (m === null) return null;
  const total = num(m[1]);
  const failed = num(m[2]);
  const skipped = num(m[3]);
  const errors = num(m[4]);
  return { passed: Math.max(0, total - failed - skipped), failed, skipped, errors, total };
}

// --- row 16: minitest / rails test ------------------------------------------

const MINITEST_RE = /^(\d+) runs, (\d+) assertions, (\d+) failures, (\d+) errors, (\d+) skips/m;

function parseMinitest(text: string): Parsed | null {
  const m = lastMatch(MINITEST_RE, text);
  if (m === null) return null;
  const total = num(m[1]);
  const failed = num(m[3]);
  const errors = num(m[4]);
  const skipped = num(m[5]);
  return { passed: Math.max(0, total - failed - errors - skipped), failed, errors, skipped, total };
}

// --- row 17: phpunit / pest -------------------------------------------------

const PHPUNIT_OK_RE = /^OK \((\d+) tests?, (\d+) assertions?\)/m;
const PHPUNIT_FAIL_RE = /^(?:OK, but[^\n]*!|WARNINGS!|FAILURES!|ERRORS!)\s*\nTests: (\d+), Assertions: (\d+)(?:, Failures: (\d+))?(?:, Errors: (\d+))?(?:, Skipped: (\d+))?/m;
const PEST_RE = /Tests:\s+(?:(\d+) failed, )?(\d+) passed/m;

function parsePhpunit(text: string): Parsed | null {
  const ok = PHPUNIT_OK_RE.exec(text);
  if (ok !== null) {
    const total = num(ok[1]);
    return { total, passed: total, failed: 0 };
  }
  const f = PHPUNIT_FAIL_RE.exec(text);
  if (f !== null) {
    const total = num(f[1]);
    const failed = num(f[3]);
    const errors = num(f[4]);
    const skipped = num(f[5]);
    return { passed: Math.max(0, total - failed - errors - skipped), failed, errors, skipped, total };
  }
  const p = PEST_RE.exec(text);
  if (p === null) return null;
  const failed = num(p[1]);
  const passed = num(p[2]);
  return { passed, failed, total: passed + failed };
}

// --- row 18: mix test -------------------------------------------------------

const MIX_RE = /^(?:(\d+) propert(?:y|ies), )?(?:(\d+) doctests?, )?(\d+) tests?, (\d+) failures?(?:, (\d+) excluded)?(?:, (\d+) skipped)?/m;

function parseMix(text: string): Parsed | null {
  const m = lastMatch(MIX_RE, text);
  if (m === null) return null;
  const total = num(m[1]) + num(m[2]) + num(m[3]);
  const failed = num(m[4]);
  const skipped = num(m[6]);
  return { passed: Math.max(0, total - failed - skipped), failed, skipped, total };
}

// --- row 19: ctest ----------------------------------------------------------

const CTEST_RE = /^(\d+)% tests passed, (\d+) tests failed out of (\d+)/m;

function parseCtest(text: string): Parsed | null {
  const m = lastMatch(CTEST_RE, text);
  if (m === null) return null;
  const total = num(m[3]);
  const failed = num(m[2]);
  return { passed: Math.max(0, total - failed), failed, total };
}

// --- row 20: deno test ------------------------------------------------------

const DENO_RE = /^(ok|FAILED) \| (\d+) passed(?: \((\d+) steps?\))? \| (\d+) failed(?: \((\d+) steps?\))?(?: \| (\d+) ignored)?/m;

function parseDeno(text: string): Parsed | null {
  const m = lastMatch(DENO_RE, text);
  if (m === null) return null;
  const passed = num(m[2]);
  const failed = num(m[4]);
  const skipped = num(m[6]);
  return { passed, failed, skipped, total: passed + failed };
}

// --- row 21: swift test / xcodebuild ----------------------------------------

const SWIFT_EXECUTED_RE = /Executed (\d+) tests?, with (\d+) failures? \((\d+) unexpected\)/m;
const SWIFT_MARKER_RE = /\*\* TEST (SUCCEEDED|FAILED) \*\*/m;

function parseSwift(text: string): Parsed | null {
  const m = lastMatch(SWIFT_EXECUTED_RE, text);
  if (m !== null) {
    const total = num(m[1]);
    const failed = num(m[2]);
    return { passed: Math.max(0, total - failed), failed, total };
  }
  const marker = SWIFT_MARKER_RE.exec(text);
  if (marker !== null && marker[1] === 'FAILED') return { failed: 1, total: 1 };
  return null;
}

// --- row 22: flutter / dart test --------------------------------------------

const FLUTTER_RE = /^(\d{2}:\d{2}) \+(\d+)(?: ~(\d+))?(?: -(\d+))?: (?:All tests passed!|Some tests failed\.)/m;

function parseFlutter(text: string): Parsed | null {
  const m = lastMatch(FLUTTER_RE, text);
  if (m === null) return null;
  const passed = num(m[2]);
  const skipped = num(m[3]);
  const failed = num(m[4]);
  return { passed, skipped, failed, total: passed + skipped + failed };
}

// --- row 23: generic (npm test, make test, tox, …) --------------------------

const GENERIC_RUNNERS: ReadonlySet<string> = new Set(['make:test', 'make:check', 'just:test', 'tox', 'nox', 'hatch-test', 'poe-test']);

function detectGeneric(segment: ShellSegment): boolean {
  const r = segment.runner;
  return r !== undefined && (r.startsWith('npm-script:test') || GENERIC_RUNNERS.has(r));
}

/**
 * Runs a spec's parser in §4.6.4 parse order: the last 1 KB of the combined
 * output first (the tail is where result lines live), then the full text.
 */
export function parseOutput(spec: RunnerSpec, text: string): Parsed | null {
  if (text === '') return null;
  const tail = text.length > 1024 ? text.slice(text.length - 1024) : text;
  const fromTail = spec.parse(tail);
  if (fromTail !== null) return fromTail;
  return text.length > 1024 ? spec.parse(text) : null;
}

/**
 * The generic runner (#23): tries every parser above it in table order, first
 * match wins, and reports which runner's parser matched (`parsedFrom`).
 */
export function parseGeneric(text: string): { parsed: Parsed; parsedFrom: string } | null {
  for (const spec of RUNNERS) {
    if (spec.id === 'generic') continue;
    const parsed = parseOutput(spec, text);
    if (parsed !== null) return { parsed, parsedFrom: spec.id };
  }
  return null;
}

function runnerIs(...ids: readonly string[]): (segment: ShellSegment) => boolean {
  return (segment) => segment.runner !== undefined && ids.includes(segment.runner);
}

/**
 * The §7 table in row order. `bun test` unwraps to `npm-script:test` in S11,
 * so row 8 detects it from the raw segment text and must sit before row 23;
 * rows 13/17/21/22 cover both dialects their §7 row names.
 */
export const RUNNERS: readonly RunnerSpec[] = [
  { id: 'pytest', detect: runnerIs('pytest'), parse: parsePytest },
  { id: 'unittest', detect: runnerIs('unittest'), parse: parseUnittest },
  { id: 'jest', detect: runnerIs('jest'), parse: parseJest },
  { id: 'vitest', detect: runnerIs('vitest'), parse: parseVitest },
  { id: 'mocha', detect: runnerIs('mocha'), parse: parseMocha },
  { id: 'ava', detect: runnerIs('ava'), parse: parseAva },
  { id: 'node-test', detect: runnerIs('node-test'), parse: parseNodeTest },
  { id: 'bun', detect: (s) => s.raw === 'bun test' || s.raw.startsWith('bun test '), parse: parseBun },
  { id: 'playwright', detect: runnerIs('playwright'), parse: parsePlaywright },
  { id: 'cypress', detect: runnerIs('cypress'), parse: parseCypress },
  { id: 'go-test', detect: runnerIs('go-test'), parse: parseGoTest },
  { id: 'cargo-test', detect: runnerIs('cargo-test'), parse: parseCargoTest },
  { id: 'maven', detect: runnerIs('maven', 'gradle'), parse: parseMavenGradle },
  { id: 'dotnet', detect: runnerIs('dotnet'), parse: parseDotnet },
  { id: 'rspec', detect: runnerIs('rspec'), parse: parseRspec },
  { id: 'minitest', detect: runnerIs('minitest'), parse: parseMinitest },
  { id: 'phpunit', detect: runnerIs('phpunit', 'pest'), parse: parsePhpunit },
  { id: 'mix', detect: runnerIs('mix'), parse: parseMix },
  { id: 'ctest', detect: runnerIs('ctest'), parse: parseCtest },
  { id: 'deno', detect: runnerIs('deno-test'), parse: parseDeno },
  { id: 'swift', detect: runnerIs('swift-test', 'xcodebuild'), parse: parseSwift },
  { id: 'flutter', detect: runnerIs('flutter', 'dart-test'), parse: parseFlutter },
  { id: 'generic', detect: detectGeneric, parse: (text) => parseGeneric(text)?.parsed ?? null },
];
