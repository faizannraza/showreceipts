/**
 * Pure path-string helpers (§4.6.1): canonicalisation, display forms and the
 * write-scope classifier. This module never imports `node:fs` or `node:os` —
 * every root (home, temp dirs, repo roots) is injected, so the ledger and the
 * readers stay deterministic and platform semantics are always POSIX.
 */
import { posix } from 'node:path';
import { displayWidth, truncateToWidth } from './width.js';

/** Where a write landed (§4.6.1). Mirrors `WriteFact['scope']` — `util` sits below `model`, so the union is spelled here and a test asserts both agree. */
export type WriteScope = 'repo' | 'worktree' | 'other-repo' | 'scratch' | 'harness-config' | 'home-dotfile' | 'system' | 'unknown';

const PRIVATE_PREFIX_RE = /^\/private\/(tmp|var|etc)(?=\/|$)/;
const DRIVE_RE = /^[A-Za-z]:\//;

/** Default temp roots; the pipeline adds `os.tmpdir()` and `%TEMP%`. */
export const DEFAULT_TMP_ROOTS: readonly string[] = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];

/** Directories under `home` that hold harness configuration and state. */
export const HARNESS_CONFIG_DIRNAMES: readonly string[] = [
  '.claude',
  '.codex',
  '.cursor',
  '.gemini',
  '.copilot',
  '.hermes',
  '.showreceipts',
];

/** Top-level system directories. */
const SYSTEM_ROOTS: readonly string[] = ['/etc', '/usr', '/Library', '/System', '/bin', '/sbin', '/opt'];

/** Converts backslashes to slashes (`C:\Users\u` → `C:/Users/u`). */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Collapses `//`, resolves `.`/`..`, strips a trailing slash (except on `/`) and folds `/private/{tmp,var,etc}`. */
function normalizePosix(p: string): string {
  if (p === '') return '';
  let out = posix.normalize(p);
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out.replace(PRIVATE_PREFIX_RE, '/$1');
}

export interface CanonOptions {
  /** The home directory a leading `~` expands to (already canonical or not — it is normalised too). */
  home: string;
}

/**
 * The canonical form of a logged path (§4.6.1): POSIX separators,
 * `path.posix.normalize`, `//` collapsed, trailing `/` stripped, a leading
 * `~` expanded with the injected home, and `^/private/(tmp|var|etc)`
 * folded to `/$1`. Relative paths stay relative (see `resolveAgainst`).
 */
export function canon(p: string, options: CanonOptions): string {
  let path = toPosix(p.trim());
  if (path === '~' || path.startsWith('~/')) {
    const home = normalizePosix(toPosix(options.home));
    path = path === '~' ? home : `${home}/${path.slice(2)}`;
  }
  return normalizePosix(path);
}

/** `~`-prefixed form of an absolute path under `homeDir`; other paths unchanged. */
export function displayPath(abs: string, homeDir: string): string {
  const home = normalizePosix(toPosix(homeDir));
  const path = toPosix(abs);
  if (home === '' || home === '/') return path;
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** The last path segment (POSIX semantics; a trailing slash is ignored). */
export function basename(p: string): string {
  return posix.basename(toPosix(p));
}

/** The extension including the dot (`.ts`), or `''`. */
export function extname(p: string): string {
  return posix.extname(toPosix(p));
}

/**
 * Middle-truncates a path to `max` columns keeping the basename intact: the
 * directory head is cut by display width (not on a segment boundary) and an
 * ellipsis marks the cut, so `/Users/u/projects/foo/src/x.ts` at 20 becomes
 * `/Users/u/proje…/x.ts`. When even the basename does not fit, it is cut from
 * the left to at least `minBase` columns (so the result may exceed `max` for
 * a very long basename).
 */
export function middleTruncate(path: string, max: number, minBase = 12): string {
  if (displayWidth(path) <= max) return path;
  const slash = path.lastIndexOf('/');
  const base = slash === -1 ? path : path.slice(slash + 1);
  const dir = slash === -1 ? '' : path.slice(0, slash);
  const tail = `…/${base}`;
  const tailWidth = displayWidth(tail);
  if (dir === '' || tailWidth >= max) {
    const keep = Math.max(minBase, max - 1);
    return leftTruncate(base, keep);
  }
  const headBudget = max - tailWidth;
  const head = headBudget > 0 ? truncateToWidth(dir, headBudget, '') : '';
  return `${head.replace(/\/$/, '')}${tail}`;
}

/** Keeps the last `keep` columns of `s` behind an ellipsis (cluster-safe via `truncateToWidth` on the reversed cut). */
function leftTruncate(s: string, keep: number): string {
  if (displayWidth(s) <= keep) return s;
  const chars = Array.from(s);
  let width = 0;
  let start = chars.length;
  while (start > 0) {
    const w = displayWidth(chars[start - 1] as string);
    if (width + w > keep) break;
    width += w;
    start -= 1;
  }
  return `…${chars.slice(start).join('')}`;
}

/** True when `child` equals `parent` or lies below it (both canonical). */
export function isUnder(child: string, parent: string): boolean {
  if (parent === '') return false;
  if (child === parent) return true;
  const prefix = parent.endsWith('/') ? parent : `${parent}/`;
  return child.startsWith(prefix);
}

/** True when `p` lies under one of `tmpRoots` (roots are normalised, so `/private/tmp` and `/tmp` match alike). */
export function isTmpPath(p: string, tmpRoots: readonly string[] = DEFAULT_TMP_ROOTS): boolean {
  const path = normalizePosix(toPosix(p));
  return tmpRoots.some((root) => isUnder(path, normalizePosix(toPosix(root))));
}

export interface ScopeContext {
  /** The tool call's working directory (relative `canonPath`s resolve against it). */
  cwd: string;
  /** The session's repository root, or `null` when the cwd is not inside a repository. */
  repoRoot: string | null;
  home: string;
  tmpRoots?: readonly string[];
  /** Harness config directories (default: the seven `~/.<harness>` dirs). */
  harnessConfigDirs?: readonly string[];
  /** The repository root found by walking up from the written path, when it differs from `repoRoot`. */
  otherRepoRoot?: string | null;
}

/**
 * Classifies where a write landed (§4.6.1), in order: `repo`, `worktree`
 * (`<repoRoot>/.claude/worktrees/<id>/…`), `other-repo`, `scratch`,
 * `harness-config`, `home-dotfile`, `system`, `unknown`.
 */
export function classifyScope(canonPath: string, ctx: ScopeContext): WriteScope {
  const path = resolveAgainst(ctx.cwd, canonPath);
  const home = normalizePosix(toPosix(ctx.home));
  if (ctx.repoRoot !== null && ctx.repoRoot !== '') {
    const root = normalizePosix(toPosix(ctx.repoRoot));
    if (isUnder(path, root)) {
      const worktrees = `${root}/.claude/worktrees/`;
      return path.startsWith(worktrees) && path.length > worktrees.length ? 'worktree' : 'repo';
    }
  }
  if (ctx.otherRepoRoot !== undefined && ctx.otherRepoRoot !== null && ctx.otherRepoRoot !== '') {
    const other = normalizePosix(toPosix(ctx.otherRepoRoot));
    if (other !== ctx.repoRoot && isUnder(path, other)) return 'other-repo';
  }
  if (isTmpPath(path, ctx.tmpRoots ?? DEFAULT_TMP_ROOTS)) return 'scratch';
  const configDirs = ctx.harnessConfigDirs ?? HARNESS_CONFIG_DIRNAMES.map((name) => `${home}/${name}`);
  if (configDirs.some((dir) => isUnder(path, normalizePosix(toPosix(dir))))) return 'harness-config';
  if (home !== '' && home !== '/' && isUnder(path, home)) {
    const rest = path.slice(home.length + 1);
    if (rest.startsWith('.')) return 'home-dotfile';
  }
  if (SYSTEM_ROOTS.some((root) => isUnder(path, root))) return 'system';
  return 'unknown';
}

/** True for `/…`, `~`, `~/…` and `C:/…` (already POSIX-separated). */
function isAbsoluteLike(p: string): boolean {
  return p.startsWith('/') || p === '~' || p.startsWith('~/') || DRIVE_RE.test(p);
}

/**
 * Resolves `p` against `cwd` when it is relative; absolute, `~`-prefixed and
 * drive-letter paths are returned normalised. The result is canonical in the
 * `canon` sense except for `~` expansion, which needs a home.
 */
export function resolveAgainst(cwd: string, p: string): string {
  const path = toPosix(p.trim());
  if (path === '') return normalizePosix(toPosix(cwd));
  if (isAbsoluteLike(path)) return normalizePosix(path);
  return normalizePosix(posix.join(toPosix(cwd), path));
}
