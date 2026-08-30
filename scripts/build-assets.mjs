// Post-`tsc` step: copy every non-.ts file under src/ to the same relative
// path under dist/, byte-identical, creating directories as needed. This is
// how src/cost/prices.json and src/render/report.js reach the package; there
// is deliberately no per-file list. Runtime code reads such files with
// readFileSync(new URL('./x', import.meta.url)), never with import attributes.
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const srcDir = join(root, 'src');
const distDir = join(root, 'dist');

/** Every file under `dir`, recursively, as absolute paths. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

let copied = 0;
for (const file of walk(srcDir)) {
  if (file.endsWith('.ts')) continue;
  const target = join(distDir, relative(srcDir, file));
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(file, target);
  copied++;
}
process.stdout.write(`build-assets: copied ${copied} file(s) to dist/\n`);
