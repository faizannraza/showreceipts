/**
 * S20 — audit header/footer, session table fitting sequence, rate table
 * (§10.1), plus the timeline and doctor text renderers, and the 80-column
 * full audit screen snapshot over the fixture-tree cards (§10.2).
 */
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DoctorReport, RateRow, Receipt, Session, SessionCard, TimelineEntry } from '../../src/model/types.js';
import { parsePriceTable } from '../../src/cost/validate.js';
import { resolveRoots } from '../../src/discover/roots.js';
import { buildRateRows, buildSessionCard, sessionKey } from '../../src/pipeline/cards.js';
import { buildReceipt, buildTurnReceipts, type ReceiptOptions } from '../../src/pipeline/receipt.js';
import { loadSessions } from '../../src/pipeline/run.js';
import { assertWidth } from '../../src/render/box.js';
import { renderDoctor } from '../../src/render/doctor.js';
import { renderAuditFooter, renderAuditHeader, renderRateTable, renderSessionTable } from '../../src/render/summary.js';
import { renderReceipt } from '../../src/render/term.js';
import { renderTimeline } from '../../src/render/timeline.js';
import { displayWidth } from '../../src/util/width.js';
import { TOOL_VERSION } from '../../src/version.js';
import { FIXTURES_ROOT, materialize } from '../helpers/fixtures.js';
import { GOLDEN_HOME } from '../helpers/goldens.js';
import { makeTempDir } from '../helpers/tmp.js';

const U = { cols: 80, unicode: true } as const;

// ---------------------------------------------------------------------------
// Header and footer
// ---------------------------------------------------------------------------

describe('audit header (§10.2)', () => {
  it('renders the sample line verbatim at 80 columns', () => {
    const lines = renderAuditHeader(
      {
        toolVersion: '0.1.0',
        sessions: 41,
        byHarness: [
          { label: 'Claude Code', sessions: 37 },
          { label: 'Codex', sessions: 4 },
        ],
        from: '2026-08-01T00:00:00Z',
        to: '2026-08-29T12:00:00Z',
      },
      U,
    );
    expect(lines).toEqual(['showreceipts 0.1.0 · scanned 41 sessions · Claude Code 37 · Codex 4 · Aug 1–29']);
  });

  it('wraps at ` · ` when narrow; cross-month and cross-year spans carry both dates', () => {
    const scan = {
      toolVersion: '0.1.0',
      sessions: 3,
      byHarness: [{ label: 'Claude Code', sessions: 3 }],
      from: '2025-12-30T00:00:00Z',
      to: '2026-01-02T00:00:00Z',
    };
    const lines = renderAuditHeader(scan, { cols: 44, unicode: true });
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(42);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toContain('Dec 30 2025 – Jan 2 2026');
    const july = renderAuditHeader({ ...scan, from: '2026-07-18T00:00:00Z', to: '2026-08-23T00:00:00Z' }, U);
    expect(july.join(' ')).toContain('Jul 18 – Aug 23');
  });
});

describe('audit footer (§10.2)', () => {
  it('shows the report path and, only without installed hooks, the setup hint', () => {
    expect(renderAuditFooter({ reportPath: '.showreceipts/report.html', showSetupHint: true }, U)).toEqual([
      'report → .showreceipts/report.html     setup → npx showreceipts setup',
    ]);
    expect(renderAuditFooter({ reportPath: '.showreceipts/report.html', showSetupHint: false }, U)).toEqual([
      'report → .showreceipts/report.html',
    ]);
  });

  it('splits into two lines when the joined form does not fit', () => {
    const lines = renderAuditFooter({ reportPath: '.showreceipts/report.html', showSetupHint: true }, { cols: 50, unicode: false });
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(48);
    expect(lines[0]).toContain('report -> ');
  });
});

// ---------------------------------------------------------------------------
// Session table fitting sequence
// ---------------------------------------------------------------------------

function makeCard(over: Partial<SessionCard> = {}): SessionCard {
  return {
    id: '1e60d0ff-9d90-4d1c-a6cd-7a3b3f2f9df2',
    shortId: '1e60d0ff',
    harness: 'claude-code',
    harnessLabel: 'Claude Code',
    harnessVersion: '2.1.214',
    model: 'claude-sonnet-5',
    cwd: '/home/u/proj/wattage',
    title: null,
    startedAt: '2026-08-01T10:00:00.000Z',
    endedAt: '2026-08-01T11:30:00.000Z',
    turns: 4,
    doneTurns: 3,
    claims: 9,
    verdict: 'CONTRADICTED',
    costUsd: 18.42,
    unverified: false,
    kind: 'scored',
    ...over,
  };
}

describe('session table (§10.1 fitting sequence)', () => {
  const cards = [
    makeCard(),
    makeCard({ id: 'aaa', shortId: 'c0dec0de', harness: 'codex', harnessLabel: 'Codex', harnessVersion: '0.98.0', model: 'gpt-5.2-codex', endedAt: '2026-08-02T09:00:00.000Z', verdict: 'VERIFIED', costUsd: 0.07, unverified: true }),
    makeCard({ id: 'bbb', shortId: '0cafe000', harness: 'cursor', harnessLabel: 'Cursor', harnessVersion: '1.9.2', model: 'gpt-5.6-terra', endedAt: '2026-08-03T09:00:00.000Z', verdict: '—', costUsd: null, kind: 'no-turns' }),
  ];

  it('at 102 columns every column fits, sorted endedAt desc then id asc', () => {
    const lines = renderSessionTable(cards, { cols: 102, unicode: true });
    const header = lines[0] as string;
    for (const name of ['ID', 'HARNESS', 'VERSION', 'MODEL', 'DATE', 'TURNS', 'CLAIMS', 'VERDICT', 'COST']) expect(header).toContain(name);
    expect(lines[1]).toContain('0cafe000');
    expect(lines[2]).toContain('c0dec0de');
    expect(lines[3]).toContain('1e60d0ff');
    expect(lines[1]).toContain('n/a');
    expect(lines[2]).toContain('≈$0.07');
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(100);
  });

  it('drops TURNS first, then folds harness+version into the key form', () => {
    const lines = renderSessionTable(cards, { cols: 74, unicode: true });
    const header = lines[0] as string;
    expect(header).not.toContain('TURNS');
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(72);
    const narrower = renderSessionTable(cards, { cols: 71, unicode: true });
    expect(narrower[0]).not.toContain('VERSION');
    expect(narrower.join('\n')).toContain('cc 2.1.214');
    expect(narrower.join('\n')).toContain('codex 0.98.0');
  });

  it('then truncates the model, abbreviates verdicts and middle-truncates the id to 6', () => {
    const wide = cards.map((c, i) => ({ ...c, model: `claude-experimental-preview-ultra-long-model-${i}` }));
    const lines = renderSessionTable(wide, { cols: 60, unicode: true });
    const text = lines.join('\n');
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(58);
    expect(text).toContain('…');
    expect(text).toContain('CONTRA');
    expect(text).toContain('OK');
    expect(text).not.toContain('claude-experimental-preview-ultra-long-model-0');
    expect(text).not.toContain('1e60d0ff');
  });

  it('honours --limit and renders `no sessions` when empty', () => {
    const many = Array.from({ length: 25 }, (_, i) => makeCard({ id: `s${String(i).padStart(2, '0')}`, shortId: `s${String(i).padStart(2, '0')}abcde` }));
    expect(renderSessionTable(many, { cols: 102, unicode: true }).length).toBe(21);
    expect(renderSessionTable(many, { cols: 102, unicode: true, limit: 5 }).length).toBe(6);
    expect(renderSessionTable([], U)).toEqual(['no sessions']);
  });
});

// ---------------------------------------------------------------------------
// Rate table
// ---------------------------------------------------------------------------

function makeRate(over: Partial<RateRow> = {}): RateRow {
  return {
    model: 'claude-sonnet-5',
    harness: 'claude-code',
    harnessVersion: '2.1.214',
    sessions: 12,
    turns: 40,
    doneTurns: 29,
    doneTurnsByTrigger: { claims: 25, markerOnly: 4 },
    byTrigger: { human: 27, notification: 2 },
    contradictedTurns: 3,
    unverifiedTurns: 7,
    cleanTurns: 19,
    claims: {
      total: 80,
      verified: 60,
      unverified: 12,
      contradicted: 5,
      notScored: 3,
      byKind: {
        file: 30, 'file-count': 2, test: 20, 'test-added': 3, 'test-ran': 5, check: 6, command: 4, install: 1, git: 5, verification: 2, completion: 1, 'no-change': 1,
      },
    },
    testRunRate: 0.8,
    costPerDoneTurnUsd: { median: 1.2, mean: 2.3 },
    contradictionReasons: { 'last-run-red': 2, 'no-evidence': 1 },
    integritySignals: 0,
    ledgerIncompleteSessions: 0,
    cacheHitPct: 71,
    ...over,
  };
}

describe('rate table (§5.4 display)', () => {
  it('renders label and numbers on one line when they fit', () => {
    const lines = renderRateTable([makeRate()], { cols: 100, unicode: true });
    expect(lines).toEqual(['claude-sonnet-5 · Claude Code 2.1.214  3/29 done turns contradicted (10%) · 7 unverified']);
  });

  it('moves the numbers to a second line indented 4 when they do not fit', () => {
    const lines = renderRateTable([makeRate()], { cols: 60, unicode: true });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('claude-sonnet-5 · Claude Code 2.1.214');
    expect(lines[1]).toMatch(/^ {4}3\/29 done turns contradicted \(10%\)/);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(58);
  });

  it('hides the percentage below 10 done turns (`—  (3 of 4)`) and omits zero unverified', () => {
    const lines = renderRateTable(
      [makeRate({ doneTurns: 4, contradictedTurns: 3, unverifiedTurns: 0, model: 'gpt-5.2-codex', harness: 'codex', harnessVersion: '0.98.0' })],
      U,
    );
    expect(lines).toEqual(['gpt-5.2-codex · Codex 0.98.0  —  (3 of 4)']);
    const noUnv = renderRateTable([makeRate({ unverifiedTurns: 0 })], { cols: 100, unicode: true });
    expect(noUnv[0]).not.toContain('unverified');
  });

  it('sorts by doneTurns desc, then model, harness, version', () => {
    const rows = [
      makeRate({ model: 'b-model', doneTurns: 12 }),
      makeRate({ model: 'a-model', doneTurns: 12 }),
      makeRate({ model: 'z-model', doneTurns: 30 }),
    ];
    const lines = renderRateTable(rows, { cols: 120, unicode: true });
    expect(lines[0]).toContain('z-model');
    expect(lines[1]).toContain('a-model');
    expect(lines[2]).toContain('b-model');
  });
});

// ---------------------------------------------------------------------------
// Timeline renderer
// ---------------------------------------------------------------------------

function makeEntry(over: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    seq: 10,
    at: '2026-08-01T10:05:00.000Z',
    tool: 'Bash',
    kind: 'shell',
    summary: 'uv run pytest -q',
    exit: 0,
    files: [],
    usd: 0.0042,
    agentId: null,
    flags: ['test'],
    ...over,
  };
}

describe('timeline renderer', () => {
  const entries = [
    makeEntry(),
    makeEntry({ seq: 11, at: '2026-08-01T10:06:00.000Z', tool: 'Edit', kind: 'edit', summary: '/home/u/proj/src/x.ts', exit: null, files: ['/home/u/proj/src/x.ts'], usd: null, flags: ['write'] }),
    makeEntry({ seq: 12, at: '2026-08-02T09:00:00.000Z', tool: 'Bash', summary: 'rm -rf /tmp/scratch', exit: 1, usd: null, agentId: 'a271fd7c9', flags: ['danger', 'error'] }),
  ];

  it('wide mode: one row per entry under the header, every line fitting', () => {
    const lines = renderTimeline(entries, { cols: 100, unicode: true, tz: 'utc' });
    expect(lines[0]).toMatch(/^TIME\s+TOOL\s+SUMMARY/);
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain('10:05');
    expect(lines[1]).toContain('$0.0042');
    expect(lines[2]).toContain('x.ts');
    expect(lines[3]).toContain('Aug 2 09:00');
    expect(lines[3]).toContain('a:a271fd7');
    expect(lines[3]).toContain('! rm -rf /tmp/scratch');
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(98);
    expect(renderTimeline(entries, { cols: 100, unicode: true, tz: 'utc' })).toMatchSnapshot();
  });

  it('narrow mode: two lines per entry, summary indented', () => {
    const lines = renderTimeline(entries, { cols: 60, unicode: false, tz: 'utc' });
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain('10:05 Bash -> exit 0');
    expect(lines[1]).toMatch(/^ {2}uv run pytest -q/);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(58);
  });
});

// ---------------------------------------------------------------------------
// Doctor renderer
// ---------------------------------------------------------------------------

function makeDoctor(): DoctorReport {
  return {
    roots: {
      userHome: '/home/u',
      claudeConfigDir: '/home/u/.claude',
      codexHome: '/home/u/.codex',
      showreceiptsHome: '/home/u/.showreceipts',
      realpaths: {},
    },
    node: { version: 'v26.0.0', platform: 'darwin' },
    harnesses: [
      {
        harness: 'claude-code', root: '/home/u/.claude', found: true, sessions: 37, bytes: 12_582_912,
        versions: ['2.1.214', '2.1.251'], installedVersion: '2.1.251', emptySessions: 1, emptyProjects: 0,
        orphanSessionDirs: 0, subagentFiles: { direct: 3, workflow: 8, unlinked: 0, missing: 0 }, journals: 1,
        unrecognisedFiles: 0, unknownRecordTypes: {}, unknownSubtypes: {}, unknownToolShapes: {},
        unknownContentBlocks: {}, unknownCodexPayloads: {}, badLines: 2, lineSeparatorChars: 0,
        bashWithoutToolUseResult: 0, excludedSyntheticLines: 0, legacyShapes: {},
      },
      {
        harness: 'codex', root: '/home/u/.codex', found: false, sessions: 0, bytes: 0, versions: [],
        installedVersion: null, emptySessions: 0, emptyProjects: 0, orphanSessionDirs: 0,
        subagentFiles: { direct: 0, workflow: 0, unlinked: 0, missing: 0 }, journals: 0, unrecognisedFiles: 0,
        unknownRecordTypes: {}, unknownSubtypes: {}, unknownToolShapes: {}, unknownContentBlocks: {},
        unknownCodexPayloads: {}, badLines: 0, lineSeparatorChars: 0, bashWithoutToolUseResult: 0,
        excludedSyntheticLines: 0, legacyShapes: {},
      },
    ],
    hooks: [
      {
        harness: 'claude-code', scope: 'user', configPath: '/home/u/.claude/settings.json', installed: true,
        command: '/home/u/.showreceipts/bin/showreceipts-hook hook claude-code Stop', resolvable: true,
        resolvableNote: 'in this shell; the harness process PATH may differ', disabled: false, otherStopHooks: [],
        strict: false, trusted: true,
      },
    ],
    ledgers: { sessions: 5, partial: 1, gaps: 0, stdinOverflow: 0, stopBudgetExceeded: 0, copilotTranscriptUnparsed: 0 },
    prices: { version: '2026-08-29', unverifiedInUse: true, unpricedModels: ['mystery-model-1'] },
    cache: { entries: 41, bytes: 1_048_576 },
    problems: ['unreadable root: /home/u/.claude/projects/locked'],
    warnings: ['claude-code 2.1.260 has no fixture'],
  };
}

describe('doctor renderer', () => {
  it('renders roots, harnesses, hooks, ledgers, prices, cache, warnings and problems', () => {
    const lines = renderDoctor(makeDoctor(), { cols: 120, unicode: true });
    const text = lines.join('\n');
    expect(text).toContain('node v26.0.0 darwin');
    expect(text).toContain('showreceipts  /home/u/.showreceipts');
    expect(text).toContain('37 sessions · 12.0 MB · versions 2.1.214, 2.1.251 · installed 2.1.251 · 2 bad lines');
    expect(text).toContain('/home/u/.codex · not found');
    expect(text).toContain('(user) /home/u/.claude/settings.json · installed');
    expect(text).toContain('5 sessions · 1 partial · 0 gaps');
    expect(text).toContain('version 2026-08-29');
    expect(text).toContain('! unverified rates in use');
    expect(text).toContain('! unpriced: mystery-model-1');
    expect(text).toContain('41 entries · 1.0 MB');
    expect(text).toContain('! claude-code 2.1.260 has no fixture');
    expect(text).toContain('✗ unreadable root:');
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(118);
    expect(lines).toMatchSnapshot();
  });

  it('fits and stays hazard-free at 60 columns ASCII', () => {
    const lines = renderDoctor(makeDoctor(), { cols: 60, unicode: false });
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(58);
    expect(lines.join('\n')).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(lines.join('\n')).toContain('x unreadable root:');
  });
});

// ---------------------------------------------------------------------------
// 80-column full audit screen over the fixture tree (§10.2)
// ---------------------------------------------------------------------------

const NOW = new Date('2026-08-29T12:00:00.000Z');
const prices = parsePriceTable(readFileSync(join(FIXTURES_ROOT, 'prices', 'prices.golden.json'), 'utf8'), 'prices.golden.json');

function receiptOpts(over: Partial<ReceiptOptions> = {}): ReceiptOptions {
  return { now: NOW, prices, homeDir: GOLDEN_HOME, ...over };
}

const tmp = makeTempDir('showreceipts-summary-');
const fixtureSessions: Session[] = [];
for (const id of ['claude-code/2.1.214', 'codex/shell_command']) {
  const into = join(tmp, id.replace(/\//g, '__'));
  materialize(id, into);
  const roots = resolveRoots(
    { CLAUDE_CONFIG_DIR: join(into, 'claude'), CODEX_HOME: join(into, 'codex'), SHOWRECEIPTS_HOME: join(into, 'sr') },
    GOLDEN_HOME,
  );
  const { sessions, diagnostics } = await loadSessions({ roots, all: true, noCache: true, versions: { tool: TOOL_VERSION }, now: NOW });
  if (diagnostics.problems.length > 0) throw new Error(`${id}: ${diagnostics.problems.join('; ')}`);
  fixtureSessions.push(...sessions);
}

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('80-column full audit screen (fixture tree)', () => {
  it('header + session table + rate table + latest receipt, snapshotted', () => {
    const turnReceipts = new Map(fixtureSessions.map((s) => [sessionKey(s), buildTurnReceipts(s, receiptOpts())] as const));
    const cards = fixtureSessions.map((s) => buildSessionCard(s, turnReceipts.get(sessionKey(s)) as Map<number, Receipt>));
    const rate = buildRateRows(fixtureSessions, turnReceipts);
    const latest = [...fixtureSessions].sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1))[0] as Session;
    const from = [...fixtureSessions].map((s) => s.startedAt).sort()[0] as string;
    const to = [...fixtureSessions].map((s) => s.endedAt).sort().slice(-1)[0] as string;
    const opts80 = { cols: 80, unicode: true };
    const screen = [
      ...renderAuditHeader(
        {
          toolVersion: TOOL_VERSION,
          sessions: fixtureSessions.length,
          byHarness: [
            { label: 'Claude Code', sessions: fixtureSessions.filter((s) => s.harness === 'claude-code').length },
            { label: 'Codex', sessions: fixtureSessions.filter((s) => s.harness === 'codex').length },
          ],
          from,
          to,
        },
        opts80,
      ),
      '',
      ...renderSessionTable(cards, opts80),
      '',
      ...renderRateTable(rate, opts80),
      '',
      renderReceipt(buildReceipt(latest, receiptOpts()), { cols: 80, unicode: true, tz: 'utc', homeDir: GOLDEN_HOME }).trimEnd(),
      '',
      ...renderAuditFooter({ reportPath: '.showreceipts/report.html', showSetupHint: true }, opts80),
    ].join('\n');
    for (const line of screen.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(80);
    expect(screen).toMatchSnapshot();
  });
});
