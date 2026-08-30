/**
 * Terminal display width (§10.1) without `Intl`: iterate by code point; width
 * 0 for marks, format controls, ZWJ, variation selectors, zero-width spaces,
 * emoji skin-tone modifiers; width 2 for East Asian Wide/Fullwidth ranges
 * and Emoji_Presentation ranges; 1 otherwise (ambiguous = 1). Cuts happen
 * on cluster boundaries (a base code point plus its zero-width followers and
 * ZWJ-joined continuation), so a combining sequence or surrogate pair is
 * never split.
 */
import { stripVTControlCharacters } from 'node:util';

const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}\u200b-\u200f\ufeff\ufe0e\ufe0f\u{1f3fb}-\u{1f3ff}]$/u;
const CONTROL = /^[\x00-\x1f\x7f-\x9f]$/;

/** Inclusive code-point ranges that occupy two columns (EastAsianWidth W/F + Emoji_Presentation). */
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x17000, 0x18aff],
  [0x1b000, 0x1b2ff],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f202],
  [0x1f210, 0x1f23b],
  [0x1f240, 0x1f248],
  [0x1f250, 0x1f251],
  [0x1f260, 0x1f265],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f7e0, 0x1f7ff],
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

function isWide(cp: number): boolean {
  if (cp < 0x1100) return false;
  let lo = 0;
  let hi = WIDE.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = WIDE[mid] as readonly [number, number];
    if (cp < range[0]) hi = mid - 1;
    else if (cp > range[1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Columns occupied by one code point (given as a one-code-point string). */
export function codePointWidth(ch: string): number {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return 0;
  if (CONTROL.test(ch) || ZERO_WIDTH.test(ch)) return 0;
  return isWide(cp) ? 2 : 1;
}

interface Cluster {
  text: string;
  width: number;
}

const ZWJ = '\u200d';

/**
 * Splits a (control-free) string into display clusters: a base code point,
 * its zero-width followers, and anything joined to it by ZWJ. Every cut a
 * caller makes is between clusters.
 */
function clusters(s: string): Cluster[] {
  const out: Cluster[] = [];
  let joinNext = false;
  for (const ch of s) {
    const w = codePointWidth(ch);
    const last = out[out.length - 1];
    if (last !== undefined && (w === 0 || joinNext)) {
      last.text += ch;
      last.width += w;
    } else {
      out.push({ text: ch, width: w });
    }
    joinNext = ch === ZWJ;
  }
  return out;
}

/** Display width of `s` after stripping ANSI sequences. */
export function displayWidth(s: string): number {
  let width = 0;
  for (const ch of stripVTControlCharacters(s)) width += codePointWidth(ch);
  return width;
}

/**
 * `s` when it fits in `w` columns, else the longest prefix that leaves room
 * for `ellipsis` (its width counts), cut on a cluster boundary — a trailing
 * emoji that does not fit is dropped whole. ANSI is stripped first; colour is
 * applied after layout. `w` below the ellipsis width yields an empty string.
 */
export function truncateToWidth(s: string, w: number, ellipsis = '…'): string {
  const plain = stripVTControlCharacters(s);
  if (displayWidth(plain) <= w) return plain;
  const tailWidth = displayWidth(ellipsis);
  if (w < tailWidth) return '';
  const budget = w - tailWidth;
  let used = 0;
  let out = '';
  for (const c of clusters(plain)) {
    if (used + c.width > budget) break;
    used += c.width;
    out += c.text;
  }
  return out + ellipsis;
}

/** Breaks one over-wide token into pieces of at most `w` columns, on cluster boundaries. */
function hardBreak(token: string, w: number): string[] {
  const pieces: string[] = [];
  let current = '';
  let used = 0;
  for (const c of clusters(token)) {
    if (used > 0 && used + c.width > w) {
      pieces.push(current);
      current = '';
      used = 0;
    }
    current += c.text;
    used += c.width;
  }
  if (current !== '') pieces.push(current);
  return pieces;
}

/**
 * Greedy word wrap at spaces to lines of at most `w` columns; a token wider
 * than `w` is hard-broken. When more than `maxLines` lines result, the first
 * `maxLines` are kept and the last one is truncated with `…` so the reader
 * sees that text was cut. Returns at least one line (empty input ⇒ `['']`);
 * `maxLines <= 0` ⇒ `[]`.
 */
export function wrapToWidth(s: string, w: number, maxLines: number): string[] {
  if (maxLines <= 0) return [];
  const width = Math.max(1, w);
  const words = stripVTControlCharacters(s).split(' ').filter((word) => word !== '');
  const lines: string[] = [];
  let current = '';
  let used = 0;
  const flush = (): void => {
    lines.push(current);
    current = '';
    used = 0;
  };
  for (const word of words) {
    const pieces = displayWidth(word) > width ? hardBreak(word, width) : [word];
    for (const piece of pieces) {
      const pw = displayWidth(piece);
      if (used === 0) {
        current = piece;
        used = pw;
      } else if (used + 1 + pw <= width) {
        current += ` ${piece}`;
        used += 1 + pw;
      } else {
        flush();
        current = piece;
        used = pw;
      }
    }
  }
  if (used > 0 || lines.length === 0) flush();
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const rest = lines.slice(maxLines - 1).join(' ');
  kept[maxLines - 1] = truncateToWidth(rest, width);
  return kept;
}

/** Pads `s` with spaces on the right to `w` columns; never truncates. */
export function padEnd(s: string, w: number): string {
  const missing = w - displayWidth(s);
  return missing > 0 ? s + ' '.repeat(missing) : s;
}
