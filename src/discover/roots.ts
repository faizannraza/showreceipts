/**
 * Config roots (ARCHITECTURE §4.1): environment override → default under the
 * injected home → `fs.realpathSync` once. This module never reads
 * `process.env` — the caller (the CLI context) hands the environment in, so
 * discovery stays testable and deterministic. Absent roots are normal: their
 * realpath is `null` and enumeration simply finds nothing there.
 */
import fs from 'node:fs';
import { join } from 'node:path';
import type { Roots } from '../model/types.js';

/** The environment shape `resolveRoots` accepts (a plain record, never `process.env` directly from here). */
export type EnvLike = Readonly<Record<string, string | undefined>>;

/** A non-empty env value, or `undefined` (empty and whitespace-only values fall back to the default). */
function envPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** `fs.realpathSync` or `null` when the path does not exist or cannot resolve. */
function realpathOrNull(path: string): string | null {
  try {
    return fs.realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Resolves the four config roots (§4.1): `CLAUDE_CONFIG_DIR` → `~/.claude`,
 * `CODEX_HOME` → `~/.codex`, `SHOWRECEIPTS_HOME` → `~/.showreceipts`, plus
 * the injected user home itself. Each root is realpath-resolved exactly once
 * (symlinked homes); a root that does not exist keeps its configured spelling
 * in the named field and gets `null` in `realpaths`.
 */
export function resolveRoots(env: EnvLike, homedir: string): Roots {
  const userHome = homedir;
  const claudeConfigDir = envPath(env['CLAUDE_CONFIG_DIR']) ?? join(homedir, '.claude');
  const codexHome = envPath(env['CODEX_HOME']) ?? join(homedir, '.codex');
  const showreceiptsHome = envPath(env['SHOWRECEIPTS_HOME']) ?? join(homedir, '.showreceipts');
  return {
    userHome,
    claudeConfigDir,
    codexHome,
    showreceiptsHome,
    realpaths: {
      userHome: realpathOrNull(userHome),
      claudeConfigDir: realpathOrNull(claudeConfigDir),
      codexHome: realpathOrNull(codexHome),
      showreceiptsHome: realpathOrNull(showreceiptsHome),
    },
  };
}

/** The realpath of a named root, or `null` when the root is absent. */
export function rootRealpath(roots: Roots, name: 'userHome' | 'claudeConfigDir' | 'codexHome' | 'showreceiptsHome'): string | null {
  return roots.realpaths[name] ?? null;
}
