/**
 * Path construction for everything the hook runtime writes (§9): ledger
 * files, per-session state files and the last-receipt directory. Every
 * user-influenced component passes `safeSid` (S02 `util/ids.ts`) and every
 * final path is `path.join`ed and asserted to resolve inside its base
 * directory — a failed assertion throws {@link HookPathError}, which the
 * runtime treats as `{}` plus a `hook.log` line, never a crash.
 *
 * Repository-root discovery reuses S23c `util/gitroot.ts` — the single
 * implementation; there is no second walk-up here.
 */
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Harness } from '../model/types.js';
import { lstatOrNull } from '../util/fs.js';
import { findGitRoot } from '../util/gitroot.js';
import { sha256 } from '../util/hash.js';
import { safeSid } from '../util/ids.js';

export { safeSid } from '../util/ids.js';

/** A constructed path escaped its base directory (hostile sid or cwd). */
export class HookPathError extends Error {
  override readonly name = 'HookPathError';
}

/**
 * Asserts that `path` resolves strictly inside `base` (never the base
 * itself, never a sibling, never above); returns `path`. The check is
 * `path.relative`-based, so `..` segments, absolute escapes and prefix
 * tricks (`/base-evil`) all throw.
 */
export function assertInside(base: string, path: string): string {
  const rel = relative(resolve(base), resolve(path));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new HookPathError(`path escapes its base directory: ${path} is not inside ${base}`);
  }
  return path;
}

/**
 * The synthetic session id used when stdin carries none (§9):
 * `'unknown-' + sha256(cwd + ':' + t.slice(0, 13)).slice(0, 16)` — stable
 * for one cwd within one clock hour, so retries land in the same ledger.
 */
export function unknownSid(cwd: string, t: string): string {
  return `unknown-${sha256(`${cwd}:${t.slice(0, 13)}`).slice(0, 16)}`;
}

/**
 * `<home>/ledger/<harness>/<safeSid>.jsonl` (Appendix C). `sid` may be raw —
 * `safeSid` is applied here again (idempotent for already-safe ids) as
 * defence in depth — and the result is asserted inside the harness's ledger
 * directory.
 */
export function ledgerPath(home: string, harness: Harness, sid: string): string {
  const base = join(home, 'ledger', harness);
  return assertInside(base, join(base, `${safeSid(sid)}.jsonl`));
}

/**
 * `<home>/state/<harness>/<safeSid>.json` — the per-session strict-mode
 * state file (S27 `state.ts`). Same `safeSid` + assertion discipline as
 * {@link ledgerPath}.
 */
export function statePath(home: string, harness: Harness, sid: string): string {
  const base = join(home, 'state', harness);
  return assertInside(base, join(base, `${safeSid(sid)}.json`));
}

/**
 * Where `last-receipt.{md,json}` land (§9): `<gitRoot>/.showreceipts/` when
 * `cwd` is inside a git repository or worktree (a `.git` directory or
 * `gitdir:` file, per S23c `util/gitroot.ts`), else
 * `<home>/last/<harness>/`. The sid parameter is kept for signature parity
 * with the other path builders; the location is per-repo / per-harness.
 */
export function lastReceiptDir(cwd: string, home: string, harness: Harness, _sid: string): string {
  const root = findGitRoot(cwd);
  if (root !== null) {
    const dir = join(root, '.showreceipts');
    // SECURITY.md: a cloned repository can ship `.showreceipts` as a symlink
    // (git checks out symlinks by default), redirecting receipt writes to any
    // directory its author names. `assertInside` is lexical and cannot see
    // that, so require the entry to be a real directory (or absent — it will
    // be created); anything else falls back to the home location.
    const stat = lstatOrNull(dir);
    if (stat === null || stat.isDirectory()) return assertInside(root, dir);
  }
  const base = join(home, 'last');
  return assertInside(base, join(base, harness));
}
