import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

const rootDir = resolve(__dirname);

export default defineConfig({
  resolve: {
    alias: {
      '@openmig/shared': resolve(rootDir, 'packages/shared/src/index.ts'),
      '@openmig/ledger': resolve(rootDir, 'packages/ledger/src/index.ts'),
      '@openmig/core': resolve(rootDir, 'packages/core/src/index.ts'),
      '@openmig/connectors': resolve(rootDir, 'packages/connectors/src/index.ts'),
      '@openmig/scheduler': resolve(rootDir, 'packages/scheduler/src/index.ts'),
    },
  },
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
