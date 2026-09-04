/**
 * Shared setup planning (S30; §9, §12.1): scopes, per-harness target config
 * paths, harness auto-detection (config directory present), the hook command
 * string (always the double-quoted absolute launcher path — never a bare
 * `showreceipts`) and the writer contract every `setup/writers/*.ts` module
 * implements.
 */
import { join } from 'node:path';
import type { Harness, SetupResult } from '../model/types.js';
import { statOrNull } from '../util/fs.js';

/** Where a config lands (§12.1 `--project` / `--shared`). */
export type SetupScope = 'user' | 'project' | 'shared';

/** A resolved config target: the file to edit plus scope-derived notes. */
export interface SetupTarget {
  path: string;
  scope: SetupScope;
  notes: string[];
}

/** Everything path resolution needs (roots come from `discover/roots.ts`). */
export interface TargetInputs {
  home: string;
  claudeConfigDir: string;
  codexHome: string;
  /** `findGitRoot(cwd) ?? cwd`. */
  projectRoot: string;
}

/** The warning attached to every non-user-scope config (§9: embeds an absolute path). */
export const ABS_PATH_WARNING =
  "this config embeds an absolute path to this machine's launcher — teammates each run `showreceipts setup` themselves";

/** Harnesses `setup` auto-detects by config directory; dsh/opencode/openclaw stay opt-in (§9). */
export const AUTO_HARNESSES: readonly Harness[] = ['claude-code', 'codex', 'cursor', 'gemini', 'copilot', 'hermes'];

/** The harnesses found on this machine (config directory present). */
export function detectHarnesses(i: TargetInputs): Harness[] {
  const isDir = (p: string): boolean => {
    const stat = statOrNull(p);
    return stat !== null && stat.isDirectory();
  };
  const found: Harness[] = [];
  if (isDir(i.claudeConfigDir)) found.push('claude-code');
  if (isDir(i.codexHome)) found.push('codex');
  if (isDir(join(i.home, '.cursor'))) found.push('cursor');
  if (isDir(join(i.home, '.gemini'))) found.push('gemini');
  if (isDir(join(i.home, '.copilot'))) found.push('copilot');
  if (isDir(join(i.home, '.hermes'))) found.push('hermes');
  return found;
}

/**
 * The config file `setup` edits for one harness and scope (§9 table, column
 * "Config written by setup"). Hermes and the roadmap plugin harnesses have
 * no project-level config: they always resolve to the user scope (with a
 * note when a project scope was requested).
 */
export function configTarget(harness: Harness, scope: SetupScope, i: TargetInputs): SetupTarget {
  const warn = scope === 'user' ? [] : [ABS_PATH_WARNING];
  switch (harness) {
    case 'claude-code':
    case 'dsh':
      if (scope === 'project') return { path: join(i.projectRoot, '.claude', 'settings.local.json'), scope, notes: warn };
      if (scope === 'shared') return { path: join(i.projectRoot, '.claude', 'settings.json'), scope, notes: warn };
      return { path: join(i.claudeConfigDir, 'settings.json'), scope, notes: [] };
    case 'codex':
      if (scope !== 'user') return { path: join(i.projectRoot, '.codex', 'hooks.json'), scope, notes: warn };
      return { path: join(i.codexHome, 'hooks.json'), scope, notes: [] };
    case 'cursor':
      if (scope !== 'user') return { path: join(i.projectRoot, '.cursor', 'hooks.json'), scope, notes: warn };
      return { path: join(i.home, '.cursor', 'hooks.json'), scope, notes: [] };
    case 'gemini':
      if (scope !== 'user') return { path: join(i.projectRoot, '.gemini', 'settings.json'), scope, notes: warn };
      return { path: join(i.home, '.gemini', 'settings.json'), scope, notes: [] };
    case 'copilot':
      if (scope !== 'user') return { path: join(i.projectRoot, '.github', 'hooks', 'showreceipts.json'), scope, notes: warn };
      return { path: join(i.home, '.copilot', 'hooks', 'showreceipts.json'), scope, notes: [] };
    case 'hermes':
      return {
        path: join(i.home, '.hermes', 'config.yaml'),
        scope: 'user',
        notes: scope === 'user' ? [] : ['Hermes has no project-level config; the user-level file was written instead'],
      };
    case 'opencode':
      return {
        path: join(i.home, '.config', 'opencode', 'plugins', 'showreceipts.ts'),
        scope: 'user',
        notes: scope === 'user' ? [] : ['OpenCode plugins are user-level; the user-level plugin was written instead'],
      };
    case 'openclaw':
      return {
        path: join(i.home, '.config', 'openclaw', 'plugins', 'showreceipts.mjs'),
        scope: 'user',
        notes: scope === 'user' ? [] : ['the OpenClaw plugin is user-level; the user-level plugin was written instead'],
      };
  }
}

/**
 * The hook command string (§9): the launcher's absolute path, double-quoted
 * so paths with spaces survive every harness's shell/`shlex` split, then
 * `hook <dialect> <event>` (+ ` --strict`). `setup` never emits a bare
 * `showreceipts …` command (§9 "Launcher").
 */
export function hookCommand(launcherPath: string, dialect: string, event: string, strict = false): string {
  return `"${launcherPath}" hook ${dialect} ${event}${strict ? ' --strict' : ''}`;
}

/** Everything one harness writer needs for one `setup` invocation. */
export interface WriterContext {
  harness: Harness;
  target: SetupTarget;
  /** Absolute launcher path referenced by emitted configs (`.cmd` on win32). */
  launcherPath: string;
  /** Absolute `.cmd` sibling (Codex `commandWindows`, Copilot `powershell`). */
  launcherCmdPath: string;
  strict: boolean;
  remove: boolean;
  dryRun: boolean;
  nowMs: number;
  home: string;
  showreceiptsHome: string;
  codexHome: string;
  /** `state/setup.json.createdHooksKey[harness]` — we created the `hooks` key. */
  createdHooksKey: boolean;
  /** Backs up the original config text; returns the backup path (never called under `--dry-run`). */
  backup: (originalText: string) => string;
}

/** What one writer did (or refused to do). */
export interface WriterOutcome {
  result: SetupResult;
  /** 0 ok · 1 unreadable/unwritable · 3 manual step required (§12.2). */
  exit: 0 | 1 | 3;
  /** New value for `createdHooksKey[harness]`; `undefined` leaves the state alone. */
  createdHooksKey?: boolean | undefined;
  /** Manual snippet printed to stderr on exit-3 outcomes. */
  snippet?: string | undefined;
  /** Failure line printed to stderr on exit-1 outcomes. */
  error?: string | undefined;
}

/** Assembles the §12.3 `SetupResult` row for a writer outcome. */
export function makeResult(
  ctx: WriterContext,
  action: SetupResult['action'],
  extra: { backup?: string | null; diff?: string; notes?: string[] } = {},
): SetupResult {
  return {
    harness: ctx.harness,
    path: ctx.target.path,
    scope: ctx.target.scope,
    action,
    backup: extra.backup ?? null,
    launcher: ctx.launcherPath,
    diff: extra.diff ?? '',
    notes: [...ctx.target.notes, ...(extra.notes ?? [])],
  };
}
