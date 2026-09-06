import { describe, expect, it } from 'vitest';
import { attributeExit, tokenize } from '../../../../src/ledger/shell/index.js';
import type { ShellParse } from '../../../../src/ledger/shell/index.js';

const cwd = '/home/u/proj';
const opts = { home: '/home/u' };

function parse(raw: string, exit: number | null, output?: string): ShellParse {
  const p = tokenize(raw, cwd, opts);
  attributeExit(p, exit, 'harness', output);
  return p;
}

describe('pipeline sink rule (§4.5.5, takes precedence)', () => {
  it('uv run pytest -q 2>&1 | tail -40 with exit 0', () => {
    const p = parse('uv run pytest -q 2>&1 | tail -40', 0);
    const pytest = p.segments.find((s) => s.program === 'pytest');
    expect(pytest?.family).toBe('test');
    expect(pytest?.runner).toBe('pytest');
    expect(pytest?.suppressed).toBe(true);
    expect(pytest?.exitCode).toBeNull();
    expect(pytest?.exitCodeSource).toBe('sink');
    const tail = p.segments.find((s) => s.program === 'tail');
    expect(tail?.exitCode).toBe(0);
    expect(tail?.exitCodeSource).toBe('harness');
  });

  it('the same after set -o pipefail; gives pytest exit 0 harness', () => {
    const p = parse('set -o pipefail; uv run pytest -q 2>&1 | tail -40', 0);
    expect(p.pipefail).toBe(true);
    const pytest = p.segments.find((s) => s.program === 'pytest');
    expect(pytest?.suppressed).toBe(false);
    expect(pytest?.exitCode).toBe(0);
    expect(pytest?.exitCodeSource).toBe('harness');
  });

  it('a failing sink pipe gives the exit to the sink, not the runner', () => {
    const p = parse('npm test 2>&1 | tail -40', 1);
    const test = p.segments.find((s) => s.program === 'npm-script:test');
    expect(test?.exitCode).toBeNull();
    expect(test?.exitCodeSource).toBe('sink');
    expect(p.segments.find((s) => s.program === 'tail')?.exitCode).toBe(1);
  });

  it('> file suppresses output but keeps the exit', () => {
    const p = parse('pytest -q > out.txt', 0);
    expect(p.segments[0]?.suppressed).toBe(true);
    expect(p.segments[0]?.exitCode).toBe(0);
    expect(p.segments[0]?.exitCodeSource).toBe('harness');
  });

  it('a pipe into a non-sink leaves the head unknown', () => {
    const p = parse('pytest -q | python3 analyze.py', 0);
    const pytest = p.segments.find((s) => s.program === 'pytest');
    expect(pytest?.suppressed).toBe(false);
    expect(pytest?.exitCode).toBeNull();
    expect(pytest?.exitCodeSource).toBe('unknown');
  });
});

describe('&& chains (§4.5.5)', () => {
  it('exit 0 propagates 0 to every segment', () => {
    const p = parse('cd site && npm run build && cd .. && npm test', 0);
    expect(p.segments).toHaveLength(4);
    expect(p.segments.map((s) => s.exitCode)).toEqual([0, 0, 0, 0]);
    expect(p.segments.map((s) => s.ran)).toEqual([true, true, true, true]);
  });

  it('exit 1 with error TS2322 pins the build segment; npm test is short-circuited', () => {
    const p = parse('cd site && npm run build && cd .. && npm test', 1, 'src/x.ts(3,1): error TS2322: Type mismatch.');
    const [cd1, build, cd2, test] = p.segments;
    expect(build?.program).toBe('npm-script:build');
    expect(build?.exitCode).toBe(1);
    expect(build?.exitCodeSource).toBe('parsed');
    expect(cd1?.exitCode).toBe(0);
    expect(cd1?.exitCodeSource).toBe('backfilled');
    expect(cd2?.ran).toBe(false);
    expect(cd2?.exitCode).toBeNull();
    expect(test?.ran).toBe('short-circuited');
    expect(test?.exitCode).toBeNull();
  });

  it('an eslint signature pins the lint segment', () => {
    const p = parse('npm run lint && npm test', 1, '✖ 3 problems (3 errors, 0 warnings)');
    const lint = p.segments.find((s) => s.program === 'npm-script:lint');
    expect(lint?.exitCode).toBe(1);
    expect(lint?.exitCodeSource).toBe('parsed');
    expect(p.segments.find((s) => s.program === 'npm-script:test')?.ran).toBe('short-circuited');
  });

  it('a mypy signature pins the type segment', () => {
    const p = parse('uv run mypy src && uv run pytest', 1, 'Found 2 errors in 1 file (checked 34 source files)');
    const mypy = p.segments.find((s) => s.program === 'mypy');
    expect(mypy?.exitCode).toBe(1);
    expect(p.segments.find((s) => s.program === 'pytest')?.ran).toBe('short-circuited');
  });

  it('exit 1 with no signature fabricates nothing: exits unknown, the test segment short-circuited', () => {
    const p = parse('echo start && npm test', 1);
    expect(p.segments[0]?.exitCode).toBeNull();
    expect(p.segments[0]?.exitCodeSource).toBe('unknown');
    expect(p.segments[0]?.ran).toBe(true);
    expect(p.segments[1]?.exitCode).toBeNull();
    expect(p.segments[1]?.ran).toBe('short-circuited');
  });

  it('a single-unit non-zero exit still belongs to that unit', () => {
    const p = parse('npm test', 1);
    expect(p.segments[0]?.exitCode).toBe(1);
    expect(p.segments[0]?.exitCodeSource).toBe('harness');
    expect(p.segments[0]?.ran).toBe(true);
  });
});

describe('no-signature failing chains fabricate nothing (§4.5.5, Pass-1 regression)', () => {
  it('bash scripts/build.sh && npx vitest run failing at the build: vitest did not run', () => {
    const p = parse('bash scripts/build.sh && npx vitest run', 127, "build failed: missing dependency 'esbuild'");
    const build = p.segments[0];
    const vitest = p.segments.find((s) => s.family === 'test');
    // The first unit definitely ran (the shell executed it), but its exit is
    // unknown — never a fabricated `exit 0 (chained)`.
    expect(build?.ran).toBe(true);
    expect(build?.exitCode).toBeNull();
    expect(build?.exitCodeSource).toBe('unknown');
    // The trailing runner has no parsed output: it never started.
    expect(vitest?.ran).toBe('short-circuited');
    expect(vitest?.exitCode).toBeNull();
  });

  it('a parsed red result in the output proves the test segment ran', () => {
    const p = parse('bash scripts/build.sh && npx vitest run', 1, 'Test Files  1 failed (1)\n     Tests  2 failed | 3 passed (5)');
    const vitest = p.segments.find((s) => s.family === 'test');
    expect(vitest?.ran).toBe(true);
    expect(vitest?.exitCode).toBeNull();
    expect(vitest?.exitCodeSource).toBe('unknown');
  });

  it('a leading green run whose cleanup step failed keeps the run alive with an unknown exit', () => {
    const p = parse('npx vitest run && bash scripts/cleanup.sh', 1, 'Test Files  1 passed (1)\n     Tests  3 passed (3)');
    const vitest = p.segments.find((s) => s.family === 'test');
    const cleanup = p.segments.find((s) => s.program === 'bash');
    expect(vitest?.ran).toBe(true);
    expect(vitest?.exitCode).toBeNull();
    expect(cleanup?.ran).toBe(true);
    expect(cleanup?.exitCode).toBeNull();
  });

  it('a signature match keeps the precise pinning path (control)', () => {
    const p = parse('npm run build && npx vitest run', 1, 'npm error code ELIFECYCLE\nnpm error command failed');
    const build = p.segments.find((s) => s.program === 'npm-script:build');
    expect(build?.exitCode).toBe(1);
    expect(p.segments.find((s) => s.family === 'test')?.ran).toBe('short-circuited');
  });
});

describe('; chains, || and background (§4.5.5)', () => {
  it('; gives the code to the last segment only', () => {
    const p = parse('git status; npm test', 0);
    expect(p.segments[0]?.exitCode).toBeNull();
    expect(p.segments[0]?.exitCodeSource).toBe('unknown');
    expect(p.segments[1]?.exitCode).toBe(0);
  });

  it('exit 0 after || leaves earlier segments unknown with a note', () => {
    const p = parse('npm test || echo "tests failed"', 0);
    expect(p.segments[0]?.exitCode).toBeNull();
    expect(p.segments[0]?.exitCodeSource).toBe('unknown');
    expect(p.segments[1]?.exitCode).toBe(0);
    expect(p.notes).toContain('failed-somewhere');
  });

  it('trailing & backgrounds every segment', () => {
    const p = parse('npm run dev &', null);
    expect(p.background).toBe(true);
    expect(p.segments[0]?.ran).toBe('background');
    expect(p.segments[0]?.exitCode).toBeNull();
  });

  it('a null harness exit leaves everything unknown', () => {
    const p = parse('npm run build && npm test', null);
    expect(p.segments.every((s) => s.exitCode === null)).toBe(true);
  });

  it('an empty parse never throws', () => {
    const p = parse('', 0);
    expect(p.segments).toEqual([]);
  });
});
