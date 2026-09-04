/**
 * S26 e2e — `node dist/cli.js session` over the materialised fixture tree:
 * selector resolution (latest, full id, unique prefix, ambiguous prefix,
 * transcript path), `--json` against the schema, `--timeline`,
 * `--explain-claim` and the exit-5/exit-2 contracts (§12.1–§12.2).
 */
import { basename } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Receipt } from '../../src/model/types.js';
import { displayWidth } from '../../src/util/width.js';
import { materializeAll } from '../helpers/fixtures.js';
import { loadSchemaDoc, validateAgainst } from '../helpers/schema.js';
import { runCli, type RunCliResult } from '../helpers/spawn.js';
import { makeTempDir } from '../helpers/tmp.js';

const doc = loadSchemaDoc();

const tree = makeTempDir('showreceipts-e2e-session-');
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

/** The `codex/shell_command` rollout on disk (a scored session with claims and tool calls). */
const shellRollout = materialized.fixtures['codex/shell_command']?.paths.find((p) => /rollout-.*\.jsonl$/.test(basename(p)));
if (shellRollout === undefined) throw new Error('codex/shell_command fixture has no rollout');
const shellId = (/-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(basename(shellRollout))?.[1] as string).toLowerCase();

let latestMemo: Receipt | undefined;
function latestReceipt(): Receipt {
  if (latestMemo === undefined) {
    const r = run(['session', 'latest', '--json', ...COMMON]);
    expect(r.code).toBe(0);
    latestMemo = JSON.parse(r.stdout) as Receipt;
  }
  return latestMemo;
}

describe('selector resolution (§12.1)', () => {
  it('latest --json is the newest done-turn session and validates against the schema', () => {
    const receipt = latestReceipt();
    expect(validateAgainst(doc, 'session', receipt)).toEqual([]);
    expect(receipt.schema).toBe('showreceipts.receipt/1');
    expect(receipt.harness).toBe('claude-code');
    expect(receipt.endedAt.startsWith('2026-08-30')).toBe(true);
  });

  it('latest renders the boxed receipt within the width, home shown as ~', () => {
    const receipt = latestReceipt();
    const r = run(['session', 'latest', ...COMMON]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`RECEIPT  #${receipt.shortId}`);
    expect(r.stdout).not.toContain(tree);
    for (const line of r.stdout.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(80);
  });

  it('a full session id resolves', () => {
    const receipt = latestReceipt();
    const r = run(['session', receipt.id, '--json', ...COMMON]);
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout) as Receipt).id).toBe(receipt.id);
  });

  it('a unique short-id prefix (≥ 4 chars) resolves', () => {
    const receipt = latestReceipt();
    const r = run(['session', receipt.shortId.slice(0, 6), '--json', ...COMMON]);
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout) as Receipt).id).toBe(receipt.id);
  });

  it('an ambiguous prefix exits 5 and prints the candidates', () => {
    // Both codex/0.98.0 rollouts are 2026 UUIDv7 ids sharing the 019c prefix.
    const r = run(['session', '019c', ...COMMON]);
    expect(r.code).toBe(5);
    expect(r.stderr).toContain('ambiguous');
    expect(r.stderr.split('\n').filter((l) => l.startsWith('  ')).length).toBeGreaterThanOrEqual(2);
  });

  it('a transcript path resolves directly', () => {
    const r = run(['session', shellRollout, '--json', ...COMMON]);
    expect(r.code).toBe(0);
    const receipt = JSON.parse(r.stdout) as Receipt;
    expect(validateAgainst(doc, 'session', receipt)).toEqual([]);
    expect(receipt.id).toBe(shellId);
  });

  it('an unknown id exits 5', () => {
    const r = run(['session', 'deadbeef', ...COMMON]);
    expect(r.code).toBe(5);
    expect(r.stderr).toContain("no session matches 'deadbeef'");
  });

  it('a missing selector is a usage error (exit 2)', () => {
    const r = run(['session', ...COMMON]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('missing <id|prefix|path|latest>');
  });
});

describe('--timeline / --explain-claim / --turn', () => {
  it('--timeline appends the evidence timeline (text) and embeds it (--json)', () => {
    const text = run(['session', shellId, '--timeline', ...COMMON]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('TIME');
    expect(text.stdout).toContain('TOOL');
    const r = run(['session', shellId, '--timeline', '--json', ...COMMON]);
    expect(r.code).toBe(0);
    const receipt = JSON.parse(r.stdout) as Receipt;
    expect(validateAgainst(doc, 'session', receipt)).toEqual([]);
    expect(Array.isArray(receipt.timeline)).toBe(true);
    expect((receipt.timeline as unknown[]).length).toBeGreaterThan(0);
  });

  it('--explain-claim appends the explanation block (text) and embeds it (--json)', () => {
    const text = run(['session', shellId, '--explain-claim', ...COMMON]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('EXPLANATIONS');
    const r = run(['session', shellId, '--explain-claim', '--json', ...COMMON]);
    expect(r.code).toBe(0);
    const receipt = JSON.parse(r.stdout) as Receipt;
    expect(validateAgainst(doc, 'session', receipt)).toEqual([]);
    expect(Array.isArray(receipt.explanations)).toBe(true);
    expect((receipt.explanations as unknown[]).length).toBe(receipt.judgements.length);
    expect(receipt.judgements.length).toBeGreaterThan(0);
  });

  it('--turn with an unknown index is a usage error (exit 2)', () => {
    const r = run(['session', 'latest', '--turn', '9999', ...COMMON]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--turn');
  });
});
