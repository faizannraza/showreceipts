import { describe, expect, it } from 'vitest';
import { attributeExit, tokenize } from '../../../../src/ledger/shell/index.js';

const cwd = '/home/u/proj';
const opts = { home: '/home/u' };

describe('words and quoting (§4.5.1)', () => {
  it('splits plain words', () => {
    const p = tokenize('echo hello world', cwd, opts);
    expect(p.segments).toHaveLength(1);
    expect(p.segments[0]?.program).toBe('echo');
    expect(p.segments[0]?.argv).toEqual(['hello', 'world']);
    expect(p.chained).toBe(false);
  });

  it('dequotes double and single quotes into one argv word', () => {
    const p = tokenize('printf "hello world" \'a b\'', cwd, opts);
    expect(p.segments[0]?.argv).toEqual(['hello world', 'a b']);
  });

  it('keeps quoted literals out of scanTokens', () => {
    const p = tokenize('printf "quoted literal" plain --flag', cwd, opts);
    expect(p.segments[0]?.scanTokens).toEqual(['plain', '--flag']);
  });

  it('honours \\" inside double quotes', () => {
    const p = tokenize('echo "a \\" b"', cwd, opts);
    expect(p.segments[0]?.argv).toEqual(['a " b']);
  });

  it('lexes $\'…\' as a quoted word', () => {
    const p = tokenize("echo $'a\\nb'", cwd, opts);
    expect(p.segments[0]?.argv).toEqual(['a\\nb']);
  });

  it('does not split on quoted && or ;', () => {
    const p = tokenize('echo "a && b; c"', cwd, opts);
    expect(p.segments).toHaveLength(1);
    expect(p.segments[0]?.argv).toEqual(['a && b; c']);
  });

  it('treats a backslash escape as a literal', () => {
    const p = tokenize('echo a\\;b', cwd, opts);
    expect(p.segments).toHaveLength(1);
    expect(p.segments[0]?.argv).toEqual(['a;b']);
  });

  it('drops a trailing comment', () => {
    const p = tokenize('echo a # not a command', cwd, opts);
    expect(p.segments).toHaveLength(1);
    expect(p.segments[0]?.argv).toEqual(['a']);
  });

  it('never throws on unbalanced quotes and notes them', () => {
    const p = tokenize('echo "abc', cwd, opts);
    expect(p.segments[0]?.argv).toEqual(['abc']);
    expect(p.notes).toContain('unbalanced-quote');
  });
});

describe('separators and background (§4.5.2, §4.5.5)', () => {
  it('splits on && || ; | and newline', () => {
    const p = tokenize('a && b || c; d | e\nf', cwd, opts);
    expect(p.segments.map((s) => s.program)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(p.chained).toBe(true);
    expect(p.segments[3]?.piped).toBe(true);
    expect(p.segments[4]?.piped).toBe(true);
  });

  it('marks a trailing & as background', () => {
    const p = tokenize('sleep 10 &', cwd, opts);
    expect(p.background).toBe(true);
    expect(p.segments[0]?.ran).toBe('background');
  });

  it('a lone pipeline is not chained', () => {
    const p = tokenize('pytest -q | tee out.log', cwd, opts);
    expect(p.chained).toBe(false);
  });
});

describe('redirects (§4.5.1)', () => {
  it.each([
    ['echo x > out.txt', '>', `${cwd}/out.txt`, undefined],
    ['echo x >> log.txt', '>>', `${cwd}/log.txt`, undefined],
    ['echo x >| force.txt', '>|', `${cwd}/force.txt`, undefined],
    ['cmd &> all.log', '&>', `${cwd}/all.log`, undefined],
    ['cmd &>> all.log', '&>>', `${cwd}/all.log`, undefined],
    ['cmd 2> err.log', '>', `${cwd}/err.log`, 2],
    ['cmd 2>> err.log', '>>', `${cwd}/err.log`, 2],
    ['sort < in.txt', '<', `${cwd}/in.txt`, undefined],
  ] as const)('%s', (raw, op, target, fd) => {
    const p = tokenize(raw, cwd, opts);
    expect(p.segments[0]?.redirects).toHaveLength(1);
    const r = p.segments[0]?.redirects[0];
    expect(r?.op).toBe(op);
    expect(r?.target).toBe(target);
    expect(r?.resolved).toBe(true);
    if (fd !== undefined) expect(r?.fd).toBe(fd);
  });

  it('fd dups produce no redirect entry', () => {
    const p = tokenize('npm test 2>&1', cwd, opts);
    expect(p.segments[0]?.redirects).toEqual([]);
    expect(p.segments[0]?.suppressed).toBe(false);
  });

  it('drops /dev/null-family targets but still suppresses stdout', () => {
    const p = tokenize('cmd > /dev/null 2>&1', cwd, opts);
    expect(p.segments[0]?.redirects).toEqual([]);
    expect(p.segments[0]?.suppressed).toBe(true);
  });

  it('never treats -> or => as a redirect', () => {
    const p = tokenize('echo a -> b => c', cwd, opts);
    expect(p.segments[0]?.redirects).toEqual([]);
    expect(p.segments[0]?.argv).toEqual(['a', '->', 'b', '=>', 'c']);
  });

  it('a redirect target in quotes is one literal path', () => {
    const p = tokenize('echo x > "out file.txt"', cwd, opts);
    expect(p.segments[0]?.redirects[0]?.target).toBe(`${cwd}/out file.txt`);
    expect(p.segments[0]?.redirects[0]?.resolved).toBe(true);
  });

  it('herestrings and process substitutions produce no file target', () => {
    const p = tokenize('diff <(sort a.txt) <(sort b.txt) <<< "x"', cwd, opts);
    const diff = p.segments.find((s) => s.program === 'diff');
    expect(diff).toBeDefined();
    expect(diff?.redirects).toEqual([]);
    expect(p.segments.filter((s) => s.program === 'sort')).toHaveLength(2); // classification descent
  });
});

describe('heredocs (§4.5.1)', () => {
  it('redirect-then-heredoc: target kept, body never tokenised', () => {
    const p = tokenize("cat > out.txt <<'EOF'\nsecret body && rm -rf /\nEOF", cwd, opts);
    expect(p.segments).toHaveLength(1);
    const seg = p.segments[0];
    expect(seg?.redirects).toEqual([{ op: '>', target: `${cwd}/out.txt`, resolved: true }]);
    expect(seg?.heredoc?.delimiter).toBe('EOF');
    expect(seg?.heredoc?.bytes).toBe(24);
    expect(seg?.scanTokens).not.toContain('secret');
    expect(p.segments.map((s) => s.program)).not.toContain('rm');
  });

  it('heredoc-then-redirect works the same', () => {
    const p = tokenize('cat <<EOF > out.txt\nbody\nEOF', cwd, opts);
    expect(p.segments[0]?.redirects[0]?.target).toBe(`${cwd}/out.txt`);
    expect(p.segments[0]?.heredoc?.bytes).toBe(5);
  });

  it('python3 - <<PY marks the interpreter', () => {
    const p = tokenize("python3 - <<'PY'\nprint(1)\nPY", cwd, opts);
    expect(p.segments[0]?.program).toBe('python3');
    expect(p.segments[0]?.family).toBe('script');
    expect(p.heredocs).toEqual([{ delimiter: 'PY', bytes: 9, interpreter: 'python3' }]);
  });

  it('<<- strips tabs before matching the tag', () => {
    const p = tokenize('cat <<-END\n\tindented\n\tEND', cwd, opts);
    expect(p.heredocs[0]?.delimiter).toBe('END');
    expect(p.notes).not.toContain('unterminated-heredoc');
  });

  it('an unterminated heredoc is noted, never thrown', () => {
    const p = tokenize('cat <<EOF\nno terminator here', cwd, opts);
    expect(p.notes).toContain('unterminated-heredoc');
  });

  it('a heredoc inside $( ) does not break the outer parse', () => {
    const p = tokenize('git commit -m "$(cat <<\'EOF\'\nfix: things (and parens\nEOF\n)"', cwd, opts);
    const programs = p.segments.map((s) => s.program);
    expect(programs).toContain('git');
    expect(programs).toContain('cat');
    expect(p.notes).not.toContain('unbalanced-quote');
  });
});

describe('substitution descent (§4.5.2)', () => {
  it('classifies runners inside $( )', () => {
    const p = tokenize('echo "$(npm test)"', cwd, opts);
    const inner = p.segments.find((s) => s.program === 'npm-script:test');
    expect(inner).toBeDefined();
    expect(inner?.suppressed).toBe(true);
    expect(inner?.exitCode).toBeNull();
  });

  it('classifies backtick bodies', () => {
    const p = tokenize('echo `git rev-parse HEAD`', cwd, opts);
    expect(p.segments.map((s) => s.program)).toContain('git');
  });

  it('excludes substitution segments from exit attribution', () => {
    const p = tokenize('echo "$(pytest -q)"', cwd, opts);
    attributeExit(p, 0, 'harness');
    const echo = p.segments.find((s) => s.program === 'echo');
    const pytest = p.segments.find((s) => s.program === 'pytest');
    expect(echo?.exitCode).toBe(0);
    expect(pytest?.exitCode).toBeNull();
  });
});

/**
 * True when V8 coverage instrumentation is active (`npm test -- --coverage`,
 * the CI / `test:all` invocation). Counter updates slow the lexer's hot
 * character loop several-fold, so the wall-clock budgets below scale by
 * {@link budget}. Detection reads vitest's worker state; an unrecognisable
 * shape counts as instrumented so the assertions fail safe (generous budget)
 * rather than flake if the internal field is ever renamed.
 */
const coverageActive: boolean =
  (
    (globalThis as Record<string, unknown>).__vitest_worker__ as
      | { config?: { coverage?: { enabled?: boolean } } }
      | undefined
  )?.config?.coverage?.enabled !== false;

/**
 * Scales an uninstrumented wall-clock budget (ms) for coverage runs. 10x is
 * sized from measurement (a warmed best of ~31 ms was observed for the 5 ms
 * case under coverage on a machine loaded with parallel build agents, past
 * the old 6x budget) and stays decisive: the pathologies these tests guard
 * against (regex backtracking, O(n^2) scans) cost seconds, not tens of
 * milliseconds.
 */
const budget = (ms: number): number => (coverageActive ? ms * 10 : ms);

describe('robustness (§4.5.1 acceptance)', () => {
  it('parses a 100 KB command in under 5 ms without throwing', () => {
    const big = `echo start && ${'grep -n pattern src/file.ts && '.repeat(200)}printf ${'x'.repeat(95_000)} > out.txt`;
    expect(big.length).toBeGreaterThan(100_000);
    tokenize('echo warmup && ls', cwd, opts); // JIT warmup
    tokenize(big, cwd, opts);
    let best = Infinity;
    let p = tokenize(big, cwd, opts);
    for (let run = 0; run < 3; run += 1) {
      const t0 = performance.now();
      p = tokenize(big, cwd, opts);
      best = Math.min(best, performance.now() - t0);
    }
    expect(p.segments.length).toBeGreaterThan(100);
    expect(best).toBeLessThan(budget(5)); // best of three: robust to suite-wide CPU contention
  });

  it('parses 100 KB of unbalanced quote quickly', () => {
    const big = `echo "${'a b && c; '.repeat(10_000)}`;
    tokenize(big, cwd, opts); // JIT warmup
    let best = Infinity;
    let p = tokenize(big, cwd, opts);
    for (let run = 0; run < 3; run += 1) {
      const t0 = performance.now();
      p = tokenize(big, cwd, opts);
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(budget(20)); // best of three: robust to coverage instrumentation and CPU contention
    expect(p.segments).toHaveLength(1);
    expect(p.notes).toContain('unbalanced-quote');
  });

  it('applies no regex to unbounded input (state machine, not regex splitting)', () => {
    // A pathological input for backtracking regexes: nested quotes and operators.
    const evil = `${'"a" || '.repeat(5_000)}"unclosed`;
    tokenize(evil, cwd, opts); // JIT warmup
    let best = Infinity;
    for (let run = 0; run < 3; run += 1) {
      const t0 = performance.now();
      tokenize(evil, cwd, opts);
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(budget(20)); // best of three: robust to coverage instrumentation and CPU contention
  });
});
