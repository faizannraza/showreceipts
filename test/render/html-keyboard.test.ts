/**
 * S22 (f) — keyboard battery (§11.4), as source assertions over `report.js`:
 * the keydown handler bails on modifier chords and on form-control targets,
 * every `localStorage` access sits inside a try block, the shortcut set
 * (j/k/Enter/Esc/?) is present, and the on/off switch persists under
 * `showreceipts.keys` (§11.4).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('../../src/render/report.js', import.meta.url), 'utf8');

describe('keydown guards', () => {
  it('checks ctrlKey/metaKey/altKey before acting', () => {
    expect(src).toContain('e.ctrlKey || e.metaKey || e.altKey');
  });

  it('ignores events targeted at form controls and editable regions', () => {
    for (const tag of ["'INPUT'", "'TEXTAREA'", "'SELECT'"]) expect(src).toContain(tag);
    expect(src).toContain('isContentEditable');
  });

  it('registers exactly one global keydown listener', () => {
    const count = src.split("addEventListener('keydown'").length - 1;
    expect(count).toBe(1);
  });
});

describe('shortcuts', () => {
  it('handles j, k, Enter, Escape and ?', () => {
    for (const check of ["e.key === 'j'", "e.key === 'k'", "e.key === 'Enter'", "e.key === 'Escape'", "e.key === '?'"]) {
      expect(src).toContain(check);
    }
  });

  it('has an on/off switch persisted under showreceipts.keys (§11.4)', () => {
    expect(src).toContain("lsGet('showreceipts.keys')");
    expect(src).toContain("lsSet('showreceipts.keys'");
  });

  it('arrow keys mirror j/k', () => {
    expect(src).toContain("'ArrowDown'");
    expect(src).toContain("'ArrowUp'");
  });

  it('handles the rest of the §11.4 set: o, /, t, h, [, ], e', () => {
    for (const check of ["e.key === 'o'", "e.key === '/'", "e.key === 't'", "e.key === 'h'", "e.key === '['", "e.key === ']'", "e.key === 'e'"]) {
      expect(src).toContain(check);
    }
  });

  it("gates every shortcut — '?' included — behind the showreceipts.keys switch", () => {
    const gate = src.indexOf('if (!keysOn) return;');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(src.indexOf("e.key === '?'"));
  });
});

describe('storage safety', () => {
  it('wraps every localStorage access in try/catch', () => {
    const indices: number[] = [];
    let at = src.indexOf('localStorage');
    while (at !== -1) {
      indices.push(at);
      at = src.indexOf('localStorage', at + 1);
    }
    expect(indices.length).toBeGreaterThanOrEqual(3);
    for (const i of indices) {
      const before = src.slice(Math.max(0, i - 40), i);
      expect(before, `localStorage at offset ${i} must sit inside try {`).toContain('try {');
    }
  });

  it('funnels storage through the three ls helpers', () => {
    for (const helper of ['function lsGet', 'function lsSet', 'function lsDel']) expect(src).toContain(helper);
  });
});
