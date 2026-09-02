/**
 * S15 — the PATH grammar (ARCHITECTURE §4.7 step 6, cases a–d) and
 * `resolveSubject` (exact → relative → basename → ambiguous → unresolved).
 */
import { describe, expect, it } from 'vitest';
import { EXTENSIONS, findPaths, resolveSubject } from '../../../src/claims/paths.js';

const displays = (clause: string, ledger: string[] = []): string[] => findPaths(clause, ledger).map((p) => p.display);

describe('findPaths — case (a): backticked tokens', () => {
  it('accepts slash, extension and trailing-slash forms', () => {
    expect(displays('updated `src/wattage/models.py` and `mkdocs.yml` and `legacy/`')).toEqual([
      'src/wattage/models.py',
      'mkdocs.yml',
      'legacy/',
    ]);
  });

  it('rejects snippets with whitespace, <, >, = or $', () => {
    expect(displays('ran `pip install x` with `<placeholder>` and `A=1` and `$HOME` and `a > b`')).toEqual([]);
  });

  it('rejects product names and URLs', () => {
    expect(displays('uses `node.js`, `socket.io` and `https://readthedocs.io/x.md`')).toEqual([]);
  });

  it('handles Windows separators', () => {
    expect(displays('fixed `src\\old.ts`')).toEqual(['src/old.ts']);
  });
});

describe('findPaths — case (b): bare tokens with a slash', () => {
  it('accepts extension, anchor-directory and dot-prefixed forms', () => {
    expect(displays('touched src/wattage/cli.py plus tests/api and ./scripts/tool.py and ~/notes/plan.md')).toEqual([
      'src/wattage/cli.py',
      'tests/api',
      'scripts/tool.py',
      '~/notes/plan.md',
    ]);
  });

  it('rejects unanchored, short-segment, numeric and version-like tokens', () => {
    expect(displays('foo/bar src/db src/123/x v2.1.214 code/2.5')).toEqual([]);
  });

  it('rejects URLs and tokens with forbidden characters', () => {
    expect(displays('see https://example.io/a.md and src/a(b).ts and U+2028')).toEqual([]);
  });

  it('rejects English alternation pairs like doc/code', () => {
    expect(displays('fixed a doc/code drift and a pass/fail case')).toEqual([]);
  });

  it('accepts a token matching a ledger path or dirname', () => {
    expect(displays('changed backend/api today', ['backend/api/routes.py'])).toEqual(['backend/api']);
    expect(displays('changed backend/api today', [])).toEqual([]);
  });
});

describe('findPaths — cases (c) and (d): bare tokens', () => {
  it('accepts a known extension and strips trailing punctuation', () => {
    expect(displays('updated README.md, notes.txt.')).toEqual(['README.md', 'notes.txt']);
  });

  it('rejects versions, decimals, domains and the product stoplist', () => {
    expect(displays('on node.js 2.5 with v1.2.3 and asp.net and a.b.c')).toEqual([]);
  });

  it('accepts a bare ledger basename (case d), backticked or not', () => {
    expect(displays('rebuilt Makefile from scratch', ['/repo/Makefile'])).toEqual(['Makefile']);
    expect(displays('rebuilt `Makefile` from scratch', ['/repo/Makefile'])).toEqual(['Makefile']);
    expect(displays('rebuilt Makefile from scratch', [])).toEqual([]);
  });

  it('keeps a possessive stem (`mkdocs.yml`’s)', () => {
    expect(displays("fixed mkdocs.yml's URL")).toEqual(['mkdocs.yml']);
  });

  it('exposes the known extension list', () => {
    expect(EXTENSIONS).toContain('.py');
    expect(EXTENSIONS).toContain('.plist');
    expect(EXTENSIONS).not.toContain('.c');
  });
});

describe('resolveSubject', () => {
  const ledger = ['/repo/src/app.py', '/repo/tests/test_app.py', '/repo/docs/app.py', '/repo/Makefile'];

  it('exact canon wins', () => {
    expect(resolveSubject('/repo/src/app.py', ledger, '/repo')).toEqual({
      canon: '/repo/src/app.py',
      status: 'exact',
      candidates: ['/repo/src/app.py'],
    });
  });

  it('resolves relative to cwd', () => {
    expect(resolveSubject('tests/test_app.py', ledger, '/repo')).toEqual({
      canon: '/repo/tests/test_app.py',
      status: 'relative',
      candidates: ['/repo/tests/test_app.py'],
    });
  });

  it('resolves a unique basename', () => {
    expect(resolveSubject('Makefile', ledger, '/elsewhere')).toEqual({
      canon: '/repo/Makefile',
      status: 'basename',
      candidates: ['/repo/Makefile'],
    });
  });

  it('reports ambiguous basenames with candidates', () => {
    const res = resolveSubject('app.py', ledger, '/elsewhere');
    expect(res.status).toBe('ambiguous');
    expect(res.candidates).toEqual(['/repo/src/app.py', '/repo/docs/app.py']);
    expect(res.canon).toBeUndefined();
  });

  it('reports unresolved otherwise', () => {
    expect(resolveSubject('missing.py', ledger, '/repo')).toEqual({ status: 'unresolved', candidates: [] });
  });

  it('normalises Windows separators and trailing slashes before matching', () => {
    expect(resolveSubject('src\\app.py', ledger, '/repo').status).toBe('relative');
    expect(resolveSubject('/repo/src/app.py/', ledger, '/repo').status).toBe('exact');
  });
});
