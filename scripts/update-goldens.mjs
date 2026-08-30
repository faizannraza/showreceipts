// `npm run goldens:update`: re-runs the golden and render suites with
// UPDATE_GOLDENS=1 so they rewrite their expected files; extra argv is
// forwarded to vitest (e.g. a path filter).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
if (!existsSync(vitest)) {
  process.stderr.write('update-goldens: vitest is not installed (run npm ci)\n');
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [vitest, 'run', '--config', 'vitest.config.ts', '--passWithNoTests', 'test/goldens', 'test/render', ...process.argv.slice(2)],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, UPDATE_GOLDENS: '1' },
  },
);
process.exit(result.status ?? 1);
