/**
 * S20 — terminal receipt snapshot matrix (§10.1, §10.2).
 *
 * Fixtures: every hand-made edge receipt in `fixtures/render/receipts/`
 * plus the S19 golden receipts of two reader fixtures built through the real
 * pipeline. Matrix: widths {60, 73, 74, 80, 100, 120} × modes
 * {unicode+color, unicode, ascii}. Every rendered line's display width is at
 * most `cols`; wide and narrow renders carry identical claim rows and
 * VERDICT numbers; hostile strings never emit a control or bidi byte; the
 * §10.2 demo-shaped CONTRADICTED sample lines render verbatim.
 */
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { Receipt, Session } from '../../src/model/types.js';
import { parsePriceTable } from '../../src/cost/validate.js';
import { resolveRoots } from '../../src/discover/roots.js';
import { buildReceipt, type ReceiptOptions } from '../../src/pipeline/receipt.js';
import { loadSessions } from '../../src/pipeline/run.js';
import { assertWidth } from '../../src/render/box.js';
import { renderReceipt, renderReceiptLines, type TermOptions } from '../../src/render/term.js';
import { strip } from '../../src/util/ansi.js';
import { TOOL_VERSION } from '../../src/version.js';
import { FIXTURES_ROOT, materialize } from '../helpers/fixtures.js';
import { GOLDEN_HOME } from '../helpers/goldens.js';
import { makeTempDir } from '../helpers/tmp.js';

const RECEIPTS_DIR = fileURLToPath(new URL('../../fixtures/render/receipts/', import.meta.url));
const HOME = '/home/u';

/** Control/invisible bytes no render may contain (ESC and C1 CSI included when colour is off). */
const HAZARD_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200b-\u200f]/;

interface Entry {
  name: string;
  receipt: Receipt;
}

const entries: Entry[] = readdirSync(RECEIPTS_DIR)
  .filter((n) => n.endsWith('.json'))
  .sort()
  .map((n) => ({ name: n.slice(0, -'.json'.length), receipt: JSON.parse(readFileSync(join(RECEIPTS_DIR, n), 'utf8')) as Receipt }));

// --- S19 golden receipts through the real pipeline --------------------------

const NOW = new Date('2026-08-29T12:00:00.000Z');
const prices = parsePriceTable(readFileSync(join(FIXTURES_ROOT, 'prices', 'prices.golden.json'), 'utf8'), 'prices.golden.json');

function receiptOpts(over: Partial<ReceiptOptions> = {}): ReceiptOptions {
  return { now: NOW, prices, homeDir: GOLDEN_HOME, ...over };
}

const tmp = makeTempDir('showreceipts-term-');
for (const id of ['claude-code/2.1.214', 'codex/shell_command']) {
  const into = join(tmp, id.replace(/\//g, '__'));
  materialize(id, into);
  const roots = resolveRoots(
    { CLAUDE_CONFIG_DIR: join(into, 'claude'), CODEX_HOME: join(into, 'codex'), SHOWRECEIPTS_HOME: join(into, 'sr') },
    GOLDEN_HOME,
  );
  const { sessions, diagnostics } = await loadSessions({ roots, all: true, noCache: true, versions: { tool: TOOL_VERSION }, now: NOW });
  if (diagnostics.problems.length > 0) throw new Error(`${id}: ${diagnostics.problems.join('; ')}`);
  const session = sessions[0] as Session;
  if (session === undefined || sessions.length !== 1) throw new Error(`${id}: expected exactly 1 session`);
  entries.push({ name: `golden ${id}`, receipt: buildReceipt(session, receiptOpts()) });
}

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function entryOf(name: string): Receipt {
  const e = entries.find((x) => x.name === name);
  if (e === undefined) throw new Error(`no fixture ${name}`);
  return e.receipt;
}

const WIDTHS = [60, 73, 74, 80, 100, 120] as const;
const MODES = [
  { name: 'unicode+color', unicode: true, color: true },
  { name: 'unicode', unicode: true, color: false },
  { name: 'ascii', unicode: false, color: false },
] as const;

function opts(cols: number, mode: (typeof MODES)[number], over: Partial<TermOptions> = {}): TermOptions {
  return { cols, unicode: mode.unicode, color: mode.color, tz: 'utc', homeDir: HOME, ...over };
}

/** The inner text of a frame line (borders and padding stripped). */
function inner(line: string): string {
  return strip(line)
    .replace(/^\s*[│|]\s{2}/, '')
    .replace(/\s*[│|]\s*$/, '');
}

/** Claim-glyph rows of a render (wide: glyph in the claim column; narrow: glyph first). */
function claimRowCount(lines: readonly string[]): number {
  return lines.filter((l) => /^[✓✗?+x~]\s/.test(inner(l)) === true && !/^~/.test(inner(l))).length;
}

/** The verdict line's inner text. */
function verdictOf(lines: readonly string[]): string {
  const line = lines.find((l) => inner(l).startsWith('VERDICT:'));
  return line === undefined ? '' : inner(line).trimEnd();
}

// ---------------------------------------------------------------------------
// The full matrix: width assertion + wide/narrow parity + hostile hygiene
// ---------------------------------------------------------------------------

describe('snapshot matrix invariants (every fixture × width × mode)', () => {
  for (const entry of entries) {
    it(`${entry.name}: every line fits at every width and mode`, () => {
      for (const cols of WIDTHS) {
        for (const mode of MODES) {
          const lines = renderReceiptLines(entry.receipt, opts(cols, mode));
          assertWidth(lines, Math.min(cols, 102));
          if (!mode.color) expect(lines.join('\n')).not.toMatch(HAZARD_RE);
        }
      }
    });

    it(`${entry.name}: wide and narrow renders carry identical claim rows and verdict`, () => {
      const wide = renderReceiptLines(entry.receipt, opts(80, MODES[1]));
      const narrow = renderReceiptLines(entry.receipt, opts(60, MODES[1]));
      expect(claimRowCount(wide)).toBe(entry.receipt.lines.length);
      expect(claimRowCount(narrow)).toBe(entry.receipt.lines.length);
      expect(verdictOf(narrow)).toBe(verdictOf(wide));
    });
  }
});

describe('committed snapshots (74 unicode · 60 ascii; goldens also at 80)', () => {
  for (const entry of entries) {
    it(`${entry.name} @74 unicode`, () => {
      expect(renderReceipt(entry.receipt, opts(74, MODES[1]))).toMatchSnapshot();
    });
    it(`${entry.name} @60 ascii`, () => {
      expect(renderReceipt(entry.receipt, opts(60, MODES[2]))).toMatchSnapshot();
    });
  }
  it('golden claude-code/2.1.214 @80 unicode', () => {
    expect(renderReceipt(entryOf('golden claude-code/2.1.214'), opts(80, MODES[1]))).toMatchSnapshot();
  });
  it('golden codex/shell_command @80 unicode', () => {
    expect(renderReceipt(entryOf('golden codex/shell_command'), opts(80, MODES[1]))).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// §10.2 demo-shaped CONTRADICTED sample
// ---------------------------------------------------------------------------

describe('§10.2 CONTRADICTED sample (74 columns, unicode, no colour)', () => {
  const lines = renderReceiptLines(entryOf('contradicted-demo'), opts(74, MODES[1]));
  const text = lines.join('\n');

  it('renders the sample rows verbatim', () => {
    expect(text).toContain('│  RECEIPT  #0badf00d · Claude Code 2.1.214 · claude-sonnet-5          │');
    expect(text).toContain('│  ~/proj/wattage · main · Jul 18 17:14 → 23:52 · 2h 05m               │');
    expect(text).toContain('│  CLAIMED                                 EVIDENCE                    │');
    expect(text).toContain('│  ✓ updated src/wattage/models.py         Edit ×3 (17:31, 17:32)      │');
    expect(text).toContain('│  ✓ tests pass                            uv run pytest → exit 0      │');
    expect(text).toContain('│                                          41 passed (23:41)           │');
    expect(text).toContain('│  ✗ lint is clean                         ruff → exit 1 (23:44)       │');
    expect(text).toContain('│                                          2 errors, never re-run      │');
    expect(text).toContain(`│  ${('? committed the changes'.padEnd(40) + 'no git commit in log').padEnd(66)}  │`);
    expect(text).toContain('│  · edited tests/test_normalize.py after last green run (not re-run)  │');
    expect(text).toContain('│  212 tool calls · 31 files changed · 4 test runs · 1 compaction      │');
    expect(text).toContain('│  cost $18.42 (API-equivalent) · cache hit 71%                        │');
    expect(text).toContain('│  VERDICT: 1 CONTRADICTED · 1 UNVERIFIED · 3 VERIFIED                 │');
  });

  it('the narrow ASCII render matches the §10.2 sample shape', () => {
    const narrow = renderReceiptLines(entryOf('contradicted-demo'), opts(60, MODES[2])).map(strip);
    const text60 = narrow.join('\n');
    expect(narrow[0]).toBe('+----------------------------------------------------------+');
    expect(text60).toContain('|  RECEIPT #0badf00d - Claude Code 2.1.214');
    expect(text60).toContain('|  + updated src/wattage/models.py');
    expect(text60).toContain('|      Edit x3 (17:31, 17:32)');
    expect(text60).toContain('|  x lint is clean');
    expect(text60).toContain('|  VERDICT: 1 CONTRADICTED - 1 UNVERIFIED - 3 VERIFIED');
  });
});

// ---------------------------------------------------------------------------
// Colour discipline
// ---------------------------------------------------------------------------

describe('colour is applied after layout', () => {
  it('stripping the coloured render yields exactly the uncoloured render', () => {
    for (const entry of entries) {
      for (const cols of [60, 74, 100]) {
        const colored = renderReceiptLines(entry.receipt, opts(cols, MODES[0]));
        const plain = renderReceiptLines(entry.receipt, opts(cols, MODES[1]));
        expect(colored.map(strip)).toEqual(plain);
      }
    }
  });

  it('the coloured render carries SGR paint on glyphs and verdict', () => {
    const text = renderReceiptLines(entryOf('contradicted-demo'), opts(74, MODES[0])).join('\n');
    expect(text).toContain('\x1b[31m✗\x1b[0m');
    expect(text).toContain('\x1b[32m✓\x1b[0m');
    expect(text).toMatch(/\x1b\[31mVERDICT: /);
  });
});

// ---------------------------------------------------------------------------
// Hostile strings
// ---------------------------------------------------------------------------

describe('hostile receipt (ANSI/OSC/RLO/U+2028/NUL in every string field)', () => {
  it('never emits a control, C1 or bidi byte in any mode or width', () => {
    for (const cols of WIDTHS) {
      for (const mode of [MODES[1], MODES[2]]) {
        const text = renderReceiptLines(entryOf('hostile'), opts(cols, mode)).join('\n');
        expect(text).not.toMatch(HAZARD_RE);
        expect(text.includes('\x1b')).toBe(false);
        expect(text.includes('\u009b')).toBe(false);
      }
    }
  });

  it('keeps the printable payload (sanitised, not transliterated)', () => {
    // The C1 CSI byte legitimately consumes its `2J` parameters when the
    // sequence is stripped — the surrounding words survive with one space.
    const text = renderReceiptLines(entryOf('hostile'), opts(100, MODES[1])).join('\n');
    expect(text).toContain('all tests pass really');
    expect(text).toContain('updated src/');
  });
});

// ---------------------------------------------------------------------------
// Header shrink and narrow re-flow
// ---------------------------------------------------------------------------

describe('header shrink order (200-char cwd + 40-char branch + 60-char model at 74)', () => {
  const lines = renderReceiptLines(entryOf('long-header'), opts(74, MODES[1]));
  const text = lines.join('\n');

  it('middle-truncates the cwd keeping the basename, cuts branch to 16+…, model to last 14', () => {
    expect(text).toContain('wattage');
    expect(text).toContain('…');
    expect(text).not.toContain('feature/extremely-long-branch-name-9999');
    expect(text).toContain('feature/extremel…'); // 16 columns + the ellipsis
    expect(text).toContain('…-long-model-id'); // the last 14 characters survive
    expect(text).not.toContain('claude-experimental-preview-with-an-unusually-long-model-id');
  });
});

describe('narrow header re-flow (long-header at 60 columns)', () => {
  const lines = renderReceiptLines(entryOf('long-header'), opts(60, MODES[1]));
  const inners = lines.map(inner);

  it('starts with RECEIPT #<id>, model heads a following line, no continuation indent', () => {
    expect(inners[1]).toMatch(/^RECEIPT #10093ead/);
    expect(inners.some((l) => l.startsWith('claude-experimental') || l.startsWith('…'))).toBe(true);
    const headerLines = inners.slice(1, 6).filter((l) => l !== '');
    for (const l of headerLines.slice(0, 3)) expect(l.startsWith(' ')).toBe(false);
  });

  it('wraps ALSO DID with the 2-space separator-less continuation', () => {
    const idx = inners.findIndex((l) => l.startsWith('· edited tests/test_normalize.py'));
    expect(idx).toBeGreaterThan(-1);
    expect(inners[idx + 1]).toMatch(/^ {2}\S/);
    expect(inners[idx + 1]).not.toMatch(/^ {2}·/);
  });
});

// ---------------------------------------------------------------------------
// Kinds, cost wording, caps
// ---------------------------------------------------------------------------

describe('kind texts and cost wording (§10.1)', () => {
  it('no-turns: records + slash commands, zero stats, no cost line, VERDICT: —', () => {
    const text = renderReceiptLines(entryOf('no-turns'), opts(74, MODES[1])).map(inner).join('\n');
    expect(text).toContain('no assistant turns in this session (12 records, 6 slash commands)');
    expect(text).toContain('0 tool calls · 0 files changed');
    expect(text).not.toContain('cost');
    expect(text).toContain('VERDICT: —');
    expect(text).not.toContain('2h');
  });

  it('no-final: stop_reason text, ALSO DID, VERDICT: NO FINAL MESSAGE', () => {
    const text = renderReceiptLines(entryOf('no-final'), opts(74, MODES[1])).map(inner).join('\n');
    expect(text).toContain('turn ended without a final message (stop_reason: tool_use)');
    expect(text).toContain('ALSO DID (not mentioned)');
    expect(text).toContain('VERDICT: NO FINAL MESSAGE');
  });

  it('hook-captured: header tag, no-claims text with the sentence count, cost n/a', () => {
    const text = renderReceiptLines(entryOf('hook-captured'), opts(74, MODES[1])).map(inner).join('\n');
    expect(text).toContain('hook-captured');
    expect(text).toContain('no claims recognized in the final message (0 claims · 4 sentences)');
    expect(text).toContain('cost n/a (hook-captured)');
    expect(text).toContain('VERDICT: NO CLAIMS');
  });

  it('codex plan usage: ≈ cost, cache hit and plan usage on the cost line', () => {
    const text = renderReceiptLines(entryOf('codex-plan-usage'), opts(74, MODES[1])).map(inner).join('\n');
    expect(text).toContain('cost ≈$0.07 (API-equivalent) · cache hit 87% · plan usage 1%');
    expect(text).toContain('VERDICT: 2 UNVERIFIED');
  });

  it('multi-day span: the end clock names its day and the session span renders', () => {
    const text = renderReceiptLines(entryOf('multi-day'), opts(100, MODES[1])).map(inner).join('\n');
    expect(text).toContain('Aug 23 23:15 → Aug 24 01:38');
    expect(text).toContain('session Jul 18 → Aug 23 (36d)');
  });
});

describe('claim-row cap (§5.2 audit cap)', () => {
  it('capRows 12 shows 12 rows plus `+8 more claims · showreceipts session <id>`', () => {
    const lines = renderReceiptLines(entryOf('twenty-claims'), opts(80, MODES[1], { capRows: 12 }));
    expect(claimRowCount(lines)).toBe(12);
    expect(lines.map(inner).join('\n')).toContain('+8 more claims · showreceipts session 20c1a1d5');
  });

  it('--all-claims lifts the cap', () => {
    const lines = renderReceiptLines(entryOf('twenty-claims'), opts(80, MODES[1], { capRows: 12, allClaims: true }));
    expect(claimRowCount(lines)).toBe(20);
    expect(lines.map(inner).join('\n')).not.toContain('more claims');
  });
});

describe('CJK and long paths', () => {
  it('CJK claims measure by display width and never overflow', () => {
    for (const cols of WIDTHS) {
      assertWidth(renderReceiptLines(entryOf('cjk-path'), opts(cols, MODES[1])), Math.min(cols, 102));
    }
  });

  it('a 200-char cwd is middle-truncated keeping the basename', () => {
    const text = renderReceiptLines(entryOf('long-cwd'), opts(74, MODES[1])).join('\n');
    expect(text).toContain('wattage');
    expect(text).not.toContain('deeply-nested-directory-segment-05');
  });
});
