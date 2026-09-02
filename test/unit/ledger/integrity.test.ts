/**
 * S13 — integrity signals (§4.6.7): a positive and a negative case for each
 * of the six signals, built from synthetic `WriteFact`s joined to calls
 * carrying `patch` lines plus `TestRun`s.
 */
import { describe, expect, it } from 'vitest';
import { extractIntegrity } from '../../../src/ledger/integrity.js';
import type { IntegritySignal, TestRun, ToolCall, WriteFact } from '../../../src/model/types.js';

function write(seq: number, path: string, over: Partial<WriteFact> = {}): WriteFact {
  return {
    seq,
    toolCallId: `t${seq}`,
    agentId: null,
    path,
    display: path,
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

function patchCall(id: string, added: string[], removed: string[]): ToolCall {
  return {
    seq: 0,
    id,
    tool: 'Edit',
    kind: 'edit',
    agentId: null,
    turnIndex: 0,
    cwd: '/home/u/proj',
    input: {},
    resultText: '',
    resultBytes: 0,
    isError: false,
    exitCode: null,
    exitCodeSource: 'unknown',
    interrupted: false,
    background: false,
    startedAt: '2026-03-01T00:00:00Z',
    endedAt: null,
    filesTouched: [],
    patch: { added, removed, hunks: 1 },
  };
}

function run(seq: number, over: Partial<TestRun> = {}): TestRun {
  return {
    seq,
    toolCallId: `t${seq}`,
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
    parsed: { passed: 10, failed: 0, total: 10 },
    ...over,
  };
}

function kinds(signals: IntegritySignal[]): string[] {
  return signals.map((s) => s.kind);
}

describe('test-file-edited-after-green (§4.6.7c)', () => {
  it('flags a test-file write after the last green run', () => {
    const signals = extractIntegrity([write(7, 'tests/test_api.py')], [], [run(5)]);
    expect(signals).toEqual([
      {
        seq: 7,
        kind: 'test-file-edited-after-green',
        path: 'tests/test_api.py',
        detail: 'tests/test_api.py edited after the last green run (not re-run)',
      },
    ]);
  });

  it('does not flag edits before the last green run, non-test files, or failed writes', () => {
    expect(extractIntegrity([write(3, 'tests/test_api.py')], [], [run(5)])).toEqual([]);
    expect(extractIntegrity([write(7, 'src/api.py')], [], [run(5)])).toEqual([]);
    expect(extractIntegrity([write(7, 'tests/test_api.py', { status: 'failed' })], [], [run(5)])).toEqual([]);
    expect(extractIntegrity([write(7, 'tests/test_api.py', { metadataOnly: true })], [], [run(5)])).toEqual([]);
  });

  it('needs a green run — red or unknown runs never anchor the signal', () => {
    expect(extractIntegrity([write(7, 'tests/test_api.py')], [], [run(5, { green: false })])).toEqual([]);
    expect(extractIntegrity([write(7, 'tests/test_api.py')], [], [run(5, { green: 'unknown' })])).toEqual([]);
  });

  it('honours the precomputed isTestFile flag from S12', () => {
    const signals = extractIntegrity([write(7, 'checks/regression.py', { isTestFile: true })], [], [run(5)]);
    expect(kinds(signals)).toEqual(['test-file-edited-after-green']);
  });
});

describe('skip-added / only-added (§4.6.7b)', () => {
  it('flags an added .skip and an added .only separately', () => {
    const calls = [patchCall('t2', ['  it.skip("parses", () => {', '  describe.only("api", () => {'], [])];
    const signals = extractIntegrity([write(2, 'src/app.test.ts')], calls, []);
    expect(kinds(signals).sort()).toEqual(['only-added', 'skip-added']);
    expect(signals[0]?.detail).toContain('added in src/app.test.ts');
  });

  it('flags xit as skip and fdescribe as only', () => {
    const calls = [patchCall('t2', ['xit("a", () => {})', 'fdescribe("b", () => {})'], [])];
    expect(kinds(extractIntegrity([write(2, 'src/app.test.ts')], calls, []).filter((s) => s.kind !== 'test-file-edited-after-green')).sort()).toEqual([
      'only-added',
      'skip-added',
    ]);
  });

  it('flags pytest, unittest, rust, go and java markers', () => {
    const lines = [
      '@pytest.mark.skip(reason="flaky")',
      '@unittest.expectedFailure',
      '#[ignore]',
      't.Skipf("no docker")',
      '@Disabled',
      'self.skipTest("later")',
    ];
    for (const line of lines) {
      const signals = extractIntegrity([write(2, 'tests/test_x.py')], [patchCall('t2', [line], [])], []);
      expect(kinds(signals), line).toEqual(['skip-added']);
    }
  });

  it('a marker moved within the same patch is not an addition', () => {
    const calls = [patchCall('t2', ['  it.skip("parses", () => {'], ['it.skip("parses", function () {'])];
    expect(extractIntegrity([write(2, 'src/app.test.ts')], calls, [])).toEqual([]);
  });

  it('conditional skips are informational, never signals', () => {
    const calls = [
      patchCall('t2', ['@pytest.mark.skipif(sys.platform == "win32", reason="posix only")', 'x = importorskip("numpy")', '@unittest.skipUnless(has_db, "db")'], []),
    ];
    expect(extractIntegrity([write(2, 'tests/test_x.py')], calls, [])).toEqual([]);
  });

  it('markers in non-test files are not scanned', () => {
    const calls = [patchCall('t2', ['it.skip("demo", () => {'], [])];
    expect(extractIntegrity([write(2, 'src/app.ts')], calls, [])).toEqual([]);
  });
});

describe('assertion-removed (§4.6.7a)', () => {
  it('flags a net removal of assertions', () => {
    const calls = [
      patchCall('t2', ['  const x = 1;'], ['  expect(mask(home)).toBe("~");', '  assert result == 5', '  assertEqual(a, b)']),
    ];
    const signals = extractIntegrity([write(2, 'tests/test_mask.py')], calls, []);
    expect(signals).toEqual([
      { seq: 2, kind: 'assertion-removed', path: 'tests/test_mask.py', detail: '3 assertions removed in tests/test_mask.py' },
    ]);
  });

  it('adding 2 and removing 2 is no signal (net only)', () => {
    const calls = [
      patchCall('t2', ['expect(a).toBe(1)', 'assert b == 2'], ['expect(c).toBe(3)', 'assert d == 4']),
    ];
    expect(extractIntegrity([write(2, 'tests/test_mask.py')], calls, [])).toEqual([]);
  });

  it('import/comment lines never count as assertions', () => {
    const calls = [
      patchCall('t2', [], ['import assert from "node:assert";', 'from asserts import assert_all', '// expect(a).toBe(1)', '# assert legacy', '* assert doc']),
    ];
    expect(extractIntegrity([write(2, 'tests/test_mask.py')], calls, [])).toEqual([]);
  });

  it('rust and go assertion macros count', () => {
    const calls = [patchCall('t2', [], ['assert_eq!(a, b);', 't.Errorf("got %v", got)'])];
    const signals = extractIntegrity([write(2, 'src/lib_test.rs')], calls, []);
    expect(signals[0]?.detail).toBe('2 assertions removed in src/lib_test.rs');
  });
});

describe('test-count-dropped (§4.6.7d)', () => {
  const before = run(2, { parsed: { passed: 100, failed: 0, total: 100 } });
  const after = run(6, { parsed: { passed: 90, failed: 0, total: 90 } });

  it('flags a dropped total across a test-file edit', () => {
    const signals = extractIntegrity([write(4, 'tests/test_api.py')], [], [before, after]);
    expect(signals.filter((s) => s.kind === 'test-count-dropped')).toEqual([
      { seq: 6, kind: 'test-count-dropped', detail: 'test count dropped from 100 to 90 (pytest)' },
    ]);
  });

  it('no signal without a test-file edit in between', () => {
    expect(kinds(extractIntegrity([], [], [before, after]))).toEqual([]);
    expect(kinds(extractIntegrity([write(1, 'tests/test_api.py')], [], [before, after]))).toEqual([]);
  });

  it('a drop explained by failures/errors (an -x stop) is no signal', () => {
    const stopped = run(6, { green: false, parsed: { passed: 89, failed: 1, total: 90 } });
    expect(kinds(extractIntegrity([write(4, 'tests/test_api.py')], [], [before, stopped]))).not.toContain('test-count-dropped');
  });

  it('only consecutive full parsed runs of the same runner compare', () => {
    const subset = run(6, { scope: 'subset', targets: ['tests/test_api.py'], parsed: { passed: 5, failed: 0, total: 5 } });
    expect(kinds(extractIntegrity([write(4, 'tests/test_api.py')], [], [before, subset]))).not.toContain('test-count-dropped');
    const otherRunner = run(6, { runner: 'vitest', parsed: { passed: 9, failed: 0, total: 9 } });
    expect(kinds(extractIntegrity([write(4, 'tests/test_api.py')], [], [before, otherRunner]))).not.toContain('test-count-dropped');
    const unparsed = run(6, {});
    delete (unparsed as { parsed?: TestRun['parsed'] }).parsed;
    expect(kinds(extractIntegrity([write(4, 'tests/test_api.py')], [], [before, unparsed]))).not.toContain('test-count-dropped');
    const snapshot = run(6, { kind: 'snapshot-update', parsed: { passed: 9, failed: 0, total: 9 } });
    expect(kinds(extractIntegrity([write(4, 'tests/test_api.py')], [], [before, snapshot]))).not.toContain('test-count-dropped');
  });
});

describe('test-file-deleted (§4.6.7)', () => {
  it('flags an ok delete of a test file', () => {
    const signals = extractIntegrity([write(3, 'tests/test_old.py', { verb: 'delete', source: 'shell-inferred' })], [], []);
    expect(signals).toEqual([{ seq: 3, kind: 'test-file-deleted', path: 'tests/test_old.py', detail: 'deleted tests/test_old.py' }]);
  });

  it('non-test deletes and failed deletes are no signal', () => {
    expect(extractIntegrity([write(3, 'src/old.py', { verb: 'delete' })], [], [])).toEqual([]);
    expect(extractIntegrity([write(3, 'tests/test_old.py', { verb: 'delete', status: 'unknown' })], [], [])).toEqual([]);
  });

  it('a delete counts as the edit between runs for count drops', () => {
    const before = run(2, { parsed: { passed: 100, failed: 0, total: 100 } });
    const after = run(6, { parsed: { passed: 90, failed: 0, total: 90 } });
    const signals = extractIntegrity([write(4, 'tests/test_old.py', { verb: 'delete' })], [], [before, after]);
    expect(kinds(signals)).toEqual(['test-file-deleted', 'test-count-dropped']);
  });
});

describe('output ordering and joins', () => {
  it('signals are sorted by seq across kinds', () => {
    const calls = [patchCall('t9', ['it.only("x", () => {'], [])];
    const signals = extractIntegrity(
      [write(9, 'src/a.test.ts'), write(3, 'tests/test_b.py', { verb: 'delete' })],
      calls,
      [run(5)],
    );
    expect(signals.map((s) => s.seq)).toEqual([3, 9, 9]);
    expect(kinds(signals)).toEqual(['test-file-deleted', 'test-file-edited-after-green', 'only-added']);
  });

  it('a write without a patch yields no marker or assertion signals', () => {
    const signals = extractIntegrity([write(7, 'tests/test_api.py')], [], [run(5)]);
    expect(kinds(signals)).toEqual(['test-file-edited-after-green']);
  });
});
