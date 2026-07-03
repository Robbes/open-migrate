import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: { provider: 'v8', reportsDirectory: './coverage' },
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts'],
          exclude: ['**/*.integration.test.ts', '**/*.e2e.test.ts', '**/node_modules/**'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['**/*.integration.test.ts'],
          exclude: ['**/node_modules/**'],
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['**/*.e2e.test.ts'],
          exclude: ['**/node_modules/**'],
        },
      },
    ],
  },
});
