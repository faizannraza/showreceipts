/**
 * S36 — `showreceipts --version` cold-start budget (§15 npx gate): the
 * spawned CLI answers within 80 ms (× tolerance). The best of three runs is
 * taken — the budget targets the CLI, not the machine's scheduler noise.
 * (S01's e2e version test asserts correctness; this one asserts the budget
 * under the perf runner.)
 *
 * The §15 gate is `node dist/cli.js --version`, so the measurement drops the
 * test harness's netguard `--require` (a test instrument that inflates node
 * start-up by ~30 ms and is not part of the product). `--version` touches no
 * network path; the netguarded e2e suite covers that separately.
 */
import { describe, expect, it } from 'vitest';
import { runCli } from '../helpers/spawn.js';
import { PERF, tolerance } from './util.js';

describe.skipIf(!PERF)('--version budget (§15)', () => {
  it('answers within 80 ms (best of 3)', () => {
    const tol = tolerance();
    const env = { NODE_OPTIONS: undefined };
    runCli(['--version'], { env }); // warm the OS file cache
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = runCli(['--version'], { env });
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('0.1.0');
      times.push(r.ms);
    }
    const best = Math.min(...times);
    process.stdout.write(`version: best ${best.toFixed(0)} ms of [${times.map((t) => t.toFixed(0)).join(', ')}]\n`);
    expect(best).toBeLessThanOrEqual(80 * tol);
  });
});
