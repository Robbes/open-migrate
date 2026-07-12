import { startTestEnvironment, stopTestEnvironment } from './packages/testing/src/testcontainers-setup.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function runMigration(postgresUrl: string): Promise<void> {
  const { Pool } = await import('pg');
  const { readdirSync } = await import('node:fs');

  // Retry logic for connection stability
  const maxRetries = 5;
  const baseDelay = 200; // ms

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const pool = new Pool({ connectionString: postgresUrl });

    try {
      const client = await pool.connect();
      try {
        await client.query(`SELECT pg_advisory_lock(727001)`);
        try {
          // Check if full schema exists by looking for cutover_state table (created in 0004)
          const result = await client.query<{ exists: boolean }>(`SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'cutover_state'
          ) as exists`);

          if (result.rows[0].exists) {
            console.log('[Migration] Full schema already exists, skipping.');
            return;
          }

          // Drop all tables if partial schema exists (for clean test runs)
          const tablesResult = await client.query<{ tablename: string }>(`
            SELECT tablename FROM pg_tables WHERE schemaname = 'public'
          `);
          
          if (tablesResult.rows.length > 0) {
            console.log('[Migration] Partial schema detected, dropping all tables for clean state...');
            const tableNames = tablesResult.rows.map((r: { tablename: string }) => r.tablename).join(', ');
            console.log(`[Migration] Dropping tables: ${tableNames}`);
            await client.query(`DROP TABLE IF EXISTS ${tablesResult.rows.map((r: { tablename: string }) => `"${r.tablename}"`).join(', ')} CASCADE`);
          }

          // Run all migrations in order
          const migrationsDir = join(__dirname, 'packages/ledger/migrations');
          const migrationFiles = readdirSync(migrationsDir)
            .filter(f => f.endsWith('.sql'))
            .sort();

          console.log('[Migration] Running ledger schema migrations...');
          for (const migrationFile of migrationFiles) {
            const migrationPath = join(migrationsDir, migrationFile);
            const migrationSql = readFileSync(migrationPath, 'utf-8');
            console.log(`[Migration] Running ${migrationFile}...`);
            await client.query(migrationSql);
          }
          console.log('[Migration] All schema migrations complete.');
          return; // Success
        } finally {
          await client.query(`SELECT pg_advisory_unlock(727001)`);
          client.release();
        }
      } finally {
        await pool.end();
      }
    } catch (err) {
      const error = err as Error;
      console.warn(`[Migration] Attempt ${attempt}/${maxRetries} failed: ${error.message}`);

      if (attempt === maxRetries) {
        // Re-throw the original error to preserve the cause chain
        throw error;
      }

      // Exponential backoff
      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.log(`[Migration] Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

export default async function () {
  console.log('[Vitest Global Setup] Starting Testcontainers environment...');
  
  // Detect which test project is running via environment variable
  // CI workflows should set SKIP_STALWART=true for unit tests
  const skipStalwart = process.env.SKIP_STALWART === 'true';
  // Skip Nextcloud by default unless explicitly configured - DAV tests will skip themselves if not available
  const skipNextcloud = process.env.SKIP_NEXTCLOUD === 'true' || !process.env.NEXTCLOUD_WEBDAV_URL;
  
  if (skipStalwart) {
    console.log('[Vitest Global Setup] Skipping Stalwart (unit test mode via SKIP_STALWART).');
  }
  
  if (skipNextcloud) {
    console.log('[Vitest Global Setup] Skipping Nextcloud (via SKIP_NEXTCLOUD or NEXTCLOUD_WEBDAV_URL not set).');
  }
  
  // Skip Stalwart for unit tests - they don't need it and it requires stalwart-cli
  const testEnv = await startTestEnvironment(skipStalwart, skipNextcloud);

  process.env.TEST_DATABASE_URL = testEnv.postgres.connectionString;

  await runMigration(testEnv.postgres.connectionString);

  if (testEnv.stalwart) {
    process.env.STALWART_IMAP_HOST = testEnv.stalwart.imapHost;
    process.env.STALWART_IMAP_PORT = String(testEnv.stalwart.imapPort);
    process.env.STALWART_JMAP_URL = testEnv.stalwart.jmapUrl;
    process.env.STALWART_JMAP_USERNAME = testEnv.stalwart.jmapUsername;
    process.env.STALWART_JMAP_PASSWORD = testEnv.stalwart.jmapPassword;
  }

  if (testEnv.nextcloud) {
    process.env.NEXTCLOUD_WEBDAV_URL = testEnv.nextcloud.webdavUrl;
    process.env.NEXTCLOUD_USERNAME = testEnv.nextcloud.username;
    process.env.NEXTCLOUD_PASSWORD = testEnv.nextcloud.password;
  }

  console.log('[Vitest Global Setup] Testcontainers environment ready.');
  console.log(`  - DATABASE_URL: ${testEnv.postgres.connectionString}`);

  if (testEnv.stalwart) {
    console.log(`  - STALWART_JMAP_URL: ${testEnv.stalwart.jmapUrl}`);
    console.log(`  - STALWART_IMAP: ${testEnv.stalwart.imapHost}:${testEnv.stalwart.imapPort}`);
  } else {
    console.log('  - Stalwart: Skipped');
  }

  if (testEnv.nextcloud) {
    console.log(`  - NEXTCLOUD_WEBDAV: ${testEnv.nextcloud.webdavUrl}`);
  } else {
    console.log('  - Nextcloud: Skipped');
  }

  return async (error?: Error) => {
    console.log('[Vitest Global Teardown] Cleaning up Testcontainers...');
    
    // Capture diagnostics if there was an error and stalwart exists
    if (error && testEnv.stalwart) {
      console.error('[Vitest Global Teardown] Test failed with error:', error.message);
      console.error('[Vitest Global Teardown] Capturing diagnostics...');
      try {
        // Capture Stalwart diagnostics
        const { captureContainerDiagnostics } = await import('./packages/testing/src/testcontainers-setup.js');
        await captureContainerDiagnostics(
          testEnv.stalwart.container,
          'stalwart-phase2-error',
          ['ps aux', 'df -h', 'cat /etc/stalwart/config.json 2>/dev/null || echo "no config"', 'ls -la /opt/stalwart/data/']
        );
      } catch (diagErr) {
        const msg = diagErr instanceof Error ? diagErr.message : String(diagErr);
        console.warn('[Vitest Global Teardown] Could not capture diagnostics:', msg);
      }
    }
    
    await stopTestEnvironment(testEnv);
    console.log('[Vitest Global Teardown] Cleanup complete.');
  };
}
