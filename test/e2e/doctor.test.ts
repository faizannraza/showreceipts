/**
 * S26 e2e — `node dist/cli.js doctor` over the materialised fixture tree:
 * exit 0 (warnings only — the fixtures are healthy), the `--json` report
 * against the schema, and the text screen with the §12.3 durability note.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DoctorReport } from '../../src/model/types.js';
import { CLEANUP_NOTE } from '../../src/commands/doctor.js';
import { materializeAll } from '../helpers/fixtures.js';
import { loadSchemaDoc, validateAgainst } from '../helpers/schema.js';
import { runCli, type RunCliResult } from '../helpers/spawn.js';
import { makeTempDir } from '../helpers/tmp.js';

const doc = loadSchemaDoc();

const tree = makeTempDir('showreceipts-e2e-doctor-');
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

function run(args: readonly string[]): RunCliResult {
  return runCli(args, { env: ENV, cwd });
}

describe('doctor --json (§12.2/§12.3)', () => {
  it('exits 0 with warnings only and validates against the schema', () => {
    const r = run(['doctor', '--json', '--home-dir', '/home/u']);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout) as DoctorReport;
    expect(validateAgainst(doc, 'doctor', report)).toEqual([]);
    expect(report.problems).toEqual([]);
    expect(report.warnings.length).toBeGreaterThan(0);
    const claude = report.harnesses.find((h) => h.harness === 'claude-code');
    const codex = report.harnesses.find((h) => h.harness === 'codex');
    expect(claude?.found).toBe(true);
    expect(claude?.sessions).toBe(7); // doctor counts every session, window-free
    expect(claude?.bytes).toBeGreaterThan(0);
    expect(codex?.found).toBe(true);
    expect(codex?.sessions).toBe(3);
    expect(report.ledgers).toEqual({ sessions: 0, partial: 0, gaps: 0, stdinOverflow: 0, stopBudgetExceeded: 0, copilotTranscriptUnparsed: 0 });
    expect(report.cache.entries).toBeGreaterThanOrEqual(0);
  });

  it('never leaks the temp tree path when --home-dir masks the home', () => {
    const r = run(['doctor', '--width', '80', '--no-color', '--unicode', '--home-dir', '/home/u']);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain(tree);
  });
});

describe('doctor text screen', () => {
  it('prints every section and the durability note', () => {
    const r = run(['doctor', '--width', '80', '--no-color', '--ascii', '--home-dir', '/home/u']);
    expect(r.code).toBe(0);
    for (const section of ['roots', 'harnesses', 'hooks', 'ledgers', 'prices', 'cache']) expect(r.stdout).toContain(section);
    // wrapped at the width budget (Pass 3): pin the content, not the literal line
    expect(r.stdout).toContain('cleanupPeriodDays');
    expect(r.stdout).toContain('durable record');
    expect(r.stdout.replace(/\n/g, ' ')).toContain(CLEANUP_NOTE.slice(0, 60));
  });
});
