/**
 * S30 — `setup/launcher.ts`: script generation (PATH filter, npm_command
 * guard, quoted absolute paths, `{}` fallback), symlink-preferring node
 * resolution and the idempotent install, without ever spawning a process
 * (S31 owns the spawned launcher test; the setup e2e suite spawns it too).
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installLauncher,
  launcherPaths,
  launcherScriptCmd,
  launcherScriptSh,
  resolveNodePath,
  shQuote,
} from '../../../src/setup/launcher.js';
import { makeTempDir } from '../../helpers/tmp.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = makeTempDir('sr-launcher-');
  dirs.push(dir);
  return dir;
}

describe('shQuote', () => {
  it('double-quotes and escapes shell-active characters', () => {
    expect(shQuote('/plain/path')).toBe('"/plain/path"');
    expect(shQuote('/home/my user/bin')).toBe('"/home/my user/bin"');
    expect(shQuote('/a/$HOME/`x`/"q"/b\\c')).toBe('"/a/\\$HOME/\\`x\\`/\\"q\\"/b\\\\c"');
  });
});

describe('launcherScriptSh (§9)', () => {
  const script = launcherScriptSh('/opt/homebrew/bin/node', '/opt/homebrew/Cellar/node/26.0.0/bin/node', '/home/u/.showreceipts/bin/0.1.0/cli.js');

  it('filters node_modules/.bin and /_npx/ PATH entries and honours npm_command=exec', () => {
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect(script).toContain('*/node_modules/.bin) continue ;;');
    expect(script).toContain('*/_npx/*) continue ;;');
    expect(script).toContain('if [ "${npm_command:-}" != "exec" ]; then');
  });

  it('never resolves showreceipts against the unfiltered PATH (no bare fallback)', () => {
    for (const line of script.split('\n')) {
      if (line.includes('showreceipts "$@"') || line.includes('command -v showreceipts')) {
        expect(line).toContain('PATH="$CLEAN_PATH"');
      }
    }
  });

  it('falls back to the quoted absolute node + cli, then to printf {}', () => {
    expect(script).toContain('exec "/opt/homebrew/bin/node" "/home/u/.showreceipts/bin/0.1.0/cli.js" "$@"');
    expect(script).toContain("printf '{}'");
    expect(script.trimEnd().endsWith('exit 0')).toBe(true);
    expect(script).toContain('# node-realpath: /opt/homebrew/Cellar/node/26.0.0/bin/node');
  });

  it('quotes a home directory with a space', () => {
    const spaced = launcherScriptSh('/usr/local/bin/node', '/usr/local/bin/node', '/home/my user/.showreceipts/bin/0.1.0/cli.js');
    expect(spaced).toContain('exec "/usr/local/bin/node" "/home/my user/.showreceipts/bin/0.1.0/cli.js" "$@"');
  });
});

describe('launcherScriptCmd', () => {
  it('carries the same logic for win32 (npm_command guard, filtered where, quoted fallback)', () => {
    const cmd = launcherScriptCmd('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\u\\.showreceipts\\bin\\0.1.0\\cli.js');
    expect(cmd).toContain('if "%npm_command%"=="exec" goto local');
    expect(cmd).toContain('node_modules\\.bin');
    expect(cmd).toContain('_npx');
    expect(cmd).toContain('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\u\\.showreceipts\\bin\\0.1.0\\cli.js" %*');
    expect(cmd).toContain('echo {}');
  });
});

describe('resolveNodePath', () => {
  it('prefers the PATH symlink over the realpath and skips shim directories', () => {
    const dir = tempDir();
    const cellarBin = join(dir, 'cellar', 'node', '26.0.0', 'bin');
    mkdirSync(cellarBin, { recursive: true });
    const realNode = join(cellarBin, 'node');
    writeFileSync(realNode, '#!/bin/sh\n');
    chmodSync(realNode, 0o755);
    const linkBin = join(dir, 'bin');
    mkdirSync(linkBin);
    symlinkSync(realNode, join(linkBin, 'node'));
    const shimBin = join(dir, 'proj', 'node_modules', '.bin');
    mkdirSync(shimBin, { recursive: true });
    writeFileSync(join(shimBin, 'node'), '#!/bin/sh\n');
    chmodSync(join(shimBin, 'node'), 0o755);

    const resolved = resolveNodePath(realNode, [shimBin, linkBin, cellarBin].join(':'));
    expect(resolved.node).toBe(join(linkBin, 'node'));
    expect(resolved.realpath).toBe(realNode);
  });

  it('falls back to execPath when PATH has no matching entry', () => {
    const dir = tempDir();
    const node = join(dir, 'node');
    writeFileSync(node, '#!/bin/sh\n');
    const resolved = resolveNodePath(node, '/nonexistent-a:/nonexistent-b');
    expect(resolved.node).toBe(node);
  });
});

describe('installLauncher', () => {
  function makeDist(dir: string): string {
    const dist = join(dir, 'dist');
    mkdirSync(join(dist, 'cost'), { recursive: true });
    writeFileSync(join(dist, 'cli.js'), 'process.stdout.write("0.1.0\\n");\n');
    writeFileSync(join(dist, 'cost', 'prices.json'), '{"version":"x"}\n');
    return dist;
  }

  it('copies dist, writes 0755 scripts and the 0600 sidecar, and is idempotent', () => {
    const dir = tempDir();
    const home = join(dir, 'sr-home');
    const dist = makeDist(dir);
    const first = installLauncher({ showreceiptsHome: home, distDir: dist, version: '0.1.0', execPath: process.execPath, envPath: process.env['PATH'], platform: 'darwin' });
    expect(first.changed).toBe(true);
    expect(first.copied).toBe(2);
    const paths = launcherPaths(home, '0.1.0');
    expect(readFileSync(paths.cli, 'utf8')).toContain('0.1.0');
    expect(statSync(paths.launcher).mode & 0o777).toBe(0o755);
    expect(statSync(paths.launcherCmd).mode & 0o777).toBe(0o755);
    expect(statSync(paths.sidecar).mode & 0o777).toBe(0o600);
    const sidecar = JSON.parse(readFileSync(paths.sidecar, 'utf8')) as Record<string, string>;
    expect(sidecar['version']).toBe('0.1.0');
    expect(sidecar['cli']).toBe(paths.cli);
    expect(sidecar['launcher']).toBe(paths.launcher);
    expect(statSync(sidecar['node'] as string).isFile()).toBe(true);

    const second = installLauncher({ showreceiptsHome: home, distDir: dist, version: '0.1.0', execPath: process.execPath, envPath: process.env['PATH'], platform: 'darwin' });
    expect(second.changed).toBe(false);
    expect(second.copied).toBe(0);
  });

  it('points the sidecar launcher at the .cmd on win32 and throws without dist/cli.js', () => {
    const dir = tempDir();
    const home = join(dir, 'sr-home');
    const dist = makeDist(dir);
    const installed = installLauncher({ showreceiptsHome: home, distDir: dist, version: '0.1.0', execPath: process.execPath, envPath: undefined, platform: 'win32' });
    const sidecar = JSON.parse(readFileSync(installed.sidecar, 'utf8')) as Record<string, string>;
    expect(sidecar['launcher']).toBe(installed.launcherCmd);
    expect(() =>
      installLauncher({ showreceiptsHome: home, distDir: join(dir, 'empty'), version: '0.1.0', execPath: process.execPath, envPath: undefined, platform: 'darwin' }),
    ).toThrow(/cli\.js/);
  });
});
