/**
 * Test-file, doc and fixture classifiers (§4.6.3, §4.6.1, §4.6.7). Pure
 * string predicates over logged paths — no `node:fs`, nothing environmental.
 * This is the single classifier both the writes extractor (S12) and the
 * integrity scanner (S13) import; keep the patterns anchored so directory
 * names like `latest/` and basenames like `contest.py` never match.
 */

/** `(^|/)(tests?|specs?|__tests__|__snapshots__|e2e|integration)/` — anchored to a whole path segment. */
const TEST_DIR_RE = /(^|\/)(tests?|specs?|__tests__|__snapshots__|e2e|integration)\//;

/** Basename patterns from §4.6.3, in table order. */
const TEST_BASENAME_RES: readonly RegExp[] = [
  /(\.|_|-)(test|spec)s?\.[a-z]+$/,
  /^test_.*\.py$/,
  /_test\.(go|rs|py|ts|js|tsx)$/,
  /Tests?\.(swift|cs|kt|java|scala)$/,
  /_spec\.rb$/,
  /^conftest\.py$/,
  /\.snap$/,
  /\.golden(\..*)?$/,
];

/** Doc extensions (`*.md *.mdx *.rst *.txt *.adoc *.example *.sample`). */
const DOC_EXT_RE = /\.(md|mdx|rst|txt|adoc|example|sample)$/;

/** `LICENSE*`, `CHANGELOG*`, `NOTICE*` basenames. */
const DOC_BASENAME_RE = /^(LICENSE|CHANGELOG|NOTICE)/;

/** `docs/**` — anchored to a whole path segment. */
const DOC_DIR_RE = /(^|\/)docs\//;

/** `fixtures/**` and `__snapshots__/**` — anchored to a whole path segment. */
const FIXTURE_DIR_RE = /(^|\/)(fixtures|__snapshots__)\//;

/** POSIX form of a logged path (backslashes folded; no other normalisation). */
function posixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** The last path segment (a trailing slash is ignored). */
function base(p: string): string {
  const path = p.endsWith('/') ? p.slice(0, -1) : p;
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

/**
 * True when `path` is a test file per §4.6.3: it lives under an anchored test
 * directory (`tests/`, `specs/`, `__tests__/`, `__snapshots__/`, `e2e/`,
 * `integration/`) or its basename matches a test-file convention
 * (`x.test.ts`, `x_spec.rb`, `test_x.py`, `x_test.go`, `FooTests.swift`,
 * `conftest.py`, `*.snap`, `*.golden`).
 */
export function isTestFile(path: string): boolean {
  const p = posixPath(path);
  if (TEST_DIR_RE.test(p)) return true;
  const b = base(p);
  return TEST_BASENAME_RES.some((re) => re.test(b));
}

/**
 * True when `path` is documentation per §4.6.1: `*.md *.mdx *.rst *.txt
 * *.adoc *.example *.sample`, `LICENSE*`/`CHANGELOG*`/`NOTICE*` basenames,
 * or anything under a `docs/` segment.
 */
export function isDoc(path: string): boolean {
  const p = posixPath(path);
  if (DOC_DIR_RE.test(p)) return true;
  const b = base(p);
  return DOC_EXT_RE.test(b) || DOC_BASENAME_RE.test(b);
}

/**
 * True when `path` is a fixture, snapshot or golden file per §4.6.7
 * (`fixtures/**`, `__snapshots__/**`, `*.snap`, `*.golden[.*]`) — edits to
 * these after the last green run are `fixture-changed-after-green`
 * (informational), never `test-weakened`.
 */
export function isFixtureFile(path: string): boolean {
  const p = posixPath(path);
  if (FIXTURE_DIR_RE.test(p)) return true;
  const b = base(p);
  return /\.snap$/.test(b) || /\.golden(\..*)?$/.test(b);
}
