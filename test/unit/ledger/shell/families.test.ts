import { describe, expect, it } from 'vitest';
import { families, gitSubcommand, tokenize } from '../../../../src/ledger/shell/index.js';
import type { Family } from '../../../../src/model/types.js';

const cwd = '/home/u/proj';
const opts = { home: '/home/u' };

const seg = (raw: string) => {
  const p = tokenize(raw, cwd, opts);
  expect(p.segments.length).toBeGreaterThan(0);
  return p.segments[p.segments.length - 1]!;
};

describe('family table (§4.5.6)', () => {
  it.each([
    ['uv run pytest -q', 'test'],
    ['npx jest --ci', 'test'],
    ['npx playwright test', 'test'],
    ['cypress run', 'test'],
    ['dotnet test', 'test'],
    ['mix test', 'test'],
    ['deno test', 'test'],
    ['swift test', 'test'],
    ['flutter test', 'test'],
    ['xcodebuild test -scheme App', 'test'],
    ['nox', 'test'],
    ['ruff check src', 'lint'],
    ['eslint src --max-warnings 0', 'lint'],
    ['flake8', 'lint'],
    ['pylint pkg', 'lint'],
    ['cargo clippy', 'lint'],
    ['go vet ./...', 'lint'],
    ['golangci-lint run', 'lint'],
    ['biome check .', 'lint'],
    ['oxlint', 'lint'],
    ['rubocop', 'lint'],
    ['shellcheck scripts/run', 'lint'],
    ['mypy src', 'type'],
    ['pyright', 'type'],
    ['flow check', 'type'],
    ['deno check main.ts', 'type'],
    ['tsc --noEmit', 'type'],
    ['tsc', 'type'],
    ['tsc -b', 'build'],
    ['tsc -p tsconfig.json', 'build'],
    ['cargo build --release', 'build'],
    ['go build ./...', 'build'],
    ['mkdocs build', 'build'],
    ['vite build', 'build'],
    ['next build', 'build'],
    ['uv build', 'build'],
    ['docker build -t app .', 'build'],
    ['swift build', 'build'],
    ['dotnet build', 'build'],
    ['xcodebuild -scheme App', 'build'],
    ['ruff format src', 'format'],
    ['prettier --write .', 'format'],
    ['black .', 'format'],
    ['isort .', 'format'],
    ['gofmt -w .', 'format'],
    ['rustfmt src/main.rs', 'format'],
    ['cargo fmt', 'format'],
    ['git commit -m "x"', 'git'],
    ['gh pr create --fill', 'git'],
    ['glab mr create', 'git'],
    ['hub pull-request', 'git'],
    ['npm ci', 'install'],
    ['npm i lodash', 'install'],
    ['pnpm install', 'install'],
    ['yarn add react', 'install'],
    ['bun add zod', 'install'],
    ['pip install -r requirements.txt', 'install'],
    ['pip3 install requests', 'install'],
    ['uv sync', 'install'],
    ['uv pip install httpx', 'install'],
    ['uv tool install ruff', 'install'],
    ['pipx install poetry', 'install'],
    ['cargo add serde', 'install'],
    ['go get golang.org/x/tools', 'install'],
    ['bundle install', 'install'],
    ['gem install rails', 'install'],
    ['brew install jq', 'install'],
    ['apt-get install -y curl', 'install'],
    ['curl -fsSL https://example.com/x -o /tmp/x', 'network'],
    ['wget https://example.com/a.tar.gz', 'network'],
    ['http GET example.com/api', 'network'],
    ['gh api repos/o/r/pulls', 'network'],
    ['ssh host uptime', 'network'],
    ['scp a.txt host:/tmp/', 'network'],
    ['alembic upgrade head', 'migrate'],
    ['prisma migrate dev', 'migrate'],
    ['prisma db push', 'migrate'],
    ['knex migrate:latest', 'migrate'],
    ['rails db:migrate', 'migrate'],
    ['python manage.py migrate', 'migrate'],
    ['sqlx migrate run', 'migrate'],
    ['dbmate up', 'migrate'],
    ['goose up', 'migrate'],
    ['flyway migrate', 'migrate'],
    ['atlas migrate apply', 'migrate'],
    ['python tools/gen.py', 'script'],
    ['node scripts/build.js', 'script'],
    ['ruby -e "puts 1"', 'script'],
    ['./run.sh', 'script'],
    ['ls -la', 'other'],
    ['echo hi', 'other'],
  ] as const)('%s → %s', (raw, family) => {
    expect(seg(raw).family).toBe(family as Family);
  });

  it('ruff check --fix is lint AND a formatter write', () => {
    const s = seg('ruff check --fix src');
    expect(s.family).toBe('lint');
    expect(s.mayWrite).toBe(true);
  });

  it('formatter check flags are checks, not writes', () => {
    expect(seg('ruff format --check src').mayWrite).toBeUndefined();
    expect(seg('prettier --check .').mayWrite).toBeUndefined();
    expect(seg('black --diff .').mayWrite).toBeUndefined();
    expect(seg('gofmt -l .').mayWrite).toBeUndefined();
    expect(seg('prettier --write .').mayWrite).toBe(true);
  });

  it('tsc -b --noEmit is still type', () => {
    expect(seg('tsc -b --noEmit').family).toBe('type');
  });
});

describe('runner ids (§7 detection column)', () => {
  it.each([
    ['uv run pytest -q', 'pytest'],
    ['py.test', 'pytest'],
    ['python -m unittest discover', 'unittest'],
    ['npx jest', 'jest'],
    ['npx vitest run', 'vitest'],
    ['mocha test/', 'mocha'],
    ['ava', 'ava'],
    ['node --test', 'node-test'],
    ['tsx --test test/a.ts', 'node-test'],
    ['bun test', 'npm-script:test'],
    ['npx playwright test', 'playwright'],
    ['cypress run', 'cypress'],
    ['go test ./...', 'go-test'],
    ['cargo test', 'cargo-test'],
    ['cargo nextest run', 'cargo-test'],
    ['mvn verify', 'maven'],
    ['./gradlew test', 'gradle'],
    ['dotnet test', 'dotnet'],
    ['bundle exec rspec', 'rspec'],
    ['rails test', 'minitest'],
    ['rake test', 'minitest'],
    ['vendor/bin/phpunit', 'phpunit'],
    ['pest', 'pest'],
    ['mix test', 'mix'],
    ['ctest', 'ctest'],
    ['deno test', 'deno-test'],
    ['swift test', 'swift-test'],
    ['flutter test', 'flutter'],
    ['dart test', 'dart-test'],
    ['npm test', 'npm-script:test'],
    ['make check', 'make:check'],
    ['tox', 'tox'],
  ] as const)('%s → %s', (raw, runner) => {
    expect(seg(raw).runner).toBe(runner);
  });
});

describe('test scope (§4.5.6)', () => {
  it.each([
    ['pytest -q', 'full', []],
    ['npx vitest run', 'full', []],
    ['npm test', 'full', []],
    ['pytest tests/test_api.py', 'subset', ['tests/test_api.py']],
    ['pytest tests/test_api.py::test_login', 'subset', ['tests/test_api.py::test_login']],
    ['pytest -k "login and not slow"', 'subset', ['login and not slow']],
    ['pytest -m slow', 'subset', ['slow']],
    ['pytest -x', 'subset', []],
    ['pytest --lf', 'subset', []],
    ['pytest --deselect tests/test_a.py', 'subset', ['tests/test_a.py']],
    ['npx vitest run src/util.test.ts', 'subset', ['src/util.test.ts']],
    ['npx jest --testNamePattern login', 'subset', ['login']],
    ['npx jest -t "adds"', 'subset', ['adds']],
    ['go test -run TestFoo ./pkg', 'subset', ['TestFoo', './pkg']],
    ['npx playwright test --grep smoke', 'subset', ['smoke']],
    ['npx playwright test -p chromium', 'subset', ['chromium']],
    // §4.5.6 lists -p for every runner; a pytest plugin flag is a known, accepted subset false positive (docs/decisions.md, W2).
    ['pytest -p no:cacheprovider', 'subset', ['no:cacheprovider']],
    ['npx mocha --grep=api', 'subset', ['api']],
  ] as const)('%s → %s %j', (raw, scope, targets) => {
    const s = seg(raw);
    expect(s.testScope?.scope).toBe(scope);
    expect(s.testScope?.targets).toEqual(targets);
  });
});

describe('snapshot-update markers (§4.5.6)', () => {
  it.each([
    'npx vitest run -u',
    'npx jest --updateSnapshot',
    'npx jest --update-snapshots',
    'npx playwright test --update-snapshots',
    'UPDATE_SNAPSHOTS=1 npm test',
    'UPDATE_GOLDENS=1 npm test',
    'cargo insta accept',
  ])('%s', (raw) => {
    expect(seg(raw).snapshotUpdate).toBe(true);
  });

  it('a plain run has no marker; sort -u is not a snapshot update', () => {
    expect(seg('npx vitest run').snapshotUpdate).toBeUndefined();
    expect(seg('sort -u names.txt').snapshotUpdate).toBeUndefined();
  });
});

describe('git subcommand (§4.5.6)', () => {
  it.each([
    [['commit', '-m', 'x'], 'commit'],
    [['-C', 'site', 'status'], 'status'],
    [['-c', 'user.name=x', 'commit'], 'commit'],
    [['--git-dir=.git', 'log'], 'log'],
    [['--work-tree=/tmp/x', 'checkout', 'main'], 'checkout'],
    [['--no-pager', 'diff', '--stat'], 'diff'],
    [['-C', 'a', '-c', 'k=v', '--no-pager', 'push'], 'push'],
    [[], null],
    [['--no-pager'], null],
  ] as const)('%j → %s', (argv, sub) => {
    expect(gitSubcommand([...argv])).toBe(sub);
  });
});

describe('families() direct', () => {
  it('script-name programs classify by prefix table', () => {
    expect(families('npm-script:test:unit', [])).toEqual({ family: 'test', runner: 'npm-script:test:unit' });
    expect(families('npm-script:lint:fix', [])).toEqual({ family: 'lint' });
    expect(families('npm-script:typecheck', [])).toEqual({ family: 'type' });
    expect(families('npm-script:build:site', [])).toEqual({ family: 'build' });
    expect(families('npm-script:fmt', [])).toEqual({ family: 'format' });
    expect(families('npm-script:deploy', [])).toEqual({ family: 'other' });
    expect(families('make:all', [])).toEqual({ family: 'build' });
    expect(families('make:typecheck', [])).toEqual({ family: 'type' });
    expect(families('gradle:assemble', [])).toEqual({ family: 'build' });
    expect(families('mvn:compile', [])).toEqual({ family: 'build' });
    expect(families('mvn:clean,package', [])).toEqual({ family: 'test', runner: 'maven' });
    expect(families('just:deploy', [])).toEqual({ family: 'other' });
    expect(families('rake:db', [])).toEqual({ family: 'other' });
  });

  it('mayRunTests on scripts whose name/args mention test|spec|check|ci', () => {
    expect(seg('./scripts/ci.sh').mayRunTests).toBe(true);
    expect(seg('bash run_specs.sh').mayRunTests).toBe(true);
    expect(seg('bash deploy.sh').mayRunTests).toBeUndefined();
  });
});
