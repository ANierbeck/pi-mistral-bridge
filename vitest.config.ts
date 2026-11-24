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
      // tests instead. T1 ships src/index.ts as a placeholder stub, so the
      // floors start at 0.
      // TODO(T3+): raise statements/branches/functions/lines from the first
      // green measurement of the real implementation and never lower them.
      thresholds: {
        statements: 0,
        branches: 0,
        functions: 0,
        lines: 0,
      },
    },
  },
});
