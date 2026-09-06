/**
 * S23b — the `demo` command and the frozen §10.2 samples.
 *
 * Every scenario renders at `--width 74 --tz utc` (unicode, no colour) and is
 * compared to `docs/samples/<scenario>.txt` (`UPDATE_GOLDENS=1` rewrites).
 * The four §10.2 spec samples and the 60-column ASCII sample are additionally
 * byte-identical to `fixtures/render/samples-spec/*.txt` — the reconciled
 * pins that `UPDATE_GOLDENS` never rewrites, so any renderer drift from the
 * spec fails here even after a golden refresh.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Receipt } from '../../src/model/types.js';
import { parse } from '../../src/cli/args.js';
import { createContext } from '../../src/cli/context.js';
import { DEMO_HOME, demoReceipts, run } from '../../src/commands/demo.js';
import { SCENARIOS } from '../../src/demo/scenarios.js';
import { assertWidth } from '../../src/render/box.js';
import { approxLegend } from '../../src/render/summary.js';
import { renderReceipt, renderReceiptLines, type TermOptions } from '../../src/render/term.js';
import { makeTempDir } from '../helpers/tmp.js';

const UPDATE = process.env['UPDATE_GOLDENS'] === '1';
const SAMPLES_DIR = fileURLToPath(new URL('../../docs/samples/', import.meta.url));
const SPEC_DIR = fileURLToPath(new URL('../../fixtures/render/samples-spec/', import.meta.url));
const NOW = new Date('2026-08-29T12:00:00.000Z');

/** `docs/samples` render: §10.2's `demo --width 74 --tz utc --no-color --unicode`. */
const WIDE: TermOptions = { cols: 74, unicode: true, color: false, tz: 'utc', homeDir: DEMO_HOME };
/** The narrow §10.2 sample: `--width 60 --ascii --no-color`. */
const NARROW: TermOptions = { cols: 60, unicode: false, color: false, tz: 'utc', homeDir: DEMO_HOME };

/** The four §10.2 spec scenarios, plus the 60-column ASCII pin of the first. */
const SPEC_NAMES = ['contradicted', 'verified', 'unverified-codex', 'no-claims-ledger'] as const;

const receipts = await demoReceipts(NOW);
const byName = new Map<string, Receipt>(SCENARIOS.map((s, i) => [s.name, receipts[i] as Receipt]));

function receiptNamed(name: string): Receipt {
  const r = byName.get(name);
  if (r === undefined) throw new Error(`no scenario named ${name}`);
  return r;
}

/** A minimal writable sink for the injected command context. */
interface Sink extends NodeJS.WritableStream {
  text: string;
}

function sink(): Sink {
  const s = {
    text: '',
    write(chunk: unknown): boolean {
      s.text += String(chunk);
      return true;
    },
  };
  return s as unknown as Sink;
}

/** Runs the demo command in-process with pinned env and clock. */
async function runDemo(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out = sink();
  const err = sink();
  const args = parse(['demo', ...argv]);
  const ctx = createContext(args, { stdout: out, stderr: err, env: {}, cwd: '/', now: NOW, isTTY: false });
  const code = await run(ctx);
  return { code, out: out.text, err: err.text };
}

// ---------------------------------------------------------------------------
// docs/samples goldens (UPDATE_GOLDENS=1 rewrites)
// ---------------------------------------------------------------------------

describe('every scenario renders to its docs/samples golden (74 · unicode · utc)', () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, () => {
      const text = renderReceipt(receiptNamed(scenario.name), WIDE);
      const path = join(SAMPLES_DIR, `${scenario.name}.txt`);
      if (UPDATE) {
        mkdirSync(SAMPLES_DIR, { recursive: true });
        writeFileSync(path, text);
      }
      expect(text).toBe(readFileSync(path, 'utf8'));
    });
  }
});

// ---------------------------------------------------------------------------
// The frozen §10.2 pins (never rewritten by UPDATE_GOLDENS)
// ---------------------------------------------------------------------------

// The frozen pins are written ONLY under this explicit env (one reconciliation
// pass, S23b) — never under UPDATE_GOLDENS, so a renderer drift that slips
// into a golden refresh still fails against the reconciled §10.2 text.
if (process.env['UPDATE_SAMPLES_SPEC'] === '1') {
  mkdirSync(SPEC_DIR, { recursive: true });
  for (const name of SPEC_NAMES) {
    writeFileSync(join(SPEC_DIR, `${name}.txt`), renderReceipt(receiptNamed(name), WIDE));
  }
  writeFileSync(join(SPEC_DIR, 'contradicted-60-ascii.txt'), renderReceipt(receiptNamed('contradicted'), NARROW));
}

describe('§10.2 spec samples are byte-identical to fixtures/render/samples-spec', () => {
  for (const name of SPEC_NAMES) {
    it(`${name} @74 unicode`, () => {
      const text = renderReceipt(receiptNamed(name), WIDE);
      expect(text).toBe(readFileSync(join(SPEC_DIR, `${name}.txt`), 'utf8'));
    });
  }

  it('contradicted @60 ascii (the narrow §10.2 sample)', () => {
    const text = renderReceipt(receiptNamed('contradicted'), NARROW);
    expect(text).toBe(readFileSync(join(SPEC_DIR, 'contradicted-60-ascii.txt'), 'utf8'));
  });

  it('the spec samples carry no ALSO SAID section (§14.1 decision a)', () => {
    for (const name of SPEC_NAMES) {
      expect(renderReceipt(receiptNamed(name), WIDE)).not.toContain('ALSO SAID');
    }
  });
});

// ---------------------------------------------------------------------------
// Layout invariants
// ---------------------------------------------------------------------------

describe('layout invariants over every scenario', () => {
  it('every line fits at 60, 74, 80 and 102 columns', () => {
    for (const receipt of receipts) {
      for (const cols of [60, 74, 80, 102]) {
        for (const unicode of [true, false]) {
          const lines = renderReceiptLines(receipt, { ...WIDE, cols, unicode });
          assertWidth(lines, cols);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The command shell
// ---------------------------------------------------------------------------

describe('demo command', () => {
  it('default text output is the docs/samples files concatenated, plus the one-line ≈ legend', async () => {
    const { code, out } = await runDemo(['--width', '74', '--tz', 'utc', '--no-color', '--unicode']);
    expect(code).toBe(0);
    const expected = SCENARIOS.map((s) => readFileSync(join(SAMPLES_DIR, `${s.name}.txt`), 'utf8')).join('\n');
    // §8.3 / Pass 3: a screen that showed ≈ explains it once, after the last receipt.
    expect(out).toBe(`${expected}\n${approxLegend(true, 74).join('\n')}\n`);
    expect(out.match(/≈ = estimated/g)?.length).toBe(1);
  });

  it('--json emits one array with every scenario receipt, in order', async () => {
    const { code, out } = await runDemo(['--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as Receipt[];
    expect(parsed).toHaveLength(SCENARIOS.length);
    expect(parsed.map((r) => r.shortId).slice(0, 4)).toEqual(['0badf00d', '00decaf0', 'c0dec0de', '0cafe000']);
    expect(parsed.map((r) => r.verdict)).toEqual(SCENARIOS.map((s) => s.expect.verdict));
  });

  it('--json output is deterministic across runs', async () => {
    const a = await runDemo(['--json']);
    const b = await runDemo(['--json']);
    expect(a.out).toBe(b.out);
  });

  it('--svg FILE writes the first scenario as an SVG and keeps stdout intact', async () => {
    const tmp = makeTempDir('showreceipts-demo-svg-');
    const file = join(tmp, 'receipt.svg');
    const { code, out } = await runDemo(['--width', '74', '--unicode', '--no-color', '--svg', file]);
    expect(code).toBe(0);
    const svg = readFileSync(file, 'utf8');
    expect(svg.startsWith('<svg ')).toBe(true);
    expect(svg).toContain('#0badf00d');
    expect(svg).not.toContain('<script');
    // the standalone image is labelled as the demo scenario (docs/release.md step 4)
    expect(svg).toContain('aria-label="showreceipts demo scenario receipt #0badf00d"');
    expect(svg).toContain('>demo scenario</text>');
    expect(out).toContain('RECEIPT');
  });

  it('--ascii wins over --unicode and renders the ASCII frame', async () => {
    const { out } = await runDemo(['--width', '60', '--ascii', '--unicode', '--no-color']);
    expect(out.startsWith('+---')).toBe(true);
    expect(out).not.toContain('┌');
  });
});
