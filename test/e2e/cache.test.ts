/**
 * S26 e2e — the parse cache through spawned `audit` runs (§4.9): a second
 * run is all hits, `--no-cache` and `SHOWRECEIPTS_NO_CACHE=1` bypass it,
 * a corrupt entry is recovered byte-identically, and a warm `--as-of`
 * recompute changes only the `codex/shell_command` fixture's cost line —
 * the S24 assertion — with `cacheHits` unchanged.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AuditJson } from '../../src/commands/audit.js';
import { materializeAll } from '../helpers/fixtures.js';
import { runCli } from '../helpers/spawn.js';
import { makeTempDir } from '../helpers/tmp.js';

const tree = makeTempDir('showreceipts-e2e-cache-');
const materialized = materializeAll(tree);
const home = join(tree, 'home');
const cwd = join(tree, 'cwd');
const srHome = join(tree, 'sr');
const cacheDir = join(srHome, 'cache');
for (const dir of [home, cwd, srHome]) mkdirSync(dir, { recursive: true });

const ENV: Record<string, string> = {
  HOME: home,
  USERPROFILE: home,
  CLAUDE_CONFIG_DIR: materialized.claudeConfigDir,
  CODEX_HOME: materialized.codexHome,
  SHOWRECEIPTS_HOME: srHome,
};

afterAll(() => {
  rmSync(tree, { recursive: true, force: true });
});

const BASE = ['audit', '--since', '2026-01-01', '--width', '80', '--no-color', '--unicode', '--tz', 'utc', '--home-dir', '/home/u', '--json'];

function auditJson(extra: readonly string[] = [], env: Record<string, string | undefined> = {}): AuditJson {
  const r = runCli([...BASE, ...extra], { env: { ...ENV, ...env }, cwd });
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout) as AuditJson;
}

/** Entry files (not the path index) currently in the cache directory. */
function entryFiles(): string[] {
  return readdirSync(cacheDir)
    .filter((name) => /^[0-9a-f]{64}\.json$/.test(name))
    .sort();
}

// The cold parse populates the cache on first use — inside the first test,
// so a spawn failure attributes to a named test instead of file collection;
// every later assertion runs warm. Tests that need a warm cache call
// `cold()` first so they also pass when filtered to a single test.
let coldMemo: AuditJson | undefined;
function cold(): AuditJson {
  coldMemo ??= auditJson();
  return coldMemo;
}

describe('warm and bypassed runs (§4.9)', () => {
  it('the cold run misses for every session and stores one entry per parsed file', () => {
    expect(cold().scanned.cacheHits).toBe(0);
    expect(cold().scanned.sessions).toBe(9);
    // 9 files parsed and cached: the 2025 legacy fixture is mtime-prefiltered
    // at enumeration under --since 2026-01-01 and never reaches the parser.
    expect(entryFiles().length).toBe(9);
  });

  it('the second run hits for every session and reproduces the receipts exactly', () => {
    cold(); // warm the cache even when this test runs alone
    const warm = auditJson();
    expect(warm.scanned.cacheHits).toBe(warm.scanned.sessions);
    expect(warm.sessions).toEqual(cold().sessions);
    expect(warm.rate).toEqual(cold().rate);
    expect(warm.latest).toEqual(cold().latest);
  });

  it('--no-cache bypasses the cache entirely', () => {
    const bypassed = auditJson(['--no-cache']);
    expect(bypassed.scanned.cacheHits).toBe(0);
    expect(bypassed.sessions).toEqual(cold().sessions);
  });

  it('SHOWRECEIPTS_NO_CACHE=1 bypasses it too', () => {
    const bypassed = auditJson([], { SHOWRECEIPTS_NO_CACHE: '1' });
    expect(bypassed.scanned.cacheHits).toBe(0);
    expect(bypassed.sessions).toEqual(cold().sessions);
  });
});

describe('corrupt-entry recovery (§4.9: a corrupt entry is a miss, never a failure)', () => {
  it('recovers byte-identically, counts the corruption, and heals the entry', () => {
    cold(); // populate the cache even when this test runs alone
    const victim = entryFiles()[0] as string;
    writeFileSync(join(cacheDir, victim), 'garbage{{{');

    const recovered = auditJson();
    expect(recovered.scanned.cacheHits).toBe(recovered.scanned.sessions - 1);
    expect(recovered.diagnostics.corruptCache).toBe(1);
    expect(recovered.sessions).toEqual(cold().sessions);
    expect(recovered.latest).toEqual(cold().latest);

    // The re-parse rewrote the entry: the next run is all hits again.
    const healed = auditJson();
    expect(healed.scanned.cacheHits).toBe(healed.scanned.sessions);
  });
});

describe('warm --as-of recompute (the S24 assertion; prices never invalidate a parse)', () => {
  it('changes only the codex/shell_command cost line, cacheHits unchanged', () => {
    cold(); // warm the cache even when this test runs alone
    const warm = auditJson();
    expect(warm.scanned.cacheHits).toBe(warm.scanned.sessions);

    const asOf = auditJson(['--as-of', '2026-07-15']);
    expect(asOf.scanned.cacheHits).toBe(asOf.scanned.sessions); // still every parse from the cache

    const changed = warm.sessions.filter((card, i) => JSON.stringify(card) !== JSON.stringify(asOf.sessions[i]));
    expect(changed).toHaveLength(1);
    const card = changed[0];
    expect(card?.harness).toBe('codex');
    expect(card?.endedAt.startsWith('2026-08-15')).toBe(true); // the shell_command fixture
    expect(card?.costUsd).toBeCloseTo(0.020749, 6);
    const repriced = asOf.sessions.find((c) => c.id === card?.id);
    expect(repriced?.costUsd).toBeCloseTo(0.025936, 6);

    // Every other receipt keeps its dollars; the latest only gains the asOf stamp.
    expect(asOf.latest?.cost.usd).toBe(warm.latest?.cost.usd);
    expect(asOf.latest?.cost.asOf).toBe('2026-07-15');
  });
});
