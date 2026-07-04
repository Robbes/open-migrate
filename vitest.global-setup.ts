// Copyright 2026 OpenHands Agent (Apache-2.0)
// Vitest global setup for Testcontainers lifecycle management.

import { startTestEnvironment, stopTestEnvironment } from './packages/testing/src/testcontainers-setup.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Run the ledger schema migration exactly once.
 * Uses advisory lock to prevent concurrent execution.
 */
async function runMigration(postgresUrl: string): Promise<void> {
  const { default: postgres } = await import('postgres');
  const sql = postgres(postgresUrl);

  try {
    // Acquire advisory lock to prevent concurrent migrations
    await sql`SELECT pg_advisory_lock(727001)`;

    try {
      // Check if migration already completed (table exists)
      const exists = await sql`SELECT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'tenant'
      )`;
      
      if (exists[0].exists) {
        console.log('[Migration] Schema already exists, skipping.');
        return;
      }

      // Read and execute migration
      const migrationPath = join(__dirname, 'packages/ledger/migrations/0001_init.sql');
      const migrationSql = readFileSync(migrationPath, 'utf-8');

      console.log('[Migration] Running ledger schema migration...');
      await sql.unsafe(migrationSql);
      console.log('[Migration] Schema migration complete.');
    } finally {
      // Release advisory lock
      await sql`SELECT pg_advisory_unlock(727001)`;
    }
  } finally {
    await sql.end();
  }
}

export default async function () {
  console.log('[Vitest Global Setup] Starting Testcontainers environment...');
  const testEnv = await startTestEnvironment();

  // Export connection info as environment variables for tests to consume
  process.env.TEST_DATABASE_URL = testEnv.postgres.connectionString;

  // Run migration exactly once before any tests start
  await runMigration(testEnv.postgres.connectionString);

  if (testEnv.stalwart) {
    process.env.STALWART_IMAP_HOST = testEnv.stalwart.imapHost;
    process.env.STALWART_IMAP_PORT = String(testEnv.stalwart.imapPort);
    process.env.STALWART_JMAP_URL = testEnv.stalwart.jmapUrl;
    process.env.STALWART_JMAP_USERNAME = testEnv.stalwart.jmapUsername;
    process.env.STALWART_JMAP_PASSWORD = testEnv.stalwart.jmapPassword;
  }

  console.log('[Vitest Global Setup] Testcontainers environment ready.');
  console.log(`  - DATABASE_URL: ${testEnv.postgres.connectionString}`);

  if (testEnv.stalwart) {
    console.log(`  - STALWART_JMAP_URL: ${testEnv.stalwart.jmapUrl}`);
    console.log(`  - STALWART_IMAP: ${testEnv.stalwart.imapHost}:${testEnv.stalwart.imapPort}`);
  } else {
    console.log('  - STALWART: Not configured (JMAP/IMAP tests will fail if attempted)');
  }

  return async () => {
    console.log('[Vitest Global Teardown] Cleaning up Testcontainers...');
    await stopTestEnvironment(testEnv);
    console.log('[Vitest Global Teardown] Cleanup complete.');
  };
}
