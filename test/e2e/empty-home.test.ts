/**
 * S26 e2e — a HOME with no root present at all (no Claude Code, no Codex,
 * no showreceipts state): every command exits 0 (§12.2 — "no sessions
 * found" is a success), except `session x`, which exits 5.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AuditJson } from '../../src/commands/audit.js';
import { loadSchemaDoc, validateAgainst } from '../helpers/schema.js';
import { runCli, type RunCliResult } from '../helpers/spawn.js';
import { makeTempDir } from '../helpers/tmp.js';

const doc = loadSchemaDoc();

const tree = makeTempDir('showreceipts-e2e-empty-');
const home = join(tree, 'home');
const cwd = join(tree, 'cwd');
for (const dir of [home, cwd]) mkdirSync(dir, { recursive: true });

// Every root points at a directory that does not exist.
const ENV: Record<string, string> = {
  HOME: home,
  USERPROFILE: home,
  CLAUDE_CONFIG_DIR: join(tree, 'no-claude'),
  CODEX_HOME: join(tree, 'no-codex'),
  SHOWRECEIPTS_HOME: join(tree, 'no-sr'),
};

afterAll(() => {
  rmSync(tree, { recursive: true, force: true });
});

const COMMON = ['--width', '80', '--no-color', '--unicode', '--tz', 'utc', '--home-dir', '/home/u'];

function run(args: readonly string[]): RunCliResult {
  return runCli(args, { env: ENV, cwd });
}

describe('all roots absent (§12.2)', () => {
  it('audit exits 0 with the demo hint', () => {
    const r = run(['audit', ...COMMON]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('no sessions found');
    expect(r.stdout).toContain('showreceipts demo');
  });

  it('audit --json validates with an empty session list', () => {
    const r = run(['audit', '--json', ...COMMON]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as AuditJson;
    expect(validateAgainst(doc, 'audit', parsed)).toEqual([]);
    expect(parsed.sessions).toEqual([]);
    expect(parsed.latest).toBeNull();
    expect(parsed.scanned.sessions).toBe(0);
  });

  it('session x exits 5 (too-short prefixes are refused, not guessed)', () => {
    const r = run(['session', 'x', ...COMMON]);
    expect(r.code).toBe(5);
    expect(r.stderr).toContain('id prefix must be at least 4 characters');
  });

  it('session with an unknown 4+ char prefix exits 5', () => {
    const r = run(['session', 'xxxx', ...COMMON]);
    expect(r.code).toBe(5);
    expect(r.stderr).toContain("no session matches 'xxxx'");
  });

  it('export latest exits 5 (nothing to export)', () => {
    const r = run(['export', 'latest', '--json', ...COMMON]);
    expect(r.code).toBe(5);
    expect(r.stderr).toContain('no sessions found');
  });

  it('report exits 0 and writes an empty report', () => {
    const r = run(['report', '--home-dir', '/home/u', '--no-color', '--json']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as { out: string; sessions: number };
    expect(parsed.sessions).toBe(0);
    expect(existsSync(parsed.out)).toBe(true);
    expect(parsed.out).toBe(join(cwd, '.showreceipts', 'report.html'));
  });

  it('demo exits 0 (needs no data)', () => {
    const r = run(['demo', '--ascii', '--no-color']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('RECEIPT');
  });

  it('bench --json exits 0 and validates', () => {
    const r = run(['bench', '--json', '--home-dir', '/home/u']);
    expect(r.code).toBe(0);
    expect(validateAgainst(doc, 'bench', JSON.parse(r.stdout))).toEqual([]);
  });

  it('doctor --json exits 0 (missing roots are warnings, not problems) and validates', () => {
    const r = run(['doctor', '--json', '--home-dir', '/home/u']);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout) as { problems: string[] };
    expect(validateAgainst(doc, 'doctor', report)).toEqual([]);
    expect(report.problems).toEqual([]);
  });
});
