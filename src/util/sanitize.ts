/**
 * Sanitisation of transcript-derived text before it is measured or rendered
 * (§10.1): terminal control sequences, C0/C1 controls, line separators and
 * bidi/zero-width controls are removed so that no final message can move the
 * cursor, write the clipboard (OSC 52), reorder the display or hide text.
 */
import { stripVTControlCharacters } from 'node:util';

/** C0 controls except TAB/LF (mapped to spaces first), DEL and the C1 range. */
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
/**
 * Line/paragraph separators (U+2028/2029), bidi embeddings/overrides
 * (U+202A–202E) and isolates (U+2066–2069), zero-width/joiner/direction marks
 * (U+200B–200F), invisible operators (U+2060–2064), ALM (U+061C) and BOM.
 */
const INVISIBLE = /[\u2028\u2029\u202a-\u202e\u2066-\u2069\u200b-\u200f\u2060-\u2064\u061c\ufeff]/g;
const TABS_NEWLINES = /\t|\r?\n/g;
const SPACE_RUNS = / {2,}/g;

/**
 * Strips VT control sequences, deletes C0/C1 controls, maps tabs and newlines
 * to a single space, deletes U+2028/2029 and bidi/zero-width controls, and
 * collapses runs of spaces. The result never contains byte 0x1b or 0x9b.
 */
export function sanitize(s: string): string {
  return stripVTControlCharacters(s)
    .replace(TABS_NEWLINES, ' ')
    .replace(CONTROLS, '')
    .replace(INVISIBLE, '')
    .replace(SPACE_RUNS, ' ');
}

/**
 * `sanitize` for a table cell or one-line field: every remaining whitespace
 * character (NBSP, ideographic space, …) becomes a plain space, runs collapse
 * and the ends are trimmed.
 */
export function sanitizeForCell(s: string): string {
  return sanitize(s).replace(/\s+/g, ' ').trim();
}
