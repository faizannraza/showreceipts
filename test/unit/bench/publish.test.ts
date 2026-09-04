/**
 * S25 — `bench/publish.ts` + `bench/validate.ts`: month snapping, the
 * built-in-key model mapping (§13.3), row merging and rounding, the
 * envelope's content hash, and every Appendix D validator rule triggered
 * once (whitelist keys, string charset, the `/` rule, month regexes, finite
 * non-negative numbers, hash recomputation, enums, the day-precision scan
 * sparing only `generator.pricesVersion`, and the forbidden substrings).
 */
import { describe, expect, it } from 'vitest';
import type { PublishPayload, PublishRow, RateRow } from '../../../src/model/types.js';
import {
  buildPublishPayload,
  buildPublishRows,
  monthBoundsMs,
  resolveBuiltinKey,
  snapPeriod,
  utcMonthOf,
} from '../../../src/bench/publish.js';
import { validatePublish, type PublishContext } from '../../../src/bench/validate.js';
import { loadPriceTable } from '../../../src/cost/resolve.js';
import { sha256 } from '../../../src/util/hash.js';
import { stableStringify } from '../../../src/util/json.js';

const NOW = new Date('2026-08-29T12:00:00.000Z');
const table = loadPriceTable();

function rateRow(over: Partial<RateRow> = {}): RateRow {
  return {
    model: 'claude-sonnet-5',
    harness: 'claude-code',
    harnessVersion: '2.1.214',
    sessions: 2,
    turns: 10,
    doneTurns: 8,
    doneTurnsByTrigger: { claims: 7, markerOnly: 1 },
    byTrigger: { human: 8, notification: 0 },
    contradictedTurns: 1,
    unverifiedTurns: 2,
    cleanTurns: 5,
    claims: {
      total: 20,
      verified: 14,
      unverified: 4,
      contradicted: 2,
      notScored: 0,
      byKind: {
        file: 8,
        'file-count': 0,
        test: 6,
        'test-added': 0,
        'test-ran': 0,
        check: 4,
        command: 0,
        install: 0,
        git: 2,
        verification: 0,
        completion: 0,
        'no-change': 0,
      },
    },
    testRunRate: 0.725,
    costPerDoneTurnUsd: { median: 4.105, mean: 4.4 },
    contradictionReasons: { 'last-run-red': 2 },
    integritySignals: 1,
    ledgerIncompleteSessions: 0,
    cacheHitPct: 70.6,
    ...over,
  };
}

describe('month snapping (§13.3)', () => {
  it('defaults to the previous complete month; the current month is partial', () => {
    expect(snapPeriod(NOW)).toEqual({ from: '2026-07', to: '2026-07', partial: false });
    expect(snapPeriod(NOW, '2026-08')).toEqual({ from: '2026-08', to: '2026-08', partial: true });
    expect(snapPeriod(NOW, '2026-02')).toEqual({ from: '2026-02', to: '2026-02', partial: false });
    expect(snapPeriod(new Date('2026-01-15T00:00:00Z'))).toEqual({ from: '2025-12', to: '2025-12', partial: false });
    expect(() => snapPeriod(NOW, '2026-13')).toThrow(RangeError);
  });

  it('monthBoundsMs covers the whole UTC month', () => {
    expect(monthBoundsMs('2026-02')).toEqual({ startMs: Date.UTC(2026, 1, 1), endMs: Date.UTC(2026, 2, 1) });
    expect(utcMonthOf(NOW)).toBe('2026-08');
  });
});

describe('resolveBuiltinKey (§8.1 normalisation → built-in key or other)', () => {
  it('maps ids onto built-in keys', () => {
    expect(resolveBuiltinKey('claude-sonnet-5', table)).toBe('claude-sonnet-5');
    expect(resolveBuiltinKey('Claude-Sonnet-5', table)).toBe('claude-sonnet-5');
    expect(resolveBuiltinKey('claude-sonnet-5[1m]', table)).toBe('claude-sonnet-5');
    expect(resolveBuiltinKey('gpt-5.2-codex', table)).toBe('gpt-5.2');
    expect(resolveBuiltinKey('gpt-5.6-terra', table)).toBe('gpt-5.6-terra');
  });

  it('maps partner-marked and unknown ids to other', () => {
    expect(resolveBuiltinKey('us.anthropic.claude-sonnet-5-v1', table)).toBe('other');
    expect(resolveBuiltinKey('claude-sonnet-5@20260101', table)).toBe('other');
    expect(resolveBuiltinKey('completely-unknown-model', table)).toBe('other');
  });

  it('never returns an unpublishable key', () => {
    for (const id of ['claude-zzz-experimental', 'gpt-5.4-codex-mini', 'grok-nonsense', 'mistral-whatever']) {
      const key = resolveBuiltinKey(id, table);
      expect(key === 'other' || /^[A-Za-z0-9.\-_ ]{1,64}$/.test(key), `${id} → ${key}`).toBe(true);
    }
  });
});

describe('buildPublishRows', () => {
  it('maps, rounds, drops zero kinds and excludes <synthetic>', () => {
    const rows = buildPublishRows([rateRow(), rateRow({ model: '<synthetic>', harness: 'codex' })], table);
    expect(rows).toHaveLength(1);
    const row = rows[0] as PublishRow;
    expect(row.model).toBe('claude-sonnet-5');
    expect(row.harnessVersion).toBe('2.1.214');
    expect(row.testRunRate).toBe(0.73);
    expect(row.costPerDoneTurnUsd).toBe(4.11);
    expect(row.cacheHitPct).toBe(71);
    expect(row.claims.byKind).toEqual({ file: 8, test: 6, check: 4, git: 2 });
    expect(row.contradictionReasons).toEqual({ 'last-run-red': 2 });
  });

  it('folds a non-publishable harness version to unknown and merges colliding keys', () => {
    const rows = buildPublishRows(
      [
        rateRow({ model: 'weird-model-a', harnessVersion: 'nightly', sessions: 2, doneTurns: 4, testRunRate: 1, costPerDoneTurnUsd: { median: 2, mean: 2 } }),
        rateRow({ model: 'weird-model-b', harnessVersion: 'nightly', sessions: 2, doneTurns: 4, testRunRate: 0.5, costPerDoneTurnUsd: { median: 4, mean: 4 } }),
      ],
      table,
    );
    expect(rows).toHaveLength(1);
    const row = rows[0] as PublishRow;
    expect(row.model).toBe('other');
    expect(row.harnessVersion).toBe('unknown');
    expect(row.sessions).toBe(4);
    expect(row.turns).toBe(20);
    expect(row.testRunRate).toBe(0.75); // sessions-weighted
    expect(row.costPerDoneTurnUsd).toBe(3); // doneTurns-weighted median
  });

  it('null rates stay null', () => {
    const rows = buildPublishRows([rateRow({ testRunRate: null, costPerDoneTurnUsd: null, cacheHitPct: null })], table);
    const row = rows[0] as PublishRow;
    expect(row.testRunRate).toBeNull();
    expect(row.costPerDoneTurnUsd).toBeNull();
    expect(row.cacheHitPct).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Appendix D validator
// ---------------------------------------------------------------------------

const ENVELOPE = {
  version: '0.1.0',
  rulesVersion: 'claims/1',
  pricesVersion: '2026-08-29',
  os: 'darwin',
  nodeMajor: '26',
  period: { from: '2026-02', to: '2026-02', partial: false },
};

function ctx(over: Partial<PublishContext> = {}): PublishContext {
  return {
    builtinModelKeys: new Set(Object.keys(table.models)),
    homePaths: ['/Users/someone'],
    hostname: 'mymachine',
    usernames: ['longusername'],
    sessionIds: ['0199aaaa-bbbb-4ccc-8ddd-eeeeffff0000'],
    shortIds: ['abcd1234'],
    ...over,
  };
}

function payloadOf(rows: PublishRow[] = buildPublishRows([rateRow()], table)): PublishPayload {
  return buildPublishPayload(rows, ENVELOPE);
}

function check(payload: PublishPayload, context: PublishContext = ctx()): string[] {
  return validatePublish(payload, `${stableStringify(payload)}\n`, context);
}

/** A structurally-cloned payload with an edit applied (hash NOT recomputed unless asked). */
function mutate(edit: (p: PublishPayload) => void, rehash = true): PublishPayload {
  const p = structuredClone(payloadOf());
  edit(p);
  if (rehash) p.contentHash = sha256(stableStringify(p.rows)).slice(0, 16);
  return p;
}

describe('validatePublish (Appendix D, rule by rule)', () => {
  it('accepts a well-formed payload, empty rows included', () => {
    expect(check(payloadOf())).toEqual([]);
    expect(check(payloadOf([]))).toEqual([]);
  });

  it('the content hash is stable and §13.3-exact', () => {
    const rows = buildPublishRows([rateRow()], table);
    const a = buildPublishPayload(rows, ENVELOPE);
    const b = buildPublishPayload(structuredClone(rows), ENVELOPE);
    expect(a.contentHash).toBe(sha256(stableStringify(rows)).slice(0, 16));
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  const cases: { rule: string; payload: () => PublishPayload }[] = [
    { rule: 'unknown-key', payload: () => mutate((p) => ((p as unknown as Record<string, unknown>)['extra'] = 1)) },
    { rule: 'schema', payload: () => mutate((p) => ((p as unknown as Record<string, unknown>)['schema'] = 'nope/1')) },
    { rule: 'month-format', payload: () => mutate((p) => (p.period.from = '2026-2')) },
    { rule: 'node-major', payload: () => mutate((p) => (p.platform.node = 'v26')) },
    { rule: 'number', payload: () => mutate((p) => ((p.rows[0] as PublishRow).sessions = -1)) },
    { rule: 'content-hash', payload: () => mutate((p) => ((p.rows[0] as PublishRow).sessions = 99), false) },
    { rule: 'harness-enum', payload: () => mutate((p) => (((p.rows[0] as PublishRow) as unknown as Record<string, unknown>)['harness'] = 'frob')) },
    { rule: 'harness-version', payload: () => mutate((p) => ((p.rows[0] as PublishRow).harnessVersion = 'nightly-9')) },
    { rule: 'model-key', payload: () => mutate((p) => ((p.rows[0] as PublishRow).model = 'not-a-price-key')) },
    { rule: 'string-charset', payload: () => mutate((p) => ((p.rows[0] as PublishRow).model = 'a$b')) },
    { rule: 'slash', payload: () => mutate((p) => ((p.rows[0] as PublishRow).model = 'gpt/5')) },
    { rule: 'claim-kind', payload: () => mutate((p) => (((p.rows[0] as PublishRow).claims.byKind as Record<string, number>)['bogus'] = 1)) },
    { rule: 'reason-enum', payload: () => mutate((p) => (((p.rows[0] as PublishRow).contradictionReasons as Record<string, number>)['bogus'] = 1)) },
    { rule: 'day-precision', payload: () => mutate((p) => (p.generator.version = '2026-08-29')) },
    { rule: 'prices-version', payload: () => mutate((p) => (p.generator.pricesVersion = '2026-08')) },
  ];
  for (const { rule, payload } of cases) {
    it(`refuses on ${rule}`, () => {
      const violations = check(payload());
      expect(violations.some((v) => v.startsWith(`${rule}:`)), violations.join(' | ')).toBe(true);
    });
  }

  it('generator.pricesVersion is the one string allowed to be a date', () => {
    expect(check(payloadOf())).toEqual([]); // pricesVersion 2026-08-29 in the base envelope
  });

  it('schema and rulesVersion are the only strings that may contain a slash — and only one', () => {
    const good = payloadOf();
    expect(good.schema).toContain('/');
    expect(good.generator.rulesVersion).toContain('/');
    expect(check(good)).toEqual([]);
    // Appendix D: at most one '/'. `schema` is pinned by exact equality (any
    // deviation, an extra slash included, refuses with `schema:`); the shared
    // checkString multi-slash guard is reachable via generator.rulesVersion.
    const twoInSchema = mutate((p) => ((p as unknown as Record<string, unknown>)['schema'] = 'showreceipts.bench-publish/1/x'));
    expect(check(twoInSchema).some((v) => v.startsWith('schema:'))).toBe(true);
    const twoInRules = mutate((p) => (p.generator.rulesVersion = 'claims/1/x'));
    expect(check(twoInRules).some((v) => v.startsWith('slash: generator.rulesVersion'))).toBe(true);
  });

  describe('forbidden substrings over the serialised bytes', () => {
    const base = payloadOf();
    const serialized = `${stableStringify(base)}\n`;

    function scan(extra: string, context: PublishContext = ctx()): string[] {
      return validatePublish(base, serialized.slice(0, -2) + extra + serialized.slice(-2), context);
    }

    it('home path', () => {
      expect(scan('/Users/someone/proj').some((v) => v.startsWith('home-path:'))).toBe(true);
    });
    it('hostname', () => {
      expect(scan('on mymachine today').some((v) => v.startsWith('hostname:'))).toBe(true);
    });
    it('e-mail address', () => {
      expect(scan('mail me at a@b.co').some((v) => v.startsWith('email:'))).toBe(true);
    });
    it('session id', () => {
      expect(scan('0199aaaa-bbbb-4ccc-8ddd-eeeeffff0000').some((v) => v.startsWith('session-id:'))).toBe(true);
    });
    it('short id on hex-token boundaries only', () => {
      expect(scan(' abcd1234 ').some((v) => v.startsWith('short-id:'))).toBe(true);
      // Inside a longer hex run (a content hash) it is NOT a short-id hit.
      expect(scan(' deadbeefabcd1234deadbeef ').some((v) => v.startsWith('short-id:'))).toBe(false);
    });
    it('username (≥ 6 chars) on token boundaries only', () => {
      expect(scan(' longusername ').some((v) => v.startsWith('username:'))).toBe(true);
      expect(scan(' xlongusernamex ').some((v) => v.startsWith('username:'))).toBe(false);
      expect(scan(' short ', ctx({ usernames: ['short'] })).some((v) => v.startsWith('username:'))).toBe(false);
    });
    it('a clean file passes every scan', () => {
      expect(validatePublish(base, serialized, ctx())).toEqual([]);
    });
  });
});
