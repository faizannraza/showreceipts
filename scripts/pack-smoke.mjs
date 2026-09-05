// Pack-and-install smoke test (S34; ARCHITECTURE §15).
//
//   npm pack  →  assert the tarball manifest (dist/cost/prices.json,
//   dist/render/report.js, dist/demo/scenarios.js must ship)  →  install the
//   tarball globally into a temp prefix with `--offline --ignore-scripts`  →
//   run the *installed* CLI from an empty cwd with empty SHOWRECEIPTS_HOME /
//   CLAUDE_CONFIG_DIR / CODEX_HOME:
//
//     showreceipts demo --ascii --no-color   exit 0, non-empty receipt
//     showreceipts doctor --json             exit 0, stdout parses as JSON
//     showreceipts --version                 exit 0, prints the pkg version
//
// This is the "npx first run" gate: no network, no install scripts, no state
// on the machine — the freshly installed package must still render.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const isWindows = process.platform === 'win32';
const failures = [];

function log(message) {
  process.stdout.write(`pack-smoke: ${message}\n`);
}

/** Run npm reliably whether or not this script itself was launched by npm. */
function npm(args, opts = {}) {
  const env = { ...process.env, npm_config_update_notifier: 'false', ...opts.env };
  const npmCli = process.env.npm_execpath;
  const common = { cwd: opts.cwd ?? root, env, encoding: 'utf8', stdio: opts.stdio ?? ['ignore', 'pipe', 'inherit'] };
  if (npmCli && /\.[cm]?js$/.test(npmCli)) {
    return execFileSync(process.execPath, [npmCli, ...args], common);
  }
  return execFileSync(isWindows ? 'npm.cmd' : 'npm', args, { ...common, shell: isWindows });
}

const work = mkdtempSync(join(tmpdir(), 'showreceipts-pack-smoke-'));
const dirs = {
  packDest: join(work, 'pack'),
  prefix: join(work, 'prefix'),
  cwd: join(work, 'empty-cwd'),
  home: join(work, 'home'),
  srHome: join(work, 'sr-home'),
  claude: join(work, 'claude'),
  codex: join(work, 'codex'),
};
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });

try {
  // --- pack -----------------------------------------------------------------
  log(`packing showreceipts@${pkg.version} (prepack builds dist/)`);
  npm(['pack', '--pack-destination', dirs.packDest], { stdio: ['ignore', 'ignore', 'inherit'] });
  const tarballs = readdirSync(dirs.packDest).filter((f) => f.endsWith('.tgz'));
  if (tarballs.length !== 1) {
    throw new Error(`expected exactly one tarball in ${dirs.packDest}, found: ${tarballs.join(', ') || '(none)'}`);
  }
  const expectedName = `showreceipts-${pkg.version}.tgz`;
  if (tarballs[0] !== expectedName) failures.push(`tarball is ${tarballs[0]}, expected ${expectedName}`);
  const tarball = join(dirs.packDest, tarballs[0]);

  // --- tarball manifest -------------------------------------------------------
  const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().replace(/\\/g, '/'))
    .filter(Boolean);
  const required = [
    'bin/showreceipts.js',
    'dist/cli.js',
    'dist/cost/prices.json',
    'dist/render/report.js',
    'dist/demo/scenarios.js',
  ];
  for (const rel of required) {
    if (!listing.includes(`package/${rel}`)) failures.push(`tarball is missing ${rel}`);
  }
  log(`tarball ${tarballs[0]}: ${listing.length} entries, manifest ok`);

  // --- offline global install into a temp prefix ------------------------------
  log(`installing globally into ${dirs.prefix} (--offline --ignore-scripts)`);
  npm(
    ['install', '-g', tarball, '--prefix', dirs.prefix, '--offline', '--no-audit', '--no-fund', '--ignore-scripts'],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );

  // POSIX global layout: <prefix>/bin/<name> shim → lib/node_modules/...
  // Windows global layout has no lib/ segment and uses .cmd shims; run the
  // installed bin file through node instead (best-effort platform).
  const installedBin = isWindows
    ? join(dirs.prefix, 'node_modules', 'showreceipts', 'bin', 'showreceipts.js')
    : join(dirs.prefix, 'bin', 'showreceipts');
  if (!existsSync(installedBin)) throw new Error(`installed binary not found at ${installedBin}`);

  // --- run the installed CLI hermetically -------------------------------------
  const env = {
    ...process.env,
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    SHOWRECEIPTS_HOME: dirs.srHome,
    CLAUDE_CONFIG_DIR: dirs.claude,
    CODEX_HOME: dirs.codex,
    NO_COLOR: '1',
  };
  delete env.NODE_OPTIONS;
  delete env.FORCE_COLOR;
  delete env.SHOWRECEIPTS_NOW;
  delete env.SHOWRECEIPTS_NO_CACHE;

  /** Run the installed CLI from the empty cwd; returns stdout or null on failure. */
  function run(args) {
    const display = `showreceipts ${args.join(' ')}`;
    const argv = isWindows ? [installedBin, ...args] : args;
    const file = isWindows ? process.execPath : installedBin;
    try {
      const stdout = execFileSync(file, argv, { cwd: dirs.cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      log(`${display}: exit 0 (${stdout.length} bytes of stdout)`);
      return stdout;
    } catch (err) {
      const status = err && typeof err === 'object' && 'status' in err ? err.status : '?';
      const stderr = err && typeof err === 'object' && 'stderr' in err ? String(err.stderr).trim().slice(-400) : '';
      failures.push(`\`${display}\` failed (exit ${status})${stderr ? `: ${stderr}` : ''}`);
      return null;
    }
  }

  const demo = run(['demo', '--ascii', '--no-color']);
  if (demo !== null && demo.trim() === '') failures.push('`showreceipts demo --ascii --no-color` printed nothing');

  const doctor = run(['doctor', '--json']);
  if (doctor !== null) {
    try {
      JSON.parse(doctor);
    } catch {
      failures.push('`showreceipts doctor --json` stdout is not valid JSON');
    }
  }

  const version = run(['--version']);
  if (version !== null && !version.includes(pkg.version)) {
    failures.push(`\`showreceipts --version\` printed ${JSON.stringify(version.trim())}, expected it to contain ${pkg.version}`);
  }
} catch (err) {
  failures.push(err instanceof Error ? err.message : String(err));
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`pack-smoke: FAIL: ${failure}\n`);
  process.exit(1);
}
log(`ok (packed, manifest verified, offline global install, demo/doctor/--version all green)`);
