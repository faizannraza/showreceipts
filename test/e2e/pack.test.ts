/**
 * S26 e2e — pack-install smoke (§15 pack-smoke): `npm pack` into a temp
 * directory, assert the tarball's file list (not just exit codes), install
 * it globally into a temp `--prefix` offline, then run the installed CLI
 * from an empty cwd with the netguard back on: `demo --ascii --no-color`,
 * `doctor --json` (exit 0) and `--version`.
 *
 * Only the npm processes run without the guard (`test/helpers/pack.ts`
 * strips `NODE_OPTIONS` for them alone).
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOOL_VERSION } from '../../src/version.js';
import { installGlobal, packTarball, runInstalled, type InstalledCli } from '../helpers/pack.js';
import { loadSchemaDoc, validateAgainst } from '../helpers/schema.js';
import { makeTempDir } from '../helpers/tmp.js';

const doc = loadSchemaDoc();
const NPM_BUDGET_MS = 240_000;

/** Top-level entries the tarball may contain (§15 / scripts/size.mjs). */
const ALLOWED_TOP_LEVEL = ['bin/', 'dist/', 'README.md', 'LICENSE', 'package.json'];

const tree = makeTempDir('showreceipts-e2e-pack-');
const emptyCwd = join(tree, 'empty-cwd');
const home = join(tree, 'home');
for (const dir of [emptyCwd, home]) mkdirSync(dir, { recursive: true });

/** Empty roots for the installed runs: nothing on disk, nothing writable but the temp home. */
const ENV: Record<string, string> = {
  HOME: home,
  USERPROFILE: home,
  CLAUDE_CONFIG_DIR: join(tree, 'no-claude'),
  CODEX_HOME: join(tree, 'no-codex'),
  SHOWRECEIPTS_HOME: join(tree, 'sr'),
};

afterAll(() => {
  rmSync(tree, { recursive: true, force: true });
});

describe('npm pack (file lists, not just exit codes)', () => {
  const packed = packTarball();

  it('ships the bundled assets: prices, report template, demo scenarios', () => {
    expect(packed.files).toContain('dist/cost/prices.json');
    expect(packed.files).toContain('dist/render/report.js');
    expect(packed.files).toContain('dist/demo/scenarios.js');
    expect(packed.files).toContain('dist/cli.js');
    expect(packed.files).toContain('bin/showreceipts.js');
    for (const name of ['package.json', 'README.md', 'LICENSE']) expect(packed.files).toContain(name);
  });

  it('contains nothing outside bin/ dist/ README.md LICENSE package.json', () => {
    const outside = packed.files.filter((p) => !ALLOWED_TOP_LEVEL.some((ok) => (ok.endsWith('/') ? p.startsWith(ok) : p === ok)));
    expect(outside).toEqual([]);
  });

  it('contains no build artefacts or tests', () => {
    const stray = packed.files.filter((p) => p.endsWith('.map') || p.endsWith('.d.ts') || p.startsWith('test/'));
    expect(stray).toEqual([]);
  });
});

describe('global install and installed runs (offline, guard back on)', () => {
  let cli: InstalledCli;

  // Install once in beforeAll so a failure surfaces as this hook's error and
  // the dependent tests are skipped instead of crashing on an unset `cli`.
  beforeAll(() => {
    cli = installGlobal(packTarball().tgzPath);
  }, NPM_BUDGET_MS);

  it('installs globally into a temp prefix with --offline --ignore-scripts', () => {
    expect(cli.entryPath.endsWith(join('bin', 'showreceipts.js'))).toBe(true);
    if (process.platform !== 'win32') expect(cli.binPath).not.toBeNull();
  });

  it('showreceipts demo --ascii --no-color renders from an empty cwd', () => {
    const r = runInstalled(cli.entryPath, ['demo', '--ascii', '--no-color'], { env: ENV, cwd: emptyCwd });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('+--');
    expect(r.stdout).not.toContain('┌');
    expect(r.stdout).toContain('RECEIPT');
  });

  it('showreceipts doctor --json exits 0 and validates against the schema', () => {
    const r = runInstalled(cli.entryPath, ['doctor', '--json'], { env: ENV, cwd: emptyCwd });
    expect(r.code, r.stderr).toBe(0);
    expect(validateAgainst(doc, 'doctor', JSON.parse(r.stdout))).toEqual([]);
  });

  it('showreceipts --version prints the tool version', () => {
    const r = runInstalled(cli.entryPath, ['--version'], { env: ENV, cwd: emptyCwd });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${TOOL_VERSION}\n`);
  });

  it('the bin launcher works too (POSIX)', () => {
    if (cli.binPath === null) return; // windows layout: covered via entryPath
    const r = runInstalled(cli.binPath, ['--version'], { env: ENV, cwd: emptyCwd });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${TOOL_VERSION}\n`);
  });
});
