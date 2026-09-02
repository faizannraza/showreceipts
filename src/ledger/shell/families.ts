/**
 * Segment families and runner ids (§4.5.6, runner ids from the §7 detection
 * column). Detection runs on the unwrapped `program` + `argv` (§4.5.2) —
 * wrappers (`npx`, `uv run`, `python -m`, `npm run S` → `npm-script:S`, …)
 * were already folded into the program by `segments.ts`. Also computes the
 * test scope (`full`/`subset` + targets) and snapshot-update markers S13
 * consumes, and the `mayWrite`/`mayRunTests` hints for S12.
 */
import type { Family, ShellSegment } from '../../model/types.js';

/** The family and, for tests, the §7 runner id of one unwrapped program. */
export interface FamilyInfo {
  family: Family;
  runner?: string;
}

const INTERPRETERS = new Set(['python', 'python3', 'python2', 'node', 'ruby', 'perl', 'php', 'bash', 'sh', 'zsh', 'dash', 'ksh']);
const SCRIPT_EXT_RE = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|mts|rb|pl)$/;
const TEST_HINT_RE = /(test|spec|check|ci)/i;

/** §7 detection: program (post-unwrap) → runner id, for single-token runners. */
const RUNNER_BY_PROGRAM: Readonly<Record<string, string>> = {
  pytest: 'pytest',
  'py.test': 'pytest',
  unittest: 'unittest',
  jest: 'jest',
  vitest: 'vitest',
  mocha: 'mocha',
  ava: 'ava',
  'node-test': 'node-test',
  'go-test': 'go-test',
  'cargo-test': 'cargo-test',
  rspec: 'rspec',
  pest: 'pest',
  phpunit: 'phpunit',
  ctest: 'ctest',
  tox: 'tox',
  nox: 'nox',
};

/** Program + first argv token → runner id (`playwright test`, `deno test`, …). */
const RUNNER_BY_SUBCOMMAND: Readonly<Record<string, string>> = {
  'playwright test': 'playwright',
  'cypress run': 'cypress',
  'dotnet test': 'dotnet',
  'rails test': 'minitest',
  'artisan test': 'phpunit',
  'mix test': 'mix',
  'deno test': 'deno-test',
  'swift test': 'swift-test',
  'flutter test': 'flutter',
  'dart test': 'dart-test',
  'hatch test': 'hatch-test',
  'poe test': 'poe-test',
};

const LINT_PROGRAMS = new Set(['eslint', 'flake8', 'pylint', 'golangci-lint', 'oxlint', 'rubocop', 'shellcheck']);
const TYPE_PROGRAMS = new Set(['mypy', 'pyright', 'flow']);
const FORMAT_PROGRAMS = new Set(['prettier', 'black', 'isort', 'gofmt', 'rustfmt']);
const NETWORK_PROGRAMS = new Set(['curl', 'wget', 'http', 'ssh', 'scp']);
const MIGRATE_PROGRAMS = new Set(['alembic', 'dbmate', 'goose', 'flyway', 'atlas']);
const FORMAT_CHECK_FLAGS = new Set(['--check', '-c', '--diff', '-l']);

const VALUE_SUBSET_FLAGS = new Set(['-k', '-t', '--grep', '-m', '--deselect', '-run', '--testNamePattern', '-p']);
const BARE_SUBSET_FLAGS = new Set(['--lf', '-x']);
const SNAPSHOT_FLAGS = new Set(['-u', '--update', '--updateSnapshot', '--update-snapshots', '--snapshot-update']);
const SNAPSHOT_ASSIGNMENTS = ['UPDATE_GOLDENS', 'UPDATE_SNAPSHOTS'];
/** Leading runner subcommands that are modes, not targets. */
const RUNNER_MODE_WORDS = new Set(['run', 'watch', 'test']);

/** True when a script name (`npm-script:X`, `make:T`, …) matches a family word list. */
function scriptNameIs(name: string, exact: readonly string[], prefixes: readonly string[]): boolean {
  return exact.includes(name) || prefixes.some((p) => name.startsWith(p));
}

/** `tsc` is `type` with `--noEmit` or without `-b|--build|-p`; else `build` (§4.5.6). */
function tscFamily(argv: readonly string[]): Family {
  if (argv.includes('--noEmit')) return 'type';
  return argv.some((a) => a === '-b' || a === '--build' || a === '-p' || a.startsWith('-p=') || a.startsWith('--project')) ? 'build' : 'type';
}

/** The scoped script families: `npm-script:X`, `make:T`, `just:T`, `gradle:T`, `mvn:<goals>`, `rake:T`. */
function scriptProgramFamily(program: string): FamilyInfo | null {
  const colon = program.indexOf(':');
  if (colon === -1) return null;
  const kind = program.slice(0, colon);
  const name = program.slice(colon + 1);
  if (kind === 'npm-script') {
    if (name.startsWith('test')) return { family: 'test', runner: program };
    if (name.startsWith('lint')) return { family: 'lint' };
    if (scriptNameIs(name, ['types', 'check-types', 'tsc'], ['typecheck'])) return { family: 'type' };
    if (name.startsWith('build')) return { family: 'build' };
    if (name.startsWith('format') || name.startsWith('fmt')) return { family: 'format' };
    return { family: 'other' };
  }
  if (kind === 'make') {
    if (name === 'test' || name === 'check') return { family: 'test', runner: program };
    if (name === 'lint') return { family: 'lint' };
    if (name === 'typecheck') return { family: 'type' };
    if (name === 'build' || name === 'all' || name === 'default') return { family: 'build' };
    return { family: 'other' };
  }
  if (kind === 'just') return name === 'test' ? { family: 'test', runner: program } : { family: 'other' };
  if (kind === 'gradle') {
    if (name === 'test') return { family: 'test', runner: 'gradle' };
    return name === 'build' || name === 'assemble' ? { family: 'build' } : { family: 'other' };
  }
  if (kind === 'mvn') {
    const goals = name.split(',');
    if (goals.some((g) => g === 'test' || g === 'verify' || g === 'package')) return { family: 'test', runner: 'maven' };
    return goals.includes('compile') ? { family: 'build' } : { family: 'other' };
  }
  if (kind === 'rake') return name === 'test' ? { family: 'test', runner: 'minitest' } : { family: 'other' };
  return null;
}

/**
 * The §4.5.6 family table on an unwrapped program + argv. Returns
 * `family:'other'` for anything unrecognised — `classifySegment` then applies
 * the `script` heuristics, which need segment context (heredoc, `-c`/`-e`).
 */
export function families(program: string, argv: readonly string[]): FamilyInfo {
  const scoped = scriptProgramFamily(program);
  if (scoped !== null) return scoped;
  const runner = RUNNER_BY_PROGRAM[program];
  if (runner !== undefined) return { family: 'test', runner };
  if (program.endsWith('/phpunit')) return { family: 'test', runner: 'phpunit' }; // `vendor/bin/phpunit` (§7)
  const first = argv[0] ?? '';
  const bySub = RUNNER_BY_SUBCOMMAND[`${program} ${first}`];
  if (bySub !== undefined) return { family: 'test', runner: bySub };
  if (program === 'tsx' && argv.includes('--test')) return { family: 'test', runner: 'node-test' };
  if (program === 'ruby' && argv.some((a) => a === '-Itest' || a === '-I' && argv.includes('test'))) return { family: 'test', runner: 'minitest' };
  if (program === 'bundle' && first === 'exec' && argv[1] === 'rspec') return { family: 'test', runner: 'rspec' };
  if (program === 'xcodebuild') return argv.includes('test') ? { family: 'test', runner: 'xcodebuild' } : { family: 'build' };
  if (program === 'ruff') {
    if (first === 'check') return { family: 'lint' };
    if (first === 'format') return { family: 'format' };
  }
  if (program === 'biome') {
    if (first === 'lint' || first === 'check') return { family: 'lint' };
    if (first === 'format') return { family: 'format' };
  }
  if (LINT_PROGRAMS.has(program)) return { family: 'lint' };
  if (program === 'cargo') {
    if (first === 'clippy') return { family: 'lint' };
    if (first === 'fmt') return { family: 'format' };
    if (first === 'build') return { family: 'build' };
    if (first === 'add' || first === 'install') return { family: 'install' };
    if (first === 'insta') return { family: 'test', runner: 'cargo-test' };
  }
  if (program === 'go') {
    if (first === 'vet') return { family: 'lint' };
    if (first === 'build') return { family: 'build' };
    if (first === 'get' || first === 'install') return { family: 'install' };
  }
  if (TYPE_PROGRAMS.has(program)) return { family: 'type' };
  if (program === 'tsc') return { family: tscFamily(argv) };
  if (program === 'deno') {
    if (first === 'check') return { family: 'type' };
  }
  if (FORMAT_PROGRAMS.has(program)) return { family: 'format' };
  if (program === 'git') return { family: 'git' };
  if (program === 'gh') return first === 'api' ? { family: 'network' } : { family: 'git' };
  if (program === 'glab' || program === 'hub') return { family: 'git' };
  if (program === 'npm') {
    if (['i', 'install', 'add', 'ci'].includes(first)) return { family: 'install' };
  }
  if ((program === 'pnpm' || program === 'yarn') && (first === 'add' || first === 'install')) return { family: 'install' };
  if (program === 'bun' && first === 'add') return { family: 'install' };
  if ((program === 'pip' || program === 'pip3') && first === 'install') return { family: 'install' };
  if (program === 'uv') {
    if (first === 'build') return { family: 'build' };
    if (['add', 'sync', 'lock'].includes(first)) return { family: 'install' };
    if ((first === 'pip' || first === 'tool') && argv[1] === 'install') return { family: 'install' };
  }
  if (program === 'pipx' && first === 'install') return { family: 'install' };
  if (program === 'bundle' && (first === 'install' || first === 'add')) return { family: 'install' };
  if ((program === 'gem' || program === 'brew') && first === 'install') return { family: 'install' };
  if (program === 'apt-get' && first === 'install') return { family: 'install' };
  if (NETWORK_PROGRAMS.has(program)) return { family: 'network' };
  if (MIGRATE_PROGRAMS.has(program)) return { family: 'migrate' };
  if (program === 'prisma' && (first === 'migrate' || (first === 'db' && argv[1] === 'push'))) return { family: 'migrate' };
  if (program === 'knex' && first.startsWith('migrate')) return { family: 'migrate' };
  if (program === 'rails' && first === 'db:migrate') return { family: 'migrate' };
  if (program === 'sqlx' && first === 'migrate') return { family: 'migrate' };
  if (basename(program) === 'manage.py' && first === 'migrate') return { family: 'migrate' };
  if (['mkdocs', 'vite', 'next', 'docker', 'swift', 'dotnet'].includes(program) && first === 'build') return { family: 'build' };
  if (program === 'build') return { family: 'build' }; // `python -m build`, unwrapped
  return { family: 'other' };
}

/** The git subcommand after skipping `-C <dir>`, `-c k=v`, `--git-dir=`, `--work-tree=`, `--no-pager` (§4.5.6). */
export function gitSubcommand(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === '-C' || a === '-c') {
      i += 1;
      continue;
    }
    if (a.startsWith('--git-dir=') || a.startsWith('--work-tree=') || a === '--no-pager') continue;
    if (a.startsWith('-')) continue;
    return a;
  }
  return null;
}

function basename(p: string): string {
  const slash = p.lastIndexOf('/');
  return slash === -1 ? p : p.slice(slash + 1);
}

/** A `python manage.py migrate`-shaped interpreter call (checked before `script`). */
function interpreterMigrate(program: string, argv: readonly string[]): boolean {
  return INTERPRETERS.has(program) && basename(argv[0] ?? '') === 'manage.py' && argv[1] === 'migrate';
}

/** The §4.5.6 `script` row: interpreter with a heredoc/`-c`/`-e`/stdin body or a file argument, `bash x.sh`, `./x.sh`, `uv run x.py`, `node x.js`. */
function isScript(seg: ShellSegment): boolean {
  const p = seg.program;
  if (p.startsWith('./') || SCRIPT_EXT_RE.test(p)) return true;
  if (!INTERPRETERS.has(p)) return false;
  if (seg.heredoc !== undefined) return true;
  if (seg.argv.some((a) => a === '-c' || a === '-e' || a === '-')) return true;
  const file = seg.argv.find((a) => !a.startsWith('-'));
  return file !== undefined && (file.includes('/') || file.includes('.'));
}

/** Test scope per §4.5.6: any path argument, `::name`, or a subset flag ⇒ `subset` with `targets[]`; else `full`. */
function testScopeOf(runner: string, argv: readonly string[]): { scope: 'full' | 'subset' | 'unknown'; targets: string[] } {
  const targets: string[] = [];
  let subset = false;
  let positionalIndex = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    const eq = a.indexOf('=');
    const flagName = a.startsWith('-') && eq > 0 ? a.slice(0, eq) : a;
    if (VALUE_SUBSET_FLAGS.has(flagName)) {
      subset = true;
      if (eq > 0) targets.push(a.slice(eq + 1));
      else if (BARE_SUBSET_FLAGS.has(a)) void 0;
      else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          targets.push(next);
          i += 1;
        }
      }
      continue;
    }
    if (BARE_SUBSET_FLAGS.has(a)) {
      subset = true;
      continue;
    }
    if (a.startsWith('-')) continue;
    positionalIndex += 1;
    if (positionalIndex === 1 && RUNNER_MODE_WORDS.has(a) && (runner === 'vitest' || runner === 'jest' || runner === 'playwright' || runner === 'cypress')) continue;
    if (a.includes('::')) {
      subset = true;
      targets.push(a);
      continue;
    }
    if (a.includes('/') || a.includes('.')) {
      subset = true;
      targets.push(a);
    }
  }
  return { scope: subset ? 'subset' : 'full', targets };
}

/** §4.5.6 snapshot-update markers on the runner segment. */
function isSnapshotUpdate(seg: ShellSegment): boolean {
  if (seg.argv.some((a) => SNAPSHOT_FLAGS.has(a))) return true;
  if (seg.assignments !== undefined && SNAPSHOT_ASSIGNMENTS.some((k) => k in (seg.assignments as Record<string, string>))) return true;
  if (seg.program === 'insta' && seg.argv[0] === 'accept') return true;
  return seg.program === 'cargo' && seg.argv[0] === 'insta' && seg.argv[1] === 'accept';
}

/**
 * Classifies one unwrapped segment in place: `family`, `runner`,
 * `testScope`/`snapshotUpdate` (family `test`), and the `mayWrite` /
 * `mayRunTests` hints (`script` segments, formatter writes, `ruff check
 * --fix`).
 */
export function classifySegment(seg: ShellSegment): void {
  if (seg.program === '') {
    seg.family = 'other';
    return;
  }
  if (interpreterMigrate(seg.program, seg.argv)) {
    seg.family = 'migrate';
    return;
  }
  const info = families(seg.program, seg.argv);
  let family = info.family;
  if (family === 'other' && isScript(seg)) family = 'script';
  seg.family = family;
  if (info.runner !== undefined) seg.runner = info.runner;
  if (family === 'test') {
    seg.testScope = testScopeOf(info.runner ?? seg.program, seg.argv);
    if (isSnapshotUpdate(seg)) seg.snapshotUpdate = true;
  } else if (family === 'script') {
    seg.mayWrite = true;
    if (TEST_HINT_RE.test(`${seg.program} ${seg.argv.join(' ')}`)) seg.mayRunTests = true;
  } else if (family === 'format') {
    if (!seg.argv.some((a) => FORMAT_CHECK_FLAGS.has(a))) seg.mayWrite = true;
  } else if (family === 'lint' && seg.program === 'ruff' && seg.argv.includes('--fix')) {
    seg.mayWrite = true; // `ruff check --fix` is lint *and* a formatter write
  }
}
