/**
 * S27 — `hook/receipt-files.ts` (§9): `last-receipt.{md,json}` written
 * atomically `0600` in `0700` directories to the git-worktree or home
 * location, exactly one `receipts.log` append per call, masking, and a
 * synthetic receipt round-tripping through `last-receipt.json`.
 */
import fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Receipt } from '../../../src/model/types.js';
import { writeReceiptFiles } from '../../../src/hook/receipt-files.js';
import { makeTempDir } from '../../helpers/tmp.js';

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const mode = (path: string): number => fs.statSync(path).mode & 0o777;

function makeReceipt(over: Partial<Receipt> = {}): Receipt {
  return {
    schema: 'showreceipts.receipt/1',
    toolVersion: '0.1.0',
    rulesVersion: 'claims/1',
    pricesVersion: '2026-08-29',
    kind: 'scored',
    id: 'sess-1',
    shortId: 'abcd1234',
    harness: 'cursor',
    harnessLabel: 'Cursor',
    harnessVersion: '1.5.0',
    model: 'gpt-x',
    cwd: '/home/u/proj',
    branch: 'main',
    startedAt: '2026-08-29T11:00:00.000Z',
    endedAt: '2026-08-29T11:30:00.000Z',
    durationMs: 1_800_000,
    source: 'ledger',
    turnIndex: 3,
    finalTrigger: 'human',
    turnsWithClaims: [3],
    finalText: 'All tests pass.',
    finalTextSource: 'stop-hook',
    claims: [],
    judgements: [],
    lines: [
      { glyph: 'ok', claim: 'tests pass', evidence: ['npm test exit 0 at 11:29'], refs: [] },
      { glyph: 'bad', claim: 'lint clean', evidence: ['eslint exit 1 at 11:20'], refs: [] },
    ],
    alsoSaid: [],
    alsoDid: [],
    stats: { toolCalls: 4, filesChanged: 2, testRuns: 1, compactions: 0, subagents: 0, apiCalls: 5, sentencesScanned: 3 },
    cost: {
      usd: null,
      apiCalls: 0,
      input: 0,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheWriteOther: 0,
      output: 0,
      cacheHitPct: null,
      unverified: false,
      unpriced: [],
      apiEquivalent: true,
      pricesVersion: '2026-08-29',
      notes: [],
    },
    verdict: 'CONTRADICTED',
    counts: { VERIFIED: 3, UNVERIFIED: 1, CONTRADICTED: 1, NOT_SCORED: 0 },
    turnActiveMs: null,
    claimsRecognized: 5,
    ...over,
  };
}

describe('writeReceiptFiles', () => {
  it('writes md + json 0600 into <home>/last/<harness> (0700) outside a repository', () => {
    const cwd = tempDir('sr-rf-cwd-');
    const home = tempDir('sr-rf-home-');
    const receipt = makeReceipt();
    const r = writeReceiptFiles({ receipt, cwd, home, harness: 'cursor', safeSid: 'sess-1' });
    expect(r.dir).toBe(join(home, 'last', 'cursor'));
    expect(r.mdPath).toBe(join(r.dir, 'last-receipt.md'));
    expect(r.jsonPath).toBe(join(r.dir, 'last-receipt.json'));
    expect(mode(r.mdPath)).toBe(0o600);
    expect(mode(r.jsonPath)).toBe(0o600);
    expect(mode(r.dir)).toBe(0o700);
    const md = fs.readFileSync(r.mdPath, 'utf8');
    expect(md.startsWith('**showreceipts**')).toBe(true);
    expect(md).toContain('CONTRADICTED');
    expect(md).toContain('receipt #abcd1234');
  });

  it('writes into <gitRoot>/.showreceipts for a cwd inside a git worktree (.git file)', () => {
    const root = tempDir('sr-rf-git-');
    const home = tempDir('sr-rf-home-');
    fs.writeFileSync(join(root, '.git'), 'gitdir: /repo/.git/worktrees/wt\n');
    fs.mkdirSync(join(root, 'src'), { recursive: true });
    const r = writeReceiptFiles({ receipt: makeReceipt(), cwd: join(root, 'src'), home, harness: 'cursor', safeSid: 's' });
    expect(r.dir).toBe(join(root, '.showreceipts'));
    expect(fs.existsSync(join(r.dir, 'last-receipt.md'))).toBe(true);
    expect(fs.existsSync(join(r.dir, 'last-receipt.json'))).toBe(true);
    expect(mode(r.dir)).toBe(0o700);
    // receipts.log still lands under the home, one line
    expect(fs.readFileSync(join(home, 'receipts.log'), 'utf8').trimEnd().split('\n')).toHaveLength(1);
  });

  it('appends exactly one receipts.log line per call: t · harness · shortId · verdict counts · path', () => {
    const cwd = tempDir('sr-rf-cwd-');
    const home = tempDir('sr-rf-home-');
    const spy = vi.spyOn(fs, 'appendFileSync');
    const r = writeReceiptFiles({ receipt: makeReceipt(), cwd, home, harness: 'cursor', safeSid: 's' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe(r.logPath);
    writeReceiptFiles({ receipt: makeReceipt(), cwd, home, harness: 'cursor', safeSid: 's' });
    expect(spy).toHaveBeenCalledTimes(2);
    const lines = fs.readFileSync(r.logPath, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(`2026-08-29T11:30:00.000Z · cursor · abcd1234 · CONTRADICTED v3 u1 c1 · ${r.mdPath}`);
    expect(mode(r.logPath)).toBe(0o600);
  });

  it('a synthetic receipt round-trips through last-receipt.json', () => {
    const cwd = tempDir('sr-rf-cwd-');
    const home = tempDir('sr-rf-home-');
    const receipt = makeReceipt();
    const r = writeReceiptFiles({ receipt, cwd, home, harness: 'cursor', safeSid: 's' });
    const back = JSON.parse(fs.readFileSync(r.jsonPath, 'utf8')) as Receipt;
    expect(back).toEqual(receipt);
  });

  it('masks secrets in both files', () => {
    const cwd = tempDir('sr-rf-cwd-');
    const home = tempDir('sr-rf-home-');
    const receipt = makeReceipt({
      finalText: 'done, key sk-abcdefghijklmnopqrstuvwx used',
      alsoSaid: ['set token=hunter2secret somewhere'],
    });
    const r = writeReceiptFiles({ receipt, cwd, home, harness: 'cursor', safeSid: 's' });
    const json = fs.readFileSync(r.jsonPath, 'utf8');
    expect(json).toContain('«masked»');
    expect(json).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(json).not.toContain('hunter2secret');
    const md = fs.readFileSync(r.mdPath, 'utf8');
    expect(md).not.toContain('hunter2secret');
  });

  it('writes are atomic: the target directory never holds a temp file afterwards', () => {
    const cwd = tempDir('sr-rf-cwd-');
    const home = tempDir('sr-rf-home-');
    const r = writeReceiptFiles({ receipt: makeReceipt(), cwd, home, harness: 'cursor', safeSid: 's' });
    expect(fs.readdirSync(r.dir).sort()).toEqual(['last-receipt.json', 'last-receipt.md']);
  });
});
