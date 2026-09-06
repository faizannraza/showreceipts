/**
 * S26 e2e — `node dist/cli.js demo`: byte-identical to the frozen
 * `docs/samples/*.txt` goldens at the §10.2 render (`--width 74 --tz utc`,
 * unicode, no colour), the `--json` array against the schema, and ASCII
 * mode. Demo touches no root, cache or override by design (§12.1).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Receipt } from '../../src/model/types.js';
import { SCENARIOS } from '../../src/demo/scenarios.js';
import { approxLegend } from '../../src/render/summary.js';
import { loadSchemaDoc, validateAgainst } from '../helpers/schema.js';
import { runCli } from '../helpers/spawn.js';

const doc = loadSchemaDoc();
const SAMPLES_DIR = fileURLToPath(new URL('../../docs/samples/', import.meta.url));

describe('demo (text)', () => {
  it('matches the docs/samples goldens concatenated in scenario order, plus the ≈ legend', () => {
    const r = runCli(['demo', '--width', '74', '--unicode', '--tz', 'utc', '--no-color']);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    const expected = SCENARIOS.map((s) => readFileSync(join(SAMPLES_DIR, `${s.name}.txt`), 'utf8')).join('\n');
    expect(r.stdout).toBe(`${expected}\n${approxLegend(true, 74).join('\n')}\n`);
  });

  it('--ascii renders the ASCII frame with no unicode glyphs', () => {
    const r = runCli(['demo', '--width', '60', '--ascii', '--no-color']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('+--');
    expect(r.stdout).not.toContain('┌');
    expect(r.stdout).not.toContain('·');
  });
});

describe('demo --json (§12.3)', () => {
  it('emits one receipt per scenario, validating against the schema', () => {
    const r = runCli(['demo', '--json']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as Receipt[];
    expect(validateAgainst(doc, 'demo', parsed)).toEqual([]);
    expect(parsed).toHaveLength(SCENARIOS.length);
    expect(parsed.map((receipt) => receipt.verdict)).toEqual(SCENARIOS.map((s) => s.expect.verdict));
  });

  it('is byte-identical across runs (seeded PRNG, no clock leak)', () => {
    const a = runCli(['demo', '--json']);
    const b = runCli(['demo', '--json']);
    expect(a.code).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  });
});
