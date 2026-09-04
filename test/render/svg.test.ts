/**
 * S23b — `render/svg.ts` goldens and hygiene: byte-deterministic output,
 * XML-escaped text, no scripts, no links, no external references beyond the
 * SVG namespace, and `<tspan fill>` paint from the S20 ANSI kinds.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Receipt } from '../../src/model/types.js';
import { renderReceiptSvg } from '../../src/render/svg.js';
import { makeReceipt } from './harness.js';

const RECEIPTS_DIR = fileURLToPath(new URL('../../fixtures/render/receipts/', import.meta.url));

function fixture(name: string): Receipt {
  return JSON.parse(readFileSync(join(RECEIPTS_DIR, `${name}.json`), 'utf8')) as Receipt;
}

const OPTS = { cols: 74, unicode: true, tz: 'utc', homeDir: '/home/u' } as const;

describe('golden bytes', () => {
  it('the contradicted demo receipt renders to the pinned SVG', () => {
    expect(renderReceiptSvg(fixture('contradicted-demo'), OPTS)).toMatchSnapshot();
  });

  it('re-rendering yields identical bytes', () => {
    const a = renderReceiptSvg(fixture('contradicted-demo'), OPTS);
    const b = renderReceiptSvg(fixture('contradicted-demo'), OPTS);
    expect(a).toBe(b);
  });
});

describe('document structure', () => {
  const svg = renderReceiptSvg(fixture('contradicted-demo'), OPTS);

  it('one <text xml:space="preserve" textLength lengthAdjust> per rendered line', () => {
    const texts = svg.match(/<text /g) ?? [];
    expect(texts.length).toBeGreaterThan(10);
    const opens = svg.match(/<text [^>]*>/g) ?? [];
    for (const open of opens) {
      expect(open).toContain('xml:space="preserve"');
      expect(open).toContain('textLength="');
      expect(open).toContain('lengthAdjust="spacingAndGlyphs"');
    }
  });

  it('paints glyphs and the verdict via <tspan fill> (ok green, bad red)', () => {
    expect(svg).toContain('<tspan fill="#3fb950">✓</tspan>');
    expect(svg).toContain('<tspan fill="#f85149">✗</tspan>');
    expect(svg).toMatch(/<tspan fill="#f85149">[^<]*VERDICT: /);
  });

  it('uses the monospace stack and a dark paper background', () => {
    expect(svg).toContain('ui-monospace');
    expect(svg).toContain('fill="#12161c"');
  });
});

describe('hygiene', () => {
  const names = ['contradicted-demo', 'hostile', 'twenty-claims'] as const;

  it('contains only the expected element names and no script/link/external reference', () => {
    for (const name of names) {
      const svg = renderReceiptSvg(fixture(name), OPTS);
      // Every `<` opens one of the five allowed elements (or closes one).
      expect(svg).not.toMatch(/<(?!\/?(?:svg|rect|g|text|tspan)[\s>])/);
      expect(svg).not.toContain('<script');
      expect(svg).not.toContain('href');
      expect(svg).not.toContain('url(');
      // The only URL in the document is the mandatory SVG namespace.
      expect(svg.split('http').length).toBe(2);
      expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    }
  });

  it('never emits a raw control byte, even from the hostile receipt', () => {
    const svg = renderReceiptSvg(fixture('hostile'), OPTS);
    expect(svg).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(svg.includes('\x1b')).toBe(false);
  });

  it('XML-escapes markup characters in claim text', () => {
    const receipt = makeReceipt({
      lines: [
        {
          glyph: 'ok',
          claim: 'wrote <index.html> & "quoted" x>y',
          evidence: ['Write (10:05)'],
          refs: [{ seq: 1, label: 'write', at: '2026-08-01T10:05:00.000Z' }],
        },
      ],
    });
    const svg = renderReceiptSvg(receipt, OPTS);
    expect(svg).toContain('&lt;index.html&gt; &amp; &quot;quoted&quot; x&gt;y');
    expect(svg).not.toContain('<index.html>');
  });
});
