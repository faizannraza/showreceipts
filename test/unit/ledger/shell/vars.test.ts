import { describe, expect, it } from 'vitest';
import { parseAssignment, resolveWord, substitute, tokenize } from '../../../../src/ledger/shell/index.js';
import type { WordLike } from '../../../../src/ledger/shell/vars.js';

const cwd = '/home/u/proj';
const opts = { home: '/home/u' };

function w(text: string, flags: Partial<WordLike> = {}): WordLike {
  return { text, scan: text, dollar: false, subst: false, glob: false, ...flags };
}

describe('parseAssignment (§4.5.4)', () => {
  it('parses NAME=value', () => {
    expect(parseAssignment(w('OUT=/tmp/a'))).toEqual({ name: 'OUT', value: '/tmp/a', literal: true });
  });

  it('accepts quoted values (scan keeps the unquoted prefix)', () => {
    expect(parseAssignment({ text: 'OUT=/tmp/a b', scan: 'OUT=', dollar: false, subst: false, glob: false })).toEqual({
      name: 'OUT',
      value: '/tmp/a b',
      literal: true,
    });
  });

  it('marks $-bearing values non-literal', () => {
    expect(parseAssignment(w('OUT=$HOME/x', { dollar: true }))?.literal).toBe(false);
    expect(parseAssignment(w('OUT=$(pwd)', { subst: true }))?.literal).toBe(false);
  });

  it('rejects non-assignments', () => {
    expect(parseAssignment(w('echo'))).toBeNull();
    expect(parseAssignment(w('=x'))).toBeNull();
    expect(parseAssignment(w('2FOO=x'))).toBeNull();
    expect(parseAssignment({ text: 'a=b', scan: '', dollar: false, subst: false, glob: false })).toBeNull();
  });
});

describe('substitute', () => {
  const vars = new Map([
    ['OUT', '/tmp/a'],
    ['NAME', 'result'],
  ]);

  it('substitutes $NAME and ${NAME}', () => {
    expect(substitute('$OUT/${NAME}.txt', vars)).toBe('/tmp/a/result.txt');
  });

  it('leaves unknown names alone', () => {
    expect(substitute('$OTHER/x', vars)).toBe('$OTHER/x');
  });
});

describe('resolveWord', () => {
  const vars = new Map([['OUT', '/tmp/a']]);

  it('resolves a known variable', () => {
    expect(resolveWord(w('$OUT', { dollar: true }), vars)).toEqual({ text: '/tmp/a', resolved: true });
  });

  it('keeps raw text for unknown variables', () => {
    expect(resolveWord(w('$MISSING', { dollar: true }), vars)).toEqual({ text: '$MISSING', resolved: false });
  });

  it('globs and substitutions are unresolved', () => {
    expect(resolveWord(w('*.txt', { glob: true }), vars).resolved).toBe(false);
    expect(resolveWord(w('$(pwd)/x', { subst: true }), vars).resolved).toBe(false);
  });
});

describe('end to end through tokenize', () => {
  it('OUT=/tmp/a; echo x > $OUT resolves the target', () => {
    const p = tokenize('OUT=/tmp/a; echo x > $OUT', cwd, opts);
    const echo = p.segments.find((s) => s.program === 'echo');
    expect(echo?.redirects).toEqual([{ op: '>', target: '/tmp/a', resolved: true }]);
  });

  it('a prefix assignment substitutes within its own command', () => {
    const p = tokenize('OUT=/tmp/b cat report.txt > $OUT', cwd, opts);
    expect(p.segments[0]?.redirects[0]).toEqual({ op: '>', target: '/tmp/b', resolved: true });
    expect(p.segments[0]?.assignments).toEqual({ OUT: '/tmp/b' });
  });

  it('echo x > "$OUT" with no assignment stays unresolved', () => {
    const p = tokenize('echo x > "$OUT"', cwd, opts);
    expect(p.segments[0]?.redirects[0]).toEqual({ op: '>', target: '$OUT', resolved: false });
  });

  it('substitutes cp/mv/sed operands', () => {
    const p = tokenize('SRC=a.txt; cp $SRC /tmp/', cwd, opts);
    const cp = p.segments.find((s) => s.program === 'cp');
    expect(cp?.argv).toEqual(['a.txt', '/tmp/']);
  });

  it('never reads process.env (HOME=/nonexistent SCRATCH=/secret never appear)', () => {
    const p = tokenize('echo $HOME > $SCRATCH/out.txt', cwd, opts);
    const dump = JSON.stringify(p);
    expect(dump).not.toContain('/nonexistent');
    expect(dump).not.toContain('/secret');
    expect(p.segments[0]?.redirects[0]?.resolved).toBe(false);
    expect(p.segments[0]?.redirects[0]?.target).toBe('$SCRATCH/out.txt');
  });
});
