import fs from 'node:fs';
import { dirname, join, parse as parsePath } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findGitRoot, makeRepoRootResolver } from '../../../src/util/gitroot.js';
import { makeTempDir } from '../../helpers/tmp.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = makeTempDir('showreceipts-git-');
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('findGitRoot', () => {
  it('recognises a .git directory from the root and from a nested cwd', () => {
    const repo = join(tempDir(), 'repo');
    fs.mkdirSync(join(repo, '.git'), { recursive: true });
    fs.mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    expect(findGitRoot(repo)).toBe(repo);
    expect(findGitRoot(join(repo, 'src', 'deep'))).toBe(repo);
    expect(findGitRoot(join(repo, 'src', 'deep', 'missing-file.ts'))).toBe(repo);
  });

  it('recognises a worktree .git file (gitdir: …)', () => {
    const wt = join(tempDir(), 'wt');
    fs.mkdirSync(join(wt, 'pkg'), { recursive: true });
    fs.writeFileSync(join(wt, '.git'), 'gitdir: /somewhere/.git/worktrees/wt\n');
    expect(findGitRoot(join(wt, 'pkg'))).toBe(wt);
  });

  it('ignores a .git file that is not a gitdir pointer', () => {
    const dir = join(tempDir(), 'notrepo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, '.git'), 'just a note\n');
    expect(findGitRoot(dir)).toBeNull();
    fs.writeFileSync(join(dir, '.git'), 'gitdir:\n');
    expect(findGitRoot(dir)).toBeNull();
  });

  it('returns null when no ancestor is a repository and never walks above the filesystem root', () => {
    const dir = join(tempDir(), 'plain', 'nested');
    fs.mkdirSync(dir, { recursive: true });
    const stat = vi.spyOn(fs, 'statSync');
    expect(findGitRoot(dir)).toBeNull();
    const probed = stat.mock.calls.map((call) => String(call[0]));
    const root = parsePath(dir).root;
    expect(probed[probed.length - 1]).toBe(join(root, '.git'));
    for (const p of probed) expect(dirname(p).startsWith(root)).toBe(true);
    expect(new Set(probed).size).toBe(probed.length);
  });

  it('treats an unreadable .git file or a stat error as not-a-root', () => {
    const dir = join(tempDir(), 'r');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, '.git'), 'gitdir: /x');
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('EACCES');
    });
    expect(findGitRoot(dir)).toBeNull();
    vi.restoreAllMocks();
    vi.spyOn(fs, 'statSync').mockImplementation(() => {
      throw new Error('ELOOP');
    });
    expect(findGitRoot(dir)).toBeNull();
  });

  it('handles a .git entry that is neither file nor directory', () => {
    const dir = join(tempDir(), 'odd');
    fs.mkdirSync(dir, { recursive: true });
    const real = fs.statSync(dir);
    vi.spyOn(fs, 'statSync').mockImplementation(() => {
      const fake = Object.create(real) as fs.Stats;
      fake.isDirectory = () => false;
      fake.isFile = () => false;
      return fake;
    });
    expect(findGitRoot(dir)).toBeNull();
  });

  it('never spawns a process', () => {
    const source = fs.readFileSync(new URL('../../../src/util/gitroot.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/child_process|execSync|spawnSync|execFileSync/);
  });
});

describe('makeRepoRootResolver', () => {
  it('memoises per directory (hits and misses) so repeated lookups stat nothing', () => {
    const base = tempDir();
    const repo = join(base, 'repo');
    fs.mkdirSync(join(repo, '.git'), { recursive: true });
    fs.mkdirSync(join(repo, 'a', 'b'), { recursive: true });
    fs.mkdirSync(join(base, 'plain', 'x'), { recursive: true });
    const resolve = makeRepoRootResolver();
    const stat = vi.spyOn(fs, 'statSync');

    expect(resolve(join(repo, 'a', 'b'))).toBe(repo);
    const firstWalk = stat.mock.calls.length;
    expect(firstWalk).toBe(3); // a/b, a, repo

    expect(resolve(join(repo, 'a', 'b'))).toBe(repo);
    expect(stat.mock.calls.length).toBe(firstWalk);

    expect(resolve(join(repo, 'a'))).toBe(repo);
    expect(resolve(repo)).toBe(repo);
    expect(stat.mock.calls.length).toBe(firstWalk);

    // A sibling directory stats itself once, then hits the cached ancestor.
    fs.mkdirSync(join(repo, 'a', 'c'));
    expect(resolve(join(repo, 'a', 'c'))).toBe(repo);
    expect(stat.mock.calls.length).toBe(firstWalk + 1);

    // Misses are cached too.
    expect(resolve(join(base, 'plain', 'x'))).toBeNull();
    const afterMiss = stat.mock.calls.length;
    expect(resolve(join(base, 'plain', 'x'))).toBeNull();
    expect(resolve(join(base, 'plain'))).toBeNull();
    expect(stat.mock.calls.length).toBe(afterMiss);
  });

  it('finds a nested repository even when its parent was cached as another root', () => {
    const outer = join(tempDir(), 'outer');
    const inner = join(outer, 'vendor', 'inner');
    fs.mkdirSync(join(outer, '.git'), { recursive: true });
    fs.mkdirSync(join(inner, '.git'), { recursive: true });
    const resolve = makeRepoRootResolver();
    expect(resolve(join(outer, 'vendor'))).toBe(outer);
    expect(resolve(inner)).toBe(inner);
    expect(resolve(join(inner, 'src'))).toBe(inner);
  });

  it('agrees with findGitRoot for worktree files and non-repos', () => {
    const base = tempDir();
    const wt = join(base, 'wt');
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(join(wt, '.git'), 'gitdir: /elsewhere');
    const resolve = makeRepoRootResolver();
    expect(resolve(wt)).toBe(findGitRoot(wt));
    expect(resolve(join(base, 'nope'))).toBe(findGitRoot(join(base, 'nope')));
  });
});
