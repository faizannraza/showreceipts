/**
 * S18 — `pipeline/dedupe.ts`: the within-session `inherited` recompute
 * (§4.2.7 — deterministic cold and warm, since the cache strips the marks)
 * and the cross-session `message.id` dedupe for aggregate totals (§8.3 —
 * the earliest session owns the row; the marked set depends on the scanned
 * set, which is exactly why it never reaches a cache entry).
 */
import { describe, expect, it } from 'vitest';
import type { Session, UsageRow } from '../../../src/model/types.js';
import { dedupeUsage, markSessionInherited } from '../../../src/pipeline/dedupe.js';
import { session } from '../reconcile/harness.js';

function row(seq: number, messageId: string, agentId: string | null = null, over: Partial<UsageRow> = {}): UsageRow {
  return { seq, agentId, messageId, ts: '2026-03-01T17:00:00.000Z', attempts: [], promptTokens: 0, ...over };
}

function withRows(rows: UsageRow[], over: Partial<Session> = {}): Session {
  return session({ usageRows: rows, ...over });
}

describe('markSessionInherited (within one session)', () => {
  it('marks the subagent copy of a main-file message.id, never the main row', () => {
    const s = withRows([row(5, 'm1', null), row(50, 'm1', 'a1')]);
    markSessionInherited(s);
    expect(s.usageRows[0]?.inherited).toBeUndefined();
    expect(s.usageRows[1]?.inherited).toBe(true);
  });

  it('the main-file row wins even at a higher seq', () => {
    const s = withRows([row(5, 'm1', 'a1'), row(50, 'm1', null)]);
    markSessionInherited(s);
    expect(s.usageRows[0]?.inherited).toBe(true);
    expect(s.usageRows[1]?.inherited).toBeUndefined();
  });

  it('among subagent copies the lowest seq wins', () => {
    const s = withRows([row(30, 'm1', 'a2'), row(20, 'm1', 'a1')]);
    markSessionInherited(s);
    expect(s.usageRows.find((r) => r.seq === 20)?.inherited).toBeUndefined();
    expect(s.usageRows.find((r) => r.seq === 30)?.inherited).toBe(true);
  });

  it('clears a stale mark on a row whose id is unique (cache round-trip determinism)', () => {
    const s = withRows([row(5, 'm1', null, { inherited: true }), row(6, 'm2', null)]);
    markSessionInherited(s);
    expect(s.usageRows[0]?.inherited).toBeUndefined();
    expect(s.usageRows[1]?.inherited).toBeUndefined();
  });

  it('is idempotent and ignores rows without a messageId', () => {
    const s = withRows([row(5, '', null), row(6, '', 'a1'), row(7, 'm1', null), row(8, 'm1', 'a1')]);
    markSessionInherited(s);
    const once = s.usageRows.map((r) => r.inherited === true);
    markSessionInherited(s);
    expect(s.usageRows.map((r) => r.inherited === true)).toEqual(once);
    expect(once).toEqual([false, false, false, true]);
  });
});

describe('dedupeUsage (across sessions, §8.3)', () => {
  const earlier = (): Session =>
    withRows([row(5, 'shared', null), row(6, 'only-a', null)], {
      sessionId: 'aaaa1111-0000-4000-8000-000000000001',
      startedAt: '2026-03-01T10:00:00.000Z',
    });
  const later = (): Session =>
    withRows([row(5, 'shared', null), row(6, 'only-b', null)], {
      sessionId: 'bbbb2222-0000-4000-8000-000000000002',
      startedAt: '2026-03-01T12:00:00.000Z',
    });

  it('the earliest session by startedAt owns a duplicated message.id', () => {
    const a = earlier();
    const b = later();
    dedupeUsage([a, b]);
    expect(a.usageRows[0]?.inherited).toBeUndefined();
    expect(b.usageRows[0]?.inherited).toBe(true);
    expect(a.usageRows[1]?.inherited).toBeUndefined();
    expect(b.usageRows[1]?.inherited).toBeUndefined();
  });

  it('the marked set depends on the scanned set (a narrower window changes the owner)', () => {
    const bAlone = later();
    dedupeUsage([bAlone]);
    expect(bAlone.usageRows[0]?.inherited).toBeUndefined(); // owner when A is out of the window

    const a = earlier();
    const bTogether = later();
    dedupeUsage([a, bTogether]);
    expect(bTogether.usageRows[0]?.inherited).toBe(true); // inherited when A is scanned
  });

  it('re-establishes the within-session baseline first (idempotent over the same set)', () => {
    const a = earlier();
    a.usageRows.push(row(50, 'shared', 'fork'));
    const b = later();
    dedupeUsage([a, b]);
    const snapshot = [a, b].map((s) => s.usageRows.map((r) => r.inherited === true));
    dedupeUsage([a, b]);
    expect([a, b].map((s) => s.usageRows.map((r) => r.inherited === true))).toEqual(snapshot);
    expect(snapshot).toEqual([
      [false, false, true], // a: owner row, own id, fork copy
      [true, false], // b: shared copy inherited, own id kept
    ]);
  });

  it('ties on startedAt break by sessionId', () => {
    const a = earlier();
    const b = later();
    b.startedAt = a.startedAt;
    dedupeUsage([b, a]);
    expect(a.usageRows[0]?.inherited).toBeUndefined();
    expect(b.usageRows[0]?.inherited).toBe(true);
  });
});
