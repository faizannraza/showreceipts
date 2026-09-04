/**
 * S26 e2e — `node dist/cli.js export` over the materialised fixture tree:
 * the Markdown snapshot, `--json` against the schema, `--out`, and the
 * `--hash-paths` privacy assertions (no raw home path survives; §11.2 —
 * the salt is random and never written).
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Receipt } from '../../src/model/types.js';
import { materializeAll } from '../helpers/fixtures.js';
import { loadSchemaDoc, validateAgainst } from '../helpers/schema.js';
import { runCli, type RunCliResult } from '../helpers/spawn.js';
import { makeTempDir } from '../helpers/tmp.js';

const doc = loadSchemaDoc();

const tree = makeTempDir('showreceipts-e2e-export-');
const materialized = materializeAll(tree);
const home = join(tree, 'home');
const cwd = join(tree, 'cwd');
for (const dir of [home, cwd, join(tree, 'sr')]) mkdirSync(dir, { recursive: true });

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

function run(args: readonly string[]): RunCliResult {
  return runCli(args, { env: ENV, cwd });
}

describe('export --md', () => {
  it('matches the snapshot and is deterministic across runs', () => {
    const a = run(['export', 'latest', '--md', ...COMMON]);
    const b = run(['export', 'latest', '--md', ...COMMON]);
    expect(a.code).toBe(0);
    expect(a.stdout).toBe(b.stdout);
    expect(a.stdout).toContain('**showreceipts**');
    expect(a.stdout).not.toContain(tree);
    expect(a.stdout).toMatchSnapshot();
  });

  it('--out writes the file atomically instead of stdout', () => {
    const target = join(cwd, 'receipt.md');
    const r = run(['export', 'latest', '--md', '--out', target, ...COMMON]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toContain('**showreceipts**');
  });
});

describe('export --json', () => {
  it('validates against the schema', () => {
    const r = run(['export', 'latest', '--json', ...COMMON]);
    expect(r.code).toBe(0);
    const receipt = JSON.parse(r.stdout) as Receipt;
    expect(validateAgainst(doc, 'export', receipt)).toEqual([]);
    expect(receipt.schema).toBe('showreceipts.receipt/1');
  });

  it('exactly one of --md/--json is required (exit 2, both ways)', () => {
    expect(run(['export', 'latest', ...COMMON]).code).toBe(2);
    expect(run(['export', 'latest', '--md', '--json', ...COMMON]).code).toBe(2);
  });

  it('an ambiguous prefix exits 5', () => {
    const r = run(['export', '019c', '--json', ...COMMON]);
    expect(r.code).toBe(5);
    expect(r.stderr).toContain('ambiguous');
  });
});

describe('--hash-paths privacy (§11.2)', () => {
  it('markdown carries hashed path tokens and no raw home path', () => {
    const r = run(['export', 'latest', '--md', '--hash-paths', ...COMMON]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/p:[0-9a-f]{8}/); // hashed path prefix tokens
    expect(r.stdout).not.toContain('/home/u');
    expect(r.stdout).not.toContain('~/');
    expect(r.stdout).not.toContain(tree);
    expect(r.stdout).not.toContain(home);
  });

  it('json sets hashPaths and strips the raw cwd', () => {
    const r = run(['export', 'latest', '--json', '--hash-paths', ...COMMON]);
    expect(r.code).toBe(0);
    const receipt = JSON.parse(r.stdout) as Receipt;
    expect(validateAgainst(doc, 'export', receipt)).toEqual([]);
    expect(receipt.hashPaths).toBe(true);
    expect(receipt.cwd).not.toContain('/home/u');
    expect(r.stdout).not.toContain('/home/u');
  });

  it('the salt is random: two hashed exports agree except for the hash tokens', () => {
    const a = run(['export', 'latest', '--md', '--hash-paths', ...COMMON]);
    const b = run(['export', 'latest', '--md', '--hash-paths', ...COMMON]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    const strip = (s: string): string => s.replace(/[a-z]:[0-9a-f]{8}/g, '<hash>');
    expect(strip(a.stdout)).toBe(strip(b.stdout));
  });
});
