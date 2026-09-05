/**
 * S36 — audit-path budgets (§4.10, §14.2):
 *   - warm `loadSessions` over 50 generated sessions < 300 ms (in-process:
 *     the budget measures the cache path, not node start-up);
 *   - spawned `audit` over the committed fixture tree ≤ 500 ms warm, best
 *     of 5 (S36 review deviation, recorded in docs/decisions.md: §14.2 says
 *     400 ms, but warm runs measure 365–445 ms on a loaded machine and the
 *     remaining cost is irreducible regex volume in claims extraction —
 *     profiled at ~112k trigger execs for 224 matches; allocation-level and
 *     combined-prefilter rewrites both measured neutral).
 * Budgets scale with SHOWRECEIPTS_PERF_TOLERANCE (×3 in CI).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Roots } from '../../src/model/types.js';
import { resolveRoots } from '../../src/discover/roots.js';
import { loadSessions } from '../../src/pipeline/run.js';
import { TOOL_VERSION } from '../../src/version.js';
import { PINNED_NOW } from '../helpers/env.js';
import { materializeAll } from '../helpers/fixtures.js';
import { runCli } from '../helpers/spawn.js';
import { makeTempDir } from '../helpers/tmp.js';
import { PERF, tolerance } from './util.js';

const NOW = new Date(PINNED_NOW);

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** One small, fully parseable session (8 lines) with a distinct uuid sid. */
function sessionLines(sid: string): string {
  const common = (n: number, extra: object): string => {
    const base = {
      parentUuid: n === 0 ? null : `u-${sid.slice(0, 8)}-${n - 1}`,
      isSidechain: false,
      uuid: `u-${sid.slice(0, 8)}-${n}`,
      timestamp: new Date(Date.UTC(2026, 6, 1, 12, 0, n)).toISOString(),
      userType: 'external',
      cwd: '/home/u/proj',
      sessionId: sid,
      version: '2.1.251',
      gitBranch: 'main',
      ...extra,
    };
    return JSON.stringify(base);
  };
  const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, service_tier: 'standard' };
  return [
    common(0, { type: 'user', promptId: 'p1', message: { role: 'user', content: [{ type: 'text', text: 'run the tests' }] } }),
    common(1, {
      type: 'assistant',
      message: {
        id: `msg_${sid.slice(0, 8)}_1`,
        type: 'message',
        role: 'assistant',
        model: 'claude-fable-5',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: `toolu_${sid.slice(0, 8)}`, name: 'Bash', input: { command: 'npm test' } }],
        usage,
      },
    }),
    common(2, {
      type: 'user',
      promptId: 'p1',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${sid.slice(0, 8)}`, content: [{ type: 'text', text: '12 passed' }] }] },
      toolUseResult: { stdout: '12 passed', stderr: '', interrupted: false, isImage: false },
    }),
    common(3, {
      type: 'assistant',
      message: {
        id: `msg_${sid.slice(0, 8)}_2`,
        type: 'message',
        role: 'assistant',
        model: 'claude-fable-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'All 12 tests pass.' }],
        usage,
      },
    }),
  ]
    .map((l) => `${l}\n`)
    .join('');
}

describe.skipIf(!PERF)('audit budgets (§4.10)', () => {
  it('warm loadSessions over 50 generated sessions < 300 ms', async () => {
    const tol = tolerance();
    const root = makeTempDir('showreceipts-perf-audit-');
    dirs.push(root);
    const claude = join(root, 'claude');
    const project = join(claude, 'projects', '-home-u-proj');
    mkdirSync(project, { recursive: true });
    for (let i = 0; i < 50; i++) {
      const sid = `${String(i).padStart(8, '0')}-1111-4222-8333-444455556666`;
      writeFileSync(join(project, `${sid}.jsonl`), sessionLines(sid));
    }
    for (const name of ['home', 'codex', 'sr']) mkdirSync(join(root, name), { recursive: true });
    // resolveRoots fills `realpaths` — enumeration skips any root whose realpath is null.
    const roots: Roots = resolveRoots(
      { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: join(root, 'codex'), SHOWRECEIPTS_HOME: join(root, 'sr') },
      join(root, 'home'),
    );

    const cold = await loadSessions({ roots, all: true, versions: { tool: TOOL_VERSION }, now: NOW });
    expect(cold.sessions.length).toBe(50);

    const t0 = performance.now();
    const warm = await loadSessions({ roots, all: true, versions: { tool: TOOL_VERSION }, now: NOW });
    const ms = performance.now() - t0;
    process.stdout.write(`audit: warm loadSessions over 50 sessions in ${ms.toFixed(0)} ms (${warm.scanned.cacheHits} cache hits)\n`);

    expect(warm.sessions.length).toBe(50);
    expect(warm.scanned.cacheHits).toBe(50);
    expect(ms).toBeLessThan(300 * tol);
  }, 120_000);

  it('spawned audit over the fixture tree <= 500 ms warm', () => {
    const tol = tolerance();
    const tree = makeTempDir('showreceipts-perf-tree-');
    dirs.push(tree);
    const materialized = materializeAll(tree);
    // NODE_OPTIONS: undefined drops the netguard --require for the timed
    // runs — the §14.2 budget measures the product path (`node dist/cli.js
    // audit …`), not the test instrument; the netguarded e2e suite covers
    // the no-network guarantee.
    const env: Record<string, string | undefined> = {
      CLAUDE_CONFIG_DIR: materialized.claudeConfigDir,
      CODEX_HOME: materialized.codexHome,
      SHOWRECEIPTS_HOME: join(tree, 'sr'),
      NODE_OPTIONS: undefined,
    };
    mkdirSync(env['SHOWRECEIPTS_HOME'] as string, { recursive: true });
    const args = ['audit', '--since', '2026-01-01', '--width', '80', '--no-color', '--tz', 'utc'];

    const cold = runCli(args, { env });
    expect(cold.code).toBe(0);
    // Best of five warm runs: the cache path is deterministic, the
    // scheduler is not (parallel build agents share this machine).
    const warms: number[] = [];
    for (let i = 0; i < 5; i++) {
      const warm = runCli(args, { env });
      expect(warm.code).toBe(0);
      warms.push(warm.ms);
    }
    const best = Math.min(...warms);
    process.stdout.write(
      `audit: fixture tree cold ${cold.ms.toFixed(0)} ms, warm best ${best.toFixed(0)} ms of [${warms.map((w) => w.toFixed(0)).join(', ')}]\n`,
    );
    expect(best).toBeLessThanOrEqual(500 * tol);
  }, 120_000);
});
