import { defineConfig } from 'vitest/config';

// Performance suites: run through `scripts/perf.mjs`, which sets
// SHOWRECEIPTS_PERF=1; every perf test self-skips without it.
export default defineConfig({
  test: {
    include: ['test/perf/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    pool: 'forks',
    testTimeout: 120000,
    passWithNoTests: true,
  },
});
