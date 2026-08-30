// No-network guarantee (ARCHITECTURE §13.4): scan dist/**/*.js (default) or
// src/**/*.{ts,js} (--src; --all scans both) line by line for network module
// imports, fetch/WebSocket/XMLHttpRequest, createRequire, process.binding,
// non-literal dynamic imports, and child_process usage. Exactly two sites are
// allow-listed for child_process (never for network): commands/report.{ts,js}
// (--open spawns the browser) and setup/writers/{opencode,openclaw}.{ts,js}
// (plugin template strings). Everything else, including hook/dialects/*, is
// scanned strictly. Exit 1 with file:line on any hit.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const NETWORK_PATTERNS = [
  /(?:from|import)\s*['"](?:node:)?(?:https?|http2|net|tls|dns|dgram)['"]/,
  /require\(\s*['"](?:node:)?(?:https?|http2|net|tls|dns|dgram)['"]\s*\)/,
  /createRequire/,
  /process\.binding/,
  /\bfetch\s*\(/,
  /new\s+WebSocket/,
  /XMLHttpRequest/,
  /import\(\s*[^'"]/,
];

const CHILD_PROCESS_PATTERNS = [
  /(?:from|import)\s*['"](?:node:)?child_process['"]/,
  /require\(\s*['"](?:node:)?child_process['"]\s*\)/,
  /\bchild_process\b/,
  /\bexecFile(?:Sync)?\b/,
  /(?<![.\w])spawn(?:Sync)?\s*\(/,
  /(?<![.\w])exec(?:Sync)?\s*\(/,
  /(?<![.\w])fork\s*\(/,
];

/** Sites allowed to mention child_process, in both src and dist spellings. */
const CHILD_PROCESS_ALLOWED = [
  /(^|\/)commands\/report\.(ts|js)$/,
  /(^|\/)setup\/writers\/(opencode|openclaw)\.(ts|js)$/,
];

function walk(dir, extensions) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path, extensions));
    else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) out.push(path);
  }
  return out;
}

function scanFile(file) {
  const rel = relative(root, file).split(sep).join('/');
  const allowChildProcess = CHILD_PROCESS_ALLOWED.some((re) => re.test(rel));
  const hits = [];
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    for (const re of NETWORK_PATTERNS) {
      const m = re.exec(line);
      if (m) hits.push(`${rel}:${index + 1}: ${m[0]}`);
    }
    if (allowChildProcess) return;
    for (const re of CHILD_PROCESS_PATTERNS) {
      const m = re.exec(line);
      if (m) hits.push(`${rel}:${index + 1}: ${m[0]}`);
    }
  });
  return hits;
}

const argv = process.argv.slice(2);
const targets = [];
if (argv.includes('--src') || argv.includes('--all')) targets.push({ dir: 'src', extensions: ['.ts', '.js', '.mjs', '.cjs'] });
if (!argv.includes('--src') || argv.includes('--all')) targets.push({ dir: 'dist', extensions: ['.js', '.mjs', '.cjs'] });

let scanned = 0;
const hits = [];
for (const { dir, extensions } of targets) {
  const abs = join(root, dir);
  if (!existsSync(abs)) {
    process.stderr.write(`check-no-network: ${dir}/ does not exist${dir === 'dist' ? ' (run npm run build first)' : ''}\n`);
    process.exit(1);
  }
  for (const file of walk(abs, extensions)) {
    scanned++;
    hits.push(...scanFile(file));
  }
}

if (hits.length > 0) {
  for (const hit of hits) process.stderr.write(`check-no-network: ${hit}\n`);
  process.exit(1);
}
process.stdout.write(`check-no-network: ok (${scanned} file(s) in ${targets.map((t) => t.dir).join(', ')})\n`);
