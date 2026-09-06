/**
 * `setup` orchestration (S30; §9, §12): launcher install, per-harness
 * writers, the `state/setup.json` createdHooksKey ledger, `--remove [--all]`
 * and `--restore <backup>`. `commands/setup.ts` is a thin argv adapter over
 * {@link runSetup}.
 */
import fs from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { resolveRoots } from '../discover/roots.js';
import { HARNESSES, type Harness, type SetupResult } from '../model/types.js';
import { atomicWriteFile, ensureDir, readJsonFile, statOrNull } from '../util/fs.js';
import { findGitRoot } from '../util/gitroot.js';
import { isRecord, stableStringify } from '../util/json.js';
import { TOOL_VERSION } from '../version.js';
import { restoreBackup, writeBackup } from './backups.js';
import { unifiedDiff } from './diff.js';
import { installLauncher, launcherPaths } from './launcher.js';
import { configTarget, detectHarnesses, type SetupScope, type TargetInputs, type WriterContext, type WriterOutcome } from './plan.js';
import { apply as applyClaudeCode } from './writers/claude-code.js';
import { apply as applyCodex } from './writers/codex.js';
import { apply as applyCopilot } from './writers/copilot.js';
import { apply as applyCursor } from './writers/cursor.js';
import { apply as applyDsh } from './writers/dsh.js';
import { apply as applyGemini } from './writers/gemini.js';
import { apply as applyHermes } from './writers/hermes.js';
import { apply as applyOpenclaw } from './writers/openclaw.js';
import { apply as applyOpencode } from './writers/opencode.js';

const WRITERS: Readonly<Record<Harness, (ctx: WriterContext) => WriterOutcome>> = {
  'claude-code': applyClaudeCode,
  codex: applyCodex,
  cursor: applyCursor,
  gemini: applyGemini,
  copilot: applyCopilot,
  hermes: applyHermes,
  dsh: applyDsh,
  opencode: applyOpencode,
  openclaw: applyOpenclaw,
};

/** Everything `runSetup` needs; the command layer resolves argv and process facts. */
export interface RunSetupOptions {
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  /** The user home (`os.homedir()`), used for roots and default config dirs. */
  home: string;
  now: Date;
  /** The running install's `dist/` directory (the launcher copies it). */
  distDir: string;
  execPath: string;
  platform: string;
  /** Explicit `--harness` list; `undefined` = auto-detect. */
  harnesses: Harness[] | undefined;
  all: boolean;
  remove: boolean;
  dryRun: boolean;
  strict: boolean;
  scope: SetupScope;
  restore: string | undefined;
}

/** The full outcome: rows, exit code, stdout notes, stderr snippets/errors. */
export interface RunSetupOutcome {
  results: SetupResult[];
  exit: number;
  /** Human notes printed after the rows (launcher line, hints). */
  notes: string[];
  /** Manual snippets printed to stderr (exit-3 outcomes). */
  snippets: string[];
  /** Failure lines printed to stderr (exit-1 outcomes). */
  errors: string[];
  /** The launcher path referenced by the emitted configs (null once removed). */
  launcher: string | null;
}

/** Worse-of for §12.2 setup exit codes: 1 (failure) > 3 (manual) > 0. */
function worse(a: number, b: number): number {
  if (a === 1 || b === 1) return 1;
  if (a === 3 || b === 3) return 3;
  return 0;
}

/** Dedupes and orders harnesses by the canonical `HARNESSES` order. */
function orderHarnesses(list: readonly Harness[]): Harness[] {
  const set = new Set(list);
  return HARNESSES.filter((h) => set.has(h));
}

/** The persisted slice of `<home>/state/setup.json` (S30 owns the writes). */
interface SetupStateData {
  createdHooksKey: Partial<Record<string, boolean>>;
}

/** Tolerant read — a missing or malformed file is a fresh state. */
function readSetupState(showreceiptsHome: string): SetupStateData {
  const raw = readJsonFile(join(showreceiptsHome, 'state', 'setup.json'));
  const out: SetupStateData = { createdHooksKey: {} };
  if (isRecord(raw) && isRecord(raw['createdHooksKey'])) {
    for (const [harness, value] of Object.entries(raw['createdHooksKey'])) {
      if (typeof value === 'boolean') out.createdHooksKey[harness] = value;
    }
  }
  return out;
}

/** Atomic 0600 write under 0700 directories (§13.2). */
function writeSetupState(showreceiptsHome: string, state: SetupStateData): void {
  ensureDir(showreceiptsHome, 0o700);
  ensureDir(join(showreceiptsHome, 'state'), 0o700);
  atomicWriteFile(join(showreceiptsHome, 'state', 'setup.json'), `${stableStringify(state)}\n`, { mode: 0o600 });
}

function failOutcome(message: string): RunSetupOutcome {
  return { results: [], exit: 1, notes: [], snippets: [], errors: [message], launcher: null };
}

/** `--restore <backup>`: explicit, surgical copy-back of one backup (§9). */
function runRestore(opts: RunSetupOptions, inputs: TargetInputs, launcherPrimary: string): RunSetupOutcome {
  const backupPath = resolve(opts.cwd, opts.restore as string);
  const harness = basename(dirname(backupPath)) as Harness;
  if (!HARNESSES.includes(harness)) {
    return failOutcome(`--restore: expected a path under ~/.showreceipts/backups/<harness>/ (got ${opts.restore ?? ''})`);
  }
  const name = basename(backupPath);
  const m = /^(.+)\.(\d+)$/.exec(name);
  if (m === null) {
    return failOutcome(`--restore: not a backup file name (<basename>.<unix-ms>): ${name}`);
  }
  let data: Buffer;
  try {
    data = fs.readFileSync(backupPath);
  } catch {
    return failOutcome(`--restore: cannot read ${backupPath}`);
  }
  const target = configTarget(harness, opts.scope, inputs);
  if (basename(target.path) !== (m[1] as string)) {
    return failOutcome(`--restore: backup ${name} does not match the ${harness} ${target.scope} config ${target.path}`);
  }
  let originalText: string | null = null;
  try {
    originalText = fs.readFileSync(target.path, 'utf8');
  } catch {
    originalText = null;
  }
  try {
    if (!opts.dryRun) restoreBackup(backupPath, target.path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return failOutcome(`--restore: cannot write ${target.path} (${code ?? String(err)})`);
  }
  const result: SetupResult = {
    harness,
    path: target.path,
    scope: target.scope,
    action: opts.dryRun ? 'dry-run' : 'updated',
    backup: backupPath,
    launcher: launcherPrimary,
    diff: unifiedDiff(originalText ?? '', data.toString('utf8'), target.path),
    notes: [`restored from ${backupPath}`],
  };
  return { results: [result], exit: 0, notes: [], snippets: [], errors: [], launcher: launcherPrimary };
}

/**
 * Runs `setup` end to end. Order of operations: `--restore` short-circuits;
 * otherwise the launcher is installed first (never under `--dry-run` or
 * `--remove`), then each harness writer runs in canonical order, then the
 * createdHooksKey state is persisted and (only under `--remove --all`) the
 * launcher directory is deleted.
 */
export function runSetup(opts: RunSetupOptions): RunSetupOutcome {
  const roots = resolveRoots(opts.env, opts.home);
  const showreceiptsHome = roots.showreceiptsHome;
  const projectRoot = findGitRoot(opts.cwd) ?? opts.cwd;
  const inputs: TargetInputs = {
    home: opts.home,
    claudeConfigDir: roots.claudeConfigDir,
    codexHome: roots.codexHome,
    projectRoot,
  };
  const paths = launcherPaths(showreceiptsHome, TOOL_VERSION);
  const launcherPrimary = opts.platform === 'win32' ? paths.launcherCmd : paths.launcher;

  if (opts.restore !== undefined) return runRestore(opts, inputs, launcherPrimary);

  const list = orderHarnesses(opts.harnesses ?? detectHarnesses(inputs));
  const notes: string[] = [];
  const snippets: string[] = [];
  const errors: string[] = [];
  if (list.length === 0) {
    return {
      results: [],
      exit: 0,
      notes: [
        'no harnesses found on this machine (looked for ~/.claude, ~/.codex, ~/.cursor, ~/.gemini, ~/.copilot, ~/.hermes) — pass --harness to set one up anyway (dsh, opencode and openclaw are always opt-in)',
      ],
      snippets,
      errors,
      launcher: null,
    };
  }

  if (!opts.dryRun && !opts.remove) {
    const installed = installLauncher({
      showreceiptsHome,
      distDir: opts.distDir,
      version: TOOL_VERSION,
      execPath: opts.execPath,
      envPath: opts.env['PATH'],
      platform: opts.platform,
    });
    notes.push(`launcher: ${installed.launcher}${installed.changed ? '' : ' (unchanged)'}`);
  }

  const state = readSetupState(showreceiptsHome);
  let stateDirty = false;
  const results: SetupResult[] = [];
  let exit = 0;
  for (const harness of list) {
    const target = configTarget(harness, opts.scope, inputs);
    const ctx: WriterContext = {
      harness,
      target,
      launcherPath: launcherPrimary,
      launcherCmdPath: paths.launcherCmd,
      strict: opts.strict,
      remove: opts.remove,
      dryRun: opts.dryRun,
      nowMs: opts.now.getTime(),
      home: opts.home,
      showreceiptsHome,
      codexHome: roots.codexHome,
      createdHooksKey: state.createdHooksKey[harness] === true,
      backup: (originalText) => writeBackup(showreceiptsHome, harness, target.path, originalText, opts.now.getTime()),
    };
    const outcome = WRITERS[harness](ctx);
    results.push(outcome.result);
    exit = worse(exit, outcome.exit);
    if (outcome.snippet !== undefined) snippets.push(outcome.snippet);
    if (outcome.error !== undefined) errors.push(outcome.error);
    if (!opts.dryRun && outcome.createdHooksKey !== undefined && state.createdHooksKey[harness] !== outcome.createdHooksKey) {
      state.createdHooksKey[harness] = outcome.createdHooksKey;
      stateDirty = true;
    }
  }
  if (stateDirty) writeSetupState(showreceiptsHome, state);

  let launcher: string | null = launcherPrimary;
  if (opts.remove) {
    if (opts.all && !opts.dryRun) {
      fs.rmSync(paths.binDir, { recursive: true, force: true });
      notes.push('launcher removed (~/.showreceipts/bin)');
      launcher = null;
    } else {
      notes.push('launcher left in place — remove it too with `showreceipts setup --remove --all`');
    }
  } else if (results.some((r) => r.action === 'installed' || r.action === 'updated' || r.action === 'dry-run')) {
    notes.push('add `.showreceipts/` to your .gitignore — receipts land there inside git repos');
    notes.push('tip: `npm i -g showreceipts` removes the npx startup overhead; the launcher prefers a real global install automatically');
  }
  if (opts.dryRun && statOrNull(paths.launcher) === null && statOrNull(paths.launcherCmd) === null) {
    notes.push('dry run: nothing was written (the launcher is not installed yet either)');
  }
  return { results, exit, notes, snippets, errors, launcher };
}
