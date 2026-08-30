/**
 * Repository-root discovery without spawning git: a walk-up that recognises a
 * `.git` directory and a worktree/submodule `.git` file (`gitdir: …`). This
 * is the single implementation; the pipeline injects `makeRepoRootResolver()`
 * into the ledger (which never imports `fs`), and the report, doctor and hook
 * paths import it directly. The default import of `node:fs` lets tests spy
 * on `statSync` to prove memoisation.
 */
import fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const GITDIR_RE = /^gitdir:\s*\S/;

/** True when `<dir>/.git` marks a repository root (directory, or a file pointing at a gitdir). */
function isRepoRoot(dir: string): boolean {
  const marker = join(dir, '.git');
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(marker, { throwIfNoEntry: false });
  } catch {
    return false;
  }
  if (stat === undefined) return false;
  if (stat.isDirectory()) return true;
  if (!stat.isFile()) return false;
  try {
    const head = fs.readFileSync(marker, { encoding: 'utf8', flag: 'r' }).slice(0, 4096);
    return GITDIR_RE.test(head);
  } catch {
    return false;
  }
}

/**
 * The nearest ancestor of `dir` (inclusive) containing a `.git` directory or
 * worktree file, or `null`. Never spawns a process and never walks above the
 * filesystem root; `dir` need not exist.
 */
export function findGitRoot(dir: string): string | null {
  let current = resolve(dir);
  for (;;) {
    if (isRepoRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * A `findGitRoot` memoised per directory: every directory visited during a
 * walk is cached (hits and misses alike), so resolving many paths inside one
 * repository stats each ancestor once.
 */
export function makeRepoRootResolver(): (p: string) => string | null {
  const cache = new Map<string, string | null>();
  return (p: string): string | null => {
    const start = resolve(p);
    const visited: string[] = [];
    let current = start;
    let root: string | null = null;
    for (;;) {
      const known = cache.get(current);
      if (known !== undefined) {
        root = known;
        break;
      }
      visited.push(current);
      if (isRepoRoot(current)) {
        root = current;
        break;
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    for (const dir of visited) cache.set(dir, root);
    return root;
  };
}
