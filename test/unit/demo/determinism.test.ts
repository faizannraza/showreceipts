/**
 * S23a determinism: two `generate()` runs are byte-identical, and the demo
 * sources contain no wall clock, `Math.random`, environment or filesystem
 * access (the §0.2 determinism pins, enforced at the source level).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generate, type Generated } from '../../../src/demo/gen.js';
import { SCENARIOS } from '../../../src/demo/scenarios.js';

/** A canonical JSON form of one generation (Maps become sorted entry lists). */
function snapshot(g: Generated): string {
  return JSON.stringify({
    harness: g.harness,
    lines: g.lines,
    ledger: g.ledger ?? null,
    subagents: g.subagents === undefined ? null : [...g.subagents.entries()].sort((a, b) => a[0].localeCompare(b[0])),
  });
}

describe('determinism', () => {
  it.each(SCENARIOS.map((s) => [s.name, s] as const))('%s: two runs produce identical JSON', (_name, scenario) => {
    expect(snapshot(generate(scenario))).toBe(snapshot(generate(scenario)));
  });

  it('scenario names are unique and non-empty', () => {
    const names = SCENARIOS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('source hygiene (PLAN §0.2: seeded PRNG only)', () => {
  const files = ['dsl.ts', 'gen.ts', 'prng.ts', 'scenarios.ts'];

  it.each(files)('src/demo/%s reads no clock, randomness, environment or filesystem', (name) => {
    const raw = readFileSync(fileURLToPath(new URL(`../../../src/demo/${name}`, import.meta.url)), 'utf8');
    // Comments may *name* the forbidden APIs (that is the point of the pins); code may not.
    const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(source).not.toMatch(/Math\.random/);
    expect(source).not.toMatch(/Date\.now/);
    expect(source).not.toMatch(/new Date\(\s*\)/);
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/from\s+'node:/);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bIntl\b/);
  });
});
