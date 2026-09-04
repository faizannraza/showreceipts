/**
 * S30 e2e — the installed launcher on disk: valid POSIX sh (`sh -n`), runs
 * `--version` from a home directory with a space, never resolves an npm exec
 * shim (`npm_command=exec` + `node_modules/.bin` on PATH), prefers a real
 * global install, and a re-run after a simulated global install is
 * `unchanged`.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SetupResult } from '../../src/model/types.js';
import { runCli } from '../helpers/spawn.js';
import { makeTempDir } from '../helpers/tmp.js';

interface Home {
  root: string;
  home: string;
  sr: string;
  launcher: string;
  env: Record<string, string>;
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A HOME whose path contains a space (§9: quoted launcher paths must work). */
function makeHome(): Home {
  const root = makeTempDir('sr-setup-launcher-');
  roots.push(root);
  const home = join(root, 'home with space');
  mkdirSync(home, { recursive: true });
  const sr = join(home, '.showreceipts');
  return {
    root,
    home,
    sr,
    launcher: join(sr, 'bin', 'showreceipts-hook'),
    env: {
      HOME: home,
      USERPROFILE: home,
      SHOWRECEIPTS_HOME: sr,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CODEX_HOME: join(home, '.codex'),
    },
  };
}

function installed(h: Home): void {
  const r = runCli(['setup', '--harness', 'claude-code'], { env: h.env, cwd: h.root });
  expect(r.code).toBe(0);
}

function runLauncher(h: Home, env: Record<string, string>): { stdout: string; status: number | null } {
  const r = spawnSync(h.launcher, ['--version'], { encoding: 'utf8', env, timeout: 30_000 });
  return { stdout: r.stdout, status: r.status };
}

describe('setup — launcher (§9, home dir with a space)', () => {
  it('is executable, passes sh -n, and runs --version via the absolute node fallback', () => {
    const h = makeHome();
    installed(h);
    expect(statSync(h.launcher).mode & 0o777).toBe(0o755);
    expect(existsSync(join(h.sr, 'bin', '0.1.0', 'cli.js'))).toBe(true);
    const syntax = spawnSync('/bin/sh', ['-n', h.launcher], { encoding: 'utf8' });
    expect(syntax.status).toBe(0);
    // npm_command=exec + a bare PATH: the global lookup is skipped and the
    // quoted "<node>" "<cli>" fallback must resolve despite the space.
    const r = runLauncher(h, { PATH: '/usr/bin:/bin', npm_command: 'exec' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('0.1.0\n');
  });

  it('never resolves an npm exec shim: PATH filter drops node_modules/.bin and /_npx/', () => {
    const h = makeHome();
    installed(h);
    const shimDir = join(h.root, 'proj', 'node_modules', '.bin');
    mkdirSync(shimDir, { recursive: true });
    const shim = join(shimDir, 'showreceipts');
    writeFileSync(shim, '#!/bin/sh\necho SHIM\nexit 42\n');
    chmodSync(shim, 0o755);
    const npxDir = join(h.root, '.npm', '_npx', 'abc123', 'node_modules', '.bin');
    mkdirSync(npxDir, { recursive: true });
    writeFileSync(join(npxDir, 'showreceipts'), '#!/bin/sh\necho NPX\nexit 42\n');
    chmodSync(join(npxDir, 'showreceipts'), 0o755);

    // With npm_command=exec AND the shims on PATH.
    const underExec = runLauncher(h, { PATH: `${shimDir}:${npxDir}:/usr/bin:/bin`, npm_command: 'exec' });
    expect(underExec.stdout).toBe('0.1.0\n');
    // Without npm_command the shim directories are still filtered out.
    const plain = runLauncher(h, { PATH: `${shimDir}:${npxDir}:/usr/bin:/bin` });
    expect(plain.stdout).toBe('0.1.0\n');

    // The generated script: PATH filter present, no bare showreceipts fallback.
    const script = readFileSync(h.launcher, 'utf8');
    expect(script).toContain('*/node_modules/.bin) continue ;;');
    expect(script).toContain('*/_npx/*) continue ;;');
    expect(script).toContain('if [ "${npm_command:-}" != "exec" ]; then');
    for (const line of script.split('\n')) {
      if (line.includes('showreceipts "$@"') || line.includes('command -v showreceipts')) {
        expect(line).toContain('PATH="$CLEAN_PATH"');
      }
    }
  });

  it('prefers a real global install, and re-running setup after one is unchanged', () => {
    const h = makeHome();
    installed(h);
    const globalBin = join(h.root, 'global-bin');
    mkdirSync(globalBin, { recursive: true });
    const globalCli = join(globalBin, 'showreceipts');
    writeFileSync(globalCli, '#!/bin/sh\necho GLOBAL\nexit 0\n');
    chmodSync(globalCli, 0o755);

    const viaGlobal = runLauncher(h, { PATH: `${globalBin}:/usr/bin:/bin` });
    expect(viaGlobal.stdout).toBe('GLOBAL\n');

    const rerun = runCli(['setup', '--harness', 'claude-code', '--json'], {
      env: { ...h.env, PATH: `${globalBin}:${process.env['PATH'] ?? ''}` },
      cwd: h.root,
    });
    expect(rerun.code).toBe(0);
    expect((JSON.parse(rerun.stdout) as SetupResult[])[0]?.action).toBe('unchanged');
  });

  it('every emitted config references the launcher by quoted absolute path', () => {
    const h = makeHome();
    const r = runCli(['setup', '--harness', 'claude-code,codex,cursor,gemini,copilot,hermes', '--json'], {
      env: h.env,
      cwd: h.root,
    });
    expect(r.code).toBe(0);
    const results = JSON.parse(r.stdout) as SetupResult[];
    expect(results).toHaveLength(6);
    for (const result of results) {
      const text = readFileSync(result.path, 'utf8');
      // Double-quoted absolute path: JSON-escaped in *.json, raw in YAML.
      const quoted = text.includes(`\\"${h.launcher}\\"`) || text.includes(`"${h.launcher}"`);
      expect(quoted, `${result.harness}: launcher not quoted in ${result.path}`).toBe(true);
      // Never a bare `showreceipts …` command string (§9).
      expect(text).not.toMatch(/[":']showreceipts /);
    }
  });
});
