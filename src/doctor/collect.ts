/**
 * `doctor` report assembly (ARCHITECTURE §12.3): the full `DoctorReport` —
 * roots, node facts, per-harness rows folded from a whole-disk scan
 * (`all: true`; doctor reports what is on disk, not a window), hook rows
 * (gathered by the command via `setup/inspect.ts` and passed in), ledger
 * counters (including `HookCounters` from `<home>/state/counters.json`,
 * read tolerantly: a missing file or key is 0, never a problem), price
 * coverage, cache stats plus a static corrupt-entry scan, and the
 * §12.2-exact `problems[]` beside the open-ended `warnings[]`.
 *
 * `nodeVersion`, `platform` and the directory lister are injectable seams so
 * the Node-< 20 and unreadable-root problems are unit-testable without a
 * real downgrade or chmod dance.
 */
import fs from 'node:fs';
import { join } from 'node:path';
import type { DoctorHarnessReport, DoctorHookReport, DoctorReport, Harness, Roots, Session } from '../model/types.js';
import { createCache } from '../cache/cache.js';
import type { PriceTable } from '../cost/resolve.js';
import { enumerateSessions } from '../discover/enumerate.js';
import { sessionCost, type ReceiptOptions } from '../pipeline/receipt.js';
import { loadSessions, type LoadResult } from '../pipeline/run.js';
import { readJsonFile, statOrNull } from '../util/fs.js';
import { isRecord } from '../util/json.js';
import { envProblems, sessionProblems, type UnreadableRoot } from './problems.js';

/** A `HookCounters` field read tolerantly (missing file/key/type ⇒ 0). */
function counterOf(raw: unknown, key: string): number {
  if (!isRecord(raw)) return 0;
  const v = raw[key];
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

/** Injectable environment facts (tests set `nodeVersion: '18.20.0'`, a throwing `listDir`, …). */
export interface CollectSeams {
  /** Default `process.version`. */
  nodeVersion?: string | undefined;
  /** Default `process.platform`. */
  platform?: string | undefined;
  /** Directory lister used by the root probe and the cache scan; default `fs.readdirSync`. */
  listDir?: ((path: string) => string[]) | undefined;
}

export interface CollectOptions {
  roots: Roots;
  /** Display home (`--home-dir`); only feeds cost display decisions. */
  homeDir: string;
  prices: PriceTable;
  /** Ignored-override notes from `prepare` (§8.1) — become warnings. */
  priceNotes: readonly string[];
  toolVersion: string;
  now: Date;
  noCache: boolean;
  harness?: Harness[] | undefined;
  /** Hook rows from `setup/inspect.ts` (the command gathers; collect judges). */
  hooks: DoctorHookReport[];
  seams?: CollectSeams | undefined;
}

/** An empty per-harness row (fields fold in from the sessions of that harness). */
function emptyHarnessRow(harness: Harness, root: string, found: boolean): DoctorHarnessReport {
  return {
    harness,
    root,
    found,
    sessions: 0,
    bytes: 0,
    versions: [],
    installedVersion: null,
    emptySessions: 0,
    emptyProjects: 0,
    orphanSessionDirs: 0,
    subagentFiles: { direct: 0, workflow: 0, unlinked: 0, missing: 0 },
    journals: 0,
    unrecognisedFiles: 0,
    unknownRecordTypes: {},
    unknownSubtypes: {},
    unknownToolShapes: {},
    unknownContentBlocks: {},
    unknownCodexPayloads: {},
    badLines: 0,
    lineSeparatorChars: 0,
    bashWithoutToolUseResult: 0,
    excludedSyntheticLines: 0,
    legacyShapes: {},
  };
}

function addRecords(into: Record<string, number>, from: Record<string, number>): void {
  for (const [key, value] of Object.entries(from)) into[key] = (into[key] ?? 0) + value;
}

/** Folds one session's diagnostics into its harness row. */
function foldSession(row: DoctorHarnessReport, session: Session): void {
  const d = session.diagnostics;
  row.sessions += 1;
  if (session.kind === 'empty') row.emptySessions += 1;
  for (const version of session.harnessVersions) {
    if (!row.versions.includes(version)) row.versions.push(version);
  }
  addRecords(row.unknownRecordTypes, d.unknownRecordTypes);
  addRecords(row.unknownSubtypes, d.unknownSubtypes);
  addRecords(row.unknownToolShapes, d.unknownToolShapes);
  addRecords(row.unknownContentBlocks, d.unknownContentBlocks);
  addRecords(row.unknownCodexPayloads, d.unknownCodexPayloads);
  addRecords(row.legacyShapes, d.legacyShapes);
  row.badLines += d.badLines;
  row.lineSeparatorChars += d.lineSeparatorChars;
  row.bashWithoutToolUseResult += d.bashWithoutToolUseResult;
  row.excludedSyntheticLines += d.excludedSyntheticLines;
  row.subagentFiles.direct += d.subagentFiles.direct;
  row.subagentFiles.workflow += d.subagentFiles.workflow;
  row.subagentFiles.unlinked += d.subagentFiles.unlinked;
  row.subagentFiles.missing += d.subagentFiles.missing;
}

/** Claude Code installed version: `<claudeConfigDir>/.last-update-result.json` (tolerant). */
function claudeInstalledVersion(claudeConfigDir: string): string | null {
  const raw = readJsonFile(join(claudeConfigDir, '.last-update-result.json'));
  if (!isRecord(raw)) return null;
  const v = raw['latestVersion'] ?? raw['version'];
  return typeof v === 'string' && v !== '' ? v : null;
}

/** Codex `models_cache.json`: `client_version` plus the first model's `shell_type` as the dialect. */
function codexModelsCache(codexHome: string): { version: string | null; dialect: string | null } {
  const raw = readJsonFile(join(codexHome, 'models_cache.json'));
  if (!isRecord(raw)) return { version: null, dialect: null };
  const version = typeof raw['client_version'] === 'string' && raw['client_version'] !== '' ? raw['client_version'] : null;
  let dialect: string | null = null;
  const models = raw['models'];
  if (Array.isArray(models)) {
    const first = models.find(isRecord);
    const shellType = first?.['shell_type'];
    if (typeof shellType === 'string' && shellType !== '') dialect = shellType;
  }
  return { version, dialect };
}

/** The number of ledger `gap` notes a session's diagnostics carry (Appendix C). */
function gapNotesOf(session: Session): number {
  return session.diagnostics.notes.filter((n) => n.startsWith('ledger gap at line ')).length;
}

/**
 * Static corrupt-entry scan of `cache/`: every `<64 hex>.json` file must be
 * JSON with `v: 1` and a `key` equal to its file name — anything else is a
 * corrupt entry (§12.2). A missing directory is zero, never a problem.
 */
export function scanCorruptCache(cacheDir: string, listDir: (p: string) => string[]): number {
  let names: string[];
  try {
    names = listDir(cacheDir);
  } catch {
    return 0;
  }
  let corrupt = 0;
  for (const name of names) {
    const m = /^([0-9a-f]{64})\.json$/.exec(name);
    if (m === null) continue;
    const raw = readJsonFile(join(cacheDir, name));
    if (!isRecord(raw) || raw['v'] !== 1 || raw['key'] !== m[1]) corrupt += 1;
  }
  return corrupt;
}

/** Roots that exist as directories but cannot be listed (`EACCES`, …). */
function probeRoots(roots: Roots, listDir: (p: string) => string[]): UnreadableRoot[] {
  const out: UnreadableRoot[] = [];
  for (const path of [roots.claudeConfigDir, roots.codexHome, roots.showreceiptsHome]) {
    const stat = statOrNull(path);
    if (stat === null || !stat.isDirectory()) continue;
    try {
      listDir(path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      out.push({ path, message: code ?? (err instanceof Error ? err.message : String(err)) });
    }
  }
  return out;
}

/** Assembles the full §12.3 `DoctorReport` (see the module JSDoc). */
export async function collectDoctorReport(opts: CollectOptions): Promise<DoctorReport> {
  const seams = opts.seams ?? {};
  const nodeVersion = seams.nodeVersion ?? process.version;
  const platform = seams.platform ?? process.platform;
  const listDir = seams.listDir ?? ((p: string): string[] => fs.readdirSync(p));
  const roots = opts.roots;

  const unreadableRoots = probeRoots(roots, listDir);

  // Whole-disk scan: doctor reports what exists, not a --since window.
  const enumerated = enumerateSessions(roots, { all: true, ...(opts.harness !== undefined ? { harness: opts.harness } : {}) });
  const load: LoadResult = await loadSessions({
    roots,
    all: true,
    ...(opts.harness !== undefined ? { harness: opts.harness } : {}),
    ...(opts.noCache ? { noCache: true } : {}),
    versions: { tool: opts.toolVersion },
    now: opts.now,
  });

  // --- per-harness rows (transcript harnesses) ------------------------------
  const claudeRow = emptyHarnessRow('claude-code', roots.claudeConfigDir, roots.realpaths['claudeConfigDir'] !== null);
  const codexRow = emptyHarnessRow('codex', roots.codexHome, roots.realpaths['codexHome'] !== null);
  claudeRow.emptyProjects = enumerated.counts.emptyProjects;
  claudeRow.orphanSessionDirs = enumerated.counts.orphanSessionDirs;
  claudeRow.journals = enumerated.counts.journals;
  claudeRow.unrecognisedFiles = enumerated.counts.unrecognisedFiles;
  for (const ref of enumerated.refs) {
    if (ref.ledger === true) continue;
    const row = ref.harness === 'codex' ? codexRow : claudeRow;
    row.bytes += ref.size;
    for (const entry of ref.subagentManifest) row.bytes += entry.size;
  }
  const originators: Record<string, number> = {};
  for (const session of load.sessions) {
    if (session.source === 'ledger') continue;
    const row = session.harness === 'codex' ? codexRow : claudeRow;
    foldSession(row, session);
    if (session.harness === 'codex' && session.originator !== undefined && session.originator !== '') {
      originators[session.originator] = (originators[session.originator] ?? 0) + 1;
    }
  }
  claudeRow.versions.sort();
  codexRow.versions.sort();
  claudeRow.installedVersion = claudeInstalledVersion(roots.claudeConfigDir);
  const modelsCache = codexModelsCache(roots.codexHome);
  codexRow.installedVersion = modelsCache.version;
  if (modelsCache.dialect !== null) codexRow.codexDialect = modelsCache.dialect;
  if (Object.keys(originators).length > 0) codexRow.originators = originators;
  if (opts.hooks.some((h) => h.harness === 'claude-code' && h.disabled)) claudeRow.hooksDisabled = true;

  // --- ledgers --------------------------------------------------------------
  const ledgerSessions = load.sessions.filter((s) => s.source === 'ledger');
  const counters = readJsonFile(join(roots.showreceiptsHome, 'state', 'counters.json'));
  const ledgers: DoctorReport['ledgers'] = {
    sessions: ledgerSessions.length,
    partial: ledgerSessions.filter((s) => s.ledgerCoverage === 'partial').length,
    gaps: ledgerSessions.reduce((sum, s) => sum + gapNotesOf(s), 0),
    stdinOverflow: counterOf(counters, 'stdinOverflow'),
    stopBudgetExceeded: counterOf(counters, 'stopBudgetExceeded'),
    copilotTranscriptUnparsed: counterOf(counters, 'copilotTranscriptUnparsed'),
  };

  // --- price coverage (post-cache session costs, §8.3) ----------------------
  const costOpts: ReceiptOptions = { now: opts.now, prices: opts.prices, homeDir: opts.homeDir };
  let unverifiedInUse = false;
  const unpriced = new Set<string>();
  const unverifiedModels = new Set<string>();
  for (const session of load.sessions) {
    if (session.source === 'ledger') continue;
    const cost = sessionCost(session, costOpts);
    if (cost.unverified) unverifiedInUse = true;
    for (const model of cost.unpriced) unpriced.add(model);
    for (const model of cost.unverifiedModels ?? []) unverifiedModels.add(model);
  }
  const prices: DoctorReport['prices'] = {
    version: opts.prices.version,
    ...(opts.prices.overrideHash !== undefined ? { overrideHash: opts.prices.overrideHash } : {}),
    unverifiedInUse,
    unpricedModels: [...unpriced].sort(),
  };

  // --- cache ----------------------------------------------------------------
  const cacheDir = join(roots.showreceiptsHome, 'cache');
  const stats = createCache({ dir: cacheDir, toolVersion: opts.toolVersion }).stats();
  const corruptCacheEntries = scanCorruptCache(cacheDir, listDir) + load.diagnostics.corruptCache;

  // --- problems (§12.2, exactly) and warnings -------------------------------
  const problems = [
    ...sessionProblems(load.sessions),
    ...envProblems({ nodeVersion, hooks: opts.hooks, unreadableRoots, corruptCacheEntries }),
  ];

  const warnings: string[] = [...opts.priceNotes];
  if (unverifiedInUse) {
    // ≈ can also arise from non-model causes (unknown-TTL cache buckets, a
    // missing cache-read rate), so the wording is per-session, not blanket;
    // the model list names what the price table itself cannot verify.
    const ids = [...unverifiedModels].sort();
    warnings.push(
      ids.length > 0
        ? `unverified prices in use (${ids.join(', ')}) — sessions priced with them print costs with the ≈ marker`
        : 'unverified prices in use — affected sessions print costs with the ≈ marker',
    );
  }
  if (prices.unpricedModels.length > 0) warnings.push(`unpriced models: ${prices.unpricedModels.join(', ')}`);
  if (!opts.hooks.some((h) => h.installed)) {
    warnings.push('no hooks installed — only transcript harnesses are audited (run `showreceipts setup`)');
  }
  for (const row of [claudeRow, codexRow]) {
    if (row.installedVersion !== null && row.sessions > 0 && !row.versions.includes(row.installedVersion)) {
      warnings.push(`${row.harness} ${row.installedVersion} installed but no scanned session used it (shapes unverified)`);
    }
    const unknownTotal =
      Object.values(row.unknownRecordTypes).reduce((a, b) => a + b, 0) +
      Object.values(row.unknownSubtypes).reduce((a, b) => a + b, 0) +
      Object.values(row.unknownToolShapes).reduce((a, b) => a + b, 0) +
      Object.values(row.unknownContentBlocks).reduce((a, b) => a + b, 0) +
      Object.values(row.unknownCodexPayloads).reduce((a, b) => a + b, 0);
    if (unknownTotal > 0) warnings.push(`${row.harness}: ${unknownTotal} unknown shape(s) recorded (--verbose lists them)`);
    if (row.badLines > 0) warnings.push(`${row.harness}: ${row.badLines} unparsable line(s) skipped`);
  }
  for (const problem of load.diagnostics.problems) warnings.push(`skipped: ${problem}`);

  return {
    roots,
    node: { version: nodeVersion, platform },
    harnesses: [claudeRow, codexRow],
    hooks: opts.hooks,
    ledgers,
    prices,
    cache: { entries: stats.entries, bytes: stats.bytes },
    problems,
    warnings,
  };
}
