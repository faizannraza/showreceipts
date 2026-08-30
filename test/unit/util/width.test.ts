import { describe, expect, it } from 'vitest';
import { paint } from '../../../src/util/ansi.js';
import { codePointWidth, displayWidth, padEnd, truncateToWidth, wrapToWidth } from '../../../src/util/width.js';

const cp = (n: number): string => String.fromCodePoint(n);
const ZWJ = cp(0x200d);
const VS16 = cp(0xfe0f);
const CAFE = `cafe${cp(0x0301)}`;

describe('displayWidth (§10.1 unit cases)', () => {
  it('counts Emoji_Presentation glyphs as 2 columns', () => {
    // §10.1 lists U+2705 among the width-2 ranges; the plan's 12/9 figures assumed width 1 and lose to the architecture.
    expect(displayWidth('✅ tests pass')).toBe(13);
    expect(displayWidth('📦 shipped')).toBe(10);
    expect(displayWidth('✅')).toBe(2);
    expect(displayWidth('📦')).toBe(2);
    expect(displayWidth('❌')).toBe(2);
    expect(displayWidth('⭐')).toBe(2);
  });

  it('counts combining sequences by their base', () => {
    expect(CAFE.length).toBe(5);
    expect(displayWidth(CAFE)).toBe(4);
  });

  it('counts East Asian wide glyphs as 2', () => {
    expect(displayWidth('日本語.md')).toBe(9);
    expect(displayWidth('ｆｕｌｌ')).toBe(8);
    expect(displayWidth('한글')).toBe(4);
  });

  it('ignores ANSI colouring', () => {
    expect(displayWidth(paint('ok', 'ok'))).toBe(2);
    expect(displayWidth(paint('bold', paint('bad', '✗ fail')))).toBe(6);
  });

  it('treats ambiguous-width glyphs as 1', () => {
    expect(displayWidth('…')).toBe(1);
    expect(displayWidth('·→×≈–—')).toBe(6);
    expect(displayWidth('✓✗')).toBe(2);
  });

  it('treats ZWJ, variation selectors, zero-width spaces, BOM and skin tones as 0', () => {
    expect(displayWidth(ZWJ)).toBe(0);
    expect(displayWidth(`❤${VS16}`)).toBe(1);
    expect(displayWidth(`☑${cp(0xfe0e)}`)).toBe(1);
    expect(displayWidth(`a${cp(0x200b)}b${cp(0xfeff)}`)).toBe(2);
    expect(displayWidth(`👍${cp(0x1f3fd)}`)).toBe(2);
    expect(displayWidth(`👨${ZWJ}👩${ZWJ}👧`)).toBe(6);
  });

  it('gives control characters width 0 and plain ASCII width 1', () => {
    expect(displayWidth(`a${String.fromCharCode(0)}b`)).toBe(2);
    expect(displayWidth('')).toBe(0);
    expect(displayWidth('abc def')).toBe(7);
  });

  it('classifies single code points across the table edges', () => {
    expect(codePointWidth('a')).toBe(1);
    expect(codePointWidth(cp(0x10ff))).toBe(1);
    expect(codePointWidth(cp(0x1100))).toBe(2);
    expect(codePointWidth(cp(0x115f))).toBe(2);
    expect(codePointWidth(cp(0x1160))).toBe(1);
    expect(codePointWidth(cp(0x3040))).toBe(1);
    expect(codePointWidth(cp(0x4e00))).toBe(2);
    expect(codePointWidth(cp(0x9fff))).toBe(2);
    expect(codePointWidth(cp(0xa000))).toBe(2);
    expect(codePointWidth(cp(0xac00))).toBe(2);
    expect(codePointWidth(cp(0xffe6))).toBe(2);
    expect(codePointWidth(cp(0xffe7))).toBe(1);
    expect(codePointWidth(cp(0x1f004))).toBe(2);
    expect(codePointWidth(cp(0x1f005))).toBe(1);
    expect(codePointWidth(cp(0x1f9ff))).toBe(2);
    expect(codePointWidth(cp(0x1faff))).toBe(2);
    expect(codePointWidth(cp(0x1fb00))).toBe(1);
    expect(codePointWidth(cp(0x20000))).toBe(2);
    expect(codePointWidth(cp(0x3fffd))).toBe(2);
    expect(codePointWidth(cp(0x3fffe))).toBe(1);
    expect(codePointWidth(cp(0x10ffff))).toBe(1);
    expect(codePointWidth(cp(0x0301))).toBe(0);
    expect(codePointWidth(cp(0x2060))).toBe(0);
    expect(codePointWidth(cp(0x200d))).toBe(0);
    expect(codePointWidth('')).toBe(0);
  });
});

describe('truncateToWidth', () => {
  it('returns strings that fit unchanged', () => {
    expect(truncateToWidth('abc', 3)).toBe('abc');
    expect(truncateToWidth('abc', 10)).toBe('abc');
    expect(truncateToWidth('', 0)).toBe('');
  });

  it('drops a trailing emoji whole when the cut lands at width−1', () => {
    const claim = 'tests pass ✅';
    expect(displayWidth(claim)).toBe(13);
    expect(truncateToWidth(claim, 12)).toBe('tests pass …');
    expect(displayWidth(truncateToWidth(claim, 12))).toBe(12);
    expect(truncateToWidth(claim, 11)).toBe('tests pass…');
  });

  it('counts the ellipsis width and never exceeds the budget', () => {
    const s = 'abcdefghij';
    expect(truncateToWidth(s, 5)).toBe('abcd…');
    expect(truncateToWidth(s, 5, '...')).toBe('ab...');
    expect(truncateToWidth(s, 1)).toBe('…');
    expect(truncateToWidth(s, 0)).toBe('');
    expect(truncateToWidth(s, 2, '...')).toBe('');
    for (let w = 0; w <= 12; w += 1) expect(displayWidth(truncateToWidth('日本語テキスト', w))).toBeLessThanOrEqual(w);
  });

  it('never splits a combining sequence, a surrogate pair or a ZWJ cluster', () => {
    expect(truncateToWidth(`${CAFE}xyz`, 5)).toBe(`${CAFE}…`);
    expect(truncateToWidth(`${CAFE}xyz`, 4)).toBe('caf…');
    const family = `👨${ZWJ}👩${ZWJ}👧`;
    expect(truncateToWidth(`${family} home`, 6)).toBe('…');
    expect(truncateToWidth(`${family} home`, 7)).toBe(`${family}…`);
    expect(truncateToWidth('a📦b', 3)).toBe('a…');
    const out = truncateToWidth('x😀😀😀', 4);
    expect(out).toBe('x😀…');
    expect([...out].every((ch) => ch.codePointAt(0) !== undefined)).toBe(true);
  });

  it('strips ANSI before cutting', () => {
    expect(truncateToWidth(paint('ok', 'abcdef'), 4)).toBe('abc…');
    expect(truncateToWidth(paint('ok', 'ab'), 4)).toBe('ab');
  });
});

describe('wrapToWidth', () => {
  it('word-wraps at spaces', () => {
    expect(wrapToWidth('exit 0 after last edit (19:02)', 12, 3)).toEqual(['exit 0 after', 'last edit', '(19:02)']);
    expect(wrapToWidth('a b c', 10, 2)).toEqual(['a b c']);
    expect(wrapToWidth('', 10, 2)).toEqual(['']);
    expect(wrapToWidth('   ', 10, 2)).toEqual(['']);
  });

  it('turns an overflow beyond maxLines into an ellipsis on the last kept line', () => {
    const lines = wrapToWidth('one two three four five six seven', 9, 2);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('one two');
    expect(lines[1]).toBe('three fo…');
    expect(displayWidth(lines[1] as string)).toBeLessThanOrEqual(9);
  });

  it('hard-breaks a token wider than the width', () => {
    expect(wrapToWidth('abcdefghij', 4, 5)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrapToWidth('x abcdefghij y', 4, 9)).toEqual(['x', 'abcd', 'efgh', 'ij y']);
    expect(wrapToWidth('日本語テキスト', 4, 9)).toEqual(['日本', '語テ', 'キス', 'ト']);
    expect(wrapToWidth('ab 日本語', 3, 9)).toEqual(['ab', '日', '本', '語']);
  });

  it('respects maxLines 0 and width below 1', () => {
    expect(wrapToWidth('a b', 10, 0)).toEqual([]);
    expect(wrapToWidth('ab', 0, 5)).toEqual(['a', 'b']);
  });

  it('strips ANSI from the input', () => {
    expect(wrapToWidth(paint('bad', 'red words here'), 9, 2)).toEqual(['red words', 'here']);
  });
});

describe('padEnd', () => {
  it('pads by display width and never truncates', () => {
    expect(padEnd('ab', 5)).toBe('ab   ');
    expect(padEnd('日本', 6)).toBe('日本  ');
    expect(padEnd('abcdef', 3)).toBe('abcdef');
    expect(padEnd(paint('ok', 'ok'), 4)).toBe(`${paint('ok', 'ok')}  `);
  });
});
