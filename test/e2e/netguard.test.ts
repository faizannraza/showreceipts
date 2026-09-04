/**
 * S26 e2e — the runtime no-network guard (§13.4): a spawned child armed
 * exactly like every CLI child fails the moment it calls `fetch` — proving
 * the guard is active in this suite — while every command runs to success
 * under the same guard over the fixture tree.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { pinnedEnv } from '../helpers/env.js';
import { materializeAll } from '../helpers/fixtures.js';
import { NETGUARD_PATH, runCli } from '../helpers/spawn.js';
import { makeTempDir } from '../helpers/tmp.js';

const tree = makeTempDir('showreceipts-e2e-netguard-');
const materialized = materializeAll(tree);
const home = join(tree, 'home');
const cwd = join(tree, 'cwd');
const outDir = join(tree, 'out');
for (const dir of [home, cwd, outDir, join(tree, 'sr')]) mkdirSync(dir, { recursive: true });

const ENV: Record<string, string> = {
  HOME: home,
  USERPROFILE: home,
  CLAUDE_CONFIG_DIR: materialized.claudeConfigDir,
  CODEX_HOME: materialized.codexHome,
  SHOWRECEIPTS_HOME: join(tree, 'sr'),
};

afterAll(() => {
  rmSync(tree, { recursive: true, force: true });
});

const COMMON = ['--since', '2026-01-01', '--width', '80', '--no-color', '--unicode', '--tz', 'utc', '--home-dir', '/home/u'];

describe('the guard is active for spawned children', () => {
  it('a child that calls fetch fails with the netguard message', () => {
    const result = spawnSync(process.execPath, ['-e', "fetch('http://127.0.0.1:9/')"], {
      env: { ...pinnedEnv(), NODE_OPTIONS: `--require "${NETGUARD_PATH}"` },
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('network blocked by netguard');
  });

  it('a child that touches node:net fails the same way', () => {
    const result = spawnSync(process.execPath, ['-e', "require('node:net').connect(9, '127.0.0.1')"], {
      env: { ...pinnedEnv(), NODE_OPTIONS: `--require "${NETGUARD_PATH}"` },
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('network blocked by netguard');
  });
});

describe('every command runs to success under the guard (§13.4)', () => {
  const cases: [string, string[]][] = [
    ['--version', ['--version']],
    ['audit', ['audit', ...COMMON]],
    ['session latest', ['session', 'latest', ...COMMON]],
    ['export latest --json', ['export', 'latest', '--json', ...COMMON]],
    ['report', ['report', '--all', '--home-dir', '/home/u', '--no-color', '--out', join(outDir, 'guard.html')]],
    ['demo', ['demo', '--ascii', '--no-color']],
    ['bench --json', ['bench', '--since', '2026-01-01', '--json', '--home-dir', '/home/u']],
    ['doctor --json', ['doctor', '--json', '--home-dir', '/home/u']],
  ];
  for (const [label, args] of cases) {
    it(`${label} exits 0 with the guard armed`, () => {
      const r = runCli(args, { env: ENV, cwd });
      expect(r.code, `${label}: ${r.stderr}`).toBe(0);
    });
  }
});
