/**
 * S10 golden-view helpers: project a parsed `Session` to the stable golden
 * shape stored in `expected.json.session`, parse every committed fixture
 * (reader fixtures via the materialiser, ledger fixtures in place), and
 * read/rewrite the expected files (`UPDATE_GOLDENS=1`).
 *
 * The golden view is deliberately a *projection*: it pins everything the
 * readers are contracted to produce (turn structure, exit sources, usage,
 * diagnostics) without pinning volatile bulk (result texts, tool inputs,
 * absolute temp paths), so goldens survive re-materialisation into any
 * temp directory.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { Harness, Session, SessionRef, SubagentInfo, Turn, UsageTotals } from '../../src/model/types.js';
import { readClaudeCodeSession, type ClaudeCodeReadOptions } from '../../src/readers/claude-code/reader.js';
import { readCodexSession } from '../../src/readers/codex/reader.js';
import { readLedgerSession } from '../../src/readers/ledger/reader.js';
import { FIXTURES_ROOT, fixtureDir, materialize } from './fixtures.js';

/** Rewrites expected files instead of comparing when set (`npm run goldens:update`). */
export const UPDATE_GOLDENS = process.env['UPDATE_GOLDENS'] === '1';

/** The injected home for fixture parsing (fixtures are redacted to `/home/u`). */
export const GOLDEN_HOME = '/home/u';

/** Where the S09 ledger fixtures (and their `<name>.expected.json` goldens) live. */
export const LEDGER_FIXTURES_ROOT = join(FIXTURES_ROOT, 'ledger');

// ---------------------------------------------------------------------------
// Golden view
// ---------------------------------------------------------------------------

export interface GoldenSegment {
  trigger: string;
  seqStart: number;
  seqEnd: number;
}

export interface GoldenTurn {
  index: number;
  kind: string;
  promptId: string;
  segments: GoldenSegment[];
  finalTrigger: string | null;
  interimFinals: number;
  isDone: boolean;
  interrupted: boolean;
  compactions: number;
  finalStopReason: string | null;
  durationMs: number | null;
  apiCalls: number;
  usage: UsageTotals;
}

export interface GoldenSubagent {
  agentId: string;
  parentAgentId: string | null;
  spawnedBy: SubagentInfo['spawnedBy'];
  agentType: string | null;
  isFork: boolean;
  toolCalls: number;
  finished: boolean;
}

export interface GoldenSession {
  harness: string;
  harnessVersion: string | null;
  harnessVersions: string[];
  sessionId: string;
  shortId: string;
  cwd: string;
  cwds: string[];
  gitBranch: string | null;
  models: string[];
  primaryModel: string;
  startedAt: string;
  endedAt: string;
  kind: string;
  records: number;
  turns: GoldenTurn[];
  toolCallCount: number;
  toolCallsByKind: Record<string, number>;
  exitSources: Record<string, number>;
  writesTouched: string[];
  postFinalCalls: number;
  subagents: GoldenSubagent[];
  compactions: Session['compactions'];
  prRefs: Session['prRefs'];
  apiErrors: Session['apiErrors'];
  refusalFallbacks: Session['refusalFallbacks'];
  editedFiles: Session['editedFiles'];
  usageRows: { count: number; attempts: number; billedAttempts: number; inherited: number; incomplete: number };
  usageTotals: UsageTotals;
  tokenDeltaTotals: { count: number; input: number; cached: number; output: number; reasoning: number };
  diagnostics: Session['diagnostics'];
}

/** A record with its keys sorted ascending (deterministic golden JSON). */
function sortRecord(rec: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(rec).sort()) {
    const value = rec[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function projectTurn(t: Turn): GoldenTurn {
  return {
    index: t.index,
    kind: t.kind,
    promptId: t.promptId,
    segments: t.segments.map((seg) => ({ trigger: seg.trigger, seqStart: seg.seqStart, seqEnd: seg.seqEnd })),
    finalTrigger: t.finalTrigger,
    interimFinals: t.interimFinals,
    isDone: t.isDone,
    interrupted: t.interrupted,
    compactions: t.compactions,
    finalStopReason: t.finalStopReason,
    durationMs: t.durationMs,
    apiCalls: t.apiCalls,
    usage: t.usage,
  };
}

function projectSubagent(info: SubagentInfo): GoldenSubagent {
  return {
    agentId: info.agentId,
    parentAgentId: info.parentAgentId,
    spawnedBy: info.spawnedBy,
    agentType: info.agentType ?? null,
    isFork: info.isFork === true,
    toolCalls: info.toolCalls,
    finished: info.finished,
  };
}

/**
 * Projects a parsed `Session` to the golden view compared against
 * `expected.json.session` (PLAN S10 instruction 1). The result is JSON
 * round-tripped so `undefined` optionals vanish and deep-equality against
 * the committed JSON is exact.
 */
export function projectSession(s: Session): GoldenSession {
  const toolCallsByKind: Record<string, number> = {};
  const exitSources: Record<string, number> = {};
  const writesTouched = new Set<string>();
  let postFinalCalls = 0;
  for (const call of s.toolCalls) {
    toolCallsByKind[call.kind] = (toolCallsByKind[call.kind] ?? 0) + 1;
    exitSources[call.exitCodeSource] = (exitSources[call.exitCodeSource] ?? 0) + 1;
    // Write-ish paths: edit/write tools, an exec-delivered apply_patch
    // (kind `shell` with a parsed patch, §4.3.4) and a ledger
    // `subagent-stop.modifiedFiles` list (§4.4) — never plain reads.
    const writeish =
      call.kind === 'edit' || call.kind === 'write' || (call.kind === 'shell' && call.patch !== undefined) || call.tool === 'subagent-stop';
    if (writeish) for (const p of call.filesTouched) writesTouched.add(p);
    if (call.postFinal === true) postFinalCalls++;
  }
  let attempts = 0;
  let billedAttempts = 0;
  let inherited = 0;
  let incomplete = 0;
  for (const row of s.usageRows) {
    attempts += row.attempts.length;
    for (const attempt of row.attempts) if (attempt.billed) billedAttempts++;
    if (row.inherited === true) inherited++;
    if (row.incomplete === true) incomplete++;
  }
  const tokenDeltaTotals = { count: 0, input: 0, cached: 0, output: 0, reasoning: 0 };
  for (const delta of s.tokenDeltas) {
    tokenDeltaTotals.count++;
    tokenDeltaTotals.input += delta.input;
    tokenDeltaTotals.cached += delta.cached;
    tokenDeltaTotals.output += delta.output;
    tokenDeltaTotals.reasoning += delta.reasoning;
  }
  const view: GoldenSession = {
    harness: s.harness,
    harnessVersion: s.harnessVersion,
    harnessVersions: [...s.harnessVersions],
    sessionId: s.sessionId,
    shortId: s.shortId,
    cwd: s.cwd,
    cwds: [...s.cwds],
    gitBranch: s.gitBranch,
    models: [...s.models],
    primaryModel: s.primaryModel,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    kind: s.kind,
    records: s.records,
    turns: s.turns.map(projectTurn),
    toolCallCount: s.toolCalls.length,
    toolCallsByKind: sortRecord(toolCallsByKind),
    exitSources: sortRecord(exitSources),
    writesTouched: [...writesTouched].sort(),
    postFinalCalls,
    subagents: s.subagents.map(projectSubagent),
    compactions: s.compactions,
    prRefs: s.prRefs,
    apiErrors: s.apiErrors,
    refusalFallbacks: s.refusalFallbacks,
    editedFiles: s.editedFiles,
    usageRows: { count: s.usageRows.length, attempts, billedAttempts, inherited, incomplete },
    usageTotals: s.usage,
    tokenDeltaTotals,
    diagnostics: s.diagnostics,
  };
  return JSON.parse(JSON.stringify(view)) as GoldenSession;
}

// ---------------------------------------------------------------------------
// Fixture parsing
// ---------------------------------------------------------------------------

export interface ParsedFixture {
  fixtureId: string;
  /** sessionId → parsed session, in transcript-path order. */
  sessions: Map<string, Session>;
  /** Uncompressed bytes of every materialised file (throughput reporting). */
  bytes: number;
  /** Wall time spent inside the readers (materialisation excluded). */
  parseMs: number;
}

const MAIN_TRANSCRIPT_RE = /^projects\/[^/]+\/[^/]+\.jsonl$/;
const ROLLOUT_ID_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/**
 * Materialises one reader fixture into `into` and parses every session in it
 * with the real discovery-shaped inputs: Claude Code main transcripts with
 * their `subagents/` directory, Codex rollouts one by one.
 */
export async function parseReaderFixture(fixtureId: string, into: string): Promise<ParsedFixture> {
  const m = materialize(fixtureId, into);
  const sessions = new Map<string, Session>();
  let bytes = 0;
  for (const p of m.paths) bytes += statSync(p).size;
  const started = performance.now();
  if (m.harness === 'claude-code') {
    const root = m.claudeConfigDir ?? into;
    for (const p of m.paths) {
      const rel = relative(root, p).split(sep).join('/');
      if (!MAIN_TRANSCRIPT_RE.test(rel)) continue;
      const sessionId = basename(p, '.jsonl');
      const ref: SessionRef = {
        harness: 'claude-code',
        sessionId,
        path: p,
        size: statSync(p).size,
        mtimeMs: 0,
        subagentManifest: [],
      };
      const opts: ClaudeCodeReadOptions = { home: GOLDEN_HOME };
      const subagentsDir = join(dirname(p), sessionId, 'subagents');
      if (existsSync(subagentsDir)) opts.subagents = { kind: 'dir', path: subagentsDir };
      const { session } = await readClaudeCodeSession(ref, opts);
      sessions.set(sessionId, session);
    }
  } else {
    for (const p of m.paths) {
      const match = ROLLOUT_ID_RE.exec(basename(p));
      if (match === null) continue;
      const sessionId = (match[1] as string).toLowerCase();
      const ref: SessionRef = { harness: 'codex', sessionId, path: p, size: statSync(p).size, mtimeMs: 0, subagentManifest: [] };
      const { session } = await readCodexSession(ref, { home: GOLDEN_HOME });
      sessions.set(sessionId, session);
    }
  }
  return { fixtureId, sessions, bytes, parseMs: performance.now() - started };
}

export interface LedgerFixture {
  /** File basename without `.jsonl` (e.g. `cursor-basic`). */
  name: string;
  harness: Harness;
  path: string;
}

/** The S09 ledger fixtures (`fixtures/ledger/<harness>-basic.jsonl`), sorted by name. */
export function listLedgerFixtures(): LedgerFixture[] {
  return readdirSync(LEDGER_FIXTURES_ROOT)
    .filter((n) => n.endsWith('.jsonl'))
    .sort()
    .map((n) => ({
      name: n.slice(0, -'.jsonl'.length),
      harness: n.split('-')[0] as Harness,
      path: join(LEDGER_FIXTURES_ROOT, n),
    }));
}

/** Parses one ledger fixture in place (pure: no transcript-head injection, no fs beyond the file). */
export function parseLedgerFixture(f: LedgerFixture): Session {
  const ref: SessionRef = {
    harness: f.harness,
    sessionId: f.name,
    path: f.path,
    size: statSync(f.path).size,
    mtimeMs: 0,
    subagentManifest: [],
    ledger: true,
  };
  return readLedgerSession(ref, { home: '/home/u/.showreceipts' });
}

// ---------------------------------------------------------------------------
// Expected files
// ---------------------------------------------------------------------------

/** `expected.json` path of a reader fixture. */
export function readerExpectedPath(fixtureId: string): string {
  return join(fixtureDir(fixtureId), 'expected.json');
}

/** Golden path of a ledger fixture (`fixtures/ledger/<name>.expected.json`). */
export function ledgerExpectedPath(name: string): string {
  return join(LEDGER_FIXTURES_ROOT, `${name}.expected.json`);
}

/** Parses an expected file; `null` when absent. */
export function readExpectedJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

/**
 * Rewrites the `session` section of an expected file, creating the file from
 * `skeleton` when absent. Every other section (`shapes`, `verified`,
 * `source`, …) is preserved verbatim.
 */
export function updateSessionSection(path: string, skeleton: Record<string, unknown>, sessions: Record<string, GoldenSession>): void {
  const current = readExpectedJson(path) ?? { ...skeleton };
  current['session'] = sessions;
  writeFileSync(path, JSON.stringify(current, null, 2) + '\n');
}
