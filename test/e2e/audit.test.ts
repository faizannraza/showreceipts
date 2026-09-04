/**
 * S26 e2e — `node dist/cli.js audit` over the materialised fixture tree in an
 * isolated temp home: the 80-column screen snapshot, narrow/ASCII variants,
 * the `showreceipts.audit/1` envelope, filters, price overrides, `--as-of`
 * and the §12.2 exit codes. Every child carries the §0.4 pins and the
 * netguard (`test/helpers/spawn.ts`).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { AuditJson } from '../../src/commands/audit.js';
import { displayWidth } from '../../src/util/width.js';
import { materializeAll } from '../helpers/fixtures.js';
import { loadSchemaDoc, validateAgainst } from '../helpers/schema.js';
import { runCli, type RunCliResult } from '../helpers/spawn.js';
import { makeTempDir } from '../helpers/tmp.js';

const doc = loadSchemaDoc();
const PRICES_DIR = fileURLToPath(new URL('../../fixtures/prices/', import.meta.url));

// One materialised fixture tree for the whole file (S26 instruction 1); the
// shared SHOWRECEIPTS_HOME means later invocations run warm, like real reruns.
const tree = makeTempDir('showreceipts-e2e-audit-');
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

/** §0.4 base invocation: fixture sessions are Feb–Aug 2026, cwds `/home/u/proj…`. */
const BASE = ['audit', '--since', '2026-01-01', '--width', '80', '--no-color', '--unicode', '--tz', 'utc', '--home-dir', '/home/u'];

function run(args: readonly string[], env: Record<string, string | undefined> = {}): RunCliResult {
  return runCli(args, { env: { ...ENV, ...env }, cwd });
}

function auditJson(extra: readonly string[] = []): AuditJson {
  const r = run([...BASE, '--json', ...extra]);
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout) as AuditJson;
}

describe('the audit screen (text)', () => {
  it('matches the 80-column snapshot with no temp path leaked (home shown as ~)', () => {
    const r = run(BASE);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).not.toContain(tree);
    expect(r.stdout).not.toContain(home);
    expect(r.stdout).toContain('RECEIPT');
    for (const line of r.stdout.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(80);
    expect(r.stdout).toMatchSnapshot();
  });

  it('renders narrow mode within --width 60', () => {
    const r = run(['audit', '--since', '2026-01-01', '--width', '60', '--no-color', '--unicode', '--tz', 'utc', '--home-dir', '/home/u']);
    expect(r.code).toBe(0);
    for (const line of r.stdout.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(60);
    expect(r.stdout).toMatchSnapshot();
  });

  it('--ascii uses no unicode frame or separator glyphs', () => {
    const r = run(['audit', '--since', '2026-01-01', '--width', '80', '--no-color', '--ascii', '--tz', 'utc', '--home-dir', '/home/u']);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('┌');
    expect(r.stdout).not.toContain('·');
    expect(r.stdout).toContain('report -> .showreceipts/report.html');
  });

  it('--limit 1 shortens the session table', () => {
    const one = run([...BASE, '--limit', '1']);
    const all = run(BASE);
    expect(one.code).toBe(0);
    expect(one.stdout.split('\n').length).toBeLessThan(all.stdout.split('\n').length);
  });

  it('--all-claims lifts the 12-row cap on the latest receipt', () => {
    const capped = run(BASE);
    const all = run([...BASE, '--all-claims']);
    expect(all.code).toBe(0);
    expect(all.stdout).not.toContain('more claims');
    expect(all.stdout.split('\n').length).toBeGreaterThanOrEqual(capped.stdout.split('\n').length);
  });
});

describe('audit --json (§12.3)', () => {
  it('validates against the schema with the DoD fixture counts', () => {
    const r = run([...BASE, '--json']);
    expect(r.code).toBe(0);
    expect(r.stdout.endsWith('\n')).toBe(true);
    expect(r.stdout.indexOf('\n')).toBe(r.stdout.length - 1);
    const parsed = JSON.parse(r.stdout) as AuditJson;
    expect(validateAgainst(doc, 'audit', parsed)).toEqual([]);
    expect(parsed.schema).toBe('showreceipts.audit/1');
    expect(parsed.generatedAt).toBe('2026-08-29T12:00:00.000Z');
    expect(parsed.scanned.byHarness['claude-code']).toBe(6);
    expect(parsed.scanned.byHarness['codex']).toBe(3);
    expect(parsed.scanned.sessions).toBe(9);
    expect(parsed.sessions).toHaveLength(9);
    expect(parsed.latest).not.toBeNull();
    expect(parsed.rate.length).toBeGreaterThan(0);
  });

  it('--harness codex keeps only the codex sessions', () => {
    const parsed = auditJson(['--harness', 'codex']);
    expect(parsed.sessions).toHaveLength(3);
    expect(parsed.sessions.every((c) => c.harness === 'codex')).toBe(true);
  });

  it('--project filters by cwd substring (proj matches all, proj1 the codex three)', () => {
    expect(auditJson(['--project', 'proj']).sessions).toHaveLength(9);
    const proj1 = auditJson(['--project', 'proj1']);
    expect(proj1.sessions).toHaveLength(3);
    expect(proj1.sessions.every((c) => c.harness === 'codex')).toBe(true);
  });
});

describe('prices and --as-of (post-cache, §4.9)', () => {
  it('--as-of stamps the effective price date into the receipt cost', () => {
    const parsed = auditJson(['--as-of', '2026-07-15']);
    expect(parsed.latest?.cost.asOf).toBe('2026-07-15');
  });

  it('--prices override-valid.json reprices only the overridden models, cache untouched', () => {
    const base = auditJson();
    const over = auditJson(['--prices', join(PRICES_DIR, 'override-valid.json')]);
    expect(over.scanned.cacheHits).toBe(over.scanned.sessions); // prices never invalidate a parse
    expect(over.pricesVersion).toMatch(/\+[0-9a-f]{8}$/);
    const changed = base.sessions.filter((card, i) => card.costUsd !== over.sessions[i]?.costUsd);
    // gpt-5.2 is overridden: exactly the two Feb 2026 gpt-5.2-codex sessions reprice.
    expect(changed).toHaveLength(2);
    expect(changed.every((c) => c.harness === 'codex' && c.model === 'gpt-5.2-codex')).toBe(true);
  });

  it('an invalid --prices file is a runtime failure (exit 1)', () => {
    const r = run([...BASE, '--prices', join(PRICES_DIR, 'override-invalid.json')]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('prices');
  });

  it('a missing --prices file is a runtime failure (exit 1)', () => {
    const r = run([...BASE, '--prices', join(tree, 'no-such-prices.json')]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('cannot read file');
  });

  it('a syntactically broken --prices file is a runtime failure (exit 1)', () => {
    const bad = join(tree, 'bad-prices.json');
    writeFileSync(bad, '{not json');
    const r = run([...BASE, '--prices', bad]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('prices');
  });
});

describe('usage errors (§12.2 exit 2)', () => {
  it('--width 39 is below the 40-column floor', () => {
    const r = run(['audit', '--width', '39']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--width');
  });

  it('a malformed --as-of is refused', () => {
    const r = run(['audit', '--as-of', 'not-a-date']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--as-of');
  });
});

describe('perf (soft; recorded only — the hard gates are S36)', () => {
  it('records the warm audit wall time against the 400 ms guide', () => {
    const r = run([...BASE, '--json']);
    expect(r.code).toBe(0);
    const budget = process.env['CI'] ? 1200 : 400;
    // Soft gate: recorded, never failed here.
    console.info(`[S26 perf] warm audit over the fixture tree: ${r.ms.toFixed(0)} ms (guide ${budget} ms)`);
  });
});
