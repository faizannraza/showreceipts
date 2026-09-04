/**
 * S22 (b) — `report.js` source battery: the app script never parses markup,
 * never reaches for dynamic code, style or event-handler attributes, or a
 * `javascript:` URL; it parses as ES2020 (checked with the Function
 * constructor — test-only), stays within the 900-line budget, and carries
 * the structural affordances §11.4 requires (roles, live region, chunked
 * rendering, safe external links).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('../../src/render/report.js', import.meta.url), 'utf8');

describe('forbidden constructs', () => {
  const banned = [
    'innerHTML',
    'outerHTML',
    'insertAdjacentHTML',
    'document.write',
    'eval(',
    'new Function',
    'srcdoc',
    "setAttribute('on",
    "setAttribute('style'",
    'javascript:',
  ];
  for (const needle of banned) {
    it(`never contains ${JSON.stringify(needle)}`, () => {
      expect(src).not.toContain(needle);
    });
  }

  it('never contains a closing script tag or an HTML comment opener', () => {
    expect(src).not.toContain('<' + '/script');
    expect(src).not.toContain('<' + '!--');
  });
});

describe('shape', () => {
  it('is syntactically valid (Function constructor parse, test only)', () => {
    expect(() => new Function(src)).not.toThrow();
  });

  it('stays within the 900-line budget (size.mjs counting)', () => {
    const lines = src.split('\n').length - (src.endsWith('\n') ? 1 : 0);
    expect(lines).toBeLessThanOrEqual(900);
  });

  it('builds DOM through createElement/createTextNode/textContent only', () => {
    expect(src).toContain('document.createElement');
    expect(src).toContain('textContent');
    expect(src).toContain('createTextNode');
  });
});

describe('§11.4 affordances', () => {
  it('external links carry rel="noopener noreferrer" and open in a new tab', () => {
    expect(src).toContain('noopener noreferrer');
    expect(src).toContain("'_blank'");
  });

  it('renders long lists in requestAnimationFrame chunks of 50', () => {
    expect(src).toContain('requestAnimationFrame');
    expect(src).toMatch(/CHUNK = 50/);
  });

  it('uses semantic roles and a polite live region', () => {
    expect(src).toContain("'listbox'");
    expect(src).toContain("'option'");
    expect(src).toContain("'grid'");
    expect(src).toContain("'tablist'");
    expect(src).toContain('aria-live');
    expect(src).toContain('aria-selected');
    expect(src).toContain('aria-expanded');
  });

  it('safeUrl is an https/http allow-list, not a deny-list', () => {
    expect(src).toMatch(/function safeUrl/);
    expect(src).toMatch(/\^https\?/);
  });

  it('validates every router value against a regex table', () => {
    expect(src).toContain('ROUTE_RE');
    expect(src).toMatch(/s: \/\^\[0-9a-f\]\{8,12\}\$\//); // §4.1: shortIds are 8 hex, 12 after a collision widening
    expect(src).toMatch(/seq: \/\^\[0-9\]\{1,7\}\$\//);
  });

  it('appends the last-green band even when the flag filter hides the green row', () => {
    expect(src).toMatch(/if \(tf !== 'all' && flags\.indexOf\(tf\) === -1\) \{[^}]*bandRow\('· after last green run ·'\)/);
  });
});
