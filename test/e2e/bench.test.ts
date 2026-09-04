/**
 * S26 e2e — `node dist/cli.js bench` over the materialised fixture tree:
 * the `--json` envelope against the schema, `--month` calendar snapping,
 * and `--publish` — Appendix D shape, byte-identical consecutive runs,
 * previous-complete-month default and `partial:true` for the current month.
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { PublishPayload, RateRow } from '../../src/model/types.js';
import { materializeAll } from '../helpers/fixtures.js';
import { loadSchemaDoc, validateAgainst } from '../helpers/schema.js';
import { runCli, type RunCliResult } from '../helpers/spawn.js';
import { makeTempDir } from '../helpers/tmp.js';

const doc = loadSchemaDoc();
const NOW_ISO = '2026-08-29T12:00:00.000Z';

const tree = makeTempDir('showreceipts-e2e-bench-');
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

const BASE = ['bench', '--home-dir', '/home/u', '--width', '80', '--no-color', '--unicode'];

function run(args: readonly string[]): RunCliResult {
  return runCli(args, { env: ENV, cwd });
}

interface BenchJson {
  schema: string;
  window: { from: string; to: string };
  rows: RateRow[];
}

describe('bench --json (§12.3)', () => {
  it('validates against the schema with the requested window', () => {
    const r = run([...BASE, '--since', '2026-01-01', '--json']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as BenchJson;
    expect(validateAgainst(doc, 'bench', parsed)).toEqual([]);
    expect(parsed.schema).toBe('showreceipts.bench/1');
    expect(parsed.window.from).toBe('2026-01-01T00:00:00.000Z');
    expect(parsed.window.to).toBe(NOW_ISO);
    expect(parsed.rows.length).toBeGreaterThan(0);
  });

  it('--month 2026-02 snaps to the calendar month over Turn.endedAt (UTC)', () => {
    const r = run([...BASE, '--month', '2026-02', '--json']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as BenchJson;
    expect(parsed.window.from).toBe('2026-02-01T00:00:00.000Z');
    expect(parsed.window.to).toBe('2026-03-01T00:00:00.000Z');
    const codex = parsed.rows.filter((row) => row.harness === 'codex');
    expect(codex.reduce((sum, row) => sum + row.sessions, 0)).toBe(2); // the two Feb rollouts
  });
});

describe('bench --publish (§13.3, Appendix D)', () => {
  it('defaults to the previous complete month and writes byte-identical consecutive runs', () => {
    const first = join(outDir, 'p1.json');
    const second = join(outDir, 'p2.json');
    const a = run(['bench', '--publish', first, '--home-dir', '/home/u']);
    expect(a.code).toBe(0);
    expect(a.stdout).toContain('publish');
    const b = run(['bench', '--publish', second, '--home-dir', '/home/u']);
    expect(b.code).toBe(0);

    const bytes = readFileSync(first, 'utf8');
    expect(readFileSync(second, 'utf8')).toBe(bytes);

    const payload = JSON.parse(bytes) as PublishPayload;
    expect(validateAgainst(doc, 'bench-publish', payload)).toEqual([]);
    expect(payload.schema).toBe('showreceipts.bench-publish/1');
    expect(payload.period).toEqual({ from: '2026-07', to: '2026-07', partial: false });
    expect(payload.rows.length).toBeGreaterThan(0);
    // Aggregates only: no fixture path, home path, or day-precision date.
    expect(bytes).not.toContain(tree);
    expect(bytes).not.toContain('/home/u');
    expect(/\d{4}-\d{2}-\d{2}/.test(bytes.replace(payload.generator.pricesVersion, ''))).toBe(false);
  });

  it('--month for the current month sets partial:true', () => {
    const out = join(outDir, 'partial.json');
    const r = run(['bench', '--month', '2026-08', '--publish', out, '--home-dir', '/home/u']);
    expect(r.code).toBe(0);
    const payload = JSON.parse(readFileSync(out, 'utf8')) as PublishPayload;
    expect(validateAgainst(doc, 'bench-publish', payload)).toEqual([]);
    expect(payload.period).toEqual({ from: '2026-08', to: '2026-08', partial: true });
  });
});
