import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  basename,
  canon,
  classifyScope,
  DEFAULT_TMP_ROOTS,
  displayPath,
  extname,
  isTmpPath,
  isUnder,
  middleTruncate,
  resolveAgainst,
  toPosix,
  type ScopeContext,
  type WriteScope,
} from '../../../src/util/paths.js';
import { displayWidth } from '../../../src/util/width.js';
import type { WriteFact } from '../../../src/model/types.js';

const home = '/home/u';

describe('module boundary', () => {
  it('imports neither node:fs nor node:os nor the model', () => {
    const source = readFileSync(new URL('../../../src/util/paths.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from ['"](?:node:)?(?:fs|os)(?:\/promises)?['"]/);
    expect(source).not.toMatch(/from ['"]\.\.\/model\//);
  });

  it('keeps WriteScope identical to WriteFact.scope (compile-time, both directions)', () => {
    const toModel = (s: WriteScope): WriteFact['scope'] => s;
    const fromModel = (s: WriteFact['scope']): WriteScope => s;
    expect(toModel('worktree')).toBe('worktree');
    expect(fromModel('harness-config')).toBe('harness-config');
  });
});

describe('toPosix', () => {
  it('converts backslashes', () => {
    expect(toPosix('C:\\Users\\u\\x.ts')).toBe('C:/Users/u/x.ts');
    expect(toPosix('/a/b')).toBe('/a/b');
  });
});

describe('canon', () => {
  it('folds /private/{tmp,var,etc}, expands ~, collapses // and strips trailing /', () => {
    expect(canon('/private/tmp/x', { home })).toBe('/tmp/x');
    expect(canon('/private/var/folders/ab/T/x', { home })).toBe('/var/folders/ab/T/x');
    expect(canon('/private/etc/hosts', { home })).toBe('/etc/hosts');
    expect(canon('/private/etc', { home })).toBe('/etc');
    expect(canon('/privateer/tmp', { home })).toBe('/privateer/tmp');
    expect(canon('/private/tmpx/y', { home })).toBe('/private/tmpx/y');
    expect(canon('~/a//b/', { home: '/home/u' })).toBe('/home/u/a/b');
    expect(canon('~', { home: '/home/u/' })).toBe('/home/u');
    expect(canon('~user/x', { home })).toBe('~user/x');
    expect(canon('/a/./b/../c/', { home })).toBe('/a/c');
    expect(canon('/', { home })).toBe('/');
    expect(canon('', { home })).toBe('');
    expect(canon('  /a/b  ', { home })).toBe('/a/b');
    expect(canon('C:\\Users\\u\\x', { home })).toBe('C:/Users/u/x');
    expect(canon('src/x.ts', { home })).toBe('src/x.ts');
    expect(canon('./src//x.ts', { home })).toBe('src/x.ts');
  });

  it('is idempotent', () => {
    for (const p of ['/private/tmp/x', '~/a//b/', '/a/./b/../c/', 'rel/../x']) {
      const once = canon(p, { home });
      expect(canon(once, { home })).toBe(once);
    }
  });
});

describe('displayPath', () => {
  it('prefixes ~ for paths under home', () => {
    expect(displayPath('/home/u/proj/x', home)).toBe('~/proj/x');
    expect(displayPath('/home/u', home)).toBe('~');
    expect(displayPath('/home/user/x', home)).toBe('/home/user/x');
    expect(displayPath('/tmp/x', home)).toBe('/tmp/x');
    expect(displayPath('/home/u/x', '/home/u/')).toBe('~/x');
    expect(displayPath('/a', '')).toBe('/a');
    expect(displayPath('/a', '/')).toBe('/a');
  });
});

describe('basename / extname', () => {
  it('use POSIX semantics regardless of platform', () => {
    expect(basename('/a/b/c.ts')).toBe('c.ts');
    expect(basename('/a/b/')).toBe('b');
    expect(basename('C:\\a\\b.txt')).toBe('b.txt');
    expect(extname('/a/b/c.test.ts')).toBe('.ts');
    expect(extname('/a/b/Makefile')).toBe('');
    expect(extname('C:\\a\\b.txt')).toBe('.txt');
  });
});

describe('middleTruncate', () => {
  it('returns short paths unchanged', () => {
    expect(middleTruncate('/a/b/c', 20)).toBe('/a/b/c');
  });

  it('keeps the basename and elides the middle', () => {
    const p = '/Users/u/projects/foo/src/components/x.ts';
    const out = middleTruncate(p, 25);
    expect(out).toBe('/Users/u/projects/f…/x.ts');
    expect(displayWidth(out)).toBe(25);
    expect(out.endsWith('/x.ts')).toBe(true);
    for (let max = 7; max <= 40; max += 1) expect(displayWidth(middleTruncate(p, max)), `max ${max}`).toBeLessThanOrEqual(max);
  });

  it('drops a partial directory slash before the ellipsis', () => {
    expect(middleTruncate('/Users/u/projects/foo/src/components/x.ts', 24)).toBe('/Users/u/projects…/x.ts');
    expect(middleTruncate('/Users/u/projects/foo/src/x.ts', 21)).toBe('/Users/u/projec…/x.ts');
    expect(middleTruncate('/Users/u/projects/foo/src/x.ts', 20)).toBe('/Users/u/proje…/x.ts');
  });

  it('cuts a long basename from the left but never below minBase', () => {
    const long = '/a/averyveryverylongbasename.ts';
    const out = middleTruncate(long, 10);
    expect(out).toBe('…gbasename.ts');
    expect(displayWidth(out)).toBe(13);
    expect(middleTruncate(long, 16)).toBe('…longbasename.ts');
    expect(middleTruncate('averyveryverylongbasename.ts', 10, 4)).toBe('…sename.ts');
    expect(middleTruncate('nodir-but-long-name.txt', 40)).toBe('nodir-but-long-name.txt');
  });

  it('measures by display width (wide glyphs count 2)', () => {
    const out = middleTruncate('/a/日本語/b/c/日本語.md', 16);
    expect(displayWidth(out)).toBeLessThanOrEqual(16);
    expect(out.endsWith('/日本語.md')).toBe(true);
  });
});

describe('isUnder', () => {
  it('matches the parent itself and descendants only', () => {
    expect(isUnder('/a/b', '/a')).toBe(true);
    expect(isUnder('/a', '/a')).toBe(true);
    expect(isUnder('/ab', '/a')).toBe(false);
    expect(isUnder('/a/b', '/a/b/c')).toBe(false);
    expect(isUnder('/a', '/')).toBe(true);
    expect(isUnder('/a', '')).toBe(false);
    expect(isUnder('/a/b', '/a/')).toBe(true);
  });
});

describe('isTmpPath', () => {
  it('uses the default roots with /private folding', () => {
    expect(isTmpPath('/tmp/x')).toBe(true);
    expect(isTmpPath('/private/tmp/x')).toBe(true);
    expect(isTmpPath('/var/folders/ab/T/x')).toBe(true);
    expect(isTmpPath('/private/var/folders/ab/T/x')).toBe(true);
    expect(isTmpPath('/tmpfile')).toBe(false);
    expect(isTmpPath('/home/u/x')).toBe(false);
    expect(DEFAULT_TMP_ROOTS).toEqual(['/tmp', '/private/tmp', '/var/folders', '/private/var/folders']);
  });

  it('accepts injected roots', () => {
    expect(isTmpPath('/scratch/a', ['/scratch/'])).toBe(true);
    expect(isTmpPath('/tmp/a', ['/scratch'])).toBe(false);
    expect(isTmpPath('C:/Users/u/AppData/Local/Temp/x', ['C:\\Users\\u\\AppData\\Local\\Temp'])).toBe(true);
  });
});

describe('classifyScope', () => {
  const repoRoot = '/home/u/proj';
  const base: ScopeContext = { cwd: repoRoot, repoRoot, home };

  it('classifies every §4.6.1 scope', () => {
    expect(classifyScope('/home/u/proj/src/x.ts', base)).toBe('repo');
    expect(classifyScope('/home/u/proj', base)).toBe('repo');
    expect(classifyScope('/home/u/proj/.claude/settings.json', base)).toBe('repo');
    expect(classifyScope('/home/u/proj/.claude/worktrees/abc123/src/x.ts', base)).toBe('worktree');
    expect(classifyScope('/home/u/proj/.claude/worktrees', base)).toBe('repo');
    expect(classifyScope('/tmp/out.txt', base)).toBe('scratch');
    expect(classifyScope('/private/var/folders/ab/T/x', base)).toBe('scratch');
    expect(classifyScope('/home/u/.claude/x', base)).toBe('harness-config');
    expect(classifyScope('/home/u/.codex/config.toml', base)).toBe('harness-config');
    expect(classifyScope('/home/u/.showreceipts/cache/x', base)).toBe('harness-config');
    expect(classifyScope('/home/u/.zshrc', base)).toBe('home-dotfile');
    expect(classifyScope('/home/u/.config/gh/hosts.yml', base)).toBe('home-dotfile');
    expect(classifyScope('/etc/hosts', base)).toBe('system');
    expect(classifyScope('/private/etc/hosts', base)).toBe('system');
    expect(classifyScope('/usr/local/bin/x', base)).toBe('system');
    expect(classifyScope('/Library/x', base)).toBe('system');
    expect(classifyScope('/home/u/other/src/y.ts', { ...base, otherRepoRoot: '/home/u/other' })).toBe('other-repo');
    expect(classifyScope('/home/u/Documents/notes.txt', base)).toBe('unknown');
    expect(classifyScope('/home/u/proj-sibling/x', base)).toBe('unknown');
  });

  it('is unknown without a repository, even under the cwd', () => {
    const noRepo: ScopeContext = { cwd: '/home/u/scratchdir', repoRoot: null, home };
    expect(classifyScope('/home/u/scratchdir/x.ts', noRepo)).toBe('unknown');
    expect(classifyScope('/tmp/x', noRepo)).toBe('scratch');
    expect(classifyScope('/home/u/.zshrc', noRepo)).toBe('home-dotfile');
    expect(classifyScope('x.ts', { cwd: '/home/u/proj', repoRoot: null, home })).toBe('unknown');
  });

  it('resolves relative paths against the cwd first', () => {
    expect(classifyScope('src/x.ts', base)).toBe('repo');
    expect(classifyScope('../x', { ...base, cwd: '/tmp/work' })).toBe('scratch');
    expect(classifyScope('', { ...base, cwd: '/home/u/proj/src' })).toBe('repo');
  });

  it('ignores otherRepoRoot when it is null, empty or the same as repoRoot', () => {
    expect(classifyScope('/home/u/proj/x', { ...base, otherRepoRoot: repoRoot })).toBe('repo');
    expect(classifyScope('/home/u/elsewhere/x', { ...base, otherRepoRoot: null })).toBe('unknown');
    expect(classifyScope('/home/u/elsewhere/x', { ...base, otherRepoRoot: '' })).toBe('unknown');
    expect(classifyScope('/home/u/elsewhere/x', { ...base, otherRepoRoot: '/home/u/elsewhere/' })).toBe('other-repo');
  });

  it('honours injected temp roots and harness config dirs', () => {
    const ctx: ScopeContext = { ...base, tmpRoots: ['/scratch'], harnessConfigDirs: ['/opt/harness'] };
    expect(classifyScope('/scratch/x', ctx)).toBe('scratch');
    expect(classifyScope('/tmp/x', ctx)).toBe('unknown');
    expect(classifyScope('/opt/harness/x', ctx)).toBe('harness-config');
    expect(classifyScope('/home/u/.claude/x', ctx)).toBe('home-dotfile');
  });

  it('treats an empty repoRoot like none and a root-level home safely', () => {
    expect(classifyScope('/x', { cwd: '/', repoRoot: '', home: '/' })).toBe('unknown');
    expect(classifyScope('/.zshrc', { cwd: '/', repoRoot: null, home: '/' })).toBe('unknown');
    expect(classifyScope('/etc/x', { cwd: '/', repoRoot: null, home: '' })).toBe('system');
  });
});

describe('resolveAgainst', () => {
  it('joins relative paths and leaves absolute-like ones alone', () => {
    expect(resolveAgainst('/home/u/proj', 'src/x.ts')).toBe('/home/u/proj/src/x.ts');
    expect(resolveAgainst('/home/u/proj', '../x')).toBe('/home/u/x');
    expect(resolveAgainst('/home/u/proj', './a/../b/')).toBe('/home/u/proj/b');
    expect(resolveAgainst('/home/u/proj', '/private/tmp/x')).toBe('/tmp/x');
    expect(resolveAgainst('/home/u/proj', '~/x')).toBe('~/x');
    expect(resolveAgainst('/home/u/proj', '~')).toBe('~');
    expect(resolveAgainst('/home/u/proj', 'C:\\a\\b')).toBe('C:/a/b');
    expect(resolveAgainst('/home/u/proj/', '')).toBe('/home/u/proj');
    expect(resolveAgainst('C:\\work', 'x.txt')).toBe('C:/work/x.txt');
  });
});
