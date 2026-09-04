/**
 * S20 — geometry and text-flow primitives (§10.1): `resolveCols` bounds, the
 * geometry table, ` · ` packing, evidence wrapping (trailing clocks are never
 * dropped), header shrink order, the width assertion, the unicode decision
 * and the ASCII transliteration map.
 */
import { describe, expect, it } from 'vitest';
import {
  assertWidth,
  boxFrame,
  geometry,
  headerWidth,
  keepTail,
  middleTruncatePath,
  packLines,
  packTokens,
  resolveCols,
  shrinkHeaderParts,
  UsageError,
  wrapEvidence,
  wrapWords,
  type HeaderPart,
} from '../../src/render/box.js';
import { decideUnicode, glyphSet, transliterate } from '../../src/render/glyphs.js';
import { displayWidth } from '../../src/util/width.js';

describe('resolveCols (§10.1 first rule)', () => {
  it('uses --width first, then stdout.columns > 0, then COLUMNS > 0, then 80', () => {
    expect(resolveCols({ width: 90, stdoutColumns: 120, COLUMNS: '70' })).toBe(90);
    expect(resolveCols({ stdoutColumns: 120, COLUMNS: '70' })).toBe(102);
    expect(resolveCols({ stdoutColumns: 96, COLUMNS: '70' })).toBe(96);
    expect(resolveCols({ COLUMNS: '70' })).toBe(70);
    expect(resolveCols({ COLUMNS: '0' })).toBe(80); // this machine's non-TTY shell exports COLUMNS=0
    expect(resolveCols({})).toBe(80);
  });

  it('--width 39 and 201 throw UsageError (exit 2); 40 and 200 are accepted', () => {
    expect(() => resolveCols({ width: 39 })).toThrow(UsageError);
    expect(() => resolveCols({ width: 201 })).toThrow(UsageError);
    expect(() => resolveCols({ width: 40 })).not.toThrow();
    expect(resolveCols({ width: 200 })).toBe(102);
  });

  it('caps at 102: --width 150 ⇒ 102; 102 and 103 from the TTY ⇒ 102', () => {
    expect(resolveCols({ width: 150 })).toBe(102);
    expect(resolveCols({ stdoutColumns: 102 })).toBe(102);
    expect(resolveCols({ stdoutColumns: 103 })).toBe(102);
  });
});

describe('geometry table (§10.1)', () => {
  it('72→I66/E26/C38, 80→I72/E28/C42, 100→I92/E36/C54, 120→W100/I94/E36/C56', () => {
    const g72 = geometry(72);
    expect([g72.I, g72.E, g72.C]).toEqual([66, 26, 38]);
    expect(g72.wide).toBe(false);
    const g80 = geometry(80);
    expect([g80.I, g80.E, g80.C]).toEqual([72, 28, 42]);
    const g100 = geometry(100);
    expect([g100.I, g100.E, g100.C]).toEqual([92, 36, 54]);
    const g120 = geometry(120);
    expect([g120.W, g120.I, g120.E, g120.C]).toEqual([100, 94, 36, 56]);
  });

  it('wide iff cols ≥ 74; narrow floors W at 40; --width 150 renders W = 100', () => {
    expect(geometry(74).wide).toBe(true);
    expect(geometry(73).wide).toBe(false);
    expect(geometry(40).W).toBe(40);
    expect(geometry(geometry(150).cols).W).toBe(100);
    expect(geometry(102).W).toBe(100);
    expect(geometry(103).W).toBe(100);
  });

  it('boxFrame lines are exactly the printed width (wide: W+2 with indent; narrow: W)', () => {
    for (const cols of [60, 73, 74, 80, 100, 120]) {
      const geo = geometry(cols);
      const frame = boxFrame(geo, glyphSet(true).box);
      const printed = geo.wide ? geo.W + 2 : geo.W;
      expect(displayWidth(frame.top)).toBe(printed);
      expect(displayWidth(frame.rule)).toBe(printed);
      expect(displayWidth(frame.line('x'))).toBe(printed);
      expect(printed).toBeLessThanOrEqual(Math.min(cols, 102));
    }
  });
});

describe('packLines (stats/cost/verdict/header-2 wrapping)', () => {
  it('joins chunks at ` · ` and starts continuation lines with the separator, indented 2', () => {
    const lines = packLines(['212 tool calls', '31 files changed', '4 test runs', '1 compaction'], 40, '·');
    expect(lines[0]).toBe('212 tool calls · 31 files changed');
    expect(lines[1]).toBe('  · 4 test runs · 1 compaction');
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(40);
  });

  it('never truncates a chunk: an over-wide chunk word-wraps with a plain 2-space continuation', () => {
    const lines = packLines(['a chunk that is far wider than the tiny budget given here'], 20, '·');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ').includes('…')).toBe(false);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(20);
  });
});

describe('packTokens (narrow header)', () => {
  it('greedy-packs with no continuation indent and no leading separator', () => {
    const lines = packTokens(['RECEIPT #0badf00d', 'Claude Code 2.1.214', 'claude-sonnet-5'], 56, '-', '...');
    expect(lines[0]).toBe('RECEIPT #0badf00d - Claude Code 2.1.214');
    expect(lines[1]).toBe('claude-sonnet-5');
  });

  it('truncates a token wider than the budget with the ellipsis', () => {
    const lines = packTokens(['averylongtokenwithoutanyspacesatallinit'], 20, '·', '…');
    expect(displayWidth(lines[0] as string)).toBeLessThanOrEqual(20);
    expect(lines[0]).toContain('…');
  });
});

describe('wrapEvidence (≤ 2 lines; the trailing clock is never dropped)', () => {
  it('`ruff check . → exit 0 (23:29)` at E = 26 wraps to two lines and keeps (23:29)', () => {
    const lines = wrapEvidence(['ruff check . → exit 0 (23:29)'], 26, '·', '…');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/\(23:29\)$/);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(26);
  });

  it('chunks share a line with the separator when they fit; the separator drops at a break', () => {
    const lines = wrapEvidence(['uv run pytest → exit 0', '41 passed (23:41)'], 26, '·', '…');
    expect(lines).toEqual(['uv run pytest → exit 0', '41 passed (23:41)']);
    const wide = wrapEvidence(['Edit ×3 (17:31, 17:32)'], 36, '·', '…');
    expect(wide).toEqual(['Edit ×3 (17:31, 17:32)']);
  });

  it('a third line collapses into the ellipsis but re-attaches a trailing clock', () => {
    const lines = wrapEvidence(['first chunk of evidence', 'second chunk of evidence', 'third chunk of evidence (11:03)'], 24, '·', '…');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/\(11:03\)$/);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(24);
  });

  it('hard-breaks a token wider than the column', () => {
    const lines = wrapEvidence(['averyveryverylongunbrokentokenthatcannotfit (10:00)'], 20, '·', '…');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(20);
    expect(lines[1]).toMatch(/\(10:00\)$/);
  });
});

describe('wrapWords', () => {
  it('wraps to maxLines and marks remaining text with the ellipsis', () => {
    const lines = wrapWords('one two three four five six seven eight nine ten', 12, 2, '…');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('…');
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(12);
  });
});

describe('header shrink order (§10.1)', () => {
  const cwd = `~/`.concat(Array.from({ length: 12 }, (_, i) => `segment-${i}`).join('/'), '/wattage');
  const parts: HeaderPart[] = [
    { text: cwd, role: 'cwd' },
    { text: 'feature/extremely-long-branch-name-9999', role: 'branch' },
    { text: 'Jul 18 17:14 → 23:52' },
    { text: '2h 05m' },
  ];

  it('middle-truncates the cwd first, keeping the basename', () => {
    const texts = shrinkHeaderParts(parts, 70, '…');
    expect(texts[0]).toContain('/wattage');
    expect(texts[0]).toContain('…');
    expect(displayWidth(texts[0] as string)).toBeLessThan(displayWidth(cwd));
  });

  it('then cuts the branch to 16 + ellipsis, then the model keeping the last 14', () => {
    const withModel: HeaderPart[] = [
      { text: 'x'.repeat(200), role: 'cwd' },
      { text: 'feature/extremely-long-branch-name-9999', role: 'branch' },
      { text: 'claude-experimental-preview-with-an-unusually-long-model-id', role: 'model' },
    ];
    const texts = shrinkHeaderParts(withModel, 60, '…');
    expect(displayWidth(texts[1] as string)).toBeLessThanOrEqual(17);
    const model = texts[2] as string;
    expect(model.startsWith('…')).toBe(true);
    expect(model.endsWith('long-model-id')).toBe(true);
    expect(displayWidth(model)).toBe(15);
  });

  it('never touches dates or unroled fragments', () => {
    const texts = shrinkHeaderParts(parts, 40, '…');
    expect(texts[2]).toBe('Jul 18 17:14 → 23:52');
    expect(texts[3]).toBe('2h 05m');
    expect(headerWidth(parts)).toBeGreaterThan(40);
  });
});

describe('middleTruncatePath / keepTail (ASCII ellipsis width)', () => {
  it('the ASCII `...` result fits the real display width', () => {
    const out = middleTruncatePath('/home/u/projects/deeply/nested/dir/wattage.py', 24, '...');
    expect(displayWidth(out)).toBeLessThanOrEqual(24);
    expect(out).toContain('wattage.py');
  });

  it('keepTail keeps the last N columns behind the ellipsis', () => {
    expect(keepTail('claude-sonnet-5', 14, '…')).toBe('claude-sonnet-5');
    expect(keepTail('claude-experimental-preview-x', 14, '…')).toBe('…ntal-preview-x');
  });
});

describe('assertWidth', () => {
  it('accepts fitting lines and names each offender', () => {
    expect(() => assertWidth(['ok', 'also ok'], 10)).not.toThrow();
    expect(() => assertWidth(['this line is far too wide'], 10)).toThrow(/1 line\(s\) exceed 10/);
  });

  it('measures stripped text: ANSI colour never counts against the width', () => {
    expect(() => assertWidth(['[32m✓ ok[0m'], 4)).not.toThrow();
  });
});

describe('decideUnicode (§10.1 unicode rule)', () => {
  it('--ascii always wins; CJK locales force ASCII even under --unicode', () => {
    expect(decideUnicode({ ascii: true, unicode: true, platform: 'darwin', env: { LANG: 'en_US.UTF-8' } })).toBe(false);
    expect(decideUnicode({ unicode: true, platform: 'darwin', env: { LANG: 'ja_JP.UTF-8' } })).toBe(false);
    expect(decideUnicode({ unicode: true, platform: 'darwin', env: { LC_ALL: 'zh_CN.UTF-8' } })).toBe(false);
  });

  it('POSIX: TERM=linux or a non-UTF-8 locale disables unicode; empty locale allows it', () => {
    expect(decideUnicode({ platform: 'linux', env: { TERM: 'linux', LANG: 'en_US.UTF-8' } })).toBe(false);
    expect(decideUnicode({ platform: 'linux', env: { TERM: 'xterm', LANG: 'en_US.ISO8859-1' } })).toBe(false);
    expect(decideUnicode({ platform: 'darwin', env: { TERM: 'xterm-256color' } })).toBe(true);
    expect(decideUnicode({ platform: 'darwin', env: { TERM: 'xterm', LANG: 'en_US.utf8' } })).toBe(true);
  });

  it('win32: a modern terminal marker enables unicode', () => {
    expect(decideUnicode({ platform: 'win32', env: {} })).toBe(false);
    expect(decideUnicode({ platform: 'win32', env: { WT_SESSION: '1' } })).toBe(true);
    expect(decideUnicode({ platform: 'win32', env: { TERM_PROGRAM: 'vscode' } })).toBe(true);
  });

  it('LC_ALL wins over LC_CTYPE wins over LANG', () => {
    expect(decideUnicode({ platform: 'linux', env: { LC_ALL: 'C', LANG: 'en_US.UTF-8', TERM: 'xterm' } })).toBe(false);
    expect(decideUnicode({ platform: 'linux', env: { LC_CTYPE: 'en_US.UTF-8', LANG: 'C', TERM: 'xterm' } })).toBe(true);
  });
});

describe('transliterate (renderer-emitted characters only)', () => {
  it('maps every §10.1 substitution', () => {
    expect(transliterate('… · → × ≈ – —')).toBe('... - -> x ~ - --');
    expect(transliterate('uv run pytest → exit 0 · 41 passed')).toBe('uv run pytest -> exit 0 - 41 passed');
  });

  it('glyph sets expose matching frames', () => {
    expect(glyphSet(true).box.tl).toBe('┌');
    expect(glyphSet(false).box.tl).toBe('+');
    expect(glyphSet(false).ellipsis).toBe('...');
  });
});
