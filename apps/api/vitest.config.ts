import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

// API unit tests run in a plain Node env with NO Testcontainers global setup.
// (Integration tests — *.integration.test.ts — run via the root vitest project
// which brings up Postgres.)
const rootDir = resolve(__dirname, '..', '..');

export default defineConfig({
  resolve: {
    alias: {
      '@openmig/shared': resolve(rootDir, 'packages/shared/src/index.ts'),
      '@openmig/ledger': resolve(rootDir, 'packages/ledger/src/index.ts'),
      '@openmig/core': resolve(rootDir, 'packages/core/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.unit.test.ts'],
  },
});
