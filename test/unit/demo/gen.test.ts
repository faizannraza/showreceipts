/**
 * S23a round-trip: every generated scenario passes its real reader with zero
 * unknown-shape diagnostics, `buildReceipt` (S18) yields the scenario's
 * named verdict class, the four §10.2 spec scenarios carry zero NOT_SCORED
 * claims, and the spec numbers (tool/file/test counts, `$18.42` / `$41.07` /
 * `≈$0.07`, cache hit 71 / 84 / 87 %) hold under the built-in price table.
 */
import { describe, expect, it } from 'vitest';
import type { Receipt, Session, SessionRef } from '../../../src/model/types.js';
import { echoHashes } from '../../../src/claims/text.js';
import { loadPriceTable } from '../../../src/cost/resolve.js';
import { generate } from '../../../src/demo/gen.js';
import { SCENARIOS, scenarioNamed } from '../../../src/demo/scenarios.js';
import type { Scenario } from '../../../src/demo/dsl.js';
import { buildLedger } from '../../../src/ledger/index.js';
import { buildReceipt } from '../../../src/pipeline/receipt.js';
import { readClaudeCodeSession, type ClaudeCodeReadOptions } from '../../../src/readers/claude-code/reader.js';
import { readCodexSession } from '../../../src/readers/codex/reader.js';
import { readLedgerSession } from '../../../src/readers/ledger/reader.js';

const table = loadPriceTable();
const HOME = '/home/u';
const NOW = new Date('2026-08-29T12:00:00.000Z');

/** Mirrors the pipeline's `parseRef` chain: reader → ledger → echo hashes. */
async function sessionOf(scenario: Scenario): Promise<Session> {
  const g = generate(scenario);
  let session: Session;
  if (scenario.harness === 'claude-code') {
    const ref: SessionRef = { harness: 'claude-code', sessionId: scenario.sessionId, path: '', size: 0, mtimeMs: 0, subagentManifest: [] };
    const opts: ClaudeCodeReadOptions = { lines: g.lines, home: HOME };
    if (g.subagents !== undefined) opts.subagents = { kind: 'memory', files: g.subagents };
    session = (await readClaudeCodeSession(ref, opts)).session;
  } else if (scenario.harness === 'codex') {
    const ref: SessionRef = {
      harness: 'codex',
      sessionId: scenario.sessionId,
      path: `${HOME}/.codex/sessions/2026/02/10/${g.lines.kind === 'text' ? g.lines.name : ''}`,
      size: 0,
      mtimeMs: 0,
      subagentManifest: [],
    };
    session = (await readCodexSession(ref, { lines: g.lines, home: HOME })).session;
  } else {
    const ref: SessionRef = {
      harness: scenario.ledgerHarness ?? 'cursor',
      sessionId: scenario.sessionId,
      path: '',
      size: 0,
      mtimeMs: 0,
      subagentManifest: [],
      ledger: true,
    };
    session = readLedgerSession(ref, { lines: g.ledger ?? g.lines, home: `${HOME}/.showreceipts` });
  }
  session.ledger = buildLedger(session);
  for (const turn of session.turns) {
    turn.echoHashes = turn.userText === null || turn.userText === '' ? [] : echoHashes(turn.userText);
  }
  return session;
}

function receiptOf(session: Session): Receipt {
  return buildReceipt(session, { now: NOW, prices: table, homeDir: HOME });
}

/** The judgement of the first claim of `kind` on the receipt. */
function judgementFor(receipt: Receipt, kind: string): Receipt['judgements'][number] | undefined {
  const claim = receipt.claims.find((c) => c.kind === kind);
  return claim === undefined ? undefined : receipt.judgements.find((j) => j.claimId === claim.id);
}

const CASES = SCENARIOS.map((s) => [s.name, s] as const);

describe('reader round-trip (0 unknown-shape diagnostics)', () => {
  it.each(CASES)('%s', async (_name, scenario) => {
    const session = await sessionOf(scenario);
    const d = session.diagnostics;
    expect(d.badLines, 'badLines').toBe(0);
    expect(d.unknownRecordTypes, 'unknownRecordTypes').toEqual({});
    expect(d.unknownSubtypes, 'unknownSubtypes').toEqual({});
    expect(d.unknownToolShapes, 'unknownToolShapes').toEqual({});
    expect(d.unknownContentBlocks, 'unknownContentBlocks').toEqual({});
    expect(d.unknownCodexPayloads, 'unknownCodexPayloads').toEqual({});
    expect(d.unknownAttachmentTypes, 'unknownAttachmentTypes').toEqual({});
    expect(d.subagentFiles.unlinked, 'unlinked subagents').toBe(0);
    expect(d.subagentFiles.missing, 'missing subagents').toBe(0);
    expect(d.legacyShapes, 'legacyShapes').toEqual({});
  });
});

describe('verdict classes and the ALSO SAID matrix', () => {
  it.each(CASES)('%s → %#', async (_name, scenario) => {
    const receipt = receiptOf(await sessionOf(scenario));
    expect(receipt.verdict).toBe(scenario.expect.verdict);
    if (scenario.expect.spec === true) {
      // Decision (a): the §10.2 spec scenarios carry no NOT_SCORED claim.
      expect(receipt.counts.NOT_SCORED, 'NOT_SCORED').toBe(0);
      expect(receipt.alsoSaid).toEqual([]);
    } else if (scenario.final !== null) {
      // Every other final carries ≥ 1 negated claim, so ALSO SAID renders.
      expect(receipt.claims.some((c) => c.polarity === 'negated'), 'a negated claim').toBe(true);
      expect(receipt.alsoSaid.length).toBeGreaterThanOrEqual(1);
    }
    if (scenario.expect.scoredClaims !== undefined) {
      expect(receipt.lines.length).toBe(scenario.expect.scoredClaims);
    }
  });
});

describe('§10.2 sample 1 — contradicted', () => {
  it('matches the sample header, counts, verdict line and cost', async () => {
    const session = await sessionOf(scenarioNamed('contradicted'));
    const receipt = receiptOf(session);
    expect(receipt.shortId).toBe('0badf00d');
    expect(receipt.harness).toBe('claude-code');
    expect(receipt.harnessVersion).toBe('2.1.214');
    expect(receipt.model).toBe('claude-sonnet-5');
    expect(receipt.branch).toBe('main');
    expect(receipt.counts.CONTRADICTED).toBe(1);
    expect(receipt.counts.UNVERIFIED).toBe(1);
    expect(receipt.counts.VERIFIED).toBe(3);
    expect(receipt.stats.toolCalls).toBe(212);
    expect(receipt.stats.filesChanged).toBe(31);
    expect(receipt.stats.testRuns).toBe(4);
    expect(receipt.stats.compactions).toBe(1);
    expect(receipt.cost.usd).not.toBeNull();
    expect(Math.round((receipt.cost.usd ?? 0) * 100) / 100).toBe(18.42);
    expect(Math.round(receipt.cost.cacheHitPct ?? 0)).toBe(71); // stored as a percent
    expect(receipt.cost.unverified).toBe(false);
    expect(session.activeMs).toBe(125 * 60_000); // 2h 05m
  });

  it('judges lint red, the commit missing and the tests green', async () => {
    const receipt = receiptOf(await sessionOf(scenarioNamed('contradicted')));
    expect(judgementFor(receipt, 'check')?.verdict).toBe('CONTRADICTED');
    expect(judgementFor(receipt, 'git')?.verdict).toBe('UNVERIFIED');
    expect(judgementFor(receipt, 'git')?.reason).toBe('no-git-op');
    expect(judgementFor(receipt, 'test')?.verdict).toBe('VERIFIED');
  });
});

describe('§10.2 sample 2 — all verified', () => {
  it('matches the sample header, counts, verdict line and cost', async () => {
    const session = await sessionOf(scenarioNamed('verified'));
    const receipt = receiptOf(session);
    expect(receipt.shortId).toBe('00decaf0');
    expect(receipt.harnessVersion).toBe('2.1.241');
    expect(receipt.model).toBe('claude-fable-5');
    expect(receipt.verdict).toBe('VERIFIED');
    expect(receipt.counts.VERIFIED).toBe(4);
    expect(receipt.counts.CONTRADICTED + receipt.counts.UNVERIFIED).toBe(0);
    expect(receipt.stats.toolCalls).toBe(418);
    expect(receipt.stats.filesChanged).toBe(87);
    expect(receipt.stats.testRuns).toBe(9);
    expect(receipt.stats.subagents).toBe(12);
    expect(Math.round((receipt.cost.usd ?? 0) * 100) / 100).toBe(41.07);
    expect(Math.round(receipt.cost.cacheHitPct ?? 0)).toBe(84);
    expect(session.subagents).toHaveLength(12);
    expect(session.ledger.git.some((f) => f.op === 'commit' && f.ok === true && f.sha?.startsWith('1fc0c28') === true)).toBe(true);
    expect(session.ledger.network.map((f) => f.host)).toEqual(expect.arrayContaining(['pypi.org', 'api.github.com']));
  });
});

describe('§10.2 sample 3 — unverified only (Codex)', () => {
  it('matches the sample header, counts and the golden cost pin', async () => {
    const session = await sessionOf(scenarioNamed('unverified-codex'));
    const receipt = receiptOf(session);
    expect(receipt.shortId).toBe('c0dec0de');
    expect(receipt.harness).toBe('codex');
    expect(receipt.harnessVersion).toBe('0.98.0');
    expect(receipt.model).toBe('gpt-5.2-codex');
    expect(receipt.branch).toBeNull();
    expect(receipt.verdict).toBe('UNVERIFIED');
    expect(receipt.counts.CONTRADICTED).toBe(0);
    expect(receipt.counts.UNVERIFIED).toBe(2); // `VERDICT: 2 UNVERIFIED` (S23b decision (j))
    // The notebook write is an interpreter heredoc → the file claim is
    // "write not observable" (the §10.2 sample's `?`), and the detached
    // heredoc (`exit: null`) leaves the verification claim unverified too,
    // so the receipt is exactly the sample's 2 UNVERIFIED. The reason
    // strings are the frozen S17 engine's business.
    expect(judgementFor(receipt, 'file')?.reason).toBe('write-not-observable');
    expect(receipt.stats.toolCalls).toBe(6);
    expect(receipt.stats.filesChanged).toBe(0);
    expect(receipt.stats.testRuns).toBe(0);
    expect(Math.round((receipt.cost.usd ?? 0) * 1e6) / 1e6).toBe(0.068394); // the §8.3 golden pin
    expect(Math.round(receipt.cost.cacheHitPct ?? 0)).toBe(87);
    expect(receipt.cost.unverified).toBe(true); // OpenAI rows are unverified → ≈
    expect(receipt.cost.planUsagePct).toBe(1);
    expect(session.turns.reduce((a, t) => a + t.opaqueWriteCommands, 0)).toBeGreaterThanOrEqual(1);
  });
});

describe('§10.2 sample 4 — no claims (hook-captured Cursor)', () => {
  it('matches the sample header, counts and the n/a cost', async () => {
    const session = await sessionOf(scenarioNamed('no-claims-ledger'));
    const receipt = receiptOf(session);
    expect(receipt.shortId).toBe('0cafe000');
    expect(receipt.harness).toBe('cursor');
    expect(receipt.harnessVersion).toBe('1.9.2');
    expect(receipt.model).toBe('gpt-5.6-terra');
    expect(receipt.source).toBe('ledger');
    expect(receipt.kind).toBe('no-claims');
    expect(receipt.verdict).toBe('NO_CLAIMS');
    expect(receipt.claims).toEqual([]);
    expect(receipt.stats.sentencesScanned).toBe(4);
    expect(receipt.stats.toolCalls).toBe(9);
    expect(receipt.stats.filesChanged).toBe(2);
    expect(receipt.stats.testRuns).toBe(1);
    expect(receipt.cost.usd).toBeNull();
  });
});

describe('the rest of the matrix', () => {
  it('twenty-claims: 20 scored file claims, all verified', async () => {
    const receipt = receiptOf(await sessionOf(scenarioNamed('twenty-claims')));
    expect(receipt.lines).toHaveLength(20);
    expect(receipt.counts.VERIFIED).toBe(20);
  });

  it('no-final and no-turns kinds', async () => {
    const noFinal = receiptOf(await sessionOf(scenarioNamed('no-final')));
    expect(noFinal.kind).toBe('no-final');
    const noTurns = receiptOf(await sessionOf(scenarioNamed('no-turns')));
    expect(noTurns.kind).toBe('no-turns');
    expect(noTurns.records ?? 0).toBeGreaterThan(0);
  });

  it('test-weakened: the green run is stale and the integrity scan fired', async () => {
    const session = await sessionOf(scenarioNamed('test-weakened'));
    const receipt = receiptOf(session);
    expect(judgementFor(receipt, 'test')?.reason).toBe('stale-run');
    expect(session.ledger.integrity.length).toBeGreaterThanOrEqual(1);
    expect(session.ledger.integrity.some((i) => i.kind === 'skip-added' || i.kind === 'test-weakened')).toBe(true);
  });

  it('stale-run: runs only before the last source write', async () => {
    const session = await sessionOf(scenarioNamed('stale-run'));
    const receipt = receiptOf(session);
    expect(judgementFor(receipt, 'test')?.reason).toBe('stale-run');
    expect(session.apiErrors).toHaveLength(1);
  });

  it('echoed: a would-be contradiction degrades because the user said it first', async () => {
    const receipt = receiptOf(await sessionOf(scenarioNamed('echoed')));
    const judgement = judgementFor(receipt, 'test');
    expect(judgement?.verdict).toBe('UNVERIFIED');
    expect(judgement?.reason).toBe('echoed');
  });

  it('refusal-fallback: both attempts are priced at their own models', async () => {
    const session = await sessionOf(scenarioNamed('refusal-fallback'));
    const receipt = receiptOf(session);
    expect(session.refusalFallbacks).toHaveLength(1);
    expect(session.refusalFallbacks[0]?.originalModel).toBe('claude-fable-5');
    // The refused Fable 5 attempt alone: 684,675 cache-read + 217 output ≈ $0.6955.
    expect(receipt.cost.usd ?? 0).toBeGreaterThan(0.69);
  });

  it('multi-day: the session spans three calendar days', async () => {
    const session = await sessionOf(scenarioNamed('multi-day'));
    const receipt = receiptOf(session);
    expect(session.spansDays).toBe(3);
    // The header's `(Nd)` counts day boundaries crossed (§5.2), not calendar days touched.
    expect(receipt.sessionSpan?.days).toBe(2);
  });
});
