/**
 * Shared factories and extractors for the S22 HTML-report tests. Not a test
 * file. Everything is synthetic and deterministic; the hostile fixture is
 * `fixtures/render/hostile-receipt.json`.
 */
import { readFileSync } from 'node:fs';
import type { RateRow, Receipt, SessionCard, TimelineEntry } from '../../src/model/types.js';
import type { ReportSessionInput } from '../../src/render/payload.js';

export const NOW = new Date('2026-08-29T12:00:00.000Z');

/** A deterministic UUIDv4-shaped session id whose first 8 hex encode `n`. */
export function sessionId(n: number): string {
  const head = n.toString(16).padStart(8, '0');
  return `${head}-0000-4000-8000-000000000000`;
}

export function makeCard(over: Partial<SessionCard> = {}): SessionCard {
  const id = over.id ?? sessionId(1);
  return {
    id,
    shortId: id.slice(0, 8),
    harness: 'claude-code',
    harnessLabel: 'Claude Code',
    harnessVersion: '2.1.240',
    model: 'claude-x',
    cwd: '/home/u/proj',
    title: 'fix the flaky test',
    startedAt: '2026-08-01T10:00:00.000Z',
    endedAt: '2026-08-01T11:30:00.000Z',
    turns: 3,
    doneTurns: 2,
    claims: 4,
    verdict: 'VERIFIED',
    costUsd: 1.23,
    unverified: false,
    kind: 'scored',
    ...over,
  };
}

export function makeCost(over: Partial<Receipt['cost']> = {}): Receipt['cost'] {
  return {
    usd: 1.23,
    apiCalls: 9,
    input: 100,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheWriteOther: 0,
    output: 50,
    cacheHitPct: 71,
    unverified: false,
    unpriced: [],
    apiEquivalent: true,
    pricesVersion: '2026-08-01',
    notes: [],
    ...over,
  };
}

export function makeReceipt(over: Partial<Receipt> = {}): Receipt {
  const id = over.id ?? sessionId(1);
  return {
    schema: 'showreceipts.receipt/1',
    toolVersion: '0.1.0',
    rulesVersion: 'claims/1+reconcile/1',
    pricesVersion: '2026-08-01',
    kind: 'scored',
    id,
    shortId: id.slice(0, 8),
    harness: 'claude-code',
    harnessLabel: 'Claude Code',
    harnessVersion: '2.1.240',
    model: 'claude-x',
    cwd: '/home/u/proj',
    branch: 'main',
    startedAt: '2026-08-01T10:00:00.000Z',
    endedAt: '2026-08-01T11:30:00.000Z',
    durationMs: 5_400_000,
    source: 'transcript',
    turnIndex: 1,
    finalTrigger: 'human',
    turnsWithClaims: [1],
    finalText: 'Done. All tests pass.',
    finalTextSource: 'transcript',
    claims: [],
    judgements: [],
    lines: [
      {
        glyph: 'ok',
        claim: 'updated src/x.ts',
        evidence: ['Edit src/x.ts (10:05)'],
        refs: [{ seq: 12, toolCallId: 't-12', label: 'write', at: '2026-08-01T10:05:00.000Z' }],
      },
    ],
    alsoSaid: [],
    alsoDid: [],
    stats: { toolCalls: 12, filesChanged: 3, testRuns: 1, compactions: 0, subagents: 0, apiCalls: 9, sentencesScanned: 7 },
    cost: makeCost(),
    verdict: 'VERIFIED',
    counts: { VERIFIED: 1, UNVERIFIED: 0, CONTRADICTED: 0, NOT_SCORED: 0 },
    turnActiveMs: 65_000,
    claimsRecognized: 1,
    ...over,
  };
}

export function makeEntry(over: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    seq: 12,
    at: '2026-08-01T10:05:00.000Z',
    tool: 'Edit',
    kind: 'edit',
    summary: 'src/x.ts',
    exit: null,
    files: ['/home/u/proj/src/x.ts'],
    usd: 0.0042,
    agentId: null,
    flags: ['write'],
    ...over,
  };
}

export function makeRateRow(over: Partial<RateRow> = {}): RateRow {
  return {
    model: 'claude-x',
    harness: 'claude-code',
    harnessVersion: '2.1.240',
    sessions: 3,
    turns: 9,
    doneTurns: 6,
    doneTurnsByTrigger: { claims: 5, markerOnly: 1 },
    byTrigger: { human: 6, notification: 0 },
    contradictedTurns: 1,
    unverifiedTurns: 2,
    cleanTurns: 3,
    claims: {
      total: 12,
      verified: 7,
      unverified: 3,
      contradicted: 1,
      notScored: 1,
      byKind: {
        file: 4,
        'file-count': 0,
        test: 3,
        'test-added': 1,
        'test-ran': 1,
        check: 1,
        command: 1,
        install: 0,
        git: 1,
        verification: 0,
        completion: 0,
        'no-change': 0,
      },
    },
    testRunRate: 0.83,
    costPerDoneTurnUsd: { median: 0.42, mean: 0.55 },
    contradictionReasons: { 'last-run-red': 1 },
    integritySignals: 0,
    ledgerIncompleteSessions: 0,
    cacheHitPct: 71,
    ...over,
  };
}

/** A full session input (card + receipt + timeline) with a consistent id. */
export function makeInput(
  n: number,
  over: { card?: Partial<SessionCard>; receipt?: Partial<Receipt>; timeline?: TimelineEntry[] | undefined } = {},
): ReportSessionInput {
  const id = sessionId(n);
  const card = makeCard({ id, shortId: id.slice(0, 8), ...over.card });
  const receipt = makeReceipt({ id, shortId: id.slice(0, 8), ...over.receipt });
  const input: ReportSessionInput = { card, receipt };
  if (over.timeline !== undefined) input.timeline = over.timeline;
  return input;
}

/** The hostile fixture (`fixtures/render/hostile-receipt.json`), typed. */
export function loadHostile(): { card: SessionCard; receipt: Receipt; timeline: TimelineEntry[] } {
  const raw = readFileSync(new URL('../../fixtures/render/hostile-receipt.json', import.meta.url), 'utf8');
  return JSON.parse(raw) as { card: SessionCard; receipt: Receipt; timeline: TimelineEntry[] };
}

const DATA_OPEN = '<script id="data" type="application/json">';

/** Locates the data block: `start`/`end` bound the JSON text between the tags. */
export function dataBlock(html: string): { start: number; end: number; text: string } {
  const open = html.indexOf(DATA_OPEN);
  if (open === -1) throw new Error('data block not found');
  const start = open + DATA_OPEN.length;
  const end = html.indexOf('<' + '/script>', start);
  if (end === -1) throw new Error('data block is unterminated');
  return { start, end, text: html.slice(start, end) };
}

/** The document with the data-block *content* removed (tags kept). */
export function templateOnly(html: string): string {
  const { start, end } = dataBlock(html);
  return html.slice(0, start) + html.slice(end);
}

/** The three script bodies in document order: [bootstrap, data, app]. */
export function scriptBodies(html: string): string[] {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1] as string);
}

/** Counts non-overlapping occurrences of `needle` in `haystack`. */
export function countOf(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}
