/**
 * SVG render of the terminal receipt (§10.1, S23b): the exact lines of
 * `renderReceiptLines` drawn on a dark paper background, one
 * `<text xml:space="preserve" textLength lengthAdjust="spacingAndGlyphs">`
 * per line with `cw = 0.6 × font-size`, the monospace stack of §10.1 and the
 * S20 ANSI paint kinds mapped to `<tspan fill>` colours.
 *
 * Deterministic by construction: pure string assembly from the receipt alone
 * (no clock, no environment, no randomness) — rendering twice yields
 * byte-identical output, which the golden asserts. Every text fragment is
 * XML-escaped; the document contains no script, no link and no external
 * reference beyond the mandatory SVG namespace.
 */
import type { Receipt } from '../model/types.js';
import { SGR, strip } from '../util/ansi.js';
import { displayWidth } from '../util/width.js';
import type { Tz } from '../util/time.js';
import { renderReceiptLines } from './term.js';

/** Options of {@link renderReceiptSvg}; a subset of the terminal options (colour is always on). */
export interface SvgOptions {
  /** Terminal columns to lay the receipt out for (already resolved). */
  cols: number;
  /** Unicode frame and glyphs. */
  unicode: boolean;
  /** Time zone for printed clocks (default `utc`). */
  tz?: Tz | undefined;
  /** The user's home directory (`~` display form of the cwd). */
  homeDir: string;
}

/** Font size in px; the §10.1 rule fixes the advance at `cw = 0.6 × font-size`. */
const FONT_SIZE = 14;
/** Character advance width in px (`0.6 × FONT_SIZE`). */
const CHAR_WIDTH = 8.4;
/** Line height in px. */
const LINE_HEIGHT = 20;
/** Baseline offset of a line's `<text>` within its line box. */
const BASELINE = 15;
/** Padding of the paper around the text block, px. */
const PADDING = 24;

/** The §10.1 monospace stack (single quotes: the attribute is double-quoted). */
const FONT_STACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace";

/** Dark paper palette: background, default ink and one fill per SGR paint code. */
const BACKGROUND = '#12161c';
const INK = '#e6edf3';
const FILL_BY_SGR: Readonly<Record<number, string>> = {
  [SGR.bad]: '#f85149',
  [SGR.ok]: '#3fb950',
  [SGR.unk]: '#d29922', // also `warn` (same SGR code)
  [SGR.dim]: '#8b949e',
};

/** XML-escapes text content and attribute values. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Fixed-point pixel value (one decimal, no float noise): `px(74 * CHAR_WIDTH)` → `621.6`. */
function px(n: number): string {
  const tenths = Math.round(n * 10);
  return tenths % 10 === 0 ? String(tenths / 10) : (tenths / 10).toFixed(1);
}

/** One painted run of a line: text plus the SGR codes active when it was emitted. */
interface Run {
  text: string;
  codes: readonly number[];
}

const SGR_RE = /\x1b\[(\d+)m/g;

/**
 * Splits one ANSI-painted line into runs. The S20 renderer nests at most
 * one paint around already-painted fragments (glyphs inside verdict lines),
 * so a stack of active codes is kept; `0` pops to empty (the renderer always
 * resets fully).
 */
function runsOf(line: string): Run[] {
  const runs: Run[] = [];
  const active: number[] = [];
  let last = 0;
  SGR_RE.lastIndex = 0;
  for (let m = SGR_RE.exec(line); m !== null; m = SGR_RE.exec(line)) {
    const text = line.slice(last, m.index);
    if (text !== '') runs.push({ text, codes: [...active] });
    const code = Number(m[1]);
    if (code === 0) active.length = 0;
    else active.push(code);
    last = m.index + m[0].length;
  }
  const tail = line.slice(last);
  if (tail !== '') runs.push({ text: tail, codes: [...active] });
  return runs;
}

/** The `<tspan>` attributes of a run: the innermost colour-bearing code wins; bold adds weight. */
function tspanAttrs(codes: readonly number[]): string {
  let fill: string | undefined;
  let bold = false;
  for (const code of codes) {
    const f = FILL_BY_SGR[code];
    if (f !== undefined) fill = f;
    if (code === SGR.bold) bold = true;
  }
  let attrs = '';
  if (fill !== undefined) attrs += ` fill="${fill}"`;
  if (bold) attrs += ' font-weight="bold"';
  return attrs;
}

/** One line's `<text>` element; plain lines carry no tspans. */
function textElement(line: string, index: number): string {
  const runs = runsOf(line);
  const width = displayWidth(line); // `displayWidth` ignores the ANSI paint
  const y = PADDING + index * LINE_HEIGHT + BASELINE;
  const open = `<text x="${PADDING}" y="${y}" textLength="${px(width * CHAR_WIDTH)}" lengthAdjust="spacingAndGlyphs" xml:space="preserve">`;
  const body = runs
    .map((run) => {
      const attrs = tspanAttrs(run.codes);
      return attrs === '' ? esc(run.text) : `<tspan${attrs}>${esc(run.text)}</tspan>`;
    })
    .join('');
  return `${open}${body}</text>`;
}

/**
 * Renders one receipt as a standalone SVG document (§10.1 `render/svg.ts`):
 * the terminal render (colour on) parsed into `<tspan fill>` runs on a dark
 * paper background. Same bytes on every call for the same inputs.
 */
export function renderReceiptSvg(receipt: Receipt, opts: SvgOptions): string {
  const lines = renderReceiptLines(receipt, {
    cols: opts.cols,
    unicode: opts.unicode,
    color: true,
    tz: opts.tz ?? 'utc',
    homeDir: opts.homeDir,
  });
  let maxWidth = 0;
  for (const line of lines) maxWidth = Math.max(maxWidth, displayWidth(strip(line)));
  const width = px(maxWidth * CHAR_WIDTH + 2 * PADDING);
  const height = px(lines.length * LINE_HEIGHT + 2 * PADDING);
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="showreceipts receipt #${esc(strip(receipt.shortId))}">`,
    `<rect width="${width}" height="${height}" rx="8" fill="${BACKGROUND}"/>`,
    `<g font-family="${FONT_STACK}" font-size="${FONT_SIZE}" fill="${INK}">`,
  ];
  lines.forEach((line, i) => parts.push(textElement(line, i)));
  parts.push('</g>', '</svg>', '');
  return parts.join('\n');
}
