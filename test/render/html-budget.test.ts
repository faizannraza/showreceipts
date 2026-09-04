/**
 * S22 (d) — byte budget (§11.1): the positional timeline encoding keeps 400
 * calls at or under 120 KB; on a synthetic ~20 MB payload the degradation
 * stages fire in their fixed order (timelines beyond `--full` → 500-row cap
 * with gap rows and `hiddenRows` → `finalText` dropped outside `--full`);
 * and capping never drops a row that receipt evidence references or that
 * carries a protected flag.
 */
import { describe, expect, it } from 'vitest';
import type { TimelineEntry } from '../../src/model/types.js';
import {
  applyBudget,
  capTimeline,
  DEGRADE_FINAL_TEXT,
  DEGRADE_ROWS,
  DEGRADE_TIMELINES,
  measureSections,
  referencedSeqs,
  SOFT_LIMIT_BYTES,
  TIMELINE_ROW_CAP,
} from '../../src/render/budget.js';
import { buildReportPayload, payloadKey, TIMELINE_COLS, type ReportSessionInput } from '../../src/render/payload.js';
import { stableStringify } from '../../src/util/json.js';
import { makeEntry, makeInput, makeReceipt, NOW, sessionId } from './harness.js';

const SEQ_AT = TIMELINE_COLS.indexOf('seq');
const FLAGS_AT = TIMELINE_COLS.indexOf('flags');
const SUMMARY_AT = TIMELINE_COLS.indexOf('summary');

/** `n` realistic entries; seq = 100 + 2i; a `test` flag every 100th row. */
function entries(n: number): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      makeEntry({
        seq: 100 + 2 * i,
        at: new Date(Date.UTC(2026, 7, 1, 10, 0, i)).toISOString(),
        tool: 'Bash',
        kind: 'shell',
        summary: `npm test -- test/unit/pipeline --reporter dot # run ${i}`,
        exit: 0,
        files: [`/home/u/proj/src/mod-${i % 7}/file-${i}.ts`],
        usd: 0.0042,
        flags: i % 100 === 0 ? ['test'] : [],
      }),
    );
  }
  return out;
}

function nonGapRows(rows: unknown[][]): unknown[][] {
  return rows.filter((r) => !((r[FLAGS_AT] as string[]) ?? []).includes('gap'));
}

function gapSum(rows: unknown[][]): number {
  let total = 0;
  for (const r of rows) {
    if (!((r[FLAGS_AT] as string[]) ?? []).includes('gap')) continue;
    const m = /^\+(\d+) hidden$/.exec(String(r[SUMMARY_AT]));
    expect(m).not.toBeNull();
    total += Number(m?.[1]);
  }
  return total;
}

describe('positional encoding', () => {
  it('keeps a 400-call timeline at or under 120 KB', () => {
    const input = makeInput(1, { timeline: entries(400) });
    const { payload } = buildReportPayload([input], { now: NOW, rows: [] });
    const timeline = payload.timelines[payloadKey(input.card)];
    expect(timeline?.rows).toHaveLength(400);
    expect(Buffer.byteLength(stableStringify(timeline), 'utf8')).toBeLessThanOrEqual(120 * 1024);
  });
});

describe('degradation order on a ~20 MB payload', () => {
  // 2 --full sessions (recent) with 1200-row timelines and refs into early rows,
  // 3 older sessions with 2000-row timelines, and 300 bulk sessions carrying
  // ~18 MB of card titles that no stage can shed.
  const refSeqs = [110, 122]; // rows 5 and 11 — early, unflagged, only saved by the refs rule
  const fullInputs = [1, 2].map((n) =>
    makeInput(n, {
      card: { endedAt: '2026-08-20T11:30:00.000Z' },
      receipt: {
        endedAt: '2026-08-20T11:30:00.000Z',
        finalText: 'x'.repeat(10_000),
        lines: [
          {
            glyph: 'bad',
            claim: 'all tests pass',
            evidence: ['pytest -> exit 1 (10:05)'],
            refs: refSeqs.map((seq) => ({ seq, label: 'test', at: '2026-08-01T10:05:00.000Z' })),
          },
        ],
      },
      timeline: entries(1200),
    }),
  );
  const droppedInputs = [3, 4, 5].map((n) => makeInput(n, { card: { endedAt: '2026-08-10T11:30:00.000Z' }, timeline: entries(2000) }));
  const bulkInputs: ReportSessionInput[] = [];
  for (let n = 6; n < 306; n++) {
    bulkInputs.push(makeInput(n, { card: { endedAt: '2026-08-05T11:30:00.000Z', title: 'x'.repeat(60_000) } }));
  }
  const built = buildReportPayload([...fullInputs, ...droppedInputs, ...bulkInputs], { now: NOW, rows: [], full: 2 });
  const fullKeys = [...built.fullKeys];
  const before = stableStringify(built.payload.timelines[fullKeys[0] ?? '']);
  const { payload: after, report } = applyBudget(built.payload, built.fullKeys);

  it('starts above the hard cap and fires all three stages in order', () => {
    expect(measureSections(built.payload).total).toBeGreaterThan(16 * 1024 * 1024);
    expect(report.degraded).toEqual([DEGRADE_TIMELINES, DEGRADE_ROWS, DEGRADE_FINAL_TEXT]);
    expect(report.softExceeded).toBe(true);
    expect(report.overCap).toBe(true); // the bulk is not degradable — the flag says so
  });

  it('stage 1 keeps only the --full timelines', () => {
    expect(Object.keys(after.timelines).sort()).toEqual([...fullKeys].sort());
    expect(fullKeys).toEqual([1, 2].map((n) => `claude-code:${sessionId(n)}`).sort());
  });

  it('stage 2 caps rows at 500, keeps every referenced seq, and accounts for hiddenRows', () => {
    for (const key of fullKeys) {
      const rows = after.timelines[key]?.rows ?? [];
      const kept = nonGapRows(rows);
      expect(kept.length).toBe(TIMELINE_ROW_CAP);
      const seqs = new Set(kept.map((r) => r[SEQ_AT] as number));
      for (const seq of refSeqs) expect(seqs.has(seq), `referenced seq ${seq} in ${key}`).toBe(true);
      // the protected-flag rows (every 100th) survive too
      for (let i = 0; i < 1200; i += 100) expect(seqs.has(100 + 2 * i), `flagged seq ${100 + 2 * i}`).toBe(true);
      expect(report.hiddenRows[key]).toBe(1200 - TIMELINE_ROW_CAP);
      expect(gapSum(rows)).toBe(1200 - TIMELINE_ROW_CAP);
    }
  });

  it('stage 3 drops finalText outside --full and keeps it inside', () => {
    for (const [key, receipt] of Object.entries(after.receipts)) {
      if (built.fullKeys.has(key)) expect(receipt.finalText.length).toBeGreaterThan(0);
      else expect(receipt.finalText).toBe('');
    }
  });

  it('never mutates the input payload', () => {
    expect(Object.keys(built.payload.timelines)).toHaveLength(5);
    expect(stableStringify(built.payload.timelines[fullKeys[0] ?? ''])).toBe(before);
    const droppedKey = payloadKey(droppedInputs[0]?.card ?? { harness: 'claude-code', id: '' });
    expect(built.payload.receipts[droppedKey]?.finalText.length).toBeGreaterThan(0);
  });
});

describe('soft limit', () => {
  it('warns without degrading between 8 and 16 MB', () => {
    const bulk: ReportSessionInput[] = [];
    for (let n = 1; n < 160; n++) bulk.push(makeInput(n, { card: { title: 'x'.repeat(60_000) } }));
    const built = buildReportPayload(bulk, { now: NOW, rows: [] });
    const { payload, report } = applyBudget(built.payload, built.fullKeys);
    expect(report.sections.total).toBeGreaterThan(SOFT_LIMIT_BYTES);
    expect(report.softExceeded).toBe(true);
    expect(report.overCap).toBe(false);
    expect(report.degraded).toEqual([]);
    expect(payload).toBe(built.payload);
  });
});

describe('capTimeline unit behaviour', () => {
  const cols = [...TIMELINE_COLS];
  function row(seq: number, flags: string[] = []): unknown[] {
    return [1000, seq, 'Bash', 'shell', `cmd ${seq}`, 0, null, null, flags, []];
  }

  it('returns the timeline unchanged at or under the cap', () => {
    const tl = { cols, rows: [row(1), row(2)] };
    const { timeline, hidden } = capTimeline(tl, new Set(), 500);
    expect(timeline).toBe(tl);
    expect(hidden).toBe(0);
  });

  it('keeps every protected row even when they alone exceed the cap', () => {
    const rows = [];
    for (let i = 0; i < 30; i++) rows.push(row(i, ['danger']));
    const { timeline, hidden } = capTimeline({ cols, rows }, new Set(), 10);
    expect(nonGapRows(timeline.rows)).toHaveLength(30);
    expect(hidden).toBe(0);
  });

  it('inserts a leading gap band when early rows are dropped', () => {
    const rows = [];
    for (let i = 0; i < 20; i++) rows.push(row(i));
    const { timeline, hidden } = capTimeline({ cols, rows }, new Set(), 5);
    expect(hidden).toBe(15);
    const first = timeline.rows[0] ?? [];
    expect((first[FLAGS_AT] as string[])).toEqual(['gap']);
    expect(first[SUMMARY_AT]).toBe('+15 hidden');
    expect(nonGapRows(timeline.rows)).toHaveLength(5);
  });

  it('referencedSeqs collects lines, alsoDid and judgement evidence', () => {
    const receipt = makeReceipt({
      lines: [{ glyph: 'ok', claim: 'c', evidence: [], refs: [{ seq: 1, label: 'a', at: 't' }] }],
      alsoDid: [{ text: 'd', refs: [{ seq: 2, label: 'b', at: 't' }] }],
      judgements: [
        { claimId: 'x', verdict: 'VERIFIED', reason: 'ok', evidence: [{ seq: 3, label: 'c', at: 't' }], text: '', notes: [] },
      ],
    });
    expect([...referencedSeqs(receipt)].sort()).toEqual([1, 2, 3]);
    expect(referencedSeqs(undefined).size).toBe(0);
  });
});
