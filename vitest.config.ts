import { defineConfig } from 'vitest/config';

// Unit, golden, render and fuzz suites: in-process over `src/`, offline, never
// dependent on `dist/`. Coverage is opt-in (`npm test -- --coverage`); vitest 4
// has no `coverage.all`, so `include` names the files that count even when no
// test loads them. Per-file thresholds are glob keys; a key whose file does not
// exist yet passes vacuously.
export default defineConfig({
  test: {
    include: ['test/{unit,goldens,render,fuzz}/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    pool: 'forks',
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/demo/**'],
      thresholds: {
        lines: 85,
        branches: 75,
        'src/claims/rules.ts': { lines: 100 },
        'src/claims/extract.ts': { lines: 100 },
        'src/cost/cost.ts': { lines: 100 },
        'src/ledger/tests.ts': { lines: 100 },
        'src/hook/strict.ts': { lines: 100 },
        'src/reconcile/reconcile.ts': { lines: 100 },
      },
    },
  },
});
