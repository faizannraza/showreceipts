/**
 * S26 pack-smoke helpers: `npm pack` the project into a temp directory,
 * install the tarball globally into a temp `--prefix` (offline, scripts
 * ignored), and run the installed CLI with the runtime netguard armed.
 *
 * The npm processes are the ONLY children that run without the netguard
 * (`NODE_OPTIONS` stripped — npm itself talks to nothing here: `--offline`,
 * a local tarball, zero runtime dependencies); every installed-CLI run gets
 * the guard back via {@link runInstalled}.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinnedEnv } from './env.js';
import { NETGUARD_PATH, type RunCliResult } from './spawn.js';
import { makeTempDir } from './tmp.js';

/** Absolute path of the project root (the directory `npm pack` runs in). */
export const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Generous budget for the npm children (pack is fast; install copies ~300 KB). */
const NPM_TIMEOUT_MS = 180_000;

/** What `npm pack --json` reported about the tarball. */
export interface PackedTarball {
  /** Absolute path of the written `.tgz`. */
  tgzPath: string;
  /** `showreceipts-<version>.tgz`. */
  filename: string;
  /** Tarball bytes. */
  size: number;
  /** Unpacked bytes. */
  unpackedSize: number;
  /** Every packed path, POSIX-relative to the package root, sorted. */
  files: string[];
}

/** One globally installed copy of the tarball. */
export interface InstalledCli {
  /** The temp `--prefix` the install landed in. */
  prefix: string;
  /** The `<prefix>/bin/showreceipts` launcher (POSIX; `null` when npm laid out no bin dir). */
  binPath: string | null;
  /** The installed package's `bin/showreceipts.js` — always runnable via `node`. */
  entryPath: string;
}

/**
 * The environment for an npm child: the pinned test environment (temp HOME,
 * so the developer's real `~/.npmrc` is never read) with the netguard's
 * `NODE_OPTIONS` stripped — for the npm process only — and the update
 * notifier off.
 */
function npmEnv(): Record<string, string> {
  const env = pinnedEnv();
  delete env['NODE_OPTIONS'];
  env['npm_config_update_notifier'] = 'false';
  return env;
}

/**
 * The npm invocation: `process.env.npm_execpath` (set when vitest runs under
 * an npm script) executed by the current node, else `npm` from PATH.
 */
function npmCommand(args: readonly string[]): { command: string; argv: string[] } {
  const npmCli = process.env['npm_execpath'];
  if (npmCli !== undefined && /\.[cm]?js$/.test(npmCli)) {
    return { command: process.execPath, argv: [npmCli, ...args] };
  }
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', argv: [...args] };
}

/** Runs one npm command; throws with stderr attached when it fails. */
function runNpm(args: readonly string[], cwd: string): string {
  const { command, argv } = npmCommand(args);
  const result = spawnSync(command, argv, {
    cwd,
    env: npmEnv(),
    encoding: 'utf8',
    timeout: NPM_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(' ')} exited ${result.status}:\n${result.stderr}`);
  }
  return result.stdout;
}

let packed: PackedTarball | undefined;

/**
 * Packs the project once per process into a temp directory with
 * `npm pack --json --ignore-scripts` (the `dist/` tree is the one
 * `npm run test:e2e` just built — no re-build races with parallel suites)
 * and returns the tarball facts. Memoised.
 */
export function packTarball(): PackedTarball {
  if (packed !== undefined) return packed;
  const dest = makeTempDir('showreceipts-pack-');
  const stdout = runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', dest], PROJECT_ROOT);
  const parsed = JSON.parse(stdout) as unknown;
  const info = (Array.isArray(parsed) ? parsed[0] : parsed) as {
    filename: string;
    size: number;
    unpackedSize: number;
    files: { path: string }[];
  };
  packed = {
    tgzPath: join(dest, info.filename),
    filename: info.filename,
    size: info.size,
    unpackedSize: info.unpackedSize,
    files: info.files.map((f) => f.path.split('\\').join('/')).sort(),
  };
  return packed;
}

/**
 * Installs a packed tarball globally into a fresh temp `--prefix` with
 * `npm i -g --offline --no-audit --no-fund --ignore-scripts` (zero runtime
 * dependencies make the offline install hermetic) and locates the installed
 * entry points.
 */
export function installGlobal(tgzPath: string): InstalledCli {
  const prefix = makeTempDir('showreceipts-pack-prefix-');
  runNpm(['i', '-g', '--prefix', prefix, '--offline', '--no-audit', '--no-fund', '--ignore-scripts', tgzPath], prefix);
  const bin = join(prefix, 'bin', 'showreceipts');
  const modulesRoot = process.platform === 'win32' ? prefix : join(prefix, 'lib');
  const entry = join(modulesRoot, 'node_modules', 'showreceipts', 'bin', 'showreceipts.js');
  if (!existsSync(entry)) throw new Error(`global install produced no ${entry}`);
  return { prefix, binPath: existsSync(bin) ? bin : null, entryPath: entry };
}

/** Options of {@link runInstalled}. */
export interface RunInstalledOptions {
  /** Extra environment; a value of `undefined` removes the key. */
  env?: Record<string, string | undefined>;
  cwd?: string;
}

/**
 * Runs the installed CLI (`node <script> <args>`) with the §0.4 pins and the
 * netguard armed — exactly like `test/helpers/spawn.ts runCli`, but against
 * an arbitrary installed script instead of the working tree's `dist/cli.js`.
 */
export function runInstalled(script: string, args: readonly string[], opts: RunInstalledOptions = {}): RunCliResult {
  const env: Record<string, string> = { ...pinnedEnv(), NODE_OPTIONS: `--require "${NETGUARD_PATH}"` };
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const started = performance.now();
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    env,
    input: '',
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const ms = performance.now() - started;
  if (result.error) throw result.error;
  return { stdout: result.stdout, stderr: result.stderr, code: result.status ?? (result.signal ? 128 : 1), ms };
}
