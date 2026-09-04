/**
 * Terminal geometry and text-flow primitives shared by every text renderer
 * (§10.1): column resolution, the wide/narrow geometry table, the box frame,
 * separator-aware wrapping, evidence wrapping (trailing clocks are never
 * dropped), the header shrink order and the width assertion the snapshot
 * matrix runs. Shared by `render/term.ts`, `demo` (S23b) and the command
 * shell (S23c).
 */
import { middleTruncate } from '../util/paths.js';
import { displayWidth, padEnd, truncateToWidth, wrapToWidth } from '../util/width.js';
import type { BoxChars } from './glyphs.js';

/**
 * A usage error raised for an out-of-range `--width`; the CLI shell maps it
 * to exit 2 (`cli/args.ts` validates argv first, so this is defence in depth
 * for direct API callers).
 */
export class UsageError extends Error {
  override readonly name = 'UsageError';
  readonly exitCode = 2;
}

/** Inputs of {@link resolveCols} (§10.1 first rule). */
export interface ResolveColsOptions {
  /** `--width` (already numeric); outside 40–200 ⇒ `UsageError`. */
  width?: number | undefined;
  /** `process.stdout.columns` (undefined off-TTY; this machine's non-TTY shell exports `COLUMNS=0`). */
  stdoutColumns?: number | undefined;
  /** The `COLUMNS` environment value. */
  COLUMNS?: string | undefined;
  /** Whether stdout is a TTY (informational; `stdoutColumns` is already TTY-derived). */
  isTTY?: boolean | undefined;
}

/** Widest column count any renderer uses (printed width caps at 2 + 100). */
const COLS_MAX = 102;

/**
 * `cols = --width ?? (stdout.columns > 0 ? columns : undefined) ??
 * (Number(COLUMNS) > 0 ? COLUMNS : undefined) ?? 80`, then capped at 102.
 * A `--width` outside 40–200 throws {@link UsageError}.
 */
export function resolveCols(opts: ResolveColsOptions): number {
  if (opts.width !== undefined) {
    if (!Number.isInteger(opts.width) || opts.width < 40 || opts.width > 200) {
      throw new UsageError(`--width: expected an integer between 40 and 200 (got '${opts.width}')`);
    }
    return Math.min(opts.width, COLS_MAX);
  }
  if (opts.stdoutColumns !== undefined && opts.stdoutColumns > 0) return Math.min(opts.stdoutColumns, COLS_MAX);
  const env = Number(opts.COLUMNS);
  if (Number.isFinite(env) && env > 0) return Math.min(Math.floor(env), COLS_MAX);
  return 80;
}

/** The resolved layout of one render (§10.1 geometry). */
export interface Geometry {
  /** Terminal columns rendered for (already capped at 102). */
  cols: number;
  /** Wide mode iff `cols ≥ 74`. */
  wide: boolean;
  /** Frame width: wide `min(cols − 2, 100)`, narrow `max(min(cols, 100), 40)`. */
  W: number;
  /** Inner width `W − 6` (border + 2-space pad each side). */
  I: number;
  /** Evidence column `clamp(floor(I × 0.40), 26, 36)` (wide mode). */
  E: number;
  /** Claim column `I − E − 2` (wide mode). */
  C: number;
  /** The text area between the borders: wide = `I`, narrow = `W − 4`. */
  T: number;
}

/** The geometry for a column count (values: 72→I66/E26/C38, 80→I72/E28/C42, 100→I92/E36/C54, 120→W100/I94/E36/C56). */
export function geometry(cols: number): Geometry {
  const capped = Math.min(cols, COLS_MAX);
  const wide = capped >= 74;
  const W = wide ? Math.min(capped - 2, 100) : Math.max(Math.min(capped, 100), 40);
  const I = W - 6;
  const E = Math.min(36, Math.max(26, Math.floor(I * 0.4)));
  const C = I - E - 2;
  return { cols: capped, wide, W, I, E, C, T: wide ? I : W - 4 };
}

/** The frame of one receipt box: borders, rules and the padded content line. */
export interface BoxFrame {
  top: string;
  rule: string;
  bottom: string;
  /** One content line: text padded into the inner area between the borders. */
  line: (text: string) => string;
}

/** Builds the frame for a geometry: wide mode indents 2 and pads 2 each side; narrow pads 2 on the left only. */
export function boxFrame(geo: Geometry, chars: BoxChars): BoxFrame {
  const indent = geo.wide ? '  ' : '';
  const bar = chars.h.repeat(geo.W - 2);
  const line = geo.wide
    ? (text: string): string => `${indent}${chars.v}  ${padEnd(text, geo.I)}  ${chars.v}`
    : (text: string): string => `${chars.v}  ${padEnd(text, geo.T)}${chars.v}`;
  return {
    top: `${indent}${chars.tl}${bar}${chars.tr}`,
    rule: `${indent}${chars.lt}${bar}${chars.rt}`,
    bottom: `${indent}${chars.bl}${bar}${chars.br}`,
    line,
  };
}

/**
 * Wraps a ` · `-separated list (stats, cost, verdict, header line 2) into
 * lines of at most `width` columns: chunks are pre-split (and already
 * transliterated for ASCII); continuation lines are indented 2 spaces and
 * START with the separator glyph (`  · 1 compaction`). Chunks are never
 * truncated; a chunk wider than its budget is word-wrapped with a plain
 * 2-space continuation.
 */
export function packLines(chunks: readonly string[], width: number, sepGlyph: string): string[] {
  const sep = ` ${sepGlyph} `;
  const contPrefix = `  ${sepGlyph} `;
  const lines: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current !== '') lines.push(current);
    current = '';
  };
  for (const chunk of chunks) {
    if (chunk === '') continue;
    const cw = displayWidth(chunk);
    if (current !== '' && displayWidth(current) + displayWidth(sep) + cw <= width) {
      current += `${sep}${chunk}`;
      continue;
    }
    flush();
    const prefix = lines.length === 0 ? '' : contPrefix;
    if (displayWidth(prefix) + cw <= width) {
      current = `${prefix}${chunk}`;
      continue;
    }
    const budget = Math.max(1, width - Math.max(2, displayWidth(prefix)));
    const pieces = wrapToWidth(chunk, budget, 999);
    current = `${prefix}${pieces[0] ?? ''}`;
    for (const piece of pieces.slice(1)) {
      flush();
      current = `  ${piece}`;
    }
  }
  flush();
  return lines.length === 0 ? [''] : lines;
}

/**
 * Greedy-packs header tokens at ` · ` into lines of at most `width` columns
 * with no continuation indent and no leading separator (§10.1 narrow header).
 * A token wider than the budget is truncated with `ellipsis`.
 */
export function packTokens(tokens: readonly string[], width: number, sepGlyph: string, ellipsis: string): string[] {
  const sep = ` ${sepGlyph} `;
  const lines: string[] = [];
  let current = '';
  for (const raw of tokens) {
    if (raw === '') continue;
    const token = displayWidth(raw) > width ? truncateToWidth(raw, width, ellipsis) : raw;
    if (current === '') {
      current = token;
    } else if (displayWidth(current) + displayWidth(sep) + displayWidth(token) <= width) {
      current += `${sep}${token}`;
    } else {
      lines.push(current);
      current = token;
    }
  }
  if (current !== '') lines.push(current);
  return lines.length === 0 ? [''] : lines;
}

/** The trailing `(HH:MM)` / `(Mon D HH:MM)` / `(HH:MM, …)` clock of an evidence string. */
const TRAILING_CLOCK_RE = /\((?:[A-Za-z]{3} \d{1,2} )?\d{2}:\d{2}(?:, [^()]*)?\)$/;

/**
 * Wraps one claim's evidence (chunks pre-split at ` · ` and pre-transliterated)
 * into at most 2 lines of `width` columns. Chunks joining on one line keep the
 * ` · ` separator; at a line break the separator is dropped. A chunk wider
 * than the budget is word-wrapped (tokens wider than the budget are hard-
 * broken). When a third line would be needed it becomes `ellipsis` — but a
 * trailing clock is never dropped: it is re-attached to the end of line 2.
 */
export function wrapEvidence(chunks: readonly string[], width: number, sepGlyph: string, ellipsis: string): string[] {
  const sep = ` ${sepGlyph} `;
  const flowed: string[] = [];
  let current = '';
  for (const chunk of chunks) {
    if (chunk === '') continue;
    if (displayWidth(chunk) > width) {
      if (current !== '') flowed.push(current);
      const pieces = wrapToWidth(chunk, width, 99);
      flowed.push(...pieces.slice(0, -1));
      current = pieces[pieces.length - 1] ?? '';
      continue;
    }
    if (current === '') {
      current = chunk;
    } else if (displayWidth(current) + displayWidth(sep) + displayWidth(chunk) <= width) {
      current += `${sep}${chunk}`;
    } else {
      flowed.push(current);
      current = chunk;
    }
  }
  if (current !== '') flowed.push(current);
  if (flowed.length <= 2) return flowed;
  const first = flowed[0] as string;
  const rest = flowed.slice(1).join(' ');
  const clock = TRAILING_CLOCK_RE.exec(chunks[chunks.length - 1] ?? '')?.[0];
  if (clock !== undefined && rest.endsWith(clock)) {
    const head = rest.slice(0, rest.length - clock.length).trimEnd();
    const headBudget = width - displayWidth(clock) - 1;
    const cut = headBudget > 0 ? truncateToWidth(head, headBudget, ellipsis) : '';
    return [first, cut === '' ? clock : `${cut} ${clock}`];
  }
  return [first, truncateToWidth(rest, width, ellipsis)];
}

/**
 * Word-wraps free text (ALSO DID items, kind texts) to at most `maxLines`
 * lines of `width` columns, truncating the last line with `ellipsis` when
 * text remains. Over-wide tokens are hard-broken.
 */
export function wrapWords(text: string, width: number, maxLines: number, ellipsis: string): string[] {
  if (maxLines <= 0) return [];
  const lines = wrapToWidth(text, width, 999);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = truncateToWidth(lines.slice(maxLines - 1).join(' '), width, ellipsis);
  return kept;
}

/**
 * Middle-truncates a path keeping the basename (§10.1) with the caller's
 * ellipsis: for the unicode `…` this is `util/paths.middleTruncate`; for the
 * ASCII `...` the result is re-shrunk until its real display width fits.
 */
export function middleTruncatePath(path: string, max: number, ellipsis: string): string {
  if (ellipsis === '…') return middleTruncate(path, max);
  let target = max;
  let out = middleTruncate(path, target).replace(/…/g, ellipsis);
  while (displayWidth(out) > max && target > 8) {
    target -= 1;
    out = middleTruncate(path, target).replace(/…/g, ellipsis);
  }
  return out;
}

/** Keeps the last `keep` columns of `s` behind `ellipsis` (header model shrink: "from the left keeping the last 14"). */
export function keepTail(s: string, keep: number, ellipsis: string): string {
  if (displayWidth(s) <= keep + displayWidth(ellipsis)) return s;
  const chars = Array.from(s);
  let width = 0;
  let start = chars.length;
  while (start > 0) {
    const w = displayWidth(chars[start - 1] as string);
    if (width + w > keep) break;
    width += w;
    start -= 1;
  }
  return `${ellipsis}${chars.slice(start).join('')}`;
}

/** One header fragment; `role` marks the fragments the shrink order may cut. */
export interface HeaderPart {
  text: string;
  role?: 'cwd' | 'branch' | 'model' | undefined;
}

/** Joined display width of `texts` separated by ` · ` (3 columns each). */
function joinedWidth(texts: readonly string[]): number {
  let width = 0;
  for (const t of texts) width += displayWidth(t);
  return width + 3 * Math.max(0, texts.length - 1);
}

/**
 * The §10.1 header shrink order applied to one header line's parts until the
 * joined width fits `budget`: middle-truncate the cwd (keep the basename, min
 * 12), then the branch to 16 columns + ellipsis, then the model from the left
 * keeping the last 14 characters. Short id, harness/version and dates are
 * never touched. Returns the adjusted texts (same order); the caller wraps at
 * ` · ` if the floors still exceed the budget.
 */
export function shrinkHeaderParts(parts: readonly HeaderPart[], budget: number, ellipsis: string): string[] {
  const texts = parts.map((p) => p.text);
  const over = (): number => joinedWidth(texts) - budget;
  const at = (role: HeaderPart['role']): number => parts.findIndex((p) => p.role === role);
  const cwd = at('cwd');
  if (over() > 0 && cwd !== -1) {
    const current = displayWidth(texts[cwd] as string);
    const target = Math.max(current - over(), 13);
    if (target < current) texts[cwd] = middleTruncatePath(texts[cwd] as string, target, ellipsis);
  }
  const branch = at('branch');
  if (over() > 0 && branch !== -1 && displayWidth(texts[branch] as string) > 16 + displayWidth(ellipsis)) {
    texts[branch] = truncateToWidth(texts[branch] as string, 16 + displayWidth(ellipsis), ellipsis);
  }
  const model = at('model');
  if (over() > 0 && model !== -1) {
    texts[model] = keepTail(texts[model] as string, 14, ellipsis);
  }
  return texts;
}

/** Joined ` · ` display width of header parts (used by tests). */
export function headerWidth(parts: readonly HeaderPart[]): number {
  return joinedWidth(parts.map((p) => p.text));
}

/**
 * Asserts every rendered line's display width is at most `cols`; throws an
 * `Error` naming each offending line. The snapshot matrix runs this on every
 * render at every width.
 */
export function assertWidth(lines: readonly string[], cols: number): void {
  const bad: string[] = [];
  for (const line of lines) {
    const w = displayWidth(line);
    if (w > cols) bad.push(`${w} > ${cols}: ${JSON.stringify(line)}`);
  }
  if (bad.length > 0) throw new Error(`assertWidth: ${bad.length} line(s) exceed ${cols} columns\n${bad.join('\n')}`);
}
