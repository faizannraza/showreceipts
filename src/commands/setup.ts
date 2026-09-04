/**
 * `showreceipts setup` (S30; §9, §12.1–§12.3): installs the Stop/post-tool
 * hooks for every v1 harness found on this machine with idempotent,
 * surgical, backed-up config edits and the PATH-independent launcher.
 * Exit codes (§12.2): 0 ok · 1 unreadable/unwritable config · 2 usage ·
 * 3 manual step required (snippet printed to stderr).
 */
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { CommandContext } from '../cli/context.js';
import { HARNESSES, type Harness, type SetupResult } from '../model/types.js';
import { runSetup, type RunSetupOptions } from '../setup/index.js';
import type { SetupScope } from '../setup/plan.js';
import { stableStringify } from '../util/json.js';
import { displayPath } from '../util/paths.js';
import { CommandUsageError } from './common.js';

/** The validated `--harness` list, or `undefined` when the flag is absent. */
function harnessFilter(ctx: CommandContext): Harness[] | undefined {
  const raw = ctx.args.flags['harness'];
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  for (const h of raw) {
    if (!(HARNESSES as readonly string[]).includes(h)) {
      throw new CommandUsageError(`--harness: unknown harness '${h}' (expected ${HARNESSES.join(', ')})`, 'setup');
    }
  }
  return raw as Harness[];
}

/** One human row per result, notes and backups indented beneath it. */
function renderResult(result: SetupResult, home: string, dryRun: boolean): string[] {
  const lines = [`  ${result.harness.padEnd(12)} ${result.action.padEnd(9)} ${displayPath(result.path, home)}`];
  if (result.backup !== null) lines.push(`               backup    ${displayPath(result.backup, home)}`);
  for (const note of result.notes) lines.push(`               note      ${note}`);
  if (dryRun && result.diff !== '') lines.push(...result.diff.replace(/\n$/, '').split('\n'));
  return lines;
}

/** Runs the command; returns the exit code (§12.2). */
export async function run(ctx: CommandContext): Promise<number> {
  const flags = ctx.args.flags;
  if (flags['project'] === true && flags['shared'] === true) {
    throw new CommandUsageError('--project and --shared are mutually exclusive', 'setup');
  }
  const scope: SetupScope = flags['shared'] === true ? 'shared' : flags['project'] === true ? 'project' : 'user';
  const home = homedir();
  const opts: RunSetupOptions = {
    env: ctx.env,
    cwd: ctx.cwd,
    home,
    now: ctx.now,
    distDir: fileURLToPath(new URL('..', import.meta.url)),
    execPath: process.execPath,
    platform: process.platform,
    harnesses: harnessFilter(ctx),
    all: flags['all'] === true,
    remove: flags['remove'] === true,
    dryRun: flags['dry-run'] === true,
    strict: flags['strict'] === true,
    scope,
    restore: typeof flags['restore'] === 'string' ? flags['restore'] : undefined,
  };

  const out = runSetup(opts);

  for (const error of out.errors) ctx.stderr.write(`showreceipts setup: ${error}\n`);
  for (const snippet of out.snippets) ctx.stderr.write(`${snippet.replace(/\n$/, '')}\n`);

  if (flags['json'] === true) {
    ctx.stdout.write(`${stableStringify(out.results)}\n`);
    return out.exit;
  }

  const displayHome =
    typeof flags['home-dir'] === 'string' ? flags['home-dir'] : (ctx.env['SHOWRECEIPTS_DISPLAY_HOME'] ?? home);
  const lines: string[] = [`showreceipts setup${opts.dryRun ? ' (dry run)' : ''}${opts.remove ? ' — remove' : ''}`];
  for (const result of out.results) lines.push(...renderResult(result, displayHome, opts.dryRun));
  if (out.launcher !== null && !opts.dryRun && !opts.remove) {
    lines.push(`  launcher: ${displayPath(out.launcher, displayHome)}`);
  }
  for (const note of out.notes) {
    lines.push(`  ${note.startsWith('launcher:') ? '' : note}`.trimEnd());
  }
  ctx.stdout.write(`${lines.filter((l) => l !== '').join('\n')}\n`);
  return out.exit;
}
