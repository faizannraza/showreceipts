// `npm run test:perf`: runs the perf suites with SHOWRECEIPTS_PERF=1 set in the
// child environment (portable: no shell `VAR=1` syntax in npm scripts) and
// forwards any extra argv to vitest. S36 adds the tolerance multiplier and
// the numbers table.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
if (!existsSync(vitest)) {
  process.stderr.write('perf: vitest is not installed (run npm ci)\n');
  process.exit(1);
}

const result = spawnSync(process.execPath, [vitest, 'run', '--config', 'vitest.perf.config.ts', ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, SHOWRECEIPTS_PERF: '1' },
});
process.exit(result.status ?? 1);
