/**
 * S27 — `hook/paths.ts` (§9): hostile session ids never escape their base
 * directory, `unknownSid` is stable per (cwd, hour), and `lastReceiptDir`
 * picks the git-worktree location for a cwd inside a repository (`.git`
 * directory or worktree file) and the home location otherwise.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assertInside,
  HookPathError,
  lastReceiptDir,
  ledgerPath,
  safeSid,
  statePath,
  unknownSid,
} from '../../../src/hook/paths.js';
import { makeTempDir } from '../../helpers/tmp.js';

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const HOSTILE_SIDS = ['../../x', '/abs/path', 'a\\b', 'A'.repeat(4096), '', '..', '.hidden', 'a b', 'x/../../y'];

describe('ledgerPath / statePath', () => {
  it('hostile sids never escape the ledger directory', () => {
    const home = tempDir('sr-paths-home-');
    for (const sid of HOSTILE_SIDS) {
      const p = ledgerPath(home, 'cursor', sid);
      const rel = relative(join(home, 'ledger', 'cursor'), p);
      expect(rel.includes('..'), `sid ${JSON.stringify(sid)} escaped: ${rel}`).toBe(false);
      expect(isAbsolute(rel)).toBe(false);
      expect(rel.includes(sep)).toBe(false);
      expect(p.endsWith('.jsonl')).toBe(true);
    }
  });

  it('hostile sids never escape the state directory', () => {
    const home = tempDir('sr-paths-home-');
    for (const sid of HOSTILE_SIDS) {
      const p = statePath(home, 'gemini', sid);
      const rel = relative(join(home, 'state', 'gemini'), p);
      expect(rel.includes('..')).toBe(false);
      expect(isAbsolute(rel)).toBe(false);
      expect(rel.includes(sep)).toBe(false);
      expect(p.endsWith('.json')).toBe(true);
    }
  });

  it('a safe sid is used verbatim; a hostile one becomes the h-hash form', () => {
    const home = tempDir('sr-paths-home-');
    expect(ledgerPath(home, 'gemini', 'abc-123.DEF')).toBe(join(home, 'ledger', 'gemini', 'abc-123.DEF.jsonl'));
    const hashed = ledgerPath(home, 'gemini', '../../x');
    expect(hashed).toBe(join(home, 'ledger', 'gemini', `${safeSid('../../x')}.jsonl`));
    expect(/^h[0-9a-f]{32}\.jsonl$/.test(hashed.split(sep).pop() ?? '')).toBe(true);
  });
});

describe('unknownSid', () => {
  it('is unknown- plus 16 hex, stable per (cwd, hour)', () => {
    const a = unknownSid('/home/u/proj', '2026-08-29T12:00:00.000Z');
    expect(a).toMatch(/^unknown-[0-9a-f]{16}$/);
    expect(unknownSid('/home/u/proj', '2026-08-29T12:59:59.000Z')).toBe(a);
    expect(unknownSid('/home/u/proj', '2026-08-29T13:00:00.000Z')).not.toBe(a);
    expect(unknownSid('/home/u/other', '2026-08-29T12:00:00.000Z')).not.toBe(a);
  });
});

describe('lastReceiptDir', () => {
  it('picks <gitRoot>/.showreceipts for a cwd inside a repository (.git directory)', () => {
    const root = tempDir('sr-paths-git-');
    const home = tempDir('sr-paths-home-');
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    expect(lastReceiptDir(root, home, 'claude-code', 'sid')).toBe(join(root, '.showreceipts'));
    expect(lastReceiptDir(join(root, 'a', 'b'), home, 'claude-code', 'sid')).toBe(join(root, '.showreceipts'));
  });

  it('recognises a worktree .git file (gitdir: …)', () => {
    const root = tempDir('sr-paths-worktree-');
    const home = tempDir('sr-paths-home-');
    writeFileSync(join(root, '.git'), 'gitdir: /somewhere/repo/.git/worktrees/wt\n');
    expect(lastReceiptDir(root, home, 'codex', 'sid')).toBe(join(root, '.showreceipts'));
  });

  it('falls back to <home>/last/<harness> outside any repository', () => {
    const cwd = tempDir('sr-paths-plain-');
    const home = tempDir('sr-paths-home-');
    expect(lastReceiptDir(cwd, home, 'cursor', 'sid')).toBe(join(home, 'last', 'cursor'));
  });

  it('a .git file without a gitdir pointer is not a repository', () => {
    const cwd = tempDir('sr-paths-notgit-');
    const home = tempDir('sr-paths-home-');
    writeFileSync(join(cwd, '.git'), 'not a gitdir pointer\n');
    expect(lastReceiptDir(cwd, home, 'cursor', 'sid')).toBe(join(home, 'last', 'cursor'));
  });
});

describe('assertInside', () => {
  it('accepts a strict child and returns it', () => {
    expect(assertInside('/base', '/base/child/file.txt')).toBe('/base/child/file.txt');
  });

  it('rejects the base itself, parents, absolute escapes and sibling prefixes', () => {
    expect(() => assertInside('/base', '/base')).toThrow(HookPathError);
    expect(() => assertInside('/base', '/base/..')).toThrow(HookPathError);
    expect(() => assertInside('/base', '/base/../evil')).toThrow(HookPathError);
    expect(() => assertInside('/base', '/etc/passwd')).toThrow(HookPathError);
    expect(() => assertInside('/base', '/base-evil/x')).toThrow(HookPathError);
  });
});
