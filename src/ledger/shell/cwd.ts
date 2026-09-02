/**
 * Working-directory tracking inside one command line (§4.5.3). The
 * left-to-right walk itself is driven by the segment builder (`segments.ts`),
 * which structurally guarantees that `cd` inside `$(…)`, backticks, quotes or
 * heredocs never reaches this module and that `(…)` subshells walk a cloned
 * state. Resolving `baseCwd` per tool call is the readers' job (S06/S08/S09)
 * — this module only applies `cd`-like segments to a running directory.
 */
import { canon, resolveAgainst } from '../../util/paths.js';

/** The running directory while walking a command's segments. */
export interface CwdState {
  /** The directory the next segment runs in (absolute, canonical). */
  dir: string;
  /** The injected home `~` expands to (fixtures use `/home/u`). */
  home: string;
  /** False once a `cd` could not be tracked (`cd -`, pushd/popd, unknown variable). */
  resolved: boolean;
}

/** A fresh state rooted at `cwd`. */
export function initialCwd(cwd: string, home: string): CwdState {
  return { dir: canon(cwd, { home }), home, resolved: true };
}

/** An independent copy for a scope (`(…)` subshell, `bash -c` body, `$(…)`). */
export function cloneCwd(state: CwdState): CwdState {
  return { dir: state.dir, home: state.home, resolved: state.resolved };
}

/**
 * Applies one `cd` to the running state. `target` is the already
 * variable-substituted argument (`null` for a bare `cd`, which goes home);
 * `targetResolved:false` (unknown variable, glob, substitution) and `cd -`
 * poison the walk (`resolved:false`, directory kept as the best guess).
 */
export function applyCd(target: string | null, targetResolved: boolean, state: CwdState): void {
  if (target === null) {
    state.dir = state.home;
    return;
  }
  if (target === '-' || !targetResolved) {
    state.resolved = false;
    return;
  }
  if (target === '~' || target.startsWith('~/')) {
    state.dir = canon(target, { home: state.home });
    return;
  }
  state.dir = resolveAgainst(state.dir, target);
}

/** `pushd`/`popd` are not tracked: they poison the walk (§4.5.3). */
export function isUntrackedDirOp(program: string): boolean {
  return program === 'pushd' || program === 'popd';
}
