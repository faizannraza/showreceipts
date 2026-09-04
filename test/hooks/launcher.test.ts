/**
 * S31 — the installed launcher, actually executed (§9: the one test that
 * runs `showreceipts-hook --version`): (a) no global install falls back to
 * the absolute node + copied cli.js, (b) a real global `showreceipts` on
 * PATH is exec'd, (c) a PATH holding only an npm shim (`node_modules/.bin`)
 * is ignored, (d) a node path with a space survives the quoting.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TOOL_VERSION } from '../../src/version.js';
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

function makeHome(): Home {
  const root = makeTempDir('sr-hook-launcher-');
  roots.push(root);
  const home = join(root, 'home');
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

/** Installs the launcher (setup for one harness is enough). */
function install(h: Home, extraEnv: Record<string, string> = {}): void {
  const r = runCli(['setup', '--harness', 'claude-code'], { env: { ...h.env, ...extraEnv }, cwd: h.root });
  expect(r.code).toBe(0);
}

function runLauncher(h: Home, env: Record<string, string>): { stdout: string; status: number | null } {
  const r = spawnSync(h.launcher, ['--version'], { encoding: 'utf8', env, timeout: 30_000 });
  return { stdout: r.stdout, status: r.status };
}

/** An executable `showreceipts` shell script that prints `marker`. */
function fakeGlobal(dir: string, marker: string): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'showreceipts');
  writeFileSync(path, `#!/bin/sh\necho ${marker}\nexit 0\n`);
  chmodSync(path, 0o755);
}

describe('the generated launcher, executed (§9)', () => {
  it('(a) no global install: falls back to the absolute node + cli.js and prints the version', () => {
    const h = makeHome();
    install(h);
    const r = runLauncher(h, { PATH: '/usr/bin:/bin' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${TOOL_VERSION}\n`);
  });

  it('(b) a real global showreceipts on PATH is exec-ed', () => {
    const h = makeHome();
    install(h);
    const globalBin = join(h.root, 'global-bin');
    fakeGlobal(globalBin, 'GLOBAL-MARKER');
    const r = runLauncher(h, { PATH: `${globalBin}:/usr/bin:/bin` });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('GLOBAL-MARKER\n');
  });

  it('(c) a PATH containing only a node_modules/.bin shim is ignored — the fallback answers', () => {
    const h = makeHome();
    install(h);
    const shimDir = join(h.root, 'proj', 'node_modules', '.bin');
    fakeGlobal(shimDir, 'SHIM-MARKER');
    const r = runLauncher(h, { PATH: shimDir });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${TOOL_VERSION}\n`);
  });

  it('(d) a node path with a space is recorded, quoted and executed', () => {
    const h = makeHome();
    const binDir = join(h.root, 'bin dir');
    mkdirSync(binDir, { recursive: true });
    symlinkSync(process.execPath, join(binDir, 'node'));
    install(h, { PATH: `${binDir}:/usr/bin:/bin` });

    const sidecar = JSON.parse(readFileSync(join(h.sr, 'bin', 'launcher.json'), 'utf8')) as { node: string };
    expect(sidecar.node).toBe(join(binDir, 'node'));
    expect(sidecar.node).toContain(' ');
    expect(readFileSync(h.launcher, 'utf8')).toContain(`"${binDir}/node"`);

    const r = runLauncher(h, { PATH: '/usr/bin:/bin' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${TOOL_VERSION}\n`);
  });
});
