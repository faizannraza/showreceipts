import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// S12b: the build-assets contract (scripts/build-assets.mjs). After `tsc`,
// the build copies every non-`.ts` file under `src/` to the same relative
// path under `dist/`, byte-identical — the one generic rule that carries
// `src/cost/prices.json` (S16) and `src/render/report.js` (S22) into the
// package without a per-file list. The build also never emits source maps or
// declarations (`declaration: false`, `sourceMap: false` in tsconfig.json).
// `npm test` is documented to follow `npm run build`, so a missing `dist/`
// is a hard failure here, never a silent skip.

const root = fileURLToPath(new URL('../../..', import.meta.url));
const srcDir = join(root, 'src');
const distDir = join(root, 'dist');

/** Every file under `dir`, recursively, as absolute paths (sorted for stable output). */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile()) out.push(path);
  }
  return out.sort();
}

/** Repo-relative path with forward slashes, for failure messages. */
function rel(path: string): string {
  return relative(root, path).split(sep).join('/');
}

/** Throws the documented instruction when the compiled tree is absent. */
function requireDist(): void {
  if (!existsSync(distDir)) throw new Error('run npm run build first');
}

describe('build assets (scripts/build-assets.mjs contract)', () => {
  it('fails with an instruction, not a skip, when dist/ is absent', () => {
    requireDist();
  });

  it('copies every non-.ts file under src/ to the same path under dist/, byte-identical', () => {
    requireDist();
    const assets = walk(srcDir).filter((file) => !file.endsWith('.ts'));
    for (const file of assets) {
      const twin = join(distDir, relative(srcDir, file));
      expect(existsSync(twin), `${rel(file)} has no twin at ${rel(twin)} — run npm run build first`).toBe(true);
      const source = readFileSync(file);
      const copy = readFileSync(twin);
      expect(copy.equals(source), `${rel(twin)} is not byte-identical to ${rel(file)} — run npm run build first`).toBe(
        true,
      );
    }
  });

  it('dist/ contains no *.map and no *.d.ts', () => {
    requireDist();
    const offenders = walk(distDir)
      .filter((file) => file.endsWith('.map') || file.endsWith('.d.ts'))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});
