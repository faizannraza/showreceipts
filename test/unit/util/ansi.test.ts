import { describe, expect, it } from 'vitest';
import { colorEnabled, paint, SGR, strip, type ColorInputs } from '../../../src/util/ansi.js';

const ESC = String.fromCharCode(0x1b);

function inputs(overrides: Partial<ColorInputs>): ColorInputs {
  return { noColor: false, forceColor: undefined, noColorEnv: undefined, term: 'xterm-256color', isTTY: true, ...overrides };
}

describe('colorEnabled precedence (§10.1)', () => {
  it('--no-color beats FORCE_COLOR=1', () => {
    expect(colorEnabled(inputs({ noColor: true, forceColor: '1' }))).toBe(false);
  });

  it('FORCE_COLOR=0 (and false) turns colour off even on a TTY', () => {
    expect(colorEnabled(inputs({ forceColor: '0' }))).toBe(false);
    expect(colorEnabled(inputs({ forceColor: 'false' }))).toBe(false);
    expect(colorEnabled(inputs({ forceColor: ' False ' }))).toBe(false);
  });

  it('FORCE_COLOR set to anything else turns colour on, even off-TTY with TERM=dumb and NO_COLOR', () => {
    expect(colorEnabled(inputs({ forceColor: '1', isTTY: false, term: 'dumb', noColorEnv: '1' }))).toBe(true);
    expect(colorEnabled(inputs({ forceColor: '', isTTY: false }))).toBe(true);
    expect(colorEnabled(inputs({ forceColor: '3', isTTY: false }))).toBe(true);
  });

  it('an empty NO_COLOR is ignored; a non-empty one turns colour off', () => {
    expect(colorEnabled(inputs({ noColorEnv: '' }))).toBe(true);
    expect(colorEnabled(inputs({ noColorEnv: '1' }))).toBe(false);
  });

  it('TERM=dumb turns colour off', () => {
    expect(colorEnabled(inputs({ term: 'dumb' }))).toBe(false);
  });

  it('otherwise follows isTTY', () => {
    expect(colorEnabled(inputs({ isTTY: false }))).toBe(false);
    expect(colorEnabled(inputs({ isTTY: true }))).toBe(true);
    expect(colorEnabled(inputs({ isTTY: true, term: undefined }))).toBe(true);
  });
});

describe('paint', () => {
  it('wraps text in the SGR code for each kind plus a reset', () => {
    expect(paint('ok', 'x')).toBe(`${ESC}[32mx${ESC}[0m`);
    expect(paint('bad', 'x')).toBe(`${ESC}[31mx${ESC}[0m`);
    expect(paint('unk', 'x')).toBe(`${ESC}[33mx${ESC}[0m`);
    expect(paint('warn', 'x')).toBe(`${ESC}[33mx${ESC}[0m`);
    expect(paint('dim', 'x')).toBe(`${ESC}[2mx${ESC}[0m`);
    expect(paint('bold', 'x')).toBe(`${ESC}[1mx${ESC}[0m`);
    expect(SGR).toEqual({ ok: 32, bad: 31, unk: 33, warn: 33, dim: 2, bold: 1 });
  });

  it('returns the text untouched when disabled or empty', () => {
    expect(paint('ok', 'x', false)).toBe('x');
    expect(paint('ok', '')).toBe('');
  });
});

describe('strip', () => {
  it('removes CSI, OSC and C1 sequences', () => {
    expect(strip(paint('bad', 'fail'))).toBe('fail');
    expect(strip(`a${ESC}]52;c;aGVsbG8=${String.fromCharCode(7)}b`)).toBe('ab');
    expect(strip(`a${String.fromCharCode(0x9b)}31mb`)).toBe('ab');
    expect(strip('plain')).toBe('plain');
  });
});
