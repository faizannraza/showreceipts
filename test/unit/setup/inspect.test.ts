/**
 * S23c — read-only hook inspection (`src/setup/inspect.ts`) over the
 * synthetic `fixtures/inspect/**` tree: installed/not installed per harness,
 * foreign Stop hooks, `disableAllHooks`, comment-bearing JSON, Hermes trust,
 * and the static launcher-sidecar `resolvable` check.
 */
import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { DoctorHookReport, Harness } from '../../../src/model/types.js';
import {
  checkLauncherSidecar,
  inspectHooks,
  managedSettingsPath,
  RESOLVABLE_NOTE,
  stripJsonComments,
} from '../../../src/setup/inspect.js';
import { makeTempDir } from '../../helpers/tmp.js';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/inspect/', import.meta.url));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = makeTempDir('showreceipts-inspect-');
  dirs.push(dir);
  return dir;
}

function copyDir(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else copyFileSync(from, to);
  }
}

/** Copies a fixture case into a temp root, resolves `__ROOT__` and marks the launcher executable. */
function materialize(name: string): string {
  const root = tempDir();
  copyDir(join(FIXTURES, name), root);
  const fix = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        fix(full);
      } else if (entry.name === 'launcher.json') {
        writeFileSync(full, readFileSync(full, 'utf8').replaceAll('__ROOT__', root));
      } else if (entry.name === 'showreceipts-hook') {
        chmodSync(full, 0o755);
      }
    }
  };
  fix(root);
  return root;
}

function rowOf(rows: DoctorHookReport[], harness: Harness, scope?: DoctorHookReport['scope']): DoctorHookReport {
  const row = rows.find((r) => r.harness === harness && (scope === undefined || r.scope === scope));
  if (row === undefined) throw new Error(`no ${harness}${scope === undefined ? '' : `/${scope}`} row`);
  return row;
}

describe('installed everywhere', () => {
  it('finds every harness installed, resolvable and untampered', () => {
    const root = materialize('installed');
    const rows = inspectHooks(join(root, 'home'), tempDir());

    for (const harness of ['claude-code', 'codex', 'cursor', 'gemini', 'copilot', 'hermes'] as const) {
      const row = rowOf(rows, harness, harness === 'copilot' || harness === 'hermes' || harness === 'claude-code' ? undefined : 'user');
      expect(row.installed, harness).toBe(true);
      expect(row.command, harness).toContain('showreceipts-hook');
      expect(row.resolvable, harness).toBe(true);
      expect(row.resolvableNote, harness).toBe(RESOLVABLE_NOTE);
      expect(row.disabled, harness).toBe(false);
      expect(row.otherStopHooks, harness).toEqual([]);
      expect(row.strict, harness).toBe(false);
      expect(row.configReadable, harness).toBeUndefined();
    }
    expect(rowOf(rows, 'claude-code', 'user').command).toContain('hook claude-code Stop');
    expect(rowOf(rows, 'codex').trusted).toBe('unknown');
    expect(rowOf(rows, 'codex').trustNote).toBeDefined();
    expect(rowOf(rows, 'hermes').trusted).toBe(true);
    expect(rowOf(rows, 'copilot').configPath.endsWith('showreceipts.json')).toBe(true);
    // the foreign plugin hooks.json yields a plugin row that is not ours
    const plugin = rowOf(rows, 'claude-code', 'plugin');
    expect(plugin.configPath.endsWith('hooks.json')).toBe(true);
    expect(plugin.installed).toBe(false);
    expect(plugin.resolvable).toBeNull();
    // determinism
    expect(inspectHooks(join(root, 'home'), tempDir())).toEqual(rows.map((r) => ({ ...r })));
  });
});

describe('nothing installed', () => {
  it('emits one user row per harness with installed:false and resolvable:null', () => {
    const root = materialize('none');
    const rows = inspectHooks(join(root, 'home'), tempDir());
    for (const harness of ['claude-code', 'codex', 'cursor', 'gemini', 'copilot', 'hermes'] as const) {
      const row = rowOf(rows, harness);
      expect(row.scope, harness).toBe('user');
      expect(row.installed, harness).toBe(false);
      expect(row.command, harness).toBeNull();
      expect(row.resolvable, harness).toBeNull();
      expect(row.resolvableNote, harness).toBe(RESOLVABLE_NOTE);
    }
    expect(rows.some((r) => r.harness === 'dsh')).toBe(false);
  });
});

describe('foreign hooks and disableAllHooks', () => {
  it('reports the foreign Stop hooks and the disabled flag without claiming installation', () => {
    const root = materialize('foreign');
    const rows = inspectHooks(join(root, 'home'), tempDir());
    const claude = rowOf(rows, 'claude-code', 'user');
    expect(claude.installed).toBe(false);
    expect(claude.disabled).toBe(true);
    expect(claude.otherStopHooks).toEqual(['/home/u/bin/session-logger.sh --on-stop']);
    const cursor = rowOf(rows, 'cursor', 'user');
    expect(cursor.otherStopHooks).toEqual(['/home/u/bin/cursor-notify --done']);
    expect(cursor.installed).toBe(false);
  });
});

describe('comment-bearing JSON', () => {
  it('flags configReadable:false and still detects our hooks best-effort', () => {
    const root = materialize('comments');
    const rows = inspectHooks(join(root, 'home'), tempDir());
    const claude = rowOf(rows, 'claude-code', 'user');
    expect(claude.configReadable).toBe(false);
    expect(claude.installed).toBe(true);
    const gemini = rowOf(rows, 'gemini', 'user');
    expect(gemini.configReadable).toBe(false);
    expect(gemini.installed).toBe(true);
  });

  it('stripJsonComments never touches string contents', () => {
    const text = '{"a": "http://x//y", "b": /* gone */ 1 // tail\n}';
    expect(JSON.parse(stripJsonComments(text))).toEqual({ a: 'http://x//y', b: 1 });
    expect(stripJsonComments('{"s": "a \\" // not a comment"}')).toBe('{"s": "a \\" // not a comment"}');
  });
});

describe('strict and dsh detection', () => {
  it('reads --strict off our command', () => {
    const root = materialize('strict');
    const rows = inspectHooks(join(root, 'home'), tempDir());
    expect(rowOf(rows, 'claude-code', 'user').strict).toBe(true);
  });

  it('emits a dsh row when PostToolUse showreceipts entries exist in the Claude Code file', () => {
    const root = materialize('dsh');
    const rows = inspectHooks(join(root, 'home'), tempDir());
    const dsh = rowOf(rows, 'dsh');
    expect(dsh.installed).toBe(true);
    expect(dsh.command).toContain('hook claude-code PostToolUse');
    expect(dsh.otherStopHooks).toEqual([]);
    expect(rowOf(rows, 'claude-code', 'user').installed).toBe(true);
  });
});

describe('Hermes trust', () => {
  it('is trusted when every (event, command) pair is allow-listed and false otherwise', () => {
    const trusted = inspectHooks(join(materialize('installed'), 'home'), tempDir());
    expect(rowOf(trusted, 'hermes').trusted).toBe(true);
    const untrusted = inspectHooks(join(materialize('hermes-untrusted'), 'home'), tempDir());
    const row = rowOf(untrusted, 'hermes');
    expect(row.installed).toBe(true);
    expect(row.trusted).toBe(false);
    expect(row.trustNote).toContain('allowlist');
  });
});

describe('the static launcher-sidecar check', () => {
  it('resolvable:true only when the sidecar parses, paths exist and the launcher is executable', () => {
    const home = join(materialize('installed'), 'home');
    expect(checkLauncherSidecar(join(home, '.showreceipts'))).toMatchObject({ resolvable: true, problems: [] });
  });

  it('a stale sidecar makes every installed row resolvable:false', () => {
    const home = join(materialize('sidecar-stale'), 'home');
    const rows = inspectHooks(home, tempDir());
    expect(rowOf(rows, 'claude-code', 'user').installed).toBe(true);
    expect(rowOf(rows, 'claude-code', 'user').resolvable).toBe(false);
    const check = checkLauncherSidecar(join(home, '.showreceipts'));
    expect(check.resolvable).toBe(false);
    expect(check.problems).toHaveLength(3);
  });

  it('a non-executable launcher fails the check', () => {
    const home = join(materialize('installed'), 'home');
    chmodSync(join(home, '.showreceipts', 'bin', 'showreceipts-hook'), 0o644);
    const check = checkLauncherSidecar(join(home, '.showreceipts'));
    expect(check.resolvable).toBe(false);
    expect(check.problems.join(' ')).toContain('not executable');
    expect(rowOf(inspectHooks(home, tempDir()), 'claude-code', 'user').resolvable).toBe(false);
  });

  it('a missing or malformed sidecar fails with a note', () => {
    const empty = tempDir();
    expect(checkLauncherSidecar(empty)).toEqual({
      resolvable: false,
      sidecarPath: join(empty, 'bin', 'launcher.json'),
      problems: ['launcher.json missing or unreadable'],
    });
    mkdirSync(join(empty, 'bin'), { recursive: true });
    writeFileSync(join(empty, 'bin', 'launcher.json'), '{"node": 1}');
    expect(checkLauncherSidecar(empty).problems).toEqual(['launcher.json malformed (node/cli/launcher required)']);
  });
});

describe('project scopes', () => {
  it('finds project, local and .github configs under the cwd', () => {
    const root = materialize('project');
    const home = tempDir();
    const rows = inspectHooks(home, join(root, 'proj'));
    expect(rowOf(rows, 'claude-code', 'project').installed).toBe(true);
    expect(rowOf(rows, 'claude-code', 'local').installed).toBe(true);
    expect(rowOf(rows, 'codex', 'project').installed).toBe(true);
    expect(rowOf(rows, 'cursor', 'project').installed).toBe(true);
    expect(rowOf(rows, 'gemini', 'project').installed).toBe(true);
    const copilot = rowOf(rows, 'copilot', 'project');
    expect(copilot.installed).toBe(true);
    expect(copilot.configPath).toContain('.github');
  });

  it('resolves the project base through the git root from a nested cwd', () => {
    const repo = tempDir();
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    copyDir(join(FIXTURES, 'project', 'proj', '.claude'), join(repo, '.claude'));
    const rows = inspectHooks(tempDir(), join(repo, 'src', 'deep'));
    expect(rowOf(rows, 'claude-code', 'project').configPath).toBe(join(repo, '.claude', 'settings.json'));
  });
});

describe('the managed path', () => {
  it('is inspected when the file exists and defaults per platform', () => {
    const managed = join(tempDir(), 'managed-settings.json');
    writeFileSync(
      managed,
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: '"/home/u/.showreceipts/bin/showreceipts-hook" hook claude-code Stop' }] }] },
      }),
    );
    const rows = inspectHooks(join(materialize('none'), 'home'), tempDir(), { managedPath: managed });
    const row = rowOf(rows, 'claude-code', 'managed');
    expect(row.installed).toBe(true);
    expect(row.configPath).toBe(managed);
    expect(managedSettingsPath('darwin')).toBe('/Library/Application Support/ClaudeCode/managed-settings.json');
    expect(managedSettingsPath('win32')).toContain('ProgramData');
    expect(managedSettingsPath('linux')).toBe('/etc/claude-code/managed-settings.json');
  });
});

describe('read-only guarantees', () => {
  it('the module never writes and never spawns', () => {
    const source = readFileSync(new URL('../../../src/setup/inspect.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/child_process|execSync|spawnSync|execFileSync|spawn\(/);
    expect(source).not.toMatch(/writeFileSync|appendFileSync|renameSync|unlinkSync|mkdirSync|chmodSync|rmSync|cpSync/);
  });

  it('inspection leaves the configs byte-identical', () => {
    const root = materialize('installed');
    const path = join(root, 'home', '.claude', 'settings.json');
    const before = readFileSync(path, 'utf8');
    inspectHooks(join(root, 'home'), tempDir());
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});
