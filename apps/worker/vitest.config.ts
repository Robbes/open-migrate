import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

// Worker unit tests run in a plain Node env with NO Testcontainers global setup.
// These cover pure wiring (e.g. deps-lifecycle close semantics) that needs no DB.
const rootDir = resolve(__dirname, '..', '..');

export default defineConfig({
  resolve: {
    alias: {
      '@openmig/shared': resolve(rootDir, 'packages/shared/src/index.ts'),
      '@openmig/ledger': resolve(rootDir, 'packages/ledger/src/index.ts'),
      '@openmig/core': resolve(rootDir, 'packages/core/src/index.ts'),
      '@openmig/connectors': resolve(rootDir, 'packages/connectors/src/index.ts'),
      '@openmig/engines': resolve(rootDir, 'packages/engines/src/index.ts'),
      '@openmig/scheduler': resolve(rootDir, 'packages/scheduler/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.unit.test.ts'],
  },
});
