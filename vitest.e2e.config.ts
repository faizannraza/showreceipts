import { defineConfig } from 'vitest/config';

// End-to-end, hook-contract and setup suites: every test here spawns
// `dist/cli.js` (see test/helpers/spawn.ts), so `npm run test:e2e` builds first.
// `passWithNoTests` keeps the script green before the first suite exists.
export default defineConfig({
  test: {
    include: ['test/{hooks,setup,e2e}/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    pool: 'forks',
    testTimeout: 60000,
    passWithNoTests: true,
  },
});
