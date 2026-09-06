import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { TOOL_VERSION } from '../../src/version.js';
import { pinnedEnv } from '../helpers/env.js';
import { NETGUARD_PATH, runCli } from '../helpers/spawn.js';

const RUNS = 10;
const BUDGET_MS = 80;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

/** Runs a snippet under the netguard exactly as CLI children do and returns its stderr. */
function underGuard(code: string, esm = false): { status: number | null; stderr: string } {
  const args = esm ? ['--input-type=module', '-e', code] : ['-e', code];
  const result = spawnSync(process.execPath, args, {
    env: { ...pinnedEnv(), NODE_OPTIONS: `--require "${NETGUARD_PATH}"` },
    encoding: 'utf8',
    timeout: 20_000,
  });
  return { status: result.status, stderr: result.stderr };
}

describe('node dist/cli.js --version', () => {
  it(`prints ${TOOL_VERSION}; the ${BUDGET_MS} ms median is a recorded soft budget (×10 pathology ceiling)`, () => {
    const times: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const result = runCli(['--version']);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(`${TOOL_VERSION}\n`);
      expect(result.stderr).toBe('');
      times.push(result.ms);
    }
    const budget = process.env['CI'] ? BUDGET_MS * 3 : BUDGET_MS;
    const med = median(times);
    // S26: the ≤ 80 ms gate is soft here — recorded only. The hard serial
    // gate is scripts/perf.mjs (`npm run test:perf`), which also documents
    // that parallel forks skew this spawn-latency measurement ~2×. Under
    // full-suite load the old ×3 ceiling still flaked (median 565 ms seen in
    // 1 of 3 runs on a busy machine), so the assertion here is a pure
    // pathology stop at ×10 — a real regression still fails test:perf.
    console.info(`[S26 perf] --version median ${med.toFixed(1)} ms over ${RUNS} runs (soft budget ${budget} ms)`);
    expect(med, `median ${med.toFixed(1)} ms over ${RUNS} runs (ceiling ${budget * 10} ms); samples: ${times.map((t) => t.toFixed(0)).join(', ')}`).toBeLessThanOrEqual(budget * 10);
  });

  it('--help prints the §12.4 screen end-to-end', () => {
    const result = runCli(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout.startsWith('showreceipts — your coding agent said "done". Show receipts.\n')).toBe(true);
  });
});

describe('netguard', () => {
  it('blocks fetch, http (CommonJS and ESM), net and dns in a child armed like the CLI', () => {
    const cases: [string, string, boolean][] = [
      ['fetch', "fetch('http://127.0.0.1:9/')", false],
      ['http.get (require)', "require('node:http').get('http://127.0.0.1:9/')", false],
      ['https.request (require)', "require('https').request('https://127.0.0.1:9/')", false],
      ['tls.connect (require)', "require('node:tls').connect(9, '127.0.0.1')", false],
      ['net.connect', "require('net').connect(9, '127.0.0.1')", false],
      ['new net.Socket().connect', "new (require('net').Socket)().connect(9, '127.0.0.1')", false],
      ['dns.lookup', "require('dns').lookup('example.invalid', () => {})", false],
      ['dns.promises.resolve4', "require('dns').promises.resolve4('example.invalid')", false],
      ['http.get (ESM import)', "import http from 'node:http'; http.get('http://127.0.0.1:9/')", true],
      ['net.connect (ESM import)', "import { connect } from 'node:net'; connect(9, '127.0.0.1')", true],
    ];
    for (const [label, code, esm] of cases) {
      const result = underGuard(code, esm);
      expect(result.status, label).not.toBe(0);
      expect(result.stderr, label).toContain('network blocked by netguard');
    }
  });

  it('leaves everything else working', () => {
    const result = underGuard("require('node:fs').statSync('.'); require('node:os').tmpdir(); process.stdout.write('ok')");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});
