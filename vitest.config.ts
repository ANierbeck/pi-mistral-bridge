import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['node_modules/**'],
      // Coverage floors per AGENTS.md §4: thresholds are set from the first
      // green real measurement and are NEVER lowered to unblock a run - add
      // tests instead. Measured 2026-11-24 on the T1-T4 implementation
      // (94 tests, 5 files): statements 88.74%, branches 78.91%,
      // functions 86.27%, lines 92.17% - floors are those rounded DOWN to
      // the integer: 88 / 78 / 86 / 92.
      thresholds: {
        statements: 88,
        branches: 78,
        functions: 86,
        lines: 92,
      },
    },
  },
});
