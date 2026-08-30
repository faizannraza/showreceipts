import { describe, expect, it } from 'vitest';
import { sanitize, sanitizeForCell } from '../../../src/util/sanitize.js';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI8 = String.fromCharCode(0x9b);
const cp = (n: number): string => String.fromCodePoint(n);

/** True when the string contains none of the bytes/characters sanitisation must remove. */
function isClean(s: string): boolean {
  for (const ch of s) {
    const code = ch.codePointAt(0) as number;
    if (code === 0x1b || code === 0x9b) return false;
    if (code <= 0x08 || (code >= 0x0b && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) return false;
    if (code === 0x09 || code === 0x0a) return false;
    if (code === 0x2028 || code === 0x2029) return false;
    if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return false;
    if ((code >= 0x200b && code <= 0x200f) || code === 0xfeff) return false;
  }
  return true;
}

describe('sanitize', () => {
  it('neutralises OSC 52 clipboard writes', () => {
    const out = sanitize(`tests pass${ESC}]52;c;aGVsbG8=${BEL} done`);
    expect(out).toBe('tests pass done');
    expect(isClean(out)).toBe(true);
  });

  it('neutralises CSI colour, 8-bit CSI and stray escapes', () => {
    expect(sanitize(`${ESC}[31mred${ESC}[0m`)).toBe('red');
    expect(sanitize(`a${CSI8}31mb`)).toBe('ab');
    const lone = sanitize(`a${ESC}b${ESC}`);
    expect(lone).toBe('ab');
    expect(isClean(lone)).toBe(true);
  });

  it('removes bidi controls (RLO prefix, isolates, marks) and line separators', () => {
    const rlo = `${cp(0x202e)}gnp.evil${cp(0x202c)}`;
    expect(sanitize(rlo)).toBe('gnp.evil');
    const iso = `${cp(0x2066)}a${cp(0x2067)}b${cp(0x2068)}c${cp(0x2069)}${cp(0x200e)}${cp(0x200f)}${cp(0x061c)}`;
    expect(sanitize(iso)).toBe('abc');
    expect(sanitize(`one${cp(0x2028)}two${cp(0x2029)}three`)).toBe('onetwothree');
    expect(isClean(sanitize(rlo + iso))).toBe(true);
  });

  it('removes zero-width characters and the BOM', () => {
    expect(sanitize(`${cp(0xfeff)}a${cp(0x200b)}b${cp(0x200c)}c${cp(0x200d)}d${cp(0x2060)}e`)).toBe('abcde');
  });

  it('maps tabs and newlines to one space and collapses runs', () => {
    expect(sanitize('a\tb\r\nc\nd')).toBe('a b c d');
    expect(sanitize('a \t \n b')).toBe('a b');
    expect(sanitize('a\rb')).toBe('ab');
  });

  it('deletes C0 and C1 controls and DEL', () => {
    expect(sanitize(`a${String.fromCharCode(0)}b${String.fromCharCode(0x7f)}c${String.fromCharCode(0x85)}d`)).toBe('abcd');
    expect(sanitize(`x${String.fromCharCode(0x08)}y`)).toBe('xy');
  });

  it('keeps ordinary Unicode text, combining marks and emoji', () => {
    const text = 'café 日本語.md ✅ tests pass — done…';
    expect(sanitize(text)).toBe(text);
    expect(sanitize('')).toBe('');
  });

  it('never leaves 0x1b/0x9b or bidi controls whatever the input', () => {
    const nasty = `${cp(0x202e)}${ESC}]8;;http://x${BEL}link${ESC}]8;;${BEL}${CSI8}?25l\t${cp(0x2028)}${ESC}`;
    expect(isClean(sanitize(nasty))).toBe(true);
  });
});

describe('sanitizeForCell', () => {
  it('turns every whitespace kind into single spaces and trims', () => {
    expect(sanitizeForCell('  a  b　c \n ')).toBe('a b c');
    expect(sanitizeForCell(`${ESC}[1m  bold  ${ESC}[0m`)).toBe('bold');
    expect(sanitizeForCell('')).toBe('');
  });
});
