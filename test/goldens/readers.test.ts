/**
 * S10 — Milestone M1 reader goldens. Every committed fixture (reader
 * fixtures and the S09 ledger fixtures) is materialised, parsed with the
 * real readers (S05 layout, S06/S07/S08/S09 parsers) and projected to the
 * golden view; the projection is deep-equal to `expected.json.session`
 * (`UPDATE_GOLDENS=1` rewrites). Every session has zero core-shape
 * problems and every `expected.json.shapes` entry is found by the survey.
 * Hand-verified Appendix A/B pins per fixture live at the bottom.
 */
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { Session } from '../../src/model/types.js';
import { coreShapeProblems } from '../../src/readers/problems.js';
import { listFixtures } from '../helpers/fixtures.js';
import {
  ledgerExpectedPath,
  listLedgerFixtures,
  parseLedgerFixture,
  parseReaderFixture,
  projectSession,
  readerExpectedPath,
  readExpectedJson,
  UPDATE_GOLDENS,
  updateSessionSection,
  type GoldenSession,
  type ParsedFixture,
} from '../helpers/goldens.js';
import { makeTempDir } from '../helpers/tmp.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// ---------------------------------------------------------------------------
// Parse everything once (throughput is reported from the same pass).
// ---------------------------------------------------------------------------

const tmp = makeTempDir('showreceipts-goldens-');
const fixtureIds = listFixtures();
const parsed = new Map<string, ParsedFixture>();
let totalBytes = 0;
let totalParseMs = 0;
for (const id of fixtureIds) {
  const p = await parseReaderFixture(id, join(tmp, id.replace(/\//g, '__')));
  parsed.set(id, p);
  totalBytes += p.bytes;
  totalParseMs += p.parseMs;
}
const ledgerFixtures = listLedgerFixtures();
const ledgerSessions = new Map<string, Session>();
for (const f of ledgerFixtures) ledgerSessions.set(f.name, parseLedgerFixture(f));

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  const mb = totalBytes / (1024 * 1024);
  const mbps = totalParseMs > 0 ? mb / (totalParseMs / 1000) : Infinity;
  // Acceptance: combined reader throughput over the uncompressed fixture tree,
  // reported in the PR. Written straight to stdout — vitest's console
  // intercept swallows console.log emitted from afterAll (S10 review).
  process.stdout.write(`[goldens] reader throughput: ${mbps.toFixed(1)} MB/s over ${mb.toFixed(2)} MB uncompressed (${totalParseMs.toFixed(0)} ms)\n`);
});

// The 60 MB/s floor is machine-dependent, so it is enforced only under the
// perf gate (same convention as test/perf/*): plain `npm test` stays
// deterministic while `SHOWRECEIPTS_PERF=1` turns the report into a check.
it.skipIf(process.env['SHOWRECEIPTS_PERF'] !== '1')('combined reader throughput meets the 60 MB/s floor', () => {
  const mb = totalBytes / (1024 * 1024);
  const mbps = totalParseMs > 0 ? mb / (totalParseMs / 1000) : Infinity;
  expect(mbps).toBeGreaterThan(60);
});

/** The session of one fixture (fails the test when missing). */
function sessionOf(fixtureId: string, sessionId?: string): Session {
  const p = parsed.get(fixtureId);
  if (p === undefined) throw new Error(`fixture ${fixtureId} was not parsed`);
  const id = sessionId ?? [...p.sessions.keys()][0];
  const s = id === undefined ? undefined : p.sessions.get(id);
  if (s === undefined) throw new Error(`fixture ${fixtureId} has no session ${String(sessionId)}`);
  return s;
}

// ---------------------------------------------------------------------------
// Goldens: fixture → expected.json.session deep-equal; zero problems.
// ---------------------------------------------------------------------------

describe.each(fixtureIds)('%s', (id) => {
  it('matches the golden session view (expected.json.session)', () => {
    const p = parsed.get(id);
    expect(p).toBeDefined();
    if (p === undefined) return;
    const view: Record<string, GoldenSession> = {};
    for (const [sid, session] of p.sessions) view[sid] = projectSession(session);
    const path = readerExpectedPath(id);
    if (UPDATE_GOLDENS) updateSessionSection(path, {}, view);
    const expected = readExpectedJson(path);
    expect(expected?.['session']).toEqual(view);
  });

  it('has zero core-shape problems (§12.2 exit 4)', () => {
    const p = parsed.get(id);
    expect(p).toBeDefined();
    if (p === undefined) return;
    for (const [sid, session] of p.sessions) {
      expect(coreShapeProblems(session), `${id} / ${sid}`).toEqual([]);
    }
  });
});

describe.each(ledgerFixtures.map((f) => f.name))('ledger/%s', (name) => {
  it('matches the golden session view (<name>.expected.json session)', () => {
    const session = ledgerSessions.get(name);
    expect(session).toBeDefined();
    if (session === undefined) return;
    const view = { [session.sessionId]: projectSession(session) };
    const path = ledgerExpectedPath(name);
    const harness = ledgerFixtures.find((f) => f.name === name)?.harness ?? 'unknown';
    if (UPDATE_GOLDENS) updateSessionSection(path, { fixture: `ledger/${name}`, harness }, view);
    const expected = readExpectedJson(path);
    expect(expected?.['session']).toEqual(view);
  });

  it('has zero core-shape problems', () => {
    const session = ledgerSessions.get(name);
    expect(session).toBeDefined();
    if (session === undefined) return;
    expect(coreShapeProblems(session)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// expected.json.shapes ⊆ found (scripts/survey-fixtures.mjs --check).
// ---------------------------------------------------------------------------

describe('shape survey', () => {
  it('expected.json.shapes ⊆ found for every fixture', () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'survey-fixtures.mjs'), '--check'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Hand-verified Appendix A/B pins (PLAN S10 instruction 2). Each fact below is
// checked against the Appendix, not merely generated; the free-text records
// live in each fixture's `expected.json.verified[]`.
// ---------------------------------------------------------------------------

describe('Appendix A/B hand-verification', () => {
  it('2.1.214: 3 compactions, duplicate uuids, pr-links, one fork subagent, notification finals', () => {
    const s = sessionOf('claude-code/2.1.214');
    expect(s.compactions).toHaveLength(3);
    expect(s.diagnostics.duplicateUuids).toBeGreaterThan(0);
    expect(s.prRefs.length).toBeGreaterThanOrEqual(1);
    expect(s.subagents.filter((a) => a.isFork === true)).toHaveLength(1);
    expect(s.turns.some((t) => t.finalTrigger === 'notification')).toBe(true);
  });

  it('2.1.215: backgroundTaskId → background, returnCodeInterpretation → interpreted, notification final', () => {
    const s = sessionOf('claude-code/2.1.215');
    const bg = s.toolCalls.filter((c) => c.backgroundTaskId !== undefined);
    expect(bg.length).toBeGreaterThanOrEqual(1);
    for (const c of bg) expect(c.background).toBe(true);
    const interpreted = s.toolCalls.filter((c) => c.exitCodeSource === 'interpreted');
    expect(interpreted.length).toBeGreaterThanOrEqual(1);
    for (const c of interpreted) {
      expect(c.exitCode).toBeNull();
      expect(c.interpretation).toBeDefined();
    }
    expect(s.turns.some((t) => t.finalTrigger === 'notification')).toBe(true);
  });

  it('2.1.235: 2 refusal fallbacks, fallback model in models, 18 Bash results without toolUseResult, interrupts', () => {
    const s = sessionOf('claude-code/2.1.235');
    expect(s.refusalFallbacks).toHaveLength(2);
    for (const f of s.refusalFallbacks) expect(s.models).toContain(f.fallbackModel);
    expect(s.diagnostics.bashWithoutToolUseResult).toBe(18);
    expect(s.turns.some((t) => t.interrupted)).toBe(true);
  });

  it('2.1.241: dangerouslyDisableSandbox seed and workflow subagents', () => {
    const s = sessionOf('claude-code/2.1.241');
    expect(s.toolCalls.some((c) => c.sandboxDisabled === true)).toBe(true);
    expect(s.subagents.some((a) => a.spawnedBy.tool === 'Workflow')).toBe(true);
  });

  it('2.1.251: bridge-session counted, owner ids absent from the output', () => {
    const s = sessionOf('claude-code/2.1.251');
    const blob = JSON.stringify(s);
    expect(blob).not.toContain('ownerAccountUuid');
    expect(blob).not.toContain('ownerOrganizationUuid');
    expect(blob).not.toContain('bridgeSessionId');
    expect(s.subagents.some((a) => a.agentType === 'workflow-subagent')).toBe(true);
  });

  it('2.1.243: no-turns session', () => {
    const s = sessionOf('claude-code/2.1.243');
    expect(s.kind).toBe('no-turns');
    expect(s.turns).toHaveLength(0);
  });

  it('codex 019c45e8: 2 turns, 6 tool calls, S08 token totals', () => {
    const s = sessionOf('codex/0.98.0', '019c45e8-ac72-76c9-96e4-1a38177c0fb3');
    expect(s.turns).toHaveLength(2);
    expect(s.toolCalls).toHaveLength(6);
    expect(s.usage.input).toBe(94_642 - 82_560);
    expect(s.usage.cacheRead).toBe(82_560);
    expect(s.usage.output).toBe(2_343);
  });

  it('codex 019c4678: 67 turns, 286 tool calls, 27+1 patches, 23 back-fills, one -1', () => {
    const s = sessionOf('codex/0.98.0', '019c4678-53b6-71c6-bb5b-d5b24ff14873');
    expect(s.turns).toHaveLength(67);
    expect(s.toolCalls).toHaveLength(286);
    const patches = s.toolCalls.filter((c) => c.tool === 'apply_patch');
    expect(patches).toHaveLength(28);
    expect(patches.filter((c) => !c.isError)).toHaveLength(27);
    expect(patches.filter((c) => c.isError)).toHaveLength(1);
    expect(s.toolCalls.filter((c) => c.exitCodeSource === 'backfilled')).toHaveLength(23);
    expect(s.toolCalls.some((c) => c.terminated === true && c.exitCode === null)).toBe(true);
  });

  it('codex shell_command: every exitCodeSource of harness|backfilled|unknown present', () => {
    const s = sessionOf('codex/shell_command');
    const sources = new Set<string>(s.toolCalls.map((c) => c.exitCodeSource));
    for (const want of ['harness', 'backfilled', 'unknown']) expect(sources.has(want)).toBe(true);
  });

  it('claude-code/legacy: legacyShapes counted', () => {
    const s = sessionOf('claude-code/legacy');
    expect(Object.keys(s.diagnostics.legacyShapes).length).toBeGreaterThan(0);
    expect(s.diagnostics.legacyShapes['Task']).toBeGreaterThanOrEqual(1);
    expect(s.diagnostics.legacyShapes['MultiEdit']).toBeGreaterThanOrEqual(1);
    expect(s.diagnostics.legacyShapes['inline-sidechain']).toBeGreaterThanOrEqual(1);
  });

  it('ledger fixtures: ledgerCoverage and finalTextSource as S09 pins them', () => {
    const cursor = ledgerSessions.get('cursor-basic');
    expect(cursor?.ledgerCoverage).toBe('all-tools');
    expect(cursor?.turns[0]?.finalTextSource).toBe('transcript');
    const gemini = ledgerSessions.get('gemini-basic');
    expect(gemini?.ledgerCoverage).toBe('partial'); // a gap line
    const dsh = ledgerSessions.get('dsh-basic');
    expect(dsh?.ledgerCoverage).toBe('partial'); // harness-truncated output
    expect(dsh?.turns[0]?.finalTextSource).toBe('transcript');
  });
});
