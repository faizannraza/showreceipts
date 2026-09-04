/**
 * The built-in demo scenarios (ARCHITECTURE §14.1, PLAN S23a instruction 3).
 * The four spec scenarios reproduce the §10.2 sample receipts — fixed short
 * ids (`0badf00d`, `00decaf0`, `c0dec0de`, `0cafe000`), tool/file/test-run
 * counts, usage totals that price to `$18.42` / `$41.07` / `≈$0.07` with
 * cache hit 71 % / 84 % / 87 % under the built-in table, and the sample
 * clock anchors (Edit ×3 at 17:31/17:32, Write 18:05, pytest 23:41, ruff
 * 23:44, `git commit → 1fc0c28`). Decision (a): the spec scenarios' finals
 * carry no negated, deferred, excluded or third-party clause, so no ALSO
 * SAID section renders (§10.2); every other scenario's final contains at
 * least one negated claim so ALSO SAID is exercised across the matrix.
 * Every final also contains non-claim prose.
 *
 * All ids, paths and texts are synthetic; nothing here derives from a real
 * session (the S03 forbidden-hash scan covers this directory).
 */
import type { DemoCommand, DemoEdit, DemoSubagent, Scenario } from './dsl.js';

/** `n` filler source edits `src/<stem><i>.<ext>` from minute `from`, `stepMin` apart. */
function fillerEdits(n: number, stem: string, ext: string, from: number, stepMin: number): DemoEdit[] {
  const out: DemoEdit[] = [];
  for (let i = 1; i <= n; i++) out.push({ path: `${stem}${i}.${ext}`, verb: 'update', at: from + i * stepMin });
  return out;
}

/** A green pytest run: `<n> passed in <s>s`, exit 0. */
function pytestGreen(n: number, at: number, seconds: string): DemoCommand {
  return { cmd: 'uv run pytest -q', exit: 0, out: `${n} passed in ${seconds}s`, at };
}

/** The 12 read-only survey subagents of the all-VERIFIED scenario. */
function surveySubagents(): DemoSubagent[] {
  const out: DemoSubagent[] = [];
  for (let i = 1; i <= 12; i++) {
    const commands: DemoCommand[] = [];
    for (let k = 1; k <= 8; k++) {
      commands.push({ cmd: `ls src/wattage/adapters`, exit: 0, out: `adapter${k}.py`, at: 3 + i * 0.5 + k * 0.05 });
    }
    out.push({ description: `survey adapter module ${i}`, commands, edits: [] });
  }
  return out;
}

/**
 * §10.2 sample 1 — CONTRADICTED (Claude Code 2.1.214 / claude-sonnet-5).
 * 212 tool calls, 31 files, 4 test runs, 1 compaction; ruff red at 23:44 and
 * never re-run; pytest 41 passed at 23:41; the test file edited between the
 * two green runs; 3 tmp writes; a committed claim without a git commit.
 * Usage prices to $18.42 with cache hit 8,000,000 / 11,200,000 ≈ 71 %.
 */
const CONTRADICTED: Scenario = {
  name: 'contradicted',
  harness: 'claude-code',
  harnessVersion: '2.1.214',
  model: 'claude-sonnet-5',
  sessionId: '0badf00d-0000-4000-8000-000000000001',
  cwd: '/home/u/proj/wattage',
  branch: 'main',
  startedAt: '2026-07-18T17:14:00Z',
  durationMin: 398, // 17:14 → 23:52
  activeMin: 125, // 2h 05m
  usageProfile: { input: 2_400_000, cacheRead: 8_000_000, cacheWrite5m: 800_000, cacheWrite1h: 0, output: 1_002_000 },
  compactions: 1,
  prompt: 'Normalize the wattage models and wire the CLI tests, then make sure everything is healthy.',
  edits: [
    { path: 'src/wattage/models.py', verb: 'update', at: 17 }, // 17:31
    { path: 'src/wattage/models.py', verb: 'update', at: 17.5 }, // 17:31
    { path: 'src/wattage/models.py', verb: 'update', at: 18 }, // 17:32
    { path: 'tests/test_cli.py', verb: 'create', at: 51 }, // 18:05
    ...fillerEdits(25, 'src/wattage/normalize_', 'py', 60, 8), // last source write at +260
    { path: 'tests/test_normalize.py', verb: 'update', at: 316 }, // between the green runs
    { path: '/tmp/demo-scratch/plan.json', verb: 'create', at: 90 },
    { path: '/tmp/demo-scratch/rows.csv', verb: 'create', at: 91 },
    { path: '/tmp/demo-scratch/notes.txt', verb: 'create', at: 92 },
  ],
  commands: [
    { cmd: 'uv run pytest -q', exit: 1, out: '1 failed, 40 passed in 9.11s', at: 2 },
    { cmd: 'uv run pytest -q', exit: 1, out: '1 failed, 40 passed in 9.40s', at: 20 },
    pytestGreen(41, 166, '12.31'), // 20:00
    pytestGreen(41, 387, '12.31'), // 23:41
    // The tail carries no `Found N errors.` summary line (S23b tuning): the
    // check is red by exit alone, so the evidence stays within its two lines
    // (`ruff check . → exit 1` · `(23:44) · never re-run`).
    { cmd: 'ruff check .', exit: 1, out: 'src/wattage/models.py:12:1: F401 `json` imported but unused', at: 390 }, // 23:44
  ],
  fillerReads: 174, // 33 edits + 5 commands + 174 reads = 212 tool calls
  final:
    'Updated `src/wattage/models.py`. Created `tests/test_cli.py`. All 41 tests pass. Lint is clean. Committed the changes.\n\nThe normalization work took most of the session.',
  expect: { verdict: 'CONTRADICTED', spec: true },
};

/**
 * §10.2 sample 2 — all VERIFIED (Claude Code 2.1.241 / claude-fable-5).
 * 418 tool calls (12 read-only subagents × 8 calls among them), 87 files,
 * 9 test runs, `git commit → 1fc0c28`, pypi.org + api.github.com contacted.
 * Usage prices to $41.07 with cache hit 1,050,000 / 1,250,000 = 84 %.
 */
const VERIFIED: Scenario = {
  name: 'verified',
  harness: 'claude-code',
  harnessVersion: '2.1.241',
  model: 'claude-fable-5',
  sessionId: '00decaf0-0000-4000-8000-000000000002',
  cwd: '/home/u/proj/wattage',
  branch: 'main',
  startedAt: '2026-08-23T23:15:00Z',
  durationMin: 143, // 23:15 → 01:38
  activeMin: 142,
  usageProfile: { input: 150_000, cacheRead: 1_050_000, cacheWrite5m: 50_000, cacheWrite1h: 0, output: 757_900 },
  subagents: surveySubagents(),
  prompt: 'Split the adapters, get the whole gate green and land it.',
  edits: fillerEdits(87, 'src/wattage/adapters/collector_', 'py', 1, 0.125), // writes end ≈ +12
  commands: [
    pytestGreen(311, 3, '38.02'),
    pytestGreen(312, 4, '38.10'),
    pytestGreen(315, 5, '38.44'),
    pytestGreen(320, 6, '39.01'),
    pytestGreen(324, 7, '39.34'),
    pytestGreen(329, 8, '40.00'),
    pytestGreen(333, 9, '40.41'),
    pytestGreen(337, 13, '40.90'),
    pytestGreen(339, 14, '41.09'), // 23:29
    { cmd: 'ruff check .', exit: 0, out: 'All checks passed!', at: 14.2 }, // 23:29
    { cmd: 'mypy --strict src', exit: 0, out: 'Success: no issues found in 87 source files', at: 14.4 },
    {
      cmd: 'git commit -m "wattage: split the adapters"',
      exit: 0,
      out: '[main 1fc0c28] wattage: split the adapters',
      at: 16, // fixed commit time 23:31
      commitSha: '1fc0c2899aa77bb66cc55dd44ee33ff221100abc',
    },
    { cmd: 'pip install -q requests', exit: 0, out: '', at: 17 }, // pypi.org (inferred)
    { cmd: 'gh api repos/u/wattage/pulls', exit: 0, out: '[]', at: 18 }, // api.github.com (inferred)
  ],
  fillerReads: 209, // 87 + 14 + 12 Agent + 96 subagent calls + 209 = 418
  final:
    'All 339 tests pass. Ruff clean. Mypy --strict clean. Committed the changes as `1fc0c28`.\n\nThe adapter split keeps the collectors modular.',
  expect: { verdict: 'VERIFIED', spec: true },
};

/**
 * The §10.2 sample's unobservable notebook write (a python3 heredoc). The
 * target path is computed, so the §4.6.1 interpreter-write inference cannot
 * resolve it — the command stays an *opaque* write ("write not observable"),
 * exactly what the sample shows.
 */
const NOTEBOOK_HEREDOC =
  "python3 - <<'PY'\nimport json, pathlib\nnb = {'cells': [], 'metadata': {}, 'nbformat': 4, 'nbformat_minor': 5}\nstem = 'lea_col_drop_' + 'preview'\npathlib.Path(stem + '.ipynb').write_text(json.dumps(nb))\nPY";

/**
 * §10.2 sample 3 — UNVERIFIED only (Codex 0.98.0 / gpt-5.2-codex).
 * 6 tool calls, 0 files, 0 test runs; the interpreter-heredoc write is not
 * observable; the golden `token_count` totals price to 0.068394 (≈$0.07,
 * cache hit 82,560 / 94,642 ≈ 87 %) with plan usage 1 %.
 */
const UNVERIFIED_CODEX: Scenario = {
  name: 'unverified-codex',
  harness: 'codex',
  harnessVersion: '0.98.0',
  model: 'gpt-5.2-codex',
  sessionId: '01983b6e-4d21-7aa0-8bcd-4242c0dec0de', // UUIDv7 → shortId c0dec0de
  cwd: '/home/u/proj/cyclone', // not the §10.2 project name: that word is on the fixtures' forbidden list
  branch: null,
  startedAt: '2026-02-10T04:56:00Z',
  durationMin: 13.1, // 04:56 → 05:09, rendered duration 13m
  tokenCounts: [{ input: 94_642, cached: 82_560, output: 2_343, ratePct: 1 }],
  prompt: 'Give me a notebook that previews the column drop for the lea table.',
  edits: [],
  commands: [
    { cmd: 'ls', exit: 0, out: 'data\nnotebooks', at: 0.5 },
    { cmd: 'cat notebooks/README.md', exit: 0, out: '# notebooks', at: 1 },
    // The heredoc runs detached (no observable exit): it stays an *opaque*
    // write and — with every other command inspection-free — nothing
    // "exercises the change", so `works as expected` is UNVERIFIED
    // (`no-run-after-write`), matching the §10.2 sample (S23b tuning).
    { cmd: NOTEBOOK_HEREDOC, exit: null, out: '', at: 2 }, // 04:58
    { cmd: 'cat data/columns.txt', exit: 0, out: 'lea_col_a\nlea_col_b', at: 5 },
    { cmd: 'ls notebooks', exit: 0, out: 'lea_col_drop_preview.ipynb', at: 8 },
    // The last write in the log (a metadata-only one, so `filesChanged` stays 0);
    // nothing runs after it, so the verification claim is `no-run-after-write`.
    { cmd: 'mkdir previews', exit: 0, out: '', at: 12.98 },
  ],
  final:
    'Created lea_col_drop_preview.ipynb. It works as expected.\n\nThe preview keeps the numeric columns grouped for review.',
  expect: { verdict: 'UNVERIFIED', spec: true },
};

/**
 * §10.2 sample 4 — NO CLAIMS (hook-captured Cursor 1.9.2 with `postToolUse`
 * exit codes). 9 tool calls, 2 files, 1 test run; a four-sentence final with
 * zero recognisable claims; cost n/a.
 */
const NO_CLAIMS_LEDGER: Scenario = {
  name: 'no-claims-ledger',
  harness: 'ledger',
  ledgerHarness: 'cursor',
  harnessVersion: '1.9.2',
  model: 'gpt-5.6-terra',
  sessionId: '0cafe000-0000-4000-8000-000000000004',
  cwd: '/home/u/proj/api',
  branch: null,
  startedAt: '2026-08-29T10:02:00Z',
  durationMin: 10, // 10:02 → 10:11 (the stop event lands at −0.02; rendered duration 9m)
  prompt: 'Tighten the payload validation on the routes.',
  edits: [
    { path: 'src/routes.ts', verb: 'update', at: 3 },
    { path: 'src/db.ts', verb: 'update', at: 4 },
  ],
  commands: [{ cmd: 'npm test', exit: 0, out: ' Test Files  3 passed (3)\n Tests  12 passed (12)\n Duration  1.42s', at: 7 }], // 10:09
  fillerReads: 6, // 2 + 1 + 6 = 9 tool calls
  final:
    'The route now rejects malformed payloads before the database call. The connection pool comes from the existing config. Rollback behaviour stays the same. Session cookies keep their previous names.',
  expect: { verdict: 'NO_CLAIMS', spec: true },
};

/** A 20-claim receipt (one file-update claim per path) plus one negated claim. */
const TWENTY_CLAIMS: Scenario = {
  name: 'twenty-claims',
  harness: 'claude-code',
  harnessVersion: '2.1.251',
  model: 'claude-fable-5',
  sessionId: '20c1a1e5-0000-4000-8000-000000000005',
  cwd: '/home/u/proj/api',
  branch: 'main',
  startedAt: '2026-06-02T09:00:00Z',
  durationMin: 60,
  prompt: 'Split the router module.',
  edits: fillerEdits(20, 'src/api/m', 'ts', 2, 1),
  commands: [],
  final:
    Array.from({ length: 20 }, (_, i) => `Updated \`src/api/m${i + 1}.ts\`.`).join(' ') +
    "\n\nI haven't run the tests yet.\n\nThe module split mirrors the router layout.",
  expect: { verdict: 'VERIFIED', scoredClaims: 20 },
};

/** A turn that never completes: records, tool calls, no `end_turn` final. */
const NO_FINAL: Scenario = {
  name: 'no-final',
  harness: 'claude-code',
  harnessVersion: '2.1.233',
  model: 'claude-sonnet-5',
  sessionId: 'a0f10000-0000-4000-8000-000000000006',
  cwd: '/home/u/proj/api',
  branch: 'main',
  startedAt: '2026-06-03T12:00:00Z',
  durationMin: 10,
  prompt: 'Refactor the parser.',
  edits: [{ path: 'src/parser.ts', verb: 'update', at: 2 }],
  commands: [{ cmd: 'npm test', exit: 1, out: ' Tests  1 failed | 34 passed (35)', at: 4 }],
  final: null,
  expect: { verdict: 'NO_FINAL' },
};

/** Records but no turns (the 2.1.243 shape): header records only. */
const NO_TURNS: Scenario = {
  name: 'no-turns',
  harness: 'claude-code',
  harnessVersion: '2.1.243',
  model: 'claude-sonnet-5',
  sessionId: 'b0705000-0000-4000-8000-000000000007',
  cwd: '/home/u/proj/api',
  branch: 'main',
  startedAt: '2026-06-04T08:00:00Z',
  durationMin: 1,
  prompt: '',
  edits: [],
  commands: [],
  final: null,
  noTurns: true,
  expect: { verdict: 'NO_TURNS' },
};

/** A Gemini hook-captured ledger session with a verified write + test claim. */
const GEMINI_LEDGER: Scenario = {
  name: 'gemini-ledger',
  harness: 'ledger',
  ledgerHarness: 'gemini',
  harnessVersion: '',
  model: '',
  sessionId: 'demo-gemini-00000008',
  cwd: '/home/u/proj/queue',
  branch: null,
  startedAt: '2026-04-12T09:00:00Z',
  durationMin: 20,
  prompt: 'Fix the dequeue bug.',
  edits: [{ path: 'src/app.py', verb: 'update', at: 0.5 }],
  commands: [{ cmd: 'pytest -q', exit: 0, out: '2 passed in 0.11s', at: 2 }],
  final: "Updated `src/app.py` and the tests pass. I didn't run the linter.\n\nThe fix follows the queue module conventions.",
  expect: { verdict: 'VERIFIED' },
};

/** A green run made stale by a `.skip(`-adding test edit (integrity ⚠). */
const TEST_WEAKENED: Scenario = {
  name: 'test-weakened',
  harness: 'claude-code',
  harnessVersion: '2.1.235',
  model: 'claude-sonnet-5',
  sessionId: 'ea51de00-0000-4000-8000-000000000009',
  cwd: '/home/u/proj/uploader',
  branch: 'main',
  startedAt: '2026-06-05T15:00:00Z',
  durationMin: 12,
  prompt: 'Make the retry logic back off.',
  edits: [
    { path: 'src/retry.ts', verb: 'update', at: 2 },
    { path: 'tests/upload.test.ts', verb: 'update', at: 8, addedLines: ["+  it.skip('flaky upload', () => {"] },
  ],
  commands: [{ cmd: 'npm test', exit: 0, out: ' Tests  12 passed (12)', at: 5 }],
  final: "Tests pass. I haven't run the linter.\n\nThe retry logic now backs off exponentially.",
  expect: { verdict: 'UNVERIFIED' },
};

/** A test claim whose only runs precede the last source write. */
const STALE_RUN: Scenario = {
  name: 'stale-run',
  harness: 'claude-code',
  harnessVersion: '2.1.236',
  model: 'claude-sonnet-5',
  sessionId: '57a1e000-0000-4000-8000-00000000000a',
  cwd: '/home/u/proj/cache',
  branch: 'main',
  startedAt: '2026-06-06T10:00:00Z',
  durationMin: 10,
  apiErrors: 1,
  prompt: 'Warm the cache lazily.',
  edits: [{ path: 'src/core.py', verb: 'update', at: 6 }],
  commands: [pytestGreen(9, 3, '0.61')],
  final: 'Tests pass. Nothing is committed yet.\n\nThe cache warmup stays opt-in.',
  expect: { verdict: 'UNVERIFIED' },
};

/** The echoed sentence (≥ 25 chars) shared by the echoed scenario's prompt and final. */
const ECHOED_SENTENCE = 'The integration tests pass on the staging box.';

/** A would-be contradiction degraded to UNVERIFIED because the user said it first. */
const ECHOED: Scenario = {
  name: 'echoed',
  harness: 'claude-code',
  harnessVersion: '2.1.234',
  model: 'claude-sonnet-5',
  sessionId: 'ec80ed00-0000-4000-8000-00000000000b',
  cwd: '/home/u/proj/export',
  branch: 'main',
  startedAt: '2026-06-07T11:00:00Z',
  durationMin: 15,
  prompt: `${ECHOED_SENTENCE} Please look at the export path.`,
  edits: [{ path: 'src/export.py', verb: 'update', at: 2 }],
  commands: [{ cmd: 'uv run pytest -q', exit: 1, out: '1 failed, 11 passed in 0.90s', at: 5 }],
  final: `${ECHOED_SENTENCE} I haven't re-run the tests.\n\nThe export path handling is untouched apart from logging.`,
  expect: { verdict: 'UNVERIFIED' },
};

/** A refusal-fallback message priced per attempt (§8.3 "fallback iterations"). */
const REFUSAL_FALLBACK: Scenario = {
  name: 'refusal-fallback',
  harness: 'claude-code',
  harnessVersion: '2.1.235',
  model: 'claude-fable-5',
  sessionId: 'ef0ba110-0000-4000-8000-00000000000c',
  cwd: '/home/u/proj/crawler',
  branch: 'main',
  startedAt: '2026-06-08T13:00:00Z',
  durationMin: 30,
  refusalFallback: {
    originalModel: 'claude-fable-5',
    fallbackModel: 'claude-opus-4-8',
    refused: { cacheRead: 684_675, output: 217 },
    at: 5,
  },
  prompt: 'Keep the crawler conservative and green.',
  edits: [{ path: 'src/crawler.py', verb: 'update', at: 2 }],
  commands: [pytestGreen(8, 10, '0.42')],
  final: "All 8 tests pass. I didn't push the branch.\n\nThe crawler config stays conservative.",
  expect: { verdict: 'VERIFIED' },
};

/** A session spanning three calendar days (`sessionSpan` in the header). */
const MULTI_DAY: Scenario = {
  name: 'multi-day',
  harness: 'claude-code',
  harnessVersion: '2.1.241',
  model: 'claude-fable-5',
  sessionId: 'da700000-0000-4000-8000-00000000000d',
  cwd: '/home/u/proj/migrate',
  branch: 'main',
  startedAt: '2026-07-03T22:00:00Z',
  durationMin: 2980, // Jul 3 22:00 → Jul 5 ~23:40 (3 calendar days)
  activeMin: 200,
  prompt: 'Run the long migration in stages.',
  edits: [{ path: 'src/stages.py', verb: 'update', at: 10 }],
  commands: [pytestGreen(5, 2900, '0.30')],
  final: 'All 5 tests pass. Note: I did not commit anything.\n\nThe migration ran in three sittings.',
  expect: { verdict: 'VERIFIED' },
};

/** Every built-in scenario, in a stable order (`demo` iterates this list). */
export const SCENARIOS: readonly Scenario[] = [
  CONTRADICTED,
  VERIFIED,
  UNVERIFIED_CODEX,
  NO_CLAIMS_LEDGER,
  TWENTY_CLAIMS,
  NO_FINAL,
  NO_TURNS,
  GEMINI_LEDGER,
  TEST_WEAKENED,
  STALE_RUN,
  ECHOED,
  REFUSAL_FALLBACK,
  MULTI_DAY,
];

/** The scenario named `name`; throws on an unknown name. */
export function scenarioNamed(name: string): Scenario {
  const s = SCENARIOS.find((x) => x.name === name);
  if (s === undefined) throw new Error(`unknown demo scenario: ${name}`);
  return s;
}
