// `npm run test:perf` (S01, extended by S36): runs the perf suites with
// SHOWRECEIPTS_PERF=1 set in the child environment (portable: no shell
// `VAR=1` syntax in npm scripts) and forwards any extra argv to vitest.
//
// S36 additions:
//   - SHOWRECEIPTS_PERF_TOLERANCE multiplies every time budget (and divides
//     every rate floor) inside the suites; default 1 locally, 3 under CI.
//     The resolved value is exported to the children and printed up front —
//     the per-suite numbers (MB/s, ms, RSS) are printed by the tests
//     themselves and recorded in docs/decisions.md ("S36 perf numbers").
//   - a second vitest pass runs the seeded reader fuzz at its 50,000-line
//     perf depth (test/fuzz reads SHOWRECEIPTS_PERF to pick the sample size).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
if (!existsSync(vitest)) {
  process.stderr.write('perf: vitest is not installed (run npm ci)\n');
  process.exit(1);
}

const ci = process.env.CI !== undefined && process.env.CI !== '' && process.env.CI !== 'false';
const tolerance = process.env.SHOWRECEIPTS_PERF_TOLERANCE ?? (ci ? '3' : '1');
const env = { ...process.env, SHOWRECEIPTS_PERF: '1', SHOWRECEIPTS_PERF_TOLERANCE: tolerance };

process.stdout.write(`perf: tolerance ×${tolerance}${ci ? ' (CI)' : ''}; numbers print per suite\n`);
process.stdout.write(
  [
    'perf: budgets (time/memory caps × tolerance, rate floors ÷ tolerance):',
    '  jsonl splitter       >= 60 MB/s over the 60 MB file',
    '  full parse (60 MB)   >= 20 MB/s hard (warn < 40, target 60); peak V8 < 400 MB (rss ceiling 800 MB)',
    '  warm loadSessions    < 300 ms over 50 generated sessions',
    '  spawned audit        <= 500 ms warm over the fixture tree (best of 5; see docs/decisions.md)',
    '  --version            <= 80 ms (best of 3)',
    '  Stop resume          < 250 ms over 100 appended lines (anchor round-trip floor; see docs/decisions.md)',
    '  report               500 cards + 50 timelines: data block <= 5 MB, build < 2 s',
    '  fuzz depth           50,000 sampled lines (10,000 in plain npm test)',
  ].join('\n') + '\n',
);

// --no-file-parallelism: the suites measure wall time, so they must not
// compete with each other for cores (parallel forks skewed --version by ~2×).
const perf = spawnSync(process.execPath, [vitest, 'run', '--config', 'vitest.perf.config.ts', '--no-file-parallelism', ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env,
});

// Fuzz depth (S36 instruction 4): the same seeded reader fuzz, at 50,000
// sampled lines instead of 10,000. Skipped when the caller filtered the perf
// run down to specific files.
let fuzz = { status: 0 };
if (process.argv.length === 2) {
  process.stdout.write('perf: fuzz depth pass (50,000 sampled lines)\n');
  fuzz = spawnSync(process.execPath, [vitest, 'run', '--config', 'vitest.config.ts', 'test/fuzz'], {
    cwd: root,
    stdio: 'inherit',
    env,
  });
}

process.exit(perf.status !== 0 ? (perf.status ?? 1) : (fuzz.status ?? 1));
