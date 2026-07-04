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
    exclude: ['node_modules', 'dist'],
    globalSetup: './vitest.global-setup.ts',
    testTimeout: 180000,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['**/*.unit.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['**/*.integration.test.ts'],
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['**/*.e2e.test.ts'],
        },
      },
    ],
  },
});
