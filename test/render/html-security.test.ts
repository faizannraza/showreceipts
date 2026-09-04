/**
 * S22 (c) — hostile-receipt battery (§11.1): every marker of
 * `fixtures/render/hostile-receipt.json` (comment openers/closers, script
 * tags, `<!`, NUL, U+2028, the `"><svg onload=alert(1)>` breakout and the
 * `javascript:alert(1)` prUrl) reaches the document only inside the data
 * block, `<` escaped as `\u003c` — the template outside the data block is
 * byte-identical to a benign render.
 */
import { describe, expect, it } from 'vitest';
import { renderHtml, selfCheck } from '../../src/render/html.js';
import { buildReportPayload, payloadKey, type ReportSessionInput } from '../../src/render/payload.js';
import { countOf, dataBlock, loadHostile, makeInput, makeRateRow, NOW, templateOnly } from './harness.js';

const SCRIPT_OPEN = '<' + 'script';
const SCRIPT_CLOSE = '<' + '/script';
const MARKERS = [
  '<' + '!--',
  '-->',
  SCRIPT_OPEN,
  SCRIPT_CLOSE,
  '<' + '!',
  '"><svg onload=alert(1)>',
  'javascript:alert(1)',
];

function render(inputs: ReportSessionInput[]): string {
  const { payload } = buildReportPayload(inputs, { now: NOW, rows: [makeRateRow()] });
  return renderHtml(payload);
}

const hostile = loadHostile();
const hostileInput: ReportSessionInput = { card: hostile.card, receipt: hostile.receipt, timeline: hostile.timeline };
const html = render([hostileInput, makeInput(2)]);
const benign = render([makeInput(1), makeInput(2)]);

describe('the fixture is actually hostile', () => {
  it('carries every marker plus a raw NUL and U+2028 across the required fields', () => {
    const raw = JSON.stringify(hostile);
    for (const marker of MARKERS) expect(raw, marker).toContain(marker);
    expect(hostile.receipt.finalText).toContain('\u0000');
    expect(hostile.receipt.finalText).toContain('\u2028');
    expect(hostile.receipt.lines[0]?.claim).toContain('<' + '!--');
    expect(hostile.timeline[0]?.summary).toContain(SCRIPT_CLOSE);
    expect(hostile.timeline[1]?.files[0]).toContain('\u0000');
    expect(hostile.receipt.cwd).toContain('"><svg onload=alert(1)>');
    expect(hostile.receipt.branch).toContain('-->');
    expect(hostile.receipt.model).toContain(SCRIPT_OPEN);
    expect(hostile.card.title).toContain(SCRIPT_CLOSE);
    expect(JSON.stringify(hostile.receipt.alsoDid)).toContain('javascript:alert(1)');
  });
});

describe('markers never escape the data block', () => {
  it('the template outside the data block is byte-identical to a benign render', () => {
    expect(templateOnly(html)).toBe(templateOnly(benign));
  });

  it('adds no raw marker occurrence outside the data block', () => {
    const hostileTemplate = templateOnly(html);
    const benignTemplate = templateOnly(benign);
    for (const marker of MARKERS) {
      expect(countOf(hostileTemplate, marker), marker).toBe(countOf(benignTemplate, marker));
    }
    expect(countOf(hostileTemplate, SCRIPT_OPEN)).toBe(3);
    expect(countOf(hostileTemplate, SCRIPT_CLOSE)).toBe(3);
  });

  it('each marker appears inside the data block only in \\u003c form', () => {
    const { text } = dataBlock(html);
    expect(text).toContain('\\u003c!--');
    expect(text).toContain('--\\u003e');
    expect(text).toContain('\\u003cscript');
    expect(text).toContain('\\u003c/script');
    expect(text).toContain('\\u003csvg');
    expect(text).toContain('\\u0000');
    expect(text).toContain('\\u2028');
    expect(/[<>&]/.test(text)).toBe(false);
  });

  it('emits no raw NUL, U+2028 or U+2029 anywhere in the document', () => {
    expect(/[\0\u2028\u2029]/.test(html)).toBe(false);
  });
});

describe('the hostile document still works', () => {
  it('passes the self-check', () => {
    const check = selfCheck(html);
    expect(check.problems).toEqual([]);
  });

  it('round-trips the hostile strings exactly through JSON.parse', () => {
    const { text } = dataBlock(html);
    const parsed = JSON.parse(text) as { payload: { receipts: Record<string, { finalText: string; branch: string | null }> } };
    const receipt = parsed.payload.receipts[payloadKey(hostile.card)];
    expect(receipt?.finalText).toBe(hostile.receipt.finalText);
    expect(receipt?.branch).toBe(hostile.receipt.branch);
  });

  it('keeps the javascript: prUrl out of the template (safeUrl allow-list)', () => {
    expect(templateOnly(html)).not.toContain('javascript:');
  });
});
