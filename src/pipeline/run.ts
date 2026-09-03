/**
 * The pipeline entry point (ARCHITECTURE §4, S18): roots → enumerated refs
 * (S05) → per-ref cached parse (read → repo root → ledger → echo hashes →
 * trim) → filtered, sorted `Session[]`. Everything price- or rule-dependent
 * (claims, reconcile, cost) runs later, post-cache, in `receipt.ts` — a
 * cache entry never depends on prices, rules, `--as-of` or the scanned set.
 *
 * Failure containment: a single unreadable or corrupt file never aborts the
 * run — the ref is skipped with a `diagnostics.problems` line and the scan
 * continues. A corrupt cache entry is a miss (re-parse, byte-identical
 * output) counted in `diagnostics.corruptCache`.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Diagnostics, Harness, Roots, Session, SessionRef, ToolCall } from '../model/types.js';
import { cacheKey, createCache, trimForCache, type CacheEntry, type ParseCache } from '../cache/cache.js';
import { echoHashes } from '../claims/text.js';
import { enumerateSessions, type EnumerateCounts } from '../discover/enumerate.js';
import { buildLedger } from '../ledger/index.js';
import { readClaudeCodeSession, type ClaudeCodeReadOptions } from '../readers/claude-code/reader.js';
import { readCodexSession } from '../readers/codex/reader.js';
import { readLedgerSession } from '../readers/ledger/reader.js';
import { makeRepoRootResolver } from '../util/gitroot.js';
import { sha256 } from '../util/hash.js';
import { uuidVersion } from '../util/ids.js';
import { canon, isUnder, toPosix } from '../util/paths.js';
import { parseIso } from '../util/time.js';
import { markSessionInherited } from './dedupe.js';

/** In-memory `resultText` retention after the ledger parsers ran (§4.2.5): head 4 KB + `…` + tail 4 KB. */
const TRIM_HEAD = 4096;
const TRIM_TAIL = 4096;

/** Options of {@link loadSessions}; `since` is epoch ms derived by the caller from `ctx.now`. */
export interface LoadOptions {
  roots: Roots;
  /** Window start (epoch ms); sessions older by mtime and by parsed `endedAt` are excluded. */
  since?: number | undefined;
  /** Disables the window entirely (`--all`). */
  all?: boolean | undefined;
  /** Only these harnesses (default: every harness found). */
  harness?: Harness[] | undefined;
  /** `--project`: matches the session cwd as a substring or as a resolved path. */
  project?: string | undefined;
  /** `--no-cache` / `SHOWRECEIPTS_NO_CACHE=1`, resolved by the caller. */
  noCache?: boolean | undefined;
  /** Version pins; `tool` keys the parse cache (a new tool version re-parses everything). */
  versions: { tool: string };
  /** The command clock (`ctx.now`); held for signature stability — the load itself never reads a clock. */
  now: Date;
  /** Progress callback: `(done, total)` after each ref. */
  onProgress?: ((done: number, total: number) => void) | undefined;
}

/** The `scanned` block of `audit --json` (§12.3). */
export interface ScannedSummary {
  sessions: number;
  byHarness: Partial<Record<Harness, number>>;
  /** Earliest `startedAt` / latest `endedAt` among the loaded sessions (`null` when none). */
  from: string | null;
  to: string | null;
  /** Bytes on disk of every loaded transcript, subagent files included. */
  bytes: number;
  cacheHits: number;
}

/** Aggregated diagnostics plus the per-file failures the run survived. */
export interface LoadDiagnostics extends Diagnostics {
  /** One line per skipped file: `<path>: <error>`. */
  problems: string[];
}

export interface LoadResult {
  /** Sorted by `endedAt` desc, then `sessionId` asc (§4.1). */
  sessions: Session[];
  scanned: ScannedSummary;
  diagnostics: LoadDiagnostics;
}

/** `err` as a one-line message. */
function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Head/tail retention of one result text (§4.2.5); marks the call `truncated:'showreceipts'` when it cuts. */
function trimCall(call: ToolCall): void {
  if (call.resultText.length > TRIM_HEAD + TRIM_TAIL + 1) {
    call.resultText = `${call.resultText.slice(0, TRIM_HEAD)}…${call.resultText.slice(-TRIM_TAIL)}`;
    if (call.truncated === undefined) call.truncated = 'showreceipts';
  }
  delete call.patch;
  delete call.attempted;
}

/** SHA-256 of the last `min(4096, size)` bytes of a file (`''` when unreadable) — the §4.9 resume guard. */
function fileTailHash(path: string, size: number): string {
  const length = Math.min(4096, size);
  if (length <= 0) return sha256(Buffer.alloc(0));
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(length);
      const read = readSync(fd, buf, 0, length, size - length);
      return sha256(buf.subarray(0, read));
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** The fs-backed head reader injected into the ledger reader (Copilot final-text fallback, §4.4). */
function readTranscriptHead(path: string, maxBytes: number): string | null {
  try {
    const size = statSync(path).size;
    const length = Math.min(maxBytes, size);
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(length);
      const read = readSync(fd, buf, 0, length, 0);
      return buf.subarray(0, read).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** A widened (12-hex) short id for colliding sessions (§4.1), version-aware like `shortId`. */
function widenShortId(harness: Harness, id: string): string {
  const version = uuidVersion(id);
  const hex = id.replace(/-/g, '').toLowerCase();
  if (version === 4) return hex.slice(0, 12);
  if (version === 7) return hex.slice(-12);
  return sha256(`${harness}:${id}`).slice(0, 12);
}

/** Sums `b`'s per-session diagnostics into the aggregate `a`. */
function foldDiagnostics(a: Diagnostics, b: Diagnostics): void {
  const records = (into: Record<string, number>, from: Record<string, number>): void => {
    for (const [key, value] of Object.entries(from)) into[key] = (into[key] ?? 0) + value;
  };
  records(a.unknownRecordTypes, b.unknownRecordTypes);
  records(a.unknownSubtypes, b.unknownSubtypes);
  records(a.unknownToolShapes, b.unknownToolShapes);
  records(a.unknownContentBlocks, b.unknownContentBlocks);
  records(a.unknownCodexPayloads, b.unknownCodexPayloads);
  records(a.legacyShapes, b.legacyShapes);
  records(a.unknownAttachmentTypes, b.unknownAttachmentTypes);
  a.badLines += b.badLines;
  a.lineSeparatorChars += b.lineSeparatorChars;
  a.reorderedEvents += b.reorderedEvents;
  a.duplicateUuids += b.duplicateUuids;
  a.duplicateToolResults += b.duplicateToolResults;
  a.negativeDeltas += b.negativeDeltas;
  a.orphanAssistantLines += b.orphanAssistantLines;
  a.notificationPrompts += b.notificationPrompts;
  a.localCommandPrompts += b.localCommandPrompts;
  a.incompleteMessages += b.incompleteMessages;
  a.bashWithoutToolUseResult += b.bashWithoutToolUseResult;
  a.subagentFiles.direct += b.subagentFiles.direct;
  a.subagentFiles.workflow += b.subagentFiles.workflow;
  a.subagentFiles.unlinked += b.subagentFiles.unlinked;
  a.subagentFiles.missing += b.subagentFiles.missing;
  a.interimFinals += b.interimFinals;
  a.emptySessions += b.emptySessions;
  a.excludedSyntheticLines += b.excludedSyntheticLines;
  a.journals += b.journals;
  a.unrecognisedFiles += b.unrecognisedFiles;
  a.orphanSessionDirs += b.orphanSessionDirs;
  a.emptyProjects += b.emptyProjects;
  a.corruptCache += b.corruptCache;
  a.copilotTranscriptUnparsed += b.copilotTranscriptUnparsed;
  a.records += b.records;
  for (const note of b.notes) if (!a.notes.includes(note)) a.notes.push(note);
}

/** A zeroed aggregate `Diagnostics` + `problems`. */
function emptyLoadDiagnostics(): LoadDiagnostics {
  return {
    unknownRecordTypes: {},
    unknownSubtypes: {},
    unknownToolShapes: {},
    unknownContentBlocks: {},
    unknownCodexPayloads: {},
    badLines: 0,
    lineSeparatorChars: 0,
    reorderedEvents: 0,
    duplicateUuids: 0,
    duplicateToolResults: 0,
    negativeDeltas: 0,
    orphanAssistantLines: 0,
    notificationPrompts: 0,
    localCommandPrompts: 0,
    incompleteMessages: 0,
    bashWithoutToolUseResult: 0,
    legacyShapes: {},
    subagentFiles: { direct: 0, workflow: 0, unlinked: 0, missing: 0 },
    notes: [],
    interimFinals: 0,
    emptySessions: 0,
    excludedSyntheticLines: 0,
    unknownAttachmentTypes: {},
    journals: 0,
    unrecognisedFiles: 0,
    orphanSessionDirs: 0,
    emptyProjects: 0,
    corruptCache: 0,
    copilotTranscriptUnparsed: 0,
    records: 0,
    problems: [],
  };
}

/** Parses one ref through the reader → repo root → ledger → echo → trim chain (the cache-miss path). */
async function parseRef(
  ref: SessionRef,
  roots: Roots,
  repoRootOf: (p: string) => string | null,
  tmpRoots: string[],
): Promise<{ session: Session; bytesParsed: number; tailHash: string; builderState?: string }> {
  let session: Session;
  let bytesParsed: number;
  let tailHash: string;
  let builderState: string | undefined;
  if (ref.ledger === true) {
    session = readLedgerSession(ref, { home: roots.showreceiptsHome, readTranscriptHead });
    bytesParsed = ref.size;
    tailHash = fileTailHash(ref.path, ref.size);
  } else if (ref.harness === 'codex') {
    const result = await readCodexSession(ref, { home: roots.userHome });
    session = result.session;
    bytesParsed = result.bytesParsed;
    tailHash = result.tailHash;
  } else {
    const opts: ClaudeCodeReadOptions = { home: roots.userHome };
    if (ref.subagentDir !== undefined) opts.subagents = { kind: 'dir', path: ref.subagentDir };
    const result = await readClaudeCodeSession(ref, opts);
    session = result.session;
    bytesParsed = result.bytesParsed;
    tailHash = result.tailHash;
    builderState = result.builderState;
  }
  session.repoRoot = session.cwd === '' ? null : repoRootOf(session.cwd);
  session.ledger = buildLedger(session, { repoRootOf, tmpRoots });
  for (const turn of session.turns) {
    turn.echoHashes = turn.userText === null || turn.userText === '' ? [] : echoHashes(turn.userText);
  }
  for (const call of session.toolCalls) trimCall(call);
  const out: { session: Session; bytesParsed: number; tailHash: string; builderState?: string } = { session, bytesParsed, tailHash };
  if (builderState !== undefined) out.builderState = builderState;
  return out;
}

/** True when the session matches `--project` (cwd substring, or resolved-path equality/containment, §4.1). */
export function matchesProject(session: Session, project: string, home: string): boolean {
  const needle = project.trim();
  if (needle === '') return true;
  const dirs = session.cwds.length > 0 ? session.cwds : [session.cwd];
  if (dirs.some((d) => d.includes(needle))) return true;
  const resolved = canon(needle, { home });
  return dirs.some((d) => {
    const c = canon(d, { home });
    return c === resolved || isUnder(c, resolved) || toPosix(d).includes(resolved);
  });
}

/** Widens every colliding `shortId` among `sessions` to 12 hex (§4.1). */
export function widenShortIdCollisions(sessions: readonly Session[]): void {
  const byShort = new Map<string, Session[]>();
  for (const s of sessions) {
    const list = byShort.get(s.shortId);
    if (list === undefined) byShort.set(s.shortId, [s]);
    else list.push(s);
  }
  for (const group of byShort.values()) {
    if (group.length < 2) continue;
    const distinctIds = new Set(group.map((s) => `${s.harness}:${s.sessionId}`));
    if (distinctIds.size < 2) continue;
    for (const s of group) s.shortId = widenShortId(s.harness, s.sessionId);
  }
}

/**
 * Loads every session under `opts.roots` (§4, S18): enumerate → per ref a
 * cache lookup (`cacheKey(ref, tool)`), on a miss the harness reader,
 * `repoRoot` from the S02 resolver, `buildLedger` (parsers over the full
 * `resultText`), `Turn.echoHashes` from the prompt text, the §4.2.5
 * head/tail trim (`patch`/`attempted` dropped; `userText` stays in memory
 * only), then `trimForCache` → `cache.put`. Warm or cold, every session gets
 * its within-session `inherited` marks recomputed (dedupe layer 1) — the
 * cross-session layer is `dedupe.ts dedupeUsage`, applied by aggregate
 * commands only. Filters (`--since` on parsed `endedAt`, `--project`) and
 * the (`endedAt` desc, `sessionId` asc) sort run last; a single bad file is
 * a `problems` line, never a throw.
 */
export async function loadSessions(opts: LoadOptions): Promise<LoadResult> {
  const diagnostics = emptyLoadDiagnostics();
  const enumerated = enumerateSessions(opts.roots, {
    ...(opts.since !== undefined ? { since: opts.since } : {}),
    ...(opts.all === true ? { all: true } : {}),
    ...(opts.harness !== undefined ? { harness: opts.harness } : {}),
  });
  addEnumerateCounts(diagnostics, enumerated.counts);

  const cache: ParseCache = createCache({
    dir: join(opts.roots.showreceiptsHome, 'cache'),
    toolVersion: opts.versions.tool,
    ...(opts.noCache === true ? { disabled: true } : {}),
  });
  const repoRootOf = makeRepoRootResolver();
  const tmpRoots = [tmpdir()];

  const sessions: Session[] = [];
  let cacheHits = 0;
  let bytes = 0;
  const total = enumerated.refs.length;
  let done = 0;
  const corruptBefore = cache.stats().corrupt;

  for (const ref of enumerated.refs) {
    try {
      const key = cacheKey(ref, opts.versions.tool);
      const hit = cache.get(key);
      let session: Session;
      if (hit !== null) {
        cacheHits += 1;
        session = hit.session;
      } else {
        const parsed = await parseRef(ref, opts.roots, repoRootOf, tmpRoots);
        session = parsed.session;
        const entry: CacheEntry = {
          v: 1,
          key,
          session: trimForCache(session),
          bytesParsed: parsed.bytesParsed,
          tailHash: parsed.tailHash,
          ...(parsed.builderState !== undefined ? { builderState: parsed.builderState } : {}),
        };
        cache.put(key, entry);
      }
      markSessionInherited(session);
      bytes += ref.size;
      for (const entry of ref.subagentManifest) bytes += entry.size;
      sessions.push(session);
    } catch (err) {
      diagnostics.problems.push(`${ref.path}: ${messageOf(err)}`);
    } finally {
      done += 1;
      opts.onProgress?.(done, total);
    }
  }
  diagnostics.corruptCache += cache.stats().corrupt - corruptBefore;

  // --- window (parsed endedAt), project filter, collisions, sort -----------
  let kept = sessions;
  if (opts.all !== true && opts.since !== undefined) {
    const since = opts.since;
    kept = kept.filter((s) => {
      const endedMs = parseIso(s.endedAt);
      return endedMs === null || endedMs >= since;
    });
  }
  if (opts.project !== undefined && opts.project !== '') {
    const project = opts.project;
    kept = kept.filter((s) => matchesProject(s, project, opts.roots.userHome));
  }
  widenShortIdCollisions(kept);
  kept.sort((a, b) => {
    const aMs = parseIso(a.endedAt) ?? 0;
    const bMs = parseIso(b.endedAt) ?? 0;
    if (aMs !== bMs) return bMs - aMs;
    return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
  });

  // --- aggregate diagnostics and the scanned summary -----------------------
  const byHarness: Partial<Record<Harness, number>> = {};
  let fromMs: number | null = null;
  let toMs: number | null = null;
  let from: string | null = null;
  let to: string | null = null;
  for (const s of kept) {
    byHarness[s.harness] = (byHarness[s.harness] ?? 0) + 1;
    foldDiagnostics(diagnostics, s.diagnostics);
    if (s.kind === 'empty') diagnostics.emptySessions += 1;
    const startMs = parseIso(s.startedAt);
    if (startMs !== null && (fromMs === null || startMs < fromMs)) {
      fromMs = startMs;
      from = s.startedAt;
    }
    const endMs = parseIso(s.endedAt);
    if (endMs !== null && (toMs === null || endMs > toMs)) {
      toMs = endMs;
      to = s.endedAt;
    }
  }

  return {
    sessions: kept,
    scanned: { sessions: kept.length, byHarness, from, to, bytes, cacheHits },
    diagnostics,
  };
}

/** Folds the discovery counters (S05) into the aggregate diagnostics. */
function addEnumerateCounts(diagnostics: LoadDiagnostics, counts: EnumerateCounts): void {
  diagnostics.orphanSessionDirs += counts.orphanSessionDirs;
  diagnostics.emptyProjects += counts.emptyProjects;
  diagnostics.unrecognisedFiles += counts.unrecognisedFiles;
  diagnostics.journals += counts.journals;
}
