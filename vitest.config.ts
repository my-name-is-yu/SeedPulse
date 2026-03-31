import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: '.',
    include: ['tests/**/*.test.ts', 'tests/test_*.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/types/**', 'src/tui/**'],
      reporter: ['text', 'text-summary', 'json', 'html'],
      reportsDirectory: 'coverage',
    },
  },
});
