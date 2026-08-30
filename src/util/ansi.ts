/**
 * Terminal colour (§10.1): the precedence rule for enabling it, the eight
 * paint kinds the renderer uses, and ANSI stripping.
 */
import { stripVTControlCharacters } from 'node:util';

export type PaintKind = 'ok' | 'bad' | 'unk' | 'warn' | 'dim' | 'bold';

/** SGR codes per kind: `ok`=32, `bad`=31, `unk`/`warn`=33, `dim`=2, `bold`=1. */
export const SGR: Readonly<Record<PaintKind, number>> = {
  ok: 32,
  bad: 31,
  unk: 33,
  warn: 33,
  dim: 2,
  bold: 1,
};

export interface ColorInputs {
  /** `--no-color` was passed. */
  noColor: boolean;
  /** The `FORCE_COLOR` environment value (`undefined` when unset). */
  forceColor: string | undefined;
  /** The `NO_COLOR` environment value (`undefined` when unset). */
  noColorEnv: string | undefined;
  /** The `TERM` environment value. */
  term: string | undefined;
  /** Whether stdout is an interactive terminal. */
  isTTY: boolean;
}

/**
 * `--no-color ? off : FORCE_COLOR set ? (FORCE_COLOR ∈ {0,false} ? off : on)
 * : NO_COLOR non-empty ? off : TERM === 'dumb' ? off : stdout.isTTY`.
 */
export function colorEnabled(inputs: ColorInputs): boolean {
  if (inputs.noColor) return false;
  if (inputs.forceColor !== undefined) {
    const value = inputs.forceColor.trim().toLowerCase();
    return !(value === '0' || value === 'false');
  }
  if (inputs.noColorEnv !== undefined && inputs.noColorEnv !== '') return false;
  if (inputs.term === 'dumb') return false;
  return inputs.isTTY;
}

/**
 * Wraps `s` in the SGR sequence for `kind` and a reset. With `enabled`
 * false (the caller's `colorEnabled` result) the text is returned untouched,
 * so renderers can paint unconditionally.
 */
export function paint(kind: PaintKind, s: string, enabled = true): string {
  if (!enabled || s === '') return s;
  return `\x1b[${SGR[kind]}m${s}\x1b[0m`;
}

/** Removes every ANSI/VT control sequence (CSI, OSC, C1) from `s`. */
export function strip(s: string): string {
  return stripVTControlCharacters(s);
}
