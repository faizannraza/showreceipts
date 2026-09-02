/**
 * S13 — test runs (§4.6.4, §7): fixture-driven parsing of all 23 runners over
 * `fixtures/runners/` (coloured variants included), the tri-state `green`,
 * snapshot-update runs, the no-`TestRun` conditions and the opaque
 * test-capable counter. Segments come from the real S11 lexer (`tokenize` +
 * `attributeExit`), never hand-assembled.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { attributeExit, tokenize } from '../../../src/ledger/shell/index.js';
import { countOpaqueTestCapable, extractTestRuns } from '../../../src/ledger/tests.js';
import type { CommandFact, TestRun, ToolCall } from '../../../src/model/types.js';

interface IndexEntry {
  file: string;
  runner: string;
  exit: number | null;
  expect: { green: boolean | 'unknown'; parsed: Record<string, unknown> | null; parsedFrom?: string };
}

/** The command line each index.json `runner` key resolves to (§7 detection). */
const COMMANDS: Record<string, string> = {
  pytest: 'pytest',
  unittest: 'python -m unittest',
  jest: 'npx jest',
  vitest: 'npx vitest run',
  mocha: 'npx mocha',
  ava: 'npx ava',
  'node-test': 'node --test',
  bun: 'bun test',
  playwright: 'npx playwright test',
  cypress: 'npx cypress run',
  'go-test': 'go test',
  'cargo-test': 'cargo test',
  maven: 'mvn test',
  dotnet: 'dotnet test',
  rspec: 'rspec',
  minitest: 'rails test',
  phpunit: 'phpunit',
  mix: 'mix test',
  ctest: 'ctest',
  deno: 'deno test',
  swift: 'swift test',
  flutter: 'flutter test',
  generic: 'npm test',
};

const ROW_IDS = Object.keys(COMMANDS);

function fixture(name: string): string {
  return readFileSync(new URL(`../../../fixtures/runners/${name}`, import.meta.url), 'utf8');
}

let seq = 0;

function makeCall(command: string, resultText: string, exit: number | null, over: Partial<ToolCall> = {}): ToolCall {
  seq += 1;
  return {
    seq,
    id: `t${seq}`,
    tool: 'Bash',
    kind: 'shell',
    agentId: null,
    turnIndex: 0,
    cwd: '/home/u/proj',
    input: {},
    command,
    resultText,
    resultBytes: resultText.length,
    isError: false,
    exitCode: exit,
    exitCodeSource: exit === null ? 'unknown' : 'harness',
    interrupted: false,
    background: false,
    startedAt: '2026-03-01T00:00:00Z',
    endedAt: null,
    filesTouched: [],
    ...over,
  };
}

/** Builds a `CommandFact` the way the pipeline does (S11 lexer + attribution). */
function factOf(call: ToolCall): CommandFact {
  const parse = tokenize(call.command ?? '', call.cwd, { home: '/home/u' });
  attributeExit(parse, call.exitCode, call.exitCodeSource, call.resultText);
  const fact: CommandFact = {
    seq: call.seq,
    toolCallId: call.id,
    agentId: call.agentId,
    raw: call.command ?? '',
    segments: parse.segments,
    exitCode: call.exitCode,
    exitCodeSource: call.exitCodeSource,
    chained: parse.chained,
    background: call.background || parse.background,
    interrupted: call.interrupted,
  };
  if (parse.segments.some((s) => s.mayRunTests === true)) fact.mayRunTests = true;
  return fact;
}

function runOn(command: string, resultText: string, exit: number | null, over: Partial<ToolCall> = {}): { runs: TestRun[]; call: ToolCall } {
  const call = makeCall(command, resultText, exit, over);
  const runs = extractTestRuns([factOf(call)], [call]);
  return { runs, call };
}

const index = JSON.parse(fixture('index.json')) as IndexEntry[];

describe('fixtures/runners (§7 table)', () => {
  it('has a green and a red fixture for all 23 runners', () => {
    for (const id of ROW_IDS) {
      expect(index.some((e) => e.file === `${id}-green.txt`), `${id}-green`).toBe(true);
      expect(index.some((e) => e.file === `${id}-red.txt`), `${id}-red`).toBe(true);
    }
  });

  for (const entry of index) {
    it(entry.file, () => {
      const command = COMMANDS[entry.runner];
      expect(command, `unknown runner key ${entry.runner}`).toBeDefined();
      const { runs, call } = runOn(command as string, fixture(entry.file), entry.exit);
      expect(runs).toHaveLength(1);
      const run = runs[0] as TestRun;
      expect(run.green).toBe(entry.expect.green);
      if (entry.expect.parsed === null) {
        expect(run.parsed).toBeUndefined();
      } else {
        expect(run.parsed).toMatchObject(entry.expect.parsed);
        expect(call.parsed).toBe(run.parsed);
      }
      if (entry.expect.parsedFrom !== undefined) {
        expect(run.parsedFrom).toBe(entry.expect.parsedFrom);
        expect(call.parsedFrom).toBe(entry.expect.parsedFrom);
      }
    });
  }

  it('vitest file-load failure notes the broken test file', () => {
    const { runs } = runOn('npx vitest run', fixture('vitest-filefail.txt'), 1);
    expect(runs[0]?.green).toBe(false);
    expect(runs[0]?.note).toBe('test file failed to load');
  });

  it('a coloured vitest tail parses identically to the plain one', () => {
    const plain = runOn('npx vitest run', ' Test Files  1 passed (1)\n      Tests  136 passed (136)\n', 0);
    const colour = runOn('npx vitest run', fixture('vitest-color.txt'), 0);
    expect(colour.runs[0]?.parsed).toEqual(plain.runs[0]?.parsed);
    expect(colour.runs[0]?.green).toBe(true);
  });
});

describe('remaining §7 dialects', () => {
  it('gradle counts + BUILD SUCCESSFUL parse via the maven row', () => {
    const { runs } = runOn('gradle test', '42 tests completed, 0 failed\nBUILD SUCCESSFUL in 10s\n', 0);
    expect(runs[0]?.runner).toBe('gradle');
    expect(runs[0]?.parsedFrom).toBe('maven');
    expect(runs[0]?.parsed).toMatchObject({ total: 42, failed: 0, passed: 42 });
    expect(runs[0]?.green).toBe(true);
  });

  it('gradle BUILD FAILED without test failures is red via errors', () => {
    const { runs } = runOn('gradle test', '12 tests completed, 0 failed\nBUILD FAILED in 3s\n', 1);
    expect(runs[0]?.parsed).toMatchObject({ total: 12, failed: 0, errors: 1 });
    expect(runs[0]?.green).toBe(false);
  });

  it('cargo nextest Summary parses', () => {
    const { runs } = runOn('cargo nextest run', 'Summary [   0.351s] 128 tests run: 128 passed, 0 skipped\n', 0);
    expect(runs[0]?.parsed).toMatchObject({ total: 128, passed: 128, failed: 0 });
    expect(runs[0]?.green).toBe(true);
  });

  it('dotnet `Total tests:` block parses', () => {
    const { runs } = runOn('dotnet test', 'Total tests: 12\n Passed: 10\n Failed: 2\n Skipped: 0\n', 1);
    expect(runs[0]?.parsed).toMatchObject({ total: 12, passed: 10, failed: 2 });
    expect(runs[0]?.green).toBe(false);
  });

  it('pest summary parses via the phpunit row', () => {
    const { runs } = runOn('pest', '  Tests:    1 failed, 21 passed (42 assertions)\n', 1);
    expect(runs[0]?.parsedFrom).toBe('phpunit');
    expect(runs[0]?.parsed).toMatchObject({ failed: 1, passed: 21, total: 22 });
  });

  it('pytest `no tests ran` is total 0, not green', () => {
    const { runs } = runOn('pytest -q', '============ no tests ran in 0.01s ============\n', 5);
    expect(runs[0]?.parsed).toMatchObject({ total: 0 });
    expect(runs[0]?.green).toBe(false);
  });

  it('xcodebuild ** TEST FAILED ** without counts is red', () => {
    const { runs } = runOn('xcodebuild test', '** TEST FAILED **\n', 65);
    expect(runs[0]?.parsedFrom).toBe('swift');
    expect(runs[0]?.green).toBe(false);
  });

  it('tox output is parsed by the generic chain (pytest wins)', () => {
    const { runs } = runOn('tox', '=== 3 passed in 0.10s ===\n', 0);
    expect(runs[0]?.parsedFrom).toBe('pytest');
    expect(runs[0]?.green).toBe(true);
  });

  it('make test printing pytest output parses via the generic chain', () => {
    const { runs, call } = runOn('make test', '=== 3 passed in 0.02s ===\n', 0);
    expect(runs[0]?.runner).toBe('make:test');
    expect(runs[0]?.parsedFrom).toBe('pytest');
    expect(call.parsedFrom).toBe('pytest');
    expect(runs[0]?.green).toBe(true);
  });

  it('vitest todo and skipped tokens fold into skipped', () => {
    const { runs } = runOn('npx vitest run', '      Tests  1 todo | 2 skipped | 5 passed (8)\n', 0);
    expect(runs[0]?.parsed).toMatchObject({ passed: 5, skipped: 3, total: 8 });
    expect(runs[0]?.green).toBe(true);
  });
});

describe('tri-state green (§4.6.4)', () => {
  it('suppressed pipeline with a parsed all-pass tail is green from the parse', () => {
    const { runs } = runOn('pytest -q | tail -5', '20 passed in 0.18s\n', 0);
    const run = runs[0] as TestRun;
    expect(run.green).toBe(true);
    expect(run.exitCode).toBeNull();
    expect(run.exitCodeSource).toBe('parsed');
    expect(run.truncated).toBe(true);
    expect(run.conclusive).toBe(true);
  });

  it('suppressed pipeline with no summary is unknown', () => {
    const { runs } = runOn('pytest -q | tail -5', 'nothing that parses\n', 0);
    const run = runs[0] as TestRun;
    expect(run.green).toBe('unknown');
    expect(run.conclusive).toBe(false);
    expect(run.note).toBe('output suppressed, no result line');
  });

  it('a stdout redirect suppresses the result line', () => {
    const { runs } = runOn('pytest -q > out.txt', '', 0);
    expect(runs[0]?.green).toBe('unknown');
    expect(runs[0]?.note).toBe('output suppressed, no result line');
  });

  it('single-segment unpiped exit 0 without a result line is green but inconclusive', () => {
    const { runs } = runOn('pytest -q', 'collected quietly\n', 0);
    const run = runs[0] as TestRun;
    expect(run.green).toBe(true);
    expect(run.conclusive).toBe(false);
    expect(run.note).toBe('exit 0, no result line');
  });

  it('a multi-segment chain without a result line is unknown even on exit 0', () => {
    const { runs } = runOn('cd pkg && pytest -q', '', 0);
    expect(runs[0]?.green).toBe('unknown');
    expect(runs[0]?.note).toBe('exit unknown');
  });

  it('an unknown exit without a result line is unknown', () => {
    const { runs } = runOn('pytest -q', '', null);
    expect(runs[0]?.green).toBe('unknown');
    expect(runs[0]?.note).toBe('exit unknown');
  });

  it('a non-zero exit without a parse is red', () => {
    const { runs } = runOn('pytest -q', 'boom\n', 1);
    expect(runs[0]?.green).toBe(false);
  });

  it('a non-zero exit is never green, even with a parsed all-pass line', () => {
    const { runs } = runOn('pytest -q', '=== 5 passed in 0.10s ===\n', 1);
    expect(runs[0]?.parsed).toMatchObject({ passed: 5 });
    expect(runs[0]?.green).toBe(false);
  });

  it('a terminated call (exit −1 → null) is never green, even parsed', () => {
    const { runs } = runOn('pytest -q', '5 passed in 0.10s\n', null, { terminated: true });
    expect(runs[0]?.green).toBe('unknown');
    expect(runs[0]?.note).toBe('exit unknown');
  });

  it('persisted-truncated output without a parse is unknown and truncated', () => {
    const { runs } = runOn('pytest -q', 'giant output elided', 0, { truncated: 'persisted' });
    const run = runs[0] as TestRun;
    expect(run.green).toBe('unknown');
    expect(run.truncated).toBe(true);
    expect(run.note).toBe('output suppressed, no result line');
  });

  it('a total-0 parse on exit 0 is not green', () => {
    const { runs } = runOn('npx vitest run', 'No test files found, exiting with code 1\n', 0);
    expect(runs[0]?.green).toBe(false);
    expect(runs[0]?.note).toBe('no tests ran');
  });

  it('a snapshot-update run is never evidence', () => {
    const { runs } = runOn('npx vitest run -u', '      Tests  12 passed (12)\n', 0);
    const run = runs[0] as TestRun;
    expect(run.kind).toBe('snapshot-update');
    expect(run.green).toBe(false);
    expect(run.note).toBe('snapshot update run (not evidence)');
  });

  it('scope and targets come from the S11 test scope', () => {
    const { runs } = runOn('pytest tests/test_a.py::test_x -q', '=== 1 passed in 0.01s ===\n', 0);
    expect(runs[0]?.scope).toBe('subset');
    expect(runs[0]?.targets).toEqual(['tests/test_a.py::test_x']);
  });

  it('the cwd-reset trailer and Codex truncation markers are stripped before parsing', () => {
    const trailer = runOn('pytest -q', '=== 2 passed in 0.03s ===\nShell cwd was reset to /home/u/proj', 0);
    expect(trailer.runs[0]?.parsed).toMatchObject({ passed: 2 });
    const marker = runOn('pytest -q', '…120 tokens truncated…\n=== 2 passed in 0.03s ===\n', 0);
    expect(marker.runs[0]?.parsed).toMatchObject({ passed: 2 });
  });

  it('a fact without its call falls back to exit-only judgement', () => {
    const call = makeCall('pytest -q', '=== 2 passed in 0.03s ===\n', 0);
    const runs = extractTestRuns([factOf(call)], []);
    expect(runs[0]?.green).toBe(true);
    expect(runs[0]?.note).toBe('exit 0, no result line');
  });
});

describe('no TestRun at all (§4.6.4)', () => {
  it('background commands create no TestRun', () => {
    expect(runOn('npm test &', '', null).runs).toHaveLength(0);
    expect(runOn('npm test', '', null, { background: true }).runs).toHaveLength(0);
  });

  it('timed-out, denied and interrupted calls create no TestRun', () => {
    expect(runOn('pytest -q', '', null, { timedOutAfterMs: 120000 }).runs).toHaveLength(0);
    expect(runOn('pytest -q', 'blocked', null, { denied: 'permission-rule' }).runs).toHaveLength(0);
    expect(runOn('pytest -q', '', null, { interrupted: true }).runs).toHaveLength(0);
  });

  it('a short-circuited test segment creates no TestRun', () => {
    const { runs } = runOn('npx tsc --noEmit && pytest -q', 'src/a.ts(1,1): error TS2322: bad type\n', 2);
    expect(runs).toHaveLength(0);
  });
});

describe('countOpaqueTestCapable (§4.6.4)', () => {
  it('counts mayRunTests commands without a parseable test segment', () => {
    const script = makeCall('./scripts/run_tests.sh', 'did things\n', 0);
    const pytest = makeCall('pytest -q', '=== 1 passed in 0.01s ===\n', 0);
    const facts = [factOf(script), factOf(pytest)];
    expect(countOpaqueTestCapable(facts)).toBe(1);
    expect(extractTestRuns(facts, [script, pytest]).map((r) => r.runner)).toEqual(['pytest']);
  });
});
