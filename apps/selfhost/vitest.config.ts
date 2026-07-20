import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

// Self-host unit tests run in a plain Node env with NO Testcontainers global
// setup — config-dir loading + status formatting are pure and need no database.
const rootDir = resolve(__dirname, '..', '..');

export default defineConfig({
  resolve: {
    alias: {
      '@openmig/shared': resolve(rootDir, 'packages/shared/src/index.ts'),
      '@openmig/ledger': resolve(rootDir, 'packages/ledger/src/index.ts'),
      '@openmig/scheduler': resolve(rootDir, 'packages/scheduler/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,unit.test}.ts'],
  },
});
