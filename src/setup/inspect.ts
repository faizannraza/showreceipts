/**
 * Read-only hook inspection (S23c; §9, §12.3): which harness config files
 * carry the showreceipts hooks, whether anything disables or competes with
 * them, and whether the installed launcher is statically resolvable.
 *
 * This module NEVER writes, never launches another process (§13.4 confines
 * process creation to `commands/report.ts`) and never repairs a config:
 * a strict-JSON file that only parses after comment stripping is reported
 * with `configReadable: false` and still inspected best-effort. `resolvable`
 * is a static check of the `~/.showreceipts/bin/launcher.json` sidecar
 * (S02 `LauncherSidecar`, written by S30): it parses, its `node`/`cli`/
 * `launcher` paths exist and the launcher file is executable. The actual
 * `--version` launcher run happens only in S31's launcher test — a recorded
 * deviation from §9 (docs/decisions.md, W4/S23c).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DoctorHookReport, Harness } from '../model/types.js';
import { readJsonFile, statOrNull } from '../util/fs.js';
import { findGitRoot } from '../util/gitroot.js';
import { isRecord } from '../util/json.js';

/** The note on every row: the check is static, never a launcher run (§9 deviation, S23c). */
export const RESOLVABLE_NOTE = 'static check; the harness process PATH may differ';

/** A hook command of ours, in any config dialect (§9). */
const MARKER_RE = /showreceipts-hook|showreceipts hook/;

/** The stop-class event per harness (§9). */
const STOP_EVENT: Readonly<Partial<Record<Harness, string>>> = {
  'claude-code': 'Stop',
  codex: 'Stop',
  cursor: 'stop',
  gemini: 'AfterAgent',
  copilot: 'agentStop',
  hermes: 'post_llm_call',
};

/** The Claude Code managed settings path for a platform (§9; overridable via {@link InspectOptions.managedPath}). */
export function managedSettingsPath(platform: string): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (platform === 'win32') return 'C:\\ProgramData\\ClaudeCode\\managed-settings.json';
  return '/etc/claude-code/managed-settings.json';
}

/** Optional root overrides (the caller resolves `CLAUDE_CONFIG_DIR`/`CODEX_HOME`, §4.1). */
export interface InspectOptions {
  claudeConfigDir?: string | undefined;
  codexHome?: string | undefined;
  showreceiptsHome?: string | undefined;
  /** The managed Claude Code settings file; default {@link managedSettingsPath} for `process.platform`. */
  managedPath?: string | undefined;
}

/** One `(event, command)` hook entry found in a config file. */
interface HookEntry {
  event: string;
  command: string;
}

/** The outcome of reading one JSON config. */
interface ReadConfig {
  exists: boolean;
  /** False when strict `JSON.parse` failed (comment-bearing or broken). */
  readable: boolean;
  value: Record<string, unknown> | null;
}

/**
 * Removes `//` and `/* … *​/` comments outside string literals — enough to
 * inspect a comment-bearing config (Gemini allows them) without ever
 * rewriting it.
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i] as string;
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Reads a JSON config; a strict-parse failure marks it unreadable but still tries the comment-stripped form. */
function readJsonConfig(path: string): ReadConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { exists: false, readable: true, value: null };
  }
  try {
    const value: unknown = JSON.parse(text);
    return { exists: true, readable: true, value: isRecord(value) ? value : null };
  } catch {
    // fall through to the comment-stripped parse
  }
  try {
    const value: unknown = JSON.parse(stripJsonComments(text));
    return { exists: true, readable: false, value: isRecord(value) ? value : null };
  } catch {
    return { exists: true, readable: false, value: null };
  }
}

/** A string field of a record, else `undefined`. */
function str(record: Record<string, unknown>, key: string): string | undefined {
  const v = record[key];
  return typeof v === 'string' ? v : undefined;
}

/** Claude Code / Gemini shape: `hooks[event] = [{matcher?, hooks: [{command}]}]`. */
function nestedEntries(config: Record<string, unknown> | null): HookEntry[] {
  const out: HookEntry[] = [];
  const hooks = config?.['hooks'];
  if (!isRecord(hooks)) return out;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group)) continue;
      const inner = group['hooks'];
      if (!Array.isArray(inner)) continue;
      for (const entry of inner) {
        if (!isRecord(entry)) continue;
        const command = str(entry, 'command');
        if (command !== undefined) out.push({ event, command });
      }
    }
  }
  return out;
}

/** Cursor shape: `hooks[event] = [{command}]`. */
function flatEntries(config: Record<string, unknown> | null): HookEntry[] {
  const out: HookEntry[] = [];
  const hooks = config?.['hooks'];
  if (!isRecord(hooks)) return out;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const command = str(entry, 'command');
      if (command !== undefined) out.push({ event, command });
    }
  }
  return out;
}

/** Copilot shape: `hooks[event] = [{bash | powershell | command}]`. */
function copilotEntries(config: Record<string, unknown> | null): HookEntry[] {
  const out: HookEntry[] = [];
  const hooks = config?.['hooks'];
  if (!isRecord(hooks)) return out;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const command = str(entry, 'bash') ?? str(entry, 'command') ?? str(entry, 'powershell');
      if (command !== undefined) out.push({ event, command });
    }
  }
  return out;
}

/** The Hermes `config.yaml` entries: a light line scan, split into managed-block and foreign entries. */
function hermesEntries(text: string): { block: HookEntry[]; foreign: HookEntry[] } {
  const block: HookEntry[] = [];
  const foreign: HookEntry[] = [];
  let inBlock = false;
  let event: string | null = null;
  const EVENT_RE = /^ {2}([A-Za-z_][\w]*):\s*$/;
  const COMMAND_RE = /^\s*(?:-\s+)?command:\s*(?:"([^"]*)"|'([^']*)'|([^\s#].*?))\s*$/;
  for (const line of text.split('\n')) {
    if (/^# >>> showreceipts >>>\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (/^# <<< showreceipts <<<\s*$/.test(line)) {
      inBlock = false;
      continue;
    }
    const eventMatch = EVENT_RE.exec(line);
    if (eventMatch !== null) {
      event = eventMatch[1] as string;
      continue;
    }
    const commandMatch = COMMAND_RE.exec(line);
    if (commandMatch !== null && event !== null) {
      const command = commandMatch[1] ?? commandMatch[2] ?? commandMatch[3] ?? '';
      (inBlock ? block : foreign).push({ event, command });
    }
  }
  return { block, foreign };
}

/**
 * The Hermes allowlist as `(event, command)` pairs, accepting either an
 * array of `{event, command}` objects or a `{event: [command…]}` record.
 * `null` when the file is missing or unusable.
 */
function hermesAllowlist(path: string): Set<string> | null {
  const raw = readJsonFile(path);
  if (raw === undefined) return null;
  const pairs = new Set<string>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isRecord(item)) continue;
      const event = str(item, 'event');
      const command = str(item, 'command');
      if (event !== undefined && command !== undefined) pairs.add(`${event}\u0000${command}`);
    }
    return pairs;
  }
  if (isRecord(raw)) {
    for (const [event, commands] of Object.entries(raw)) {
      if (!Array.isArray(commands)) continue;
      for (const command of commands) {
        if (typeof command === 'string') pairs.add(`${event}\u0000${command}`);
      }
    }
    return pairs;
  }
  return null;
}

/** Every `hooks.json` under a plugins directory, depth ≤ 4, sorted. */
function pluginHookFiles(pluginsDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      const stat = statOrNull(full);
      if (stat === null) continue;
      if (stat.isDirectory()) walk(full, depth + 1);
      else if (name === 'hooks.json') out.push(full);
    }
  };
  walk(pluginsDir, 1);
  return out;
}

/** The `*.json` files of a hooks directory, sorted; empty when the directory is absent. */
function jsonFilesIn(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/** Everything needed to assemble one {@link DoctorHookReport} row. */
interface RowInputs {
  harness: Harness;
  scope: DoctorHookReport['scope'];
  configPath: string;
  entries: HookEntry[];
  stopEvent: string;
  configReadable: boolean;
  disabled: boolean;
  trusted: DoctorHookReport['trusted'];
  trustNote?: string | undefined;
}

/** Builds a row; `resolvable` is filled in afterwards from the sidecar check. */
function buildRow(inputs: RowInputs): DoctorHookReport {
  const ours = inputs.entries.filter((e) => MARKER_RE.test(e.command));
  const installed = ours.length > 0;
  const row: DoctorHookReport = {
    harness: inputs.harness,
    scope: inputs.scope,
    configPath: inputs.configPath,
    installed,
    command: ours[0]?.command ?? null,
    resolvable: null,
    resolvableNote: RESOLVABLE_NOTE,
    disabled: inputs.disabled,
    otherStopHooks: inputs.entries.filter((e) => e.event === inputs.stopEvent && !MARKER_RE.test(e.command)).map((e) => e.command),
    strict: ours.some((e) => e.command.includes('--strict')),
    trusted: inputs.trusted,
  };
  if (inputs.trustNote !== undefined) row.trustNote = inputs.trustNote;
  if (!inputs.configReadable) row.configReadable = false;
  return row;
}

/** The result of the static launcher-sidecar check (§9 deviation: no spawn, ever). */
export interface SidecarCheck {
  resolvable: boolean;
  sidecarPath: string;
  /** One line per problem found (empty when resolvable). */
  problems: string[];
}

/**
 * Statically checks `<showreceiptsHome>/bin/launcher.json` (S02
 * `LauncherSidecar`, written by S30): it parses, `node`/`cli`/`launcher`
 * name existing files, and the launcher is executable. Never spawns.
 */
export function checkLauncherSidecar(showreceiptsHome: string): SidecarCheck {
  const sidecarPath = join(showreceiptsHome, 'bin', 'launcher.json');
  const problems: string[] = [];
  const raw = readJsonFile(sidecarPath);
  if (raw === undefined) {
    return { resolvable: false, sidecarPath, problems: ['launcher.json missing or unreadable'] };
  }
  if (!isRecord(raw) || typeof raw['node'] !== 'string' || typeof raw['cli'] !== 'string' || typeof raw['launcher'] !== 'string') {
    return { resolvable: false, sidecarPath, problems: ['launcher.json malformed (node/cli/launcher required)'] };
  }
  const paths = { node: raw['node'], cli: raw['cli'], launcher: raw['launcher'] };
  for (const key of ['node', 'cli'] as const) {
    const stat = statOrNull(paths[key]);
    if (stat === null || !stat.isFile()) problems.push(`${key} path does not exist: ${paths[key]}`);
  }
  const launcherStat = statOrNull(paths.launcher);
  if (launcherStat === null || !launcherStat.isFile()) {
    problems.push(`launcher does not exist: ${paths.launcher}`);
  } else if ((launcherStat.mode & 0o111) === 0) {
    problems.push(`launcher is not executable: ${paths.launcher}`);
  }
  return { resolvable: problems.length === 0, sidecarPath, problems };
}

/**
 * Inspects every harness hook config reachable from `home` and `cwd`
 * (§12.3 `doctor --json.hooks`): user scope always yields a row per harness;
 * project/local/managed/plugin rows appear only for files that exist. The
 * project base is `findGitRoot(cwd) ?? cwd`. Rows for installed hooks carry
 * the static sidecar `resolvable`; uninstalled rows carry `null`.
 */
export function inspectHooks(home: string, cwd: string, opts: InspectOptions = {}): DoctorHookReport[] {
  const claudeDir = opts.claudeConfigDir ?? join(home, '.claude');
  const codexHome = opts.codexHome ?? join(home, '.codex');
  const showreceiptsHome = opts.showreceiptsHome ?? join(home, '.showreceipts');
  const managedPath = opts.managedPath ?? managedSettingsPath(process.platform);
  const projectRoot = findGitRoot(cwd) ?? cwd;
  const rows: DoctorHookReport[] = [];

  // --- Claude Code (+ dsh, which shares its files, §9) ----------------------
  const claudeConfigs: { scope: DoctorHookReport['scope']; path: string; always: boolean }[] = [
    { scope: 'user', path: join(claudeDir, 'settings.json'), always: true },
    { scope: 'project', path: join(projectRoot, '.claude', 'settings.json'), always: false },
    { scope: 'local', path: join(projectRoot, '.claude', 'settings.local.json'), always: false },
    { scope: 'managed', path: managedPath, always: false },
  ];
  const dshRows: DoctorHookReport[] = [];
  for (const { scope, path, always } of claudeConfigs) {
    const config = readJsonConfig(path);
    if (!config.exists && !always) continue;
    const entries = nestedEntries(config.value);
    const disabled = config.value?.['disableAllHooks'] === true;
    rows.push(
      buildRow({
        harness: 'claude-code',
        scope,
        configPath: path,
        entries,
        stopEvent: STOP_EVENT['claude-code'] as string,
        configReadable: config.readable,
        disabled,
        trusted: true,
      }),
    );
    const dshEntries = entries.filter((e) => (e.event === 'PostToolUse' || e.event === 'PostToolUseFailure') && MARKER_RE.test(e.command));
    if (dshEntries.length > 0) {
      dshRows.push(
        buildRow({
          harness: 'dsh',
          scope,
          configPath: path,
          entries: dshEntries,
          stopEvent: 'PostToolUse',
          configReadable: config.readable,
          disabled,
          trusted: true,
        }),
      );
      // dsh shares the Claude Code file: its record hooks are not "other stop hooks".
      const dshRow = dshRows[dshRows.length - 1] as DoctorHookReport;
      dshRow.otherStopHooks = [];
    }
  }
  for (const path of pluginHookFiles(join(claudeDir, 'plugins'))) {
    const config = readJsonConfig(path);
    rows.push(
      buildRow({
        harness: 'claude-code',
        scope: 'plugin',
        configPath: path,
        entries: nestedEntries(config.value),
        stopEvent: STOP_EVENT['claude-code'] as string,
        configReadable: config.readable,
        disabled: config.value?.['disableAllHooks'] === true,
        trusted: true,
      }),
    );
  }
  rows.push(...dshRows);

  // --- Codex ----------------------------------------------------------------
  const codexTrustNote = 'trust is keyed to the hook hash; run /hooks inside codex to check';
  for (const { scope, path, always } of [
    { scope: 'user' as const, path: join(codexHome, 'hooks.json'), always: true },
    { scope: 'project' as const, path: join(projectRoot, '.codex', 'hooks.json'), always: false },
  ]) {
    const config = readJsonConfig(path);
    if (!config.exists && !always) continue;
    rows.push(
      buildRow({
        harness: 'codex',
        scope,
        configPath: path,
        entries: nestedEntries(config.value),
        stopEvent: STOP_EVENT['codex'] as string,
        configReadable: config.readable,
        disabled: false,
        trusted: 'unknown',
        trustNote: codexTrustNote,
      }),
    );
  }

  // --- Cursor ---------------------------------------------------------------
  for (const { scope, path, always } of [
    { scope: 'user' as const, path: join(home, '.cursor', 'hooks.json'), always: true },
    { scope: 'project' as const, path: join(projectRoot, '.cursor', 'hooks.json'), always: false },
  ]) {
    const config = readJsonConfig(path);
    if (!config.exists && !always) continue;
    rows.push(
      buildRow({
        harness: 'cursor',
        scope,
        configPath: path,
        entries: flatEntries(config.value),
        stopEvent: STOP_EVENT['cursor'] as string,
        configReadable: config.readable,
        disabled: false,
        trusted: true,
      }),
    );
  }

  // --- Gemini (comments are legal in its settings; still flagged readable:false when strict parse fails) ---
  for (const { scope, path, always } of [
    { scope: 'user' as const, path: join(home, '.gemini', 'settings.json'), always: true },
    { scope: 'project' as const, path: join(projectRoot, '.gemini', 'settings.json'), always: false },
  ]) {
    const config = readJsonConfig(path);
    if (!config.exists && !always) continue;
    rows.push(
      buildRow({
        harness: 'gemini',
        scope,
        configPath: path,
        entries: nestedEntries(config.value),
        stopEvent: STOP_EVENT['gemini'] as string,
        configReadable: config.readable,
        disabled: false,
        trusted: true,
      }),
    );
  }

  // --- Copilot (own file per producer; scan every *.json in the hooks dirs) --
  const copilotUserFiles = jsonFilesIn(join(home, '.copilot', 'hooks'));
  const copilotFiles: { scope: DoctorHookReport['scope']; path: string }[] = [
    ...copilotUserFiles.map((path) => ({ scope: 'user' as const, path })),
    ...jsonFilesIn(join(projectRoot, '.github', 'hooks')).map((path) => ({ scope: 'project' as const, path })),
  ];
  if (copilotUserFiles.length === 0) {
    copilotFiles.unshift({ scope: 'user', path: join(home, '.copilot', 'hooks', 'showreceipts.json') });
  }
  for (const { scope, path } of copilotFiles) {
    const config = readJsonConfig(path);
    rows.push(
      buildRow({
        harness: 'copilot',
        scope,
        configPath: path,
        entries: copilotEntries(config.value),
        stopEvent: STOP_EVENT['copilot'] as string,
        configReadable: config.readable,
        disabled: false,
        trusted: true,
      }),
    );
  }

  // --- Hermes (managed YAML block + shell-hooks allowlist, §9/§12.3) --------
  {
    const path = join(home, '.hermes', 'config.yaml');
    let text: string | null = null;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      text = null;
    }
    const { block, foreign } = text === null ? { block: [], foreign: [] } : hermesEntries(text);
    const entries = [...block, ...foreign];
    const ours = entries.filter((e) => MARKER_RE.test(e.command));
    let trusted: DoctorHookReport['trusted'] = true;
    let trustNote: string | undefined;
    if (ours.length > 0) {
      const allowlist = hermesAllowlist(join(home, '.hermes', 'shell-hooks-allowlist.json'));
      trusted = allowlist !== null && ours.every((e) => allowlist.has(`${e.event}\u0000${e.command}`));
      if (!trusted) trustNote = 'not every (event, command) pair is in shell-hooks-allowlist.json';
    }
    rows.push(
      buildRow({
        harness: 'hermes',
        scope: 'user',
        configPath: path,
        entries,
        stopEvent: STOP_EVENT['hermes'] as string,
        configReadable: true,
        disabled: false,
        trusted,
        trustNote,
      }),
    );
  }

  // --- Static launcher resolvability for every installed row ----------------
  const sidecar = checkLauncherSidecar(showreceiptsHome);
  for (const row of rows) {
    if (row.installed) row.resolvable = sidecar.resolvable;
  }
  return rows;
}
