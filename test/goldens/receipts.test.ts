/**
 * S19 — Milestone M2 receipt goldens. Every committed reader fixture is
 * materialised and run through the *real* pipeline (`loadSessions` with the
 * cache disabled → `buildReceipt`), and four projections are deep-equal to
 * `expected.json` sections (`UPDATE_GOLDENS=1` rewrites them, preserving all
 * other sections):
 *
 * - `receipt`  — verdict, counts, worst-first lines as `(glyph, claim,
 *                reason, evidence strings)`, ALSO SAID, ALSO DID texts,
 *                stats and `kind` (so renderer changes cannot silently alter
 *                verdict semantics);
 * - `ledger`   — counts per fact type, `filesChanged.length`, integrity and
 *                danger kinds;
 * - `claims`   — the extracted claims of the receipt turn as `(kind,
 *                polarity, rule, subject)`;
 * - `cost`     — `usd` (6 decimals, priced with `fixtures/prices/
 *                prices.golden.json`), `unverified`, `cacheHitPct`.
 *
 * Cross-cutting assertions: every claim-evidence `EvidenceRef` resolves —
 * to a tool call of the session, or (for the §4.8 absence facts, which
 * deliberately point at the final message) to the turn's `finalSeq` — the
 * verdict counts recount from the judgements, and every verdict class listed
 * in `expected.json.expectVerdicts` (hand-set per fixture from what its data
 * supports) appears among the fixture's done-turn judgements. The §8.3 /
 * S19 cost pins (0.068394, 7.888091, the `gpt-5.6-terra` window switch under
 * `--as-of 2026-07-15`) are pinned explicitly at the bottom.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Claim, EvidenceRef, Judgement, Receipt, Session, Turn, Verdict } from '../../src/model/types.js';
import { parsePriceTable } from '../../src/cost/validate.js';
import { resolveRoots } from '../../src/discover/roots.js';
import { buildReceipt, buildTurnReceipts, sessionCost, type ReceiptOptions } from '../../src/pipeline/receipt.js';
import { loadSessions } from '../../src/pipeline/run.js';
import { TOOL_VERSION } from '../../src/version.js';
import { FIXTURES_ROOT, listFixtures, materialize } from '../helpers/fixtures.js';
import { GOLDEN_HOME, readerExpectedPath, readExpectedJson, UPDATE_GOLDENS } from '../helpers/goldens.js';
import { makeTempDir } from '../helpers/tmp.js';

/** The frozen price table the cost goldens are pinned against (byte-identical to the bundled one, S16). */
const GOLDEN_PRICES = join(FIXTURES_ROOT, 'prices', 'prices.golden.json');

const NOW = new Date('2026-08-29T12:00:00.000Z');
const prices = parsePriceTable(readFileSync(GOLDEN_PRICES, 'utf8'), 'prices.golden.json');

function receiptOpts(over: Partial<ReceiptOptions> = {}): ReceiptOptions {
  return { now: NOW, prices, homeDir: GOLDEN_HOME, ...over };
}

// ---------------------------------------------------------------------------
// Run the real pipeline over every fixture once.
// ---------------------------------------------------------------------------

interface Entry {
  session: Session;
  /** The default receipt (last done turn). */
  receipt: Receipt;
  /** One receipt per done turn (`expectVerdicts` coverage + ref resolution). */
  turnReceipts: Map<number, Receipt>;
}

const tmp = makeTempDir('showreceipts-receipt-goldens-');
const fixtureIds = listFixtures();
const byFixture = new Map<string, Entry[]>();
for (const id of fixtureIds) {
  const into = join(tmp, id.replace(/\//g, '__'));
  materialize(id, into);
  const roots = resolveRoots(
    { CLAUDE_CONFIG_DIR: join(into, 'claude'), CODEX_HOME: join(into, 'codex'), SHOWRECEIPTS_HOME: join(into, 'sr') },
    GOLDEN_HOME,
  );
  const { sessions, diagnostics } = await loadSessions({ roots, all: true, noCache: true, versions: { tool: TOOL_VERSION }, now: NOW });
  if (diagnostics.problems.length > 0) throw new Error(`${id}: ${diagnostics.problems.join('; ')}`);
  const entries: Entry[] = sessions
    .slice()
    .sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))
    .map((session) => ({
      session,
      receipt: buildReceipt(session, receiptOpts()),
      turnReceipts: buildTurnReceipts(session, receiptOpts()),
    }));
  byFixture.set(id, entries);
}

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function entriesOf(id: string): Entry[] {
  const entries = byFixture.get(id);
  if (entries === undefined || entries.length === 0) throw new Error(`fixture ${id} produced no sessions`);
  return entries;
}

// ---------------------------------------------------------------------------
// Projections (JSON round-tripped so optionals vanish and deep-equality is exact).
// ---------------------------------------------------------------------------

interface GoldenReceiptLine {
  glyph: Receipt['lines'][number]['glyph'];
  claim: string;
  reason: string;
  evidence: string[];
}

interface GoldenReceipt {
  kind: Receipt['kind'];
  verdict: Receipt['verdict'];
  turnIndex: number;
  claimsRecognized: number;
  counts: Record<Verdict, number>;
  lines: GoldenReceiptLine[];
  alsoSaid: string[];
  alsoDid: { text: string; warn?: boolean }[];
  stats: Receipt['stats'];
}

/** The judgement behind a line (`buildLines` passes `j.evidence` as `line.refs` — identity holds in-process). */
function judgementOf(receipt: Receipt, line: Receipt['lines'][number]): Judgement | undefined {
  return receipt.judgements.find((j) => j.evidence === line.refs);
}

function projectReceipt(receipt: Receipt): GoldenReceipt {
  const view: GoldenReceipt = {
    kind: receipt.kind,
    verdict: receipt.verdict,
    turnIndex: receipt.turnIndex,
    claimsRecognized: receipt.claimsRecognized,
    counts: receipt.counts,
    lines: receipt.lines.map((line) => ({
      glyph: line.glyph,
      claim: line.claim,
      reason: judgementOf(receipt, line)?.reason ?? 'unknown',
      evidence: line.evidence,
    })),
    alsoSaid: receipt.alsoSaid,
    alsoDid: receipt.alsoDid.map((d) => ({ text: d.text, ...(d.warn === true ? { warn: true } : {}) })),
    stats: receipt.stats,
  };
  return JSON.parse(JSON.stringify(view)) as GoldenReceipt;
}

interface GoldenLedger {
  writes: number;
  commands: number;
  testRuns: number;
  checks: number;
  git: number;
  network: number;
  integrity: number;
  danger: number;
  filesChanged: number;
  integrityKinds: Record<string, number>;
  dangerKinds: Record<string, number>;
}

function tally(kinds: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const kind of [...kinds].sort()) out[kind] = (out[kind] ?? 0) + 1;
  return out;
}

function projectLedger(session: Session): GoldenLedger {
  const ledger = session.ledger;
  return {
    writes: ledger.writes.length,
    commands: ledger.commands.length,
    testRuns: ledger.testRuns.length,
    checks: ledger.checks.length,
    git: ledger.git.length,
    network: ledger.network.length,
    integrity: ledger.integrity.length,
    danger: ledger.danger.length,
    filesChanged: ledger.filesChanged.length,
    integrityKinds: tally(ledger.integrity.map((s) => s.kind)),
    dangerKinds: tally(ledger.danger.map((d) => d.kind)),
  };
}

interface GoldenClaim {
  kind: Claim['kind'];
  polarity: Claim['polarity'];
  rule: string;
  subject?: string;
}

function projectClaims(receipt: Receipt): GoldenClaim[] {
  return receipt.claims.map((c) => ({
    kind: c.kind,
    polarity: c.polarity,
    rule: c.rule,
    ...(c.subject !== undefined ? { subject: c.subject } : {}),
  }));
}

interface GoldenCost {
  usd: number | null;
  unverified: boolean;
  cacheHitPct: number | null;
}

function projectCost(receipt: Receipt): GoldenCost {
  return { usd: receipt.cost.usd, unverified: receipt.cost.unverified, cacheHitPct: receipt.cost.cacheHitPct };
}

/** Per-session projections of one kind, keyed by sessionId ascending. */
function bySession<T>(entries: readonly Entry[], project: (e: Entry) => T): Record<string, T> {
  const out: Record<string, T> = {};
  for (const e of entries) out[e.session.sessionId] = project(e);
  return JSON.parse(JSON.stringify(out)) as Record<string, T>;
}

/** Rewrites the S19 sections of an expected file, preserving every other section verbatim. */
function updateGoldenSections(path: string, sections: Record<string, unknown>): void {
  const current = readExpectedJson(path) ?? {};
  for (const [key, value] of Object.entries(sections)) current[key] = value;
  writeFileSync(path, JSON.stringify(current, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Evidence resolution (S19 sanity rule)
// ---------------------------------------------------------------------------

/**
 * A claim-evidence ref resolves when its `toolCallId`/`seq` names a tool call
 * of the session; when — for the §4.8 absence facts, which deliberately
 * point at the turn's final message — its seq is the receipt turn's
 * `finalSeq` (fallback `seqEnd`); or when it names a recorded PR reference
 * (§4.8 row 17 attaches the `pr-link` record as context to an UNVERIFIED
 * `git.pr`; a pr-link still never verifies or contradicts).
 */
function refResolves(ref: EvidenceRef, session: Session, turn: Turn | undefined): boolean {
  if (ref.toolCallId !== undefined) {
    const call = session.toolCalls.find((c) => c.id === ref.toolCallId);
    return call !== undefined && call.seq === ref.seq;
  }
  if (session.toolCalls.some((c) => c.seq === ref.seq)) return true;
  if (session.prRefs.some((p) => p.seq === ref.seq)) return true;
  return turn !== undefined && ref.seq === (turn.finalSeq ?? turn.seqEnd);
}

function assertRefsResolve(session: Session, receipt: Receipt): void {
  const turn = session.turns.find((t) => t.index === receipt.turnIndex);
  for (const j of receipt.judgements) {
    for (const ref of j.evidence) {
      expect(refResolves(ref, session, turn), `claim ${j.claimId}: seq ${ref.seq} "${ref.label}" must resolve`).toBe(true);
    }
  }
  for (const line of receipt.lines) {
    expect(judgementOf(receipt, line), `line "${line.claim}" must map to a judgement`).toBeDefined();
  }
}

// ---------------------------------------------------------------------------
// Goldens
// ---------------------------------------------------------------------------

describe.each(fixtureIds)('%s', (id) => {
  it('matches the golden receipt / ledger / claims / cost sections', () => {
    const entries = entriesOf(id);
    const sections = {
      receipt: bySession(entries, (e) => projectReceipt(e.receipt)),
      ledger: bySession(entries, (e) => projectLedger(e.session)),
      claims: bySession(entries, (e) => projectClaims(e.receipt)),
      cost: bySession(entries, (e) => projectCost(e.receipt)),
    };
    const path = readerExpectedPath(id);
    if (UPDATE_GOLDENS) updateGoldenSections(path, sections);
    const expected = readExpectedJson(path);
    expect(expected?.['receipt']).toEqual(sections.receipt);
    expect(expected?.['ledger']).toEqual(sections.ledger);
    expect(expected?.['claims']).toEqual(sections.claims);
    expect(expected?.['cost']).toEqual(sections.cost);
  });

  it('every claim-evidence ref resolves (tool call, or the final message for absence facts)', () => {
    for (const e of entriesOf(id)) {
      assertRefsResolve(e.session, e.receipt);
      for (const r of e.turnReceipts.values()) assertRefsResolve(e.session, r);
    }
  });

  it('verdict counts recount from the judgements and the verdict is the worst scored claim', () => {
    for (const e of entriesOf(id)) {
      for (const r of [e.receipt, ...e.turnReceipts.values()]) {
        const counts: Record<Verdict, number> = { VERIFIED: 0, UNVERIFIED: 0, CONTRADICTED: 0, NOT_SCORED: 0 };
        for (const j of r.judgements) counts[j.verdict] += 1;
        expect(r.counts).toEqual(counts);
        if (r.kind === 'scored' || r.kind === 'no-claims') {
          const worst =
            counts.CONTRADICTED > 0 ? 'CONTRADICTED' : counts.UNVERIFIED > 0 ? 'UNVERIFIED' : counts.VERIFIED > 0 ? 'VERIFIED' : 'NO_CLAIMS';
          expect(r.verdict).toBe(worst);
        }
      }
    }
  });

  it('carries ≥ 1 claim of every verdict class in expected.json.expectVerdicts', () => {
    const expected = readExpectedJson(readerExpectedPath(id));
    const expectVerdicts = expected?.['expectVerdicts'];
    expect(Array.isArray(expectVerdicts), 'expected.json.expectVerdicts must be set (S19 instruction 3)').toBe(true);
    const found = new Set<Verdict>();
    for (const e of entriesOf(id)) {
      for (const r of e.turnReceipts.values()) for (const j of r.judgements) found.add(j.verdict);
    }
    for (const verdict of expectVerdicts as string[]) {
      expect(found.has(verdict as Verdict), `fixture must support a ${verdict} claim`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Hand-pinned S19 acceptance values (never golden-generated).
// ---------------------------------------------------------------------------

describe('S19 pins', () => {
  it('codex/0.98.0 rollout 019c45e8 costs 0.068394 and 019c4678 costs 7.888091 (§8.3 pins)', () => {
    const entries = entriesOf('codex/0.98.0');
    const short = entries.find((e) => e.session.sessionId.startsWith('019c45e8'));
    const long = entries.find((e) => e.session.sessionId.startsWith('019c4678'));
    expect(short?.receipt.cost.usd).toBe(0.068394);
    expect(long?.receipt.cost.usd).toBe(7.888091);
  });

  it('codex/shell_command prices gpt-5.6-terra at the August window; --as-of 2026-07-15 switches it', () => {
    const [entry] = entriesOf('codex/shell_command');
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.session.primaryModel).toBe('gpt-5.6-terra');
    // 2026-08-15 falls in the from-2026-07-30 window (2.0 / 12.0 / 0.2 per M).
    expect(entry.receipt.cost.usd).toBe(0.020749);
    // --as-of 2026-07-15 falls in the 2026-07-09..29 window (2.5 / 15.0 / 0.25 per M).
    const july = sessionCost(entry.session, receiptOpts({ asOf: '2026-07-15' }));
    expect(july.usd).toBe(0.025936);
    expect(july.asOf).toBe('2026-07-15');
    expect(july.usd).not.toBe(entry.receipt.cost.usd);
  });

  it('codex/shell_command: git.commit VERIFIED with the sha; the red pytest contradicts test.pass', () => {
    const [entry] = entriesOf('codex/shell_command');
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    // Default receipt = turn 1: "Committed as `0f1e2d3` on `main`."
    const commit = entry.receipt.judgements.find((j) => j.verdict === 'VERIFIED');
    expect(commit).toBeDefined();
    expect(entry.receipt.lines[0]?.evidence.join(' ')).toContain('0f1e2d3');
    // Turn 0: "all 12 tests pass (vitest)" vs the later red pytest run.
    const turn0 = entry.turnReceipts.get(0);
    const contradicted = turn0?.judgements.find((j) => j.verdict === 'CONTRADICTED');
    expect(contradicted?.reason).toBe('last-run-red');
    const line = turn0?.lines.find((l) => l.glyph === 'bad');
    expect(line?.evidence.join(' ')).toContain('pytest');
  });

  it('claude-code/2.1.243 yields the no-turns receipt', () => {
    const [entry] = entriesOf('claude-code/2.1.243');
    expect(entry?.receipt.kind).toBe('no-turns');
    expect(entry?.receipt.verdict).toBe('NO_TURNS');
    expect(entry?.receipt.records).toBeGreaterThan(0);
  });

  it('claude-code/2.1.214: prRefs render under ALSO DID and never verify a git.pr claim (§4.8 row 17)', () => {
    const [entry] = entriesOf('claude-code/2.1.214');
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.session.prRefs.length).toBeGreaterThanOrEqual(1);
    for (const r of [entry.receipt, ...entry.turnReceipts.values()]) {
      const claimById = new Map(r.claims.map((c) => [c.id, c]));
      for (const j of r.judgements) {
        const claim = claimById.get(j.claimId);
        if (claim?.kind === 'git' && claim.op === 'pr') {
          expect(j.verdict === 'VERIFIED' || j.verdict === 'CONTRADICTED').toBe(false);
        }
      }
    }
  });
});
