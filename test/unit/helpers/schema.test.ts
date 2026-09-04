/**
 * S23c — `docs/receipt-schema.md` and its validator
 * (`test/helpers/schema.ts`): every §12.3 block parses, every reference
 * resolves, the validator rejects missing keys / wrong types / unknown enum
 * choices, and the real `demo --json` receipts conform to the Receipt block.
 */
import { describe, expect, it } from 'vitest';
import { demoReceipts } from '../../../src/commands/demo.js';
import { stableStringify } from '../../../src/util/json.js';
import { loadSchemaDoc, referencesOf, schemaNames, validateAgainst, type SchemaDoc } from '../../helpers/schema.js';

const doc = loadSchemaDoc();

describe('the schema document', () => {
  it('parses and defines every §12.3 command shape', () => {
    const names = schemaNames(doc);
    for (const name of ['audit', 'session', 'export', 'report', 'doctor', 'bench', 'bench-publish', 'setup', 'demo']) {
      expect(names, name).toContain(name);
    }
    expect(names).toContain('Receipt');
    expect(names).toContain('SessionCard');
    expect(names).toContain('RateRow');
    expect(names).toContain('DoctorReport');
  });

  it('every reference inside every block resolves to a block', () => {
    for (const [name, spec] of doc.schemas) {
      for (const ref of referencesOf(spec)) {
        expect(doc.schemas.has(ref), `${name} → ${ref}`).toBe(true);
      }
    }
  });
});

describe('validation of real output', () => {
  it('demo --json receipts conform to the Receipt schema', async () => {
    const receipts = await demoReceipts(new Date('2026-08-29T12:00:00.000Z'));
    expect(receipts.length).toBeGreaterThan(4);
    const plain: unknown = JSON.parse(stableStringify(receipts));
    expect(validateAgainst(doc, 'demo', plain)).toEqual([]);
  });

  it('the §13.3 publish sample conforms to bench-publish', () => {
    const sample = {
      schema: 'showreceipts.bench-publish/1',
      generator: { name: 'showreceipts', version: '0.1.0', rulesVersion: 'claims/1', pricesVersion: '2026-08-29' },
      period: { from: '2026-07', to: '2026-07', partial: false },
      platform: { os: 'darwin', node: '26' },
      contentHash: '8f3c1a2b9d4e5f60',
      rows: [
        {
          harness: 'claude-code',
          harnessVersion: '2.1.214',
          model: 'claude-sonnet-5',
          sessions: 12,
          turns: 41,
          doneTurns: 29,
          contradictedTurns: 3,
          unverifiedTurns: 7,
          cleanTurns: 19,
          claims: {
            total: 88,
            verified: 61,
            unverified: 19,
            contradicted: 8,
            notScored: 13,
            byKind: { test: 30, check: 21, file: 25, git: 9, command: 2, verification: 1 },
          },
          testRunRate: 0.72,
          integritySignals: 2,
          ledgerIncompleteSessions: 0,
          costPerDoneTurnUsd: 4.1,
          cacheHitPct: 71,
          contradictionReasons: { 'last-run-red': 2, 'no-test-run': 1 },
        },
      ],
    };
    expect(validateAgainst(doc, 'bench-publish', sample)).toEqual([]);
  });

  it('a DoctorHookReport sample conforms, and a broken one is rejected', () => {
    const row = {
      harness: 'claude-code',
      scope: 'user',
      configPath: '/home/u/.claude/settings.json',
      installed: true,
      command: '"/home/u/.showreceipts/bin/showreceipts-hook" hook claude-code Stop',
      resolvable: true,
      resolvableNote: 'static check; the harness process PATH may differ',
      disabled: false,
      otherStopHooks: [],
      strict: false,
      trusted: 'unknown',
    };
    expect(validateAgainst(doc, 'DoctorHookReport', row)).toEqual([]);
    const broken = { ...row, trusted: 'maybe', scope: 'global' };
    const errors = validateAgainst(doc, 'DoctorHookReport', broken);
    expect(errors.some((e) => e.includes('.scope'))).toBe(true);
    expect(errors.some((e) => e.includes('.trusted'))).toBe(true);
  });

  it('a SetupResult sample conforms', () => {
    const entry = {
      harness: 'gemini',
      path: '/home/u/.gemini/settings.json',
      scope: 'user',
      action: 'installed',
      backup: null,
      launcher: '/home/u/.showreceipts/bin/showreceipts-hook',
      diff: '+ hooks',
      notes: [],
    };
    expect(validateAgainst(doc, 'setup', [entry])).toEqual([]);
  });
});

describe('validator self-tests', () => {
  const tiny: SchemaDoc = {
    schemas: new Map([
      ['Thing', { a: 'string', b: 'enum(x|y)', 'c?': 'number', d: ['number'], e: 'record(number)', f: 'string|null' }],
      ['Wrap', { inner: 'Thing' }],
    ]),
  };
  const good = { a: 'hi', b: 'x', d: [1, 2], e: { k: 3 }, f: null };

  it('accepts a conforming object (optional keys may be absent)', () => {
    expect(validateAgainst(tiny, 'Thing', good)).toEqual([]);
    expect(validateAgainst(tiny, 'Thing', { ...good, c: 5, extra: 'tolerated' })).toEqual([]);
    expect(validateAgainst(tiny, 'Wrap', { inner: good })).toEqual([]);
  });

  it('rejects a missing key', () => {
    const { a: _a, ...rest } = good;
    expect(validateAgainst(tiny, 'Thing', rest)).toEqual(['Thing.a: missing key']);
  });

  it('rejects a wrong type with the expected spec in the message', () => {
    const errors = validateAgainst(tiny, 'Thing', { ...good, a: 42 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Thing.a: expected string');
  });

  it('rejects a string outside the enum', () => {
    const errors = validateAgainst(tiny, 'Thing', { ...good, b: 'z' });
    expect(errors).toEqual(["Thing.b: expected enum(x|y), got 'z'"]);
  });

  it('checks arrays, records, unions and nested references element-wise', () => {
    expect(validateAgainst(tiny, 'Thing', { ...good, d: [1, 'two'] })[0]).toContain('Thing.d[1]');
    expect(validateAgainst(tiny, 'Thing', { ...good, e: { k: 'v' } })[0]).toContain('Thing.e');
    expect(validateAgainst(tiny, 'Thing', { ...good, f: 7 })[0]).toContain('Thing.f: expected string|null');
    expect(validateAgainst(tiny, 'Wrap', { inner: { ...good, b: 'z' } })[0]).toContain('Wrap.inner.b');
  });

  it('throws on unknown schema names, unknown references and unparsable atoms', () => {
    expect(() => validateAgainst(tiny, 'Nope', {})).toThrow(/no schema named/);
    const badRef: SchemaDoc = { schemas: new Map([['X', { a: 'Missing' }]]) };
    expect(validateAgainst(badRef, 'X', { a: 1 })[0]).toContain("unknown schema reference 'Missing'");
    const badAtom: SchemaDoc = { schemas: new Map([['X', { a: 'flurb' }]]) };
    expect(() => validateAgainst(badAtom, 'X', { a: 1 })).toThrow(/unparsable spec atom/);
  });

  it('supports const and literal-true atoms', () => {
    const d: SchemaDoc = { schemas: new Map([['X', { s: 'const:fixed', t: 'true' }]]) };
    expect(validateAgainst(d, 'X', { s: 'fixed', t: true })).toEqual([]);
    expect(validateAgainst(d, 'X', { s: 'other', t: false })).toHaveLength(2);
  });
});
