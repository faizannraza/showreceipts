/**
 * S22 (e) — contrast battery (§11.3): WCAG 2.x relative-luminance ratios
 * computed for the explicit pair list, in both palettes — text pairs ≥ 4.5:1,
 * glyph/focus pairs ≥ 3:1 — plus the §11.3 theme scaffolding (light on bare
 * `:root`, dark under both the guarded media query and `[data-theme="dark"]`,
 * `prefers-reduced-motion`, `:focus-visible`).
 */
import { describe, expect, it } from 'vitest';
import { buildCss, DARK, LIGHT, type Palette } from '../../src/render/html-css.js';

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Every surface a token can sit on (this palette's equivalents of §11.3's bg/paper/pill-bg/band/row-hover). */
const SURFACES = ['bg', 'card', 'paper', 'band', 'sel'] as const;

/**
 * Text on surfaces — ≥ 4.5:1: the full §11.3 matrix (fg/muted/accent and the
 * verdict colours, which render as flag/glyph text, over every surface),
 * plus the pill label on each verdict fill.
 */
const TEXT_PAIRS: readonly [string, string][] = [
  ...['ink', 'muted', 'accent', 'ok', 'bad', 'unk'].flatMap((fg) => SURFACES.map((bg): [string, string] => [fg, bg])),
  ['pillInk', 'ok'],
  ['pillInk', 'bad'],
  ['pillInk', 'unk'],
];

/** The focus ring against every surface it can outline — ≥ 3:1 (§11.3). */
const GLYPH_PAIRS: readonly [string, string][] = SURFACES.map((bg): [string, string] => ['focus', bg]);

for (const [name, palette] of [
  ['light', LIGHT],
  ['dark', DARK],
] as [string, Palette][]) {
  describe(`${name} palette`, () => {
    for (const [fg, bg] of TEXT_PAIRS) {
      it(`${fg} on ${bg} ≥ 4.5:1`, () => {
        const r = ratio(palette[fg] as string, palette[bg] as string);
        expect(r, `${fg}=${palette[fg]} on ${bg}=${palette[bg]} → ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      });
    }
    for (const [fg, bg] of GLYPH_PAIRS) {
      it(`${fg} on ${bg} ≥ 3:1`, () => {
        const r = ratio(palette[fg] as string, palette[bg] as string);
        expect(r, `${fg}=${palette[fg]} on ${bg}=${palette[bg]} → ${r.toFixed(2)}`).toBeGreaterThanOrEqual(3);
      });
    }
    it('defines the same token set as the other palette', () => {
      expect(Object.keys(palette).sort()).toEqual(Object.keys(name === 'light' ? DARK : LIGHT).sort());
    });
  });
}

describe('§11.3 scaffolding', () => {
  const css = buildCss();

  it('puts the light tokens on bare :root', () => {
    expect(css).toMatch(/^:root\{--bg:#f2efe9;/);
  });

  it('guards the dark media block so an explicit light choice wins', () => {
    expect(css).toContain('@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){');
  });

  it('repeats the dark tokens under [data-theme="dark"] so the toggle wins both ways', () => {
    expect(css).toContain(':root[data-theme="dark"]{');
    expect(css.split(`--bg:${DARK['bg']};`).length - 1).toBe(2);
  });

  it('has focus-visible rings and reduced-motion support', () => {
    expect(css).toContain(':focus-visible{outline:2px solid var(--focus)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('styles the receipt card, pills, listbox, grid and bands', () => {
    for (const selector of ['.receipt{', '.pill{', '.listbox{', 'table.grid', 'tr.bandrow', '.opt[aria-selected="true"]']) {
      expect(css).toContain(selector);
    }
  });

  it('gives the sticky grid header an opaque background', () => {
    expect(css).toContain('table.grid th{position:sticky;top:0;background:var(--card)');
  });
});
