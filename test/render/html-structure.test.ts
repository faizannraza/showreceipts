/**
 * S22 (a) — template structure (§11.1): exactly three script blocks, an
 * escaped inert data block that round-trips, CSP hashes over the exact
 * emitted bytes (via the `--self-check` helper), no external resources, no
 * network APIs in the inline JS, and the built `dist/render/report.js`
 * byte-identical to `src/render/report.js`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderHtml, selfCheck, THEME_BOOTSTRAP } from '../../src/render/html.js';
import { buildReportPayload } from '../../src/render/payload.js';
import { stableStringify } from '../../src/util/json.js';
import { countOf, dataBlock, makeEntry, makeInput, makeRateRow, NOW, scriptBodies, templateOnly } from './harness.js';

const inputs = [makeInput(1, { timeline: [makeEntry(), makeEntry({ seq: 14, flags: ['test'] })] }), makeInput(2)];
const { payload } = buildReportPayload(inputs, { now: NOW, rows: [makeRateRow()] });
const html = renderHtml(payload);

describe('script accounting', () => {
  it('has exactly 3 <script and 3 closing script tags', () => {
    expect(countOf(html, '<script')).toBe(3);
    expect(countOf(html, '<' + '/script>')).toBe(3);
  });

  it('orders the head as charset → CSP meta → title', () => {
    expect(html).toMatch(/<head>\n<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="[^"]+">\n<title>/);
  });

  it('embeds the exact theme bootstrap as the first script', () => {
    const [boot] = scriptBodies(html);
    expect(boot).toBe(THEME_BOOTSTRAP);
    expect(Buffer.byteLength(THEME_BOOTSTRAP, 'utf8')).toBeLessThanOrEqual(200);
  });
});

describe('data block', () => {
  it('contains no raw <, >, &, U+2028 or U+2029', () => {
    const { text } = dataBlock(html);
    expect(/[<>&\u2028\u2029]/.test(text)).toBe(false);
  });

  it('round-trips deep-equal through JSON.parse', () => {
    const { text } = dataBlock(html);
    expect(JSON.parse(text)).toEqual(JSON.parse(stableStringify({ mode: 'clear', payload })));
  });

  it('stamps generatedAt from --now', () => {
    const { text } = dataBlock(html);
    const parsed = JSON.parse(text) as { payload: { meta: { generatedAt: string } } };
    expect(parsed.payload.meta.generatedAt).toBe(NOW.toISOString());
  });
});

describe('CSP', () => {
  it('self-check confirms every hash matches the emitted bytes', () => {
    const check = selfCheck(html);
    expect(check.problems).toEqual([]);
    expect(check.ok).toBe(true);
  });

  it('self-check fails when the style bytes are tampered with', () => {
    expect(selfCheck(html.replace('<style>', '<style>/*x*/')).ok).toBe(false);
  });

  it('self-check fails when a script is injected', () => {
    const injected = html.replace('<div id="app">', '<script>1<' + '/script><div id="app">');
    expect(selfCheck(injected).ok).toBe(false);
  });

  it("blocks everything by default and never allows 'unsafe-inline'", () => {
    const csp = /content="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp.match(/'sha256-[^']+'/g)).toHaveLength(3);
  });
});

describe('self-containment', () => {
  it('has no external resource patterns in the template', () => {
    const template = templateOnly(html);
    for (const marker of ['<link', '<img', '<iframe', '<embed', '<object', ' src=', '@import', 'href="http']) {
      expect(template).not.toContain(marker);
    }
    const style = /<style>([\s\S]*?)<\/style>/.exec(template)?.[1] ?? '';
    expect(style).not.toContain('url(');
  });

  it('inline JS never talks to the network or loads code', () => {
    const [boot, , app] = scriptBodies(html);
    for (const body of [boot ?? '', app ?? '']) {
      expect(body.length).toBeGreaterThan(0);
      for (const banned of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'import(']) {
        expect(body).not.toContain(banned);
      }
    }
  });

  it('keeps the template (without data) at or under 40 KB', () => {
    expect(Buffer.byteLength(templateOnly(html), 'utf8')).toBeLessThanOrEqual(40 * 1024);
  });
});

describe('build rule (S12b)', () => {
  it('dist/render/report.js exists after npm run build and equals src/render/report.js', () => {
    const src = readFileSync(new URL('../../src/render/report.js', import.meta.url), 'utf8');
    const dist = readFileSync(new URL('../../dist/render/report.js', import.meta.url), 'utf8');
    expect(dist).toBe(src);
  });
});
