import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tokenize } from '../../../../src/ledger/shell/index.js';

const cwd = '/home/u/proj';
const opts = { home: '/home/u' };

const one = (raw: string) => {
  const p = tokenize(raw, cwd, opts);
  expect(p.segments).toHaveLength(1);
  return p.segments[0]!;
};

describe('module boundary (§0.5)', () => {
  it('no ledger/shell module imports node:fs, node:os or process.env', () => {
    for (const name of ['lex', 'segments', 'cwd', 'vars', 'families', 'index']) {
      const source = readFileSync(new URL(`../../../../src/ledger/shell/${name}.ts`, import.meta.url), 'utf8');
      expect(source, name).not.toMatch(/from ['"](?:node:)?(?:fs|os|child_process)/);
      expect(source, name).not.toMatch(/process\.env/);
    }
  });
});

describe('wrapper stripping (§4.5.2)', () => {
  it('timeout 900 npx vitest run', () => {
    const seg = one('timeout 900 npx vitest run');
    expect(seg.program).toBe('vitest');
    expect(seg.argv).toEqual(['run']);
    expect(seg.wrapper).toBe('npx');
    expect(seg.family).toBe('test');
    expect(seg.runner).toBe('vitest');
    expect(seg.testScope?.scope).toBe('full');
  });

  it('time npm run build', () => {
    const seg = one('time npm run build');
    expect(seg.program).toBe('npm-script:build');
    expect(seg.family).toBe('build');
  });

  it('env FOO=1 BAR=2 make test', () => {
    const seg = one('env FOO=1 BAR=2 make test');
    expect(seg.program).toBe('make:test');
    expect(seg.assignments).toEqual({ FOO: '1', BAR: '2' });
    expect(seg.family).toBe('test');
  });

  it('sudo is kept as the wrapper for the danger scan', () => {
    const seg = one('sudo rm -rf /opt/thing');
    expect(seg.program).toBe('rm');
    expect(seg.wrapper).toBe('sudo');
    expect(seg.scanTokens).toEqual(['-rf', '/opt/thing']);
  });

  it('VAR=/path cmd keeps the prefix as an assignment', () => {
    const seg = one('DATABASE_URL=/tmp/db.sqlite alembic upgrade head');
    expect(seg.program).toBe('alembic');
    expect(seg.assignments).toEqual({ DATABASE_URL: '/tmp/db.sqlite' });
    expect(seg.family).toBe('migrate');
  });
});

describe('wrapper → program map (§4.5.2)', () => {
  it.each([
    ['uv run pytest -q', 'pytest', ['-q'], 'test'],
    ['uvx ruff check .', 'ruff', ['check', '.'], 'lint'],
    ['poetry run mypy src', 'mypy', ['src'], 'type'],
    ['pipenv run pytest', 'pytest', [], 'test'],
    ['pnpm exec vitest run', 'vitest', ['run'], 'test'],
    ['yarn dlx prettier --check .', 'prettier', ['--check', '.'], 'format'],
    ['bunx eslint src', 'eslint', ['src'], 'lint'],
    ['python3 -m pytest tests/unit', 'pytest', ['tests/unit'], 'test'],
    ['python -m build', 'build', [], 'build'],
    ['node --test dist/', 'node-test', ['dist/'], 'test'],
    ['go test ./...', 'go-test', ['./...'], 'test'],
    ['cargo test', 'cargo-test', [], 'test'],
    ['cargo nextest run', 'cargo-test', [], 'test'],
    ['npm test', 'npm-script:test', [], 'test'],
    ['npm run test -- --run foo', 'npm-script:test', ['--run', 'foo'], 'test'],
    ['npm run typecheck', 'npm-script:typecheck', [], 'type'],
    ['npm run lint -- --fix', 'npm-script:lint', ['--fix'], 'lint'],
    ['pnpm test', 'npm-script:test', [], 'test'],
    ['yarn test', 'npm-script:test', [], 'test'],
    ['bun test', 'npm-script:test', [], 'test'],
    ['make', 'make:default', [], 'build'],
    ['make lint', 'make:lint', [], 'lint'],
    ['make -C sub test', 'make:test', ['-C', 'sub'], 'test'],
    ['make -j 4 build', 'make:build', ['-j', '4'], 'build'],
    ['just -f ci.just test', 'just:test', ['-f', 'ci.just'], 'test'],
    ['./gradlew -p sub test', 'gradle:test', ['-p', 'sub'], 'test'],
    ['just test', 'just:test', [], 'test'],
    ['./gradlew test', 'gradle:test', [], 'test'],
    ['gradle assemble', 'gradle:assemble', [], 'build'],
    ['mvn clean verify', 'mvn:clean,verify', [], 'test'],
    ['rake test', 'rake:test', [], 'test'],
    ['tox', 'tox', [], 'test'],
    ['bundle exec rspec spec/models', 'rspec', ['spec/models'], 'test'],
  ] as const)('%s', (raw, program, argv, family) => {
    const p = tokenize(raw, cwd, opts);
    const seg = p.segments.find((s) => s.program === program);
    expect(seg, raw).toBeDefined();
    expect(seg?.argv).toEqual(argv);
    expect(seg?.family).toBe(family);
  });
});

describe('bash -c and subshells (§4.5.2)', () => {
  it('re-tokenises bash -c bodies', () => {
    const p = tokenize('bash -c "npm test && git status"', cwd, opts);
    expect(p.segments.map((s) => s.program)).toEqual(['npm-script:test', 'git']);
  });

  it('bash -lc works too', () => {
    const p = tokenize("bash -lc 'uv run pytest -q'", cwd, opts);
    expect(p.segments[0]?.program).toBe('pytest');
  });

  it('re-tokenises (…) subshells and splices their segments', () => {
    const p = tokenize('(npm run build && npm test) && echo done', cwd, opts);
    expect(p.segments.map((s) => s.program)).toEqual(['npm-script:build', 'npm-script:test', 'echo']);
  });
});

describe('script family (§4.5.6)', () => {
  it('bash file.sh is a script and may write', () => {
    const seg = one('bash scripts/deploy.sh');
    expect(seg.family).toBe('script');
    expect(seg.mayWrite).toBe(true);
    expect(seg.mayRunTests).toBeUndefined();
  });

  it('./scripts/test.sh may run tests', () => {
    const seg = one('./scripts/test.sh --fast');
    expect(seg.family).toBe('script');
    expect(seg.mayRunTests).toBe(true);
  });

  it('python -c bodies are scripts', () => {
    const seg = one('python3 -c "print(1)"');
    expect(seg.family).toBe('script');
    expect(seg.mayWrite).toBe(true);
  });

  it('source is noted', () => {
    const p = tokenize('source ./env.sh && echo ok', cwd, opts);
    expect(p.notes).toContain('source: ./env.sh');
  });
});

describe('for loops (§4.5.2)', () => {
  it('expands literal word lists per word', () => {
    const p = tokenize('for f in a b c; do echo $f; done', cwd, opts);
    expect(p.segments.map((s) => s.program)).toEqual(['echo', 'echo', 'echo']);
  });

  it('substitutes the loop variable into cp operands', () => {
    const p = tokenize('for f in a.txt b.txt; do cp $f /tmp/; done', cwd, opts);
    expect(p.segments.map((s) => s.argv[0])).toEqual(['a.txt', 'b.txt']);
  });

  it('caps expansion at 32 words', () => {
    const words = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');
    const p = tokenize(`for x in ${words}; do echo $x; done`, cwd, opts);
    expect(p.segments).toHaveLength(32);
    expect(p.notes).toContain('for-expansion-capped');
  });

  it('does not expand non-literal lists', () => {
    const p = tokenize('for f in $(ls); do echo $f; done', cwd, opts);
    expect(p.notes).toContain('for-not-expanded');
    expect(p.segments.filter((s) => s.program === 'echo')).toHaveLength(1);
  });
});

describe('odd shapes from the wild (§0.3)', () => {
  it("BSD sed -i '' keeps the empty suffix argument", () => {
    const seg = one("sed -i '' -e 's/a/b/' notes.txt");
    expect(seg.program).toBe('sed');
    expect(seg.argv).toEqual(['-i', '', '-e', 's/a/b/', 'notes.txt']);
    expect(seg.scanTokens).toEqual(['-i', '-e', 'notes.txt']);
  });

  it('a 10 KB single command stays one segment', () => {
    const seg = one(`grep -rn needle ${Array.from({ length: 520 }, (_, i) => `src/dir${i}/file${i}.ts`).join(' ')}`);
    expect(seg.program).toBe('grep');
    expect(seg.raw.length).toBeGreaterThan(10_000);
  });

  it('an assignment-only command with $( ) still classifies the inner runner', () => {
    const p = tokenize('RESULT=$(uv run pytest -q)', cwd, opts);
    const pytest = p.segments.find((s) => s.program === 'pytest');
    expect(pytest?.family).toBe('test');
  });
});
