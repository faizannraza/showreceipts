// Size gates: source line budgets (PLAN §0.3) and `npm pack --dry-run --json`
// checks (tarball ≤ 200 KB, unpacked ≤ 600 KB, no *.map / *.d.ts / test files,
// only bin/, dist/, README.md, LICENSE, package.json; once they exist,
// dist/cost/prices.json and dist/demo/** must ship). `--strict` makes every
// check fatal; the default only warns (S36 makes strict the default under CI).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const strict = process.argv.includes('--strict');

const LINE_BUDGETS = [
  ['src/claims/rules.ts', 300],
  ['src/ledger/shell/lex.ts', 350],
  ['src/render/term.ts', 500],
  ['src/render/report.js', 900],
];
const SRC_TOTAL_LINES = 12000;
// W4/S22 lead decision: the npm tarball sat at 198.5/200 KB before the W4
// render assets; the report (report.js + html renderer) is not to be
// compromised for the limit, so the caps are 300 KB / 900 KB unpacked
// (recorded in docs/decisions.md, W4/S22).
const TARBALL_BYTES = 300 * 1024;
const UNPACKED_BYTES = 900 * 1024;
const ALLOWED_TOP_LEVEL = ['bin/', 'dist/', 'README.md', 'LICENSE', 'package.json'];

const problems = [];
const notes = [];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

function countLines(file) {
  const text = readFileSync(file, 'utf8');
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

// --- line budgets -----------------------------------------------------------
for (const [rel, budget] of LINE_BUDGETS) {
  const abs = join(root, rel);
  if (!existsSync(abs)) continue;
  const lines = countLines(abs);
  if (lines > budget) problems.push(`${rel}: ${lines} lines > budget ${budget}`);
  else notes.push(`${rel}: ${lines}/${budget} lines`);
}
const srcDir = join(root, 'src');
if (existsSync(srcDir)) {
  const codeFiles = walk(srcDir).filter((f) => f.endsWith('.ts') || f.endsWith('.js'));
  const total = codeFiles.reduce((sum, f) => sum + countLines(f), 0);
  if (total > SRC_TOTAL_LINES) problems.push(`src/: ${total} lines of .ts/.js > budget ${SRC_TOTAL_LINES}`);
  else notes.push(`src/: ${total}/${SRC_TOTAL_LINES} lines of .ts/.js in ${codeFiles.length} files`);
}

// --- npm pack ---------------------------------------------------------------
function npmPackDryRun() {
  const args = ['pack', '--dry-run', '--json', '--ignore-scripts'];
  const npmCli = process.env.npm_execpath;
  const env = { ...process.env, npm_config_update_notifier: 'false' };
  const stdout =
    npmCli && /\.[cm]?js$/.test(npmCli)
      ? execFileSync(process.execPath, [npmCli, ...args], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      : execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
          cwd: root,
          env,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          shell: process.platform === 'win32',
        });
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

let pack;
try {
  pack = npmPackDryRun();
} catch (err) {
  problems.push(`npm pack --dry-run failed: ${err instanceof Error ? err.message : String(err)}`);
}

if (pack) {
  const paths = (pack.files ?? []).map((f) => f.path.split(sep).join('/'));
  if (pack.size > TARBALL_BYTES) problems.push(`tarball ${kb(pack.size)} > ${kb(TARBALL_BYTES)}`);
  else notes.push(`tarball ${kb(pack.size)} (limit ${kb(TARBALL_BYTES)})`);
  if (pack.unpackedSize > UNPACKED_BYTES) problems.push(`unpacked ${kb(pack.unpackedSize)} > ${kb(UNPACKED_BYTES)}`);
  else notes.push(`unpacked ${kb(pack.unpackedSize)} (limit ${kb(UNPACKED_BYTES)}), ${paths.length} files`);

  const stray = paths.filter((p) => p.endsWith('.map') || p.endsWith('.d.ts') || p === 'test' || p.startsWith('test/'));
  if (stray.length > 0) problems.push(`tarball contains build artefacts or tests: ${stray.join(', ')}`);

  const outside = paths.filter((p) => !ALLOWED_TOP_LEVEL.some((ok) => (ok.endsWith('/') ? p.startsWith(ok) : p === ok)));
  if (outside.length > 0) problems.push(`tarball contains files outside ${ALLOWED_TOP_LEVEL.join(' ')}: ${outside.join(', ')}`);

  if (existsSync(join(root, 'src/cost/prices.json')) && !paths.includes('dist/cost/prices.json')) {
    problems.push('tarball is missing dist/cost/prices.json (run npm run build)');
  }
  if (existsSync(join(root, 'src/demo')) && !paths.some((p) => p.startsWith('dist/demo/'))) {
    problems.push('tarball is missing dist/demo/** (run npm run build)');
  }
  if (!paths.includes('dist/cli.js')) problems.push('tarball is missing dist/cli.js (run npm run build)');
}

// --- report -----------------------------------------------------------------
for (const note of notes) process.stdout.write(`size: ${note}\n`);
const label = strict ? 'FAIL' : 'WARN';
for (const problem of problems) process.stderr.write(`size: ${label}: ${problem}\n`);
if (problems.length === 0) {
  process.stdout.write(`size: ok${strict ? ' (strict)' : ''}\n`);
} else if (strict) {
  process.exit(1);
} else {
  process.stdout.write(`size: ${problems.length} warning(s); pass --strict to make them fatal\n`);
}
