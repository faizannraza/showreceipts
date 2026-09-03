/**
 * S18 — `pipeline/run.ts loadSessions` over the real fixture tree: cache
 * hits and bypass, corrupt-entry re-parse, byte-identical warm receipts
 * (Codex cost pins 0.068394 / 7.888091 among them), the §4.2.5 in-memory
 * trim, window/project filters, and failure containment.
 */
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Receipt, Session } from '../../../src/model/types.js';
import { echoHashes } from '../../../src/claims/text.js';
import { loadPriceTable } from '../../../src/cost/resolve.js';
import { resolveRoots } from '../../../src/discover/roots.js';
import { dedupeUsage } from '../../../src/pipeline/dedupe.js';
import { buildReceipt, receiptToJson, type ReceiptOptions } from '../../../src/pipeline/receipt.js';
import { loadSessions, type LoadResult } from '../../../src/pipeline/run.js';
import { sha256 } from '../../../src/util/hash.js';
import { materialize } from '../../helpers/fixtures.js';
import { makeTempDir } from '../../helpers/tmp.js';

const CODEX_A = '019c45e8-ac72-76c9-96e4-1a38177c0fb3';
const CODEX_B = '019c4678-53b6-71c6-bb5b-d5b24ff14873';
const TOOL = 'test-tool-1';

const table = loadPriceTable();
const tmp = makeTempDir('showreceipts-pipeline-');
const home = join(tmp, 'home');
const srHome = join(tmp, 'sr');
mkdirSync(home, { recursive: true });
mkdirSync(srHome, { recursive: true });
materialize('codex/0.98.0', tmp);
materialize('claude-code/2.1.241', tmp);
materialize('claude-code/2.1.243', tmp);
const roots = resolveRoots(
  { CLAUDE_CONFIG_DIR: join(tmp, 'claude'), CODEX_HOME: join(tmp, 'codex'), SHOWRECEIPTS_HOME: srHome },
  home,
);
const cacheDir = join(srHome, 'cache');

function load(over: Record<string, unknown> = {}): Promise<LoadResult> {
  return loadSessions({ roots, all: true, versions: { tool: TOOL }, now: new Date('2026-08-29T12:00:00.000Z'), ...over });
}

function receiptOpts(): ReceiptOptions {
  return { now: new Date('2026-08-29T12:00:00.000Z'), prices: table, homeDir: '/home/u', timeline: true };
}

function bySid(result: LoadResult, sid: string): Session {
  const s = result.sessions.find((x) => x.sessionId === sid);
  if (s === undefined) throw new Error(`session ${sid} not loaded`);
  return s;
}

function receiptsOf(result: LoadResult): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of result.sessions) {
    out.set(`${s.harness}:${s.sessionId}`, receiptToJson(buildReceipt(s, receiptOpts())));
  }
  return out;
}

function cacheFileHashes(): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of readdirSync(cacheDir).sort()) {
    out.set(name, sha256(readFileSync(join(cacheDir, name))));
  }
  return out;
}

let cold: LoadResult;
let coldReceipts: Map<string, string>;

beforeAll(async () => {
  cold = await load();
  coldReceipts = receiptsOf(cold);
});

describe('cold load over the fixture tree', () => {
  it('finds every session, sorted endedAt desc / sessionId asc', () => {
    expect(cold.scanned.sessions).toBe(4);
    expect(cold.scanned.byHarness).toEqual({ 'claude-code': 2, codex: 2 });
    expect(cold.scanned.cacheHits).toBe(0);
    expect(cold.scanned.bytes).toBeGreaterThan(0);
    expect(cold.scanned.from).not.toBeNull();
    const ends = cold.sessions.map((s) => Date.parse(s.endedAt));
    for (let i = 1; i < ends.length; i++) expect(ends[i - 1] as number).toBeGreaterThanOrEqual(ends[i] as number);
  });

  it('keeps no-turns sessions with their kind', () => {
    const noTurns = bySid(cold, '1f574b70-66e7-4434-96de-1c7d4a0c6fb8');
    expect(noTurns.kind).toBe('no-turns');
  });

  it('fills repoRoot, echo hashes and the §4.2.5 trim', () => {
    // The redacted fixture prompts are short placeholders, so the hash lists
    // may be empty — what matters is that the fill is exactly the S15 pass.
    let turnsWithText = 0;
    for (const s of cold.sessions) {
      for (const t of s.turns) {
        if (t.userText === null || t.userText === '') continue;
        turnsWithText += 1;
        expect(t.echoHashes).toEqual(echoHashes(t.userText));
      }
    }
    expect(turnsWithText).toBeGreaterThan(0);
    expect(echoHashes('I asked you to fix the bug in the parser and re-run the 41 tests.').length).toBeGreaterThan(0);
    for (const s of cold.sessions) {
      for (const c of s.toolCalls) {
        expect(c.resultText.length).toBeLessThanOrEqual(4096 + 4096 + 1);
        expect(c.patch).toBeUndefined();
        expect(c.attempted).toBeUndefined();
      }
    }
  });

  it('cache entries hold userText: null (prompt text never persisted)', () => {
    const names = readdirSync(cacheDir).filter((n) => /^[0-9a-f]{64}\.json$/.test(n));
    expect(names.length).toBe(4);
    for (const name of names) {
      const text = readFileSync(join(cacheDir, name), 'utf8');
      expect(text).not.toContain('"userText":"');
    }
  });
});

describe('warm load', () => {
  it('reports cacheHits === sessions and yields byte-identical receipt JSON', async () => {
    const warm = await load();
    expect(warm.scanned.cacheHits).toBe(4);
    expect(warm.scanned.sessions).toBe(4);
    const warmReceipts = receiptsOf(warm);
    expect(warmReceipts.size).toBe(coldReceipts.size);
    for (const [key, json] of coldReceipts) {
      expect(warmReceipts.get(key), key).toBe(json);
    }
  });

  it('pins the Codex costs: 019c45e8 ≈$0.068394 with planUsagePct, 019c4678 $7.888091', async () => {
    const warm = await load();
    const small = JSON.parse(coldReceipts.get(`codex:${CODEX_A}`) as string) as Receipt;
    expect(small.cost.usd).toBe(0.068394);
    expect(small.cost.unverified).toBe(true); // inferred OpenAI rows
    expect(small.cost.planUsagePct).toBeDefined();
    const smallWarm = buildReceipt(bySid(warm, CODEX_A), receiptOpts());
    expect(smallWarm.cost.usd).toBe(0.068394);
    expect(smallWarm.cost.planUsagePct).toBe(small.cost.planUsagePct);

    const big = JSON.parse(coldReceipts.get(`codex:${CODEX_B}`) as string) as Receipt;
    expect(big.cost.usd).toBe(7.888091);
  });

  it('--no-cache bypasses the cache entirely', async () => {
    const bypass = await load({ noCache: true });
    expect(bypass.scanned.cacheHits).toBe(0);
    expect(bypass.scanned.sessions).toBe(4);
  });

  it('cross-session dedupe never touches the cache files', async () => {
    const before = cacheFileHashes();
    const warm = await load();
    dedupeUsage(warm.sessions);
    expect(cacheFileHashes()).toEqual(before);
  });

  it('a corrupted cache entry triggers a re-parse with identical output', async () => {
    const names = readdirSync(cacheDir)
      .filter((n) => /^[0-9a-f]{64}\.json$/.test(n))
      .sort();
    const victim = names[0] as string;
    writeFileSync(join(cacheDir, victim), 'garbage {');
    const result = await load();
    expect(result.scanned.sessions).toBe(4);
    expect(result.scanned.cacheHits).toBe(3);
    expect(result.diagnostics.corruptCache).toBeGreaterThanOrEqual(1);
    const receipts = receiptsOf(result);
    for (const [key, json] of coldReceipts) {
      expect(receipts.get(key), key).toBe(json);
    }
  });
});

describe('filters and failure containment', () => {
  it('--since (parsed endedAt + mtime) windows sessions out; --all keeps them', async () => {
    const future = await load({ all: undefined, since: Date.parse('2026-12-01T00:00:00Z') });
    expect(future.scanned.sessions).toBe(0);
    const past = await load({ all: undefined, since: Date.parse('2020-01-01T00:00:00Z') });
    expect(past.scanned.sessions).toBe(4);
  });

  it('--project matches the cwd substring or resolved path', async () => {
    const codexOnly = await load({ project: 'proj1' });
    expect(codexOnly.scanned.byHarness).toEqual({ codex: 2 });
    const none = await load({ project: 'zzz-not-a-project' });
    expect(none.scanned.sessions).toBe(0);
  });

  it('--harness restricts enumeration', async () => {
    const codex = await load({ harness: ['codex'] });
    expect(codex.scanned.byHarness).toEqual({ codex: 2 });
  });

  it('a single unreadable file never fails the run', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root ignores modes
    const rollout = join(
      tmp,
      'codex',
      'sessions',
      '2026',
      '02',
      '09',
      `rollout-2026-02-09T23-56-42-${CODEX_A}.jsonl`,
    );
    chmodSync(rollout, 0o000);
    try {
      const result = await load({ noCache: true });
      expect(result.scanned.sessions).toBe(3);
      expect(result.diagnostics.problems).toHaveLength(1);
      expect(result.diagnostics.problems[0]).toContain(CODEX_A);
    } finally {
      chmodSync(rollout, 0o644);
    }
  });

  it('reports progress for every enumerated ref', async () => {
    const seen: [number, number][] = [];
    await load({ onProgress: (done: number, total: number) => seen.push([done, total]) });
    expect(seen.length).toBe(4);
    expect(seen[seen.length - 1]).toEqual([4, 4]);
  });
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
