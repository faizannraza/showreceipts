/**
 * Session resolution for `session` and `export` (ARCHITECTURE §4.1, §12.1,
 * S21): one selector — `latest`, a full session id, a unique id/short-id
 * prefix (≥ 4 characters), or a transcript path — becomes one `Session`.
 *
 * - `latest` → the newest session with ≥ 1 done turn (sessions are compared
 *   by `endedAt` desc, `sessionId` asc, the §4.1 order);
 * - a full id → the session whose `sessionId` equals it (case-insensitive);
 * - a prefix (≥ 4 chars) → the unique session whose `sessionId`, printed
 *   `shortId` or transcript filename starts with it (§4.1); several matches
 *   raise {@link AmbiguousError}
 *   with the candidates, none raises {@link NotFoundError} (both exit 5 at
 *   the command shell, §12.2);
 * - a path (anything that looks like one, or an existing file) → the file is
 *   read directly with the harness reader its name/location implies — under
 *   a known root or not, as long as the file exists.
 *
 * The direct-read path mirrors the S18 cache-miss chain (reader → repo root
 * → ledger → echo hashes → within-session usage dedupe) so a
 * path-selected session judges identically to a scanned one.
 */
import { closeSync, openSync, readSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import type { Harness, Roots, Session, SessionRef } from '../model/types.js';
import { HARNESSES } from '../model/types.js';
import { echoHashes } from '../claims/text.js';
import { buildLedger } from '../ledger/index.js';
import { readClaudeCodeSession, type ClaudeCodeReadOptions } from '../readers/claude-code/reader.js';
import { readCodexSession } from '../readers/codex/reader.js';
import { readLedgerSession } from '../readers/ledger/reader.js';
import { statOrNull } from '../util/fs.js';
import { makeRepoRootResolver } from '../util/gitroot.js';
import { isUnder, toPosix } from '../util/paths.js';
import { parseIso } from '../util/time.js';
import { markSessionInherited } from './dedupe.js';

/** Minimum id-prefix length (§12.1: `session <prefix>`; shorter prefixes are refused, not guessed). */
export const MIN_PREFIX = 4;

/** One row of the candidate list printed on an ambiguous prefix (exit 5, §12.2). */
export interface SessionCandidate {
  harness: Harness;
  sessionId: string;
  shortId: string;
  endedAt: string;
}

/** An id prefix matched more than one session; `candidates` are printed by the command (exit 5). */
export class AmbiguousError extends Error {
  override readonly name = 'AmbiguousError';
  readonly exitCode = 5;
  readonly candidates: SessionCandidate[];

  constructor(message: string, candidates: SessionCandidate[]) {
    super(message);
    this.candidates = candidates;
  }
}

/** No session (or file) matched the selector (exit 5). */
export class NotFoundError extends Error {
  override readonly name = 'NotFoundError';
  readonly exitCode = 5;
}

/** What {@link resolveSession} needs: the scanned sessions plus the roots and cwd for path selectors. */
export interface ResolveContext {
  /** Sessions from `loadSessions` (any order; the resolver re-sorts for `latest`). */
  sessions: readonly Session[];
  /** Resolved config roots (§4.1): the reader home and the ledger-directory check. */
  roots: Roots;
  /** The command's working directory (relative path selectors resolve against it). */
  cwd: string;
}

/** The candidate row of a session. */
function candidateOf(s: Session): SessionCandidate {
  return { harness: s.harness, sessionId: s.sessionId, shortId: s.shortId, endedAt: s.endedAt };
}

/** The §4.1 session order: `endedAt` desc, then `sessionId` asc. */
function byRecency(a: Session, b: Session): number {
  const aMs = parseIso(a.endedAt) ?? 0;
  const bMs = parseIso(b.endedAt) ?? 0;
  if (aMs !== bMs) return bMs - aMs;
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}

/** True when the session has at least one done turn (`latest` only counts these, §5.2). */
function hasDoneTurn(s: Session): boolean {
  return s.kind === 'normal' && s.turns.some((t) => t.isDone);
}

/** The newest session with ≥ 1 done turn, or a {@link NotFoundError} naming why. */
function resolveLatest(sessions: readonly Session[]): Session {
  const sorted = [...sessions].sort(byRecency);
  const latest = sorted.find(hasDoneTurn);
  if (latest === undefined) {
    const n = sessions.length;
    throw new NotFoundError(
      n === 0 ? 'no sessions found' : `no session with a done turn found (${n} session${n === 1 ? '' : 's'} scanned)`,
    );
  }
  return latest;
}

/** True when the selector is spelled like a filesystem path rather than an id. */
function looksLikePath(selector: string): boolean {
  return (
    selector.includes('/') ||
    selector.includes('\\') ||
    selector === '~' ||
    selector.startsWith('~/') ||
    selector === '.' ||
    selector === '..' ||
    selector.endsWith('.jsonl')
  );
}

/** The absolute form of a path selector (`~` expands with the user home; relative resolves against `cwd`). */
function absolutePathOf(selector: string, ctx: ResolveContext): string {
  let p = selector;
  if (p === '~' || p.startsWith('~/')) p = join(ctx.roots.userHome, p.slice(1));
  return normalize(isAbsolute(p) ? p : join(ctx.cwd, p));
}

/** A Codex rollout file name; the capture is the trailing uuid = session id (§4.1). */
const ROLLOUT_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** The fs-backed head reader injected into the ledger reader (Copilot final-text fallback, §4.4). */
function readTranscriptHead(path: string, maxBytes: number): string | null {
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      const read = readSync(fd, buf, 0, maxBytes, 0);
      return buf.subarray(0, read).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** The ledger harness of `path` when it sits under `<showreceiptsHome>/ledger/<harness>/` (§4.1), else `null`. */
function ledgerHarnessOf(path: string, roots: Roots): Harness | null {
  const posix = toPosix(path);
  for (const home of [roots.showreceiptsHome, roots.realpaths['showreceiptsHome']]) {
    if (home === null || home === undefined || home === '') continue;
    const ledgerRoot = toPosix(join(home, 'ledger'));
    if (!isUnder(posix, ledgerRoot)) continue;
    const harness = basename(dirname(posix)) as Harness;
    if (HARNESSES.includes(harness)) return harness;
  }
  return null;
}

/**
 * Reads the session at `path` directly, outside the discovery scan (§12.1
 * `session <path>`): a `rollout-*.jsonl` name reads as Codex, a file under
 * `<showreceiptsHome>/ledger/<harness>/` as a hook-captured ledger, anything
 * else as a Claude Code transcript (with its `<sid>/subagents/` directory
 * when present). The S18 post-read chain (repo root, ledger, echo hashes,
 * within-session usage dedupe) is applied so the session behaves exactly
 * like a scanned one; read failures become {@link NotFoundError} (exit 5).
 */
export async function readSessionAtPath(path: string, roots: Roots): Promise<Session> {
  const stat = statOrNull(path);
  if (stat === null || !stat.isFile()) throw new NotFoundError(`no such file: ${path}`);
  const name = basename(path);
  const rollout = ROLLOUT_RE.exec(name);
  const ledgerHarness = ledgerHarnessOf(path, roots);
  let session: Session;
  try {
    if (ledgerHarness !== null) {
      const ref: SessionRef = {
        harness: ledgerHarness,
        sessionId: name.replace(/\.jsonl$/, ''),
        path,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        subagentManifest: [],
        ledger: true,
      };
      session = readLedgerSession(ref, { home: roots.showreceiptsHome, readTranscriptHead });
    } else if (rollout !== null) {
      const ref: SessionRef = {
        harness: 'codex',
        sessionId: (rollout[1] as string).toLowerCase(),
        path,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        subagentManifest: [],
      };
      session = (await readCodexSession(ref, { home: roots.userHome })).session;
    } else {
      const sessionId = name.replace(/\.jsonl$/, '');
      const ref: SessionRef = {
        harness: 'claude-code',
        sessionId,
        path,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        subagentManifest: [],
      };
      const opts: ClaudeCodeReadOptions = { home: roots.userHome };
      const subagentDir = join(dirname(path), sessionId, 'subagents');
      const subagentStat = statOrNull(subagentDir);
      if (subagentStat !== null && subagentStat.isDirectory()) {
        ref.subagentDir = subagentDir;
        opts.subagents = { kind: 'dir', path: subagentDir };
      }
      session = (await readClaudeCodeSession(ref, opts)).session;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new NotFoundError(`cannot read ${path}: ${message}`);
  }
  return enrichSession(session);
}

/**
 * The S18 post-read chain for one already-read session (repo root, ledger
 * assembly, echo hashes, within-session usage dedupe) — shared by
 * {@link readSessionAtPath} and the S29 hook stop flow
 * (`hook/ledger-stop.ts`), so a hook-built session behaves exactly like a
 * scanned one. Returns its (mutated) argument.
 */
export function enrichSession(session: Session): Session {
  const repoRootOf = makeRepoRootResolver();
  session.repoRoot = session.cwd === '' ? null : repoRootOf(session.cwd);
  session.ledger = buildLedger(session, { repoRootOf, tmpRoots: [tmpdir()] });
  for (const turn of session.turns) {
    turn.echoHashes = turn.userText === null || turn.userText === '' ? [] : echoHashes(turn.userText);
  }
  markSessionInherited(session);
  return session;
}

/** Resolves an id or id prefix over `sessionId`, `shortId` and the transcript filename (§4.1; case-insensitive). */
function resolveId(selector: string, sessions: readonly Session[]): Session {
  const sel = selector.toLowerCase();
  const exact = sessions.filter((s) => s.sessionId.toLowerCase() === sel);
  if (exact.length === 1) return exact[0] as Session;
  if (exact.length > 1) {
    throw new AmbiguousError(
      `ambiguous id '${selector}' matches ${exact.length} sessions`,
      exact.slice().sort(byRecency).map(candidateOf),
    );
  }
  if (sel.length < MIN_PREFIX) {
    throw new NotFoundError(`'${selector}': id prefix must be at least ${MIN_PREFIX} characters`);
  }
  const matchesName = (s: Session): boolean =>
    s.transcriptPath !== null && basename(s.transcriptPath).toLowerCase().startsWith(sel);
  const matches = sessions.filter(
    (s) => s.sessionId.toLowerCase().startsWith(sel) || s.shortId.toLowerCase().startsWith(sel) || matchesName(s),
  );
  if (matches.length === 1) return matches[0] as Session;
  if (matches.length > 1) {
    throw new AmbiguousError(
      `ambiguous id '${selector}' matches ${matches.length} sessions`,
      matches.slice().sort(byRecency).map(candidateOf),
    );
  }
  throw new NotFoundError(`no session matches '${selector}'`);
}

/**
 * Resolves one CLI selector to a session (§12.1, S21): `latest` → the newest
 * session with ≥ 1 done turn; a full id → that session; a unique prefix
 * (≥ {@link MIN_PREFIX} chars over `sessionId`, `shortId` and the
 * transcript filename, §4.1) → that session; a path (or the name of an
 * existing file) → the file read
 * directly via {@link readSessionAtPath}. Throws {@link AmbiguousError}
 * (with the candidate list) or {@link NotFoundError} — both mapped to
 * exit 5 by the `session`/`export` commands (§12.2).
 */
export async function resolveSession(selector: string, ctx: ResolveContext): Promise<Session> {
  const trimmed = selector.trim();
  if (trimmed === '') throw new NotFoundError('empty session selector');
  if (trimmed.toLowerCase() === 'latest') return resolveLatest(ctx.sessions);
  if (looksLikePath(trimmed)) {
    const abs = absolutePathOf(trimmed, ctx);
    // §4.1: a bare `*.jsonl` transcript *filename* (no separator) that names
    // no file on disk still matches scanned sessions by filename.
    const bareName = !trimmed.includes('/') && !trimmed.includes('\\') && trimmed !== '~' && trimmed !== '.' && trimmed !== '..';
    if (bareName && statOrNull(abs)?.isFile() !== true) return resolveId(trimmed, ctx.sessions);
    return readSessionAtPath(abs, ctx.roots);
  }
  // A bare token naming an existing file (e.g. `x.jsonl` without a slash is
  // caught above; this covers extension-less files) still reads as a path.
  const asFile = absolutePathOf(trimmed, ctx);
  const stat = statOrNull(asFile);
  if (stat !== null && stat.isFile()) return readSessionAtPath(asFile, ctx.roots);
  return resolveId(trimmed, ctx.sessions);
}
