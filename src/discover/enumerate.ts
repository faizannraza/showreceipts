/**
 * Session discovery (ARCHITECTURE §4.1): walks the resolved roots and returns
 * a `SessionRef` per transcript or ledger file, without opening any of them.
 * The only filesystem operations here are `readdir` and `stat` — parsing is
 * the readers' job, and the roots were realpath-resolved once by
 * `resolveRoots`. `sessions-index.json`, `tool-results/`, `remote-agents/`,
 * `workflows/`, `memory/` and `tasks/` (session-dir siblings of `subagents/`)
 * are never entered, because only `projects/<p>` itself and
 * `projects/<p>/<sid>/subagents/**` are ever listed.
 *
 * `since` is a millisecond timestamp the caller derives from `ctx.now`
 * (never from the wall clock here); it prefilters on file mtime, plus a
 * ±1-day path-date prefilter for Codex rollouts (§4.1: Codex path dates are
 * local time, so they may only ever be used with that tolerance).
 */
import fs from 'node:fs';
import { join } from 'node:path';
import type { Harness, Roots, SessionRef } from '../model/types.js';
import { HARNESSES } from '../model/types.js';
import { parseJsonSafe, isRecord } from '../util/json.js';
import { statOrNull } from '../util/fs.js';
import { rootRealpath } from './roots.js';

/** Subagent transcripts (§4.2.6). */
const AGENT_JSONL_RE = /^agent-[0-9a-f]+\.jsonl$/;
/** Subagent metadata sidecars (read later only as agent metadata). */
const AGENT_META_RE = /^agent-[0-9a-f]+\.meta\.json$/;
/** The workflow journal (`{type:'started'|'result'|'failed', key, agentId}`). */
const JOURNAL_NAME = 'journal.jsonl';
/** A Codex rollout; the capture is the trailing uuid = session id. */
const ROLLOUT_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
/** The local-time date a rollout filename starts with. */
const ROLLOUT_DATE_RE = /^rollout-(\d{4})-(\d{2})-(\d{2})[T-]/;

const DAY_MS = 86_400_000;
/** Recursive subagent scan depth cap (§4.1): files deeper than 4 levels below `subagents/` are ignored. */
const SUBAGENT_DEPTH = 4;
/** Codex `sessions/YYYY/MM/DD/rollout-*.jsonl` is depth 4; leave headroom for archive layouts. */
const CODEX_DEPTH = 6;

export interface EnumerateOptions {
  /** Window start in epoch ms, derived by the caller from `ctx.now`; files older by mtime are skipped. */
  since?: number;
  /** Disables the `since` prefilter entirely. */
  all?: boolean;
  /** Only these harnesses are enumerated (default: all). */
  harness?: Harness[];
}

export interface EnumerateCounts {
  /** `projects/<p>/<sid>/` directories without a `<sid>.jsonl` beside them. */
  orphanSessionDirs: number;
  /** Project directories holding zero transcripts (not a problem). */
  emptyProjects: number;
  /** Files inside a subagent scan that match none of the accepted names. */
  unrecognisedFiles: number;
  /** `journal.jsonl` files found by the subagent scans. */
  journals: number;
}

export interface EnumerateResult {
  /** Discovered sessions, sorted by `mtimeMs` desc, then `path` asc. */
  refs: SessionRef[];
  counts: EnumerateCounts;
}

/** `readdirSync` with dirents, sorted by name; `[]` for a missing or unreadable directory. */
function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return [];
  }
}

/**
 * Recursively collects subagent-scan manifest entries under `dir` (§4.1):
 * only `agent-*.jsonl`, `agent-*.meta.json` and `journal.jsonl` are listed;
 * anything else is `unrecognisedFiles`. Depth ≤ 4, symlinks never followed
 * (a symlink is counted as unrecognised, not opened).
 */
function scanSubagents(
  dir: string,
  relPrefix: string,
  depth: number,
  manifest: SessionRef['subagentManifest'],
  counts: EnumerateCounts,
): void {
  for (const entry of listDir(dir)) {
    const rel = `${relPrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (depth < SUBAGENT_DEPTH) scanSubagents(join(dir, entry.name), rel, depth + 1, manifest, counts);
      continue;
    }
    if (!entry.isFile()) {
      counts.unrecognisedFiles += 1;
      continue;
    }
    if (AGENT_JSONL_RE.test(entry.name) || AGENT_META_RE.test(entry.name) || entry.name === JOURNAL_NAME) {
      const stat = statOrNull(join(dir, entry.name));
      if (stat !== null) manifest.push({ rel, size: stat.size, mtimeMs: stat.mtimeMs });
      if (entry.name === JOURNAL_NAME) counts.journals += 1;
    } else {
      counts.unrecognisedFiles += 1;
    }
  }
}

/** Sorts a manifest by `rel` (the deterministic order the cache key hashes). */
function sortManifest(manifest: SessionRef['subagentManifest']): SessionRef['subagentManifest'] {
  return manifest.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

interface Window {
  /** `null` when `--all` (or no `since`) disables the prefilter. */
  start: number | null;
}

function inWindow(mtimeMs: number, window: Window): boolean {
  return window.start === null || mtimeMs >= window.start;
}

/**
 * Enumerates one Claude Code project directory: `*.jsonl` transcripts
 * (non-recursive; `agent-*.jsonl` beside the main file is the tolerated older
 * subagent layout and joins every manifest of the project, never a session),
 * `<sid>/subagents/**` manifests, orphan session dirs and empty projects.
 */
function enumerateClaudeProject(projectDir: string, window: Window, refs: SessionRef[], counts: EnumerateCounts): void {
  const entries = listDir(projectDir);
  const sessionFiles: string[] = [];
  const besideNames: string[] = [];
  const dirNames: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      dirNames.push(entry.name);
    } else if (entry.isFile() && (AGENT_JSONL_RE.test(entry.name) || AGENT_META_RE.test(entry.name))) {
      besideNames.push(entry.name);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name !== JOURNAL_NAME) {
      sessionFiles.push(entry.name);
    }
  }
  const sessionIds = new Set(sessionFiles.map((name) => name.slice(0, -'.jsonl'.length)));
  for (const dirName of dirNames) {
    if (!sessionIds.has(dirName)) counts.orphanSessionDirs += 1;
  }
  if (sessionFiles.length === 0) {
    counts.emptyProjects += 1;
    return;
  }
  for (const name of sessionFiles) {
    const sessionId = name.slice(0, -'.jsonl'.length);
    const path = join(projectDir, name);
    const stat = statOrNull(path);
    if (stat === null || !stat.isFile()) continue;
    if (!inWindow(stat.mtimeMs, window)) continue;
    const manifest: SessionRef['subagentManifest'] = [];
    for (const besideName of besideNames) {
      const besideStat = statOrNull(join(projectDir, besideName));
      if (besideStat !== null) manifest.push({ rel: besideName, size: besideStat.size, mtimeMs: besideStat.mtimeMs });
    }
    const subagentDir = join(projectDir, sessionId, 'subagents');
    const subagentStat = statOrNull(subagentDir);
    const hasSubagentDir = subagentStat !== null && subagentStat.isDirectory();
    if (hasSubagentDir) scanSubagents(subagentDir, `${sessionId}/subagents`, 1, manifest, counts);
    const ref: SessionRef = {
      harness: 'claude-code',
      sessionId,
      path,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      projectDir,
      subagentManifest: sortManifest(manifest),
    };
    if (hasSubagentDir) ref.subagentDir = subagentDir;
    if (stat.size < 2) ref.empty = true;
    refs.push(ref);
  }
}

/**
 * `session_index.jsonl` as an id → title map (§4.1): tolerant line-by-line
 * parse, last entry per id wins, used only for `SessionRef.title`.
 */
function readSessionIndex(codexHome: string): Map<string, string> {
  const titles = new Map<string, string>();
  let text: string;
  try {
    text = fs.readFileSync(join(codexHome, 'session_index.jsonl'), 'utf8');
  } catch {
    return titles;
  }
  for (const line of text.split('\n')) {
    const parsed = parseJsonSafe(line);
    if (!isRecord(parsed)) continue;
    const id = parsed['id'];
    const title = parsed['thread_name'];
    if (typeof id === 'string' && typeof title === 'string') titles.set(id.toLowerCase(), title);
  }
  return titles;
}

/**
 * The ±1-day Codex path-date prefilter (§4.1): a rollout whose filename date
 * — end of that local day plus one day of tolerance — still precedes the
 * window start cannot be in the window. An unparsable date never excludes.
 */
function rolloutBeforeWindow(name: string, window: Window): boolean {
  if (window.start === null) return false;
  const m = ROLLOUT_DATE_RE.exec(name);
  if (m === null) return false;
  const dateMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return dateMs + 2 * DAY_MS <= window.start;
}

/** Recursively walks a Codex `sessions`/`archived_sessions` tree (sorted by path, depth-capped, no symlinks). */
function walkCodex(dir: string, depth: number, window: Window, titles: Map<string, string>, refs: SessionRef[]): void {
  for (const entry of listDir(dir)) {
    if (entry.isDirectory()) {
      if (depth < CODEX_DEPTH) walkCodex(join(dir, entry.name), depth + 1, window, titles, refs);
      continue;
    }
    if (!entry.isFile()) continue;
    const m = ROLLOUT_RE.exec(entry.name);
    if (m === null) continue;
    if (rolloutBeforeWindow(entry.name, window)) continue;
    const path = join(dir, entry.name);
    const stat = statOrNull(path);
    if (stat === null || !stat.isFile()) continue;
    if (!inWindow(stat.mtimeMs, window)) continue;
    const sessionId = (m[1] as string).toLowerCase();
    const ref: SessionRef = {
      harness: 'codex',
      sessionId,
      path,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      subagentManifest: [],
    };
    const title = titles.get(sessionId);
    if (title !== undefined) ref.title = title;
    refs.push(ref);
  }
}

/** Enumerates hook-captured ledgers: `<showreceiptsHome>/ledger/<harness>/*.jsonl` (§4.1). */
function enumerateLedgers(showreceiptsHome: string, wants: (h: Harness) => boolean, window: Window, refs: SessionRef[]): void {
  const ledgerRoot = join(showreceiptsHome, 'ledger');
  for (const harnessEntry of listDir(ledgerRoot)) {
    if (!harnessEntry.isDirectory()) continue;
    const harness = harnessEntry.name as Harness;
    if (!HARNESSES.includes(harness) || !wants(harness)) continue;
    const dir = join(ledgerRoot, harnessEntry.name);
    for (const entry of listDir(dir)) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const path = join(dir, entry.name);
      const stat = statOrNull(path);
      if (stat === null || !stat.isFile()) continue;
      if (!inWindow(stat.mtimeMs, window)) continue;
      refs.push({
        harness,
        sessionId: entry.name.slice(0, -'.jsonl'.length),
        path,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        subagentManifest: [],
        ledger: true,
      });
    }
  }
}

/**
 * Finds every session on disk under the resolved roots (§4.1) without
 * parsing anything: Claude Code `projects/<p>/<sid>.jsonl` with their recursive
 * subagent manifests, Codex rollouts under the `sessions` and
 * `archived_sessions` trees (titles from `session_index.jsonl`), and
 * hook-captured ledgers. Absent
 * roots yield no refs and never throw. Results are sorted by `mtimeMs`
 * descending, then `path` ascending.
 */
export function enumerateSessions(roots: Roots, opts: EnumerateOptions = {}): EnumerateResult {
  const counts: EnumerateCounts = { orphanSessionDirs: 0, emptyProjects: 0, unrecognisedFiles: 0, journals: 0 };
  const refs: SessionRef[] = [];
  const window: Window = { start: opts.all === true ? null : (opts.since ?? null) };
  const wants = (h: Harness): boolean => opts.harness === undefined || opts.harness.includes(h);

  const claudeRoot = rootRealpath(roots, 'claudeConfigDir');
  if (claudeRoot !== null && wants('claude-code')) {
    const projectsDir = join(claudeRoot, 'projects');
    for (const entry of listDir(projectsDir)) {
      if (entry.isDirectory()) enumerateClaudeProject(join(projectsDir, entry.name), window, refs, counts);
    }
  }

  const codexRoot = rootRealpath(roots, 'codexHome');
  if (codexRoot !== null && wants('codex')) {
    const titles = readSessionIndex(codexRoot);
    for (const base of ['sessions', 'archived_sessions']) {
      walkCodex(join(codexRoot, base), 1, window, titles, refs);
    }
  }

  const showreceiptsRoot = rootRealpath(roots, 'showreceiptsHome');
  if (showreceiptsRoot !== null) enumerateLedgers(showreceiptsRoot, wants, window, refs);

  refs.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { refs, counts };
}
