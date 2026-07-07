import { startTestEnvironment, stopTestEnvironment } from './packages/testing/src/testcontainers-setup.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function runMigration(postgresUrl: string): Promise<void> {
  const { default: postgres } = await import('postgres');
  
  // Retry logic for connection stability
  const maxRetries = 5;
  const baseDelay = 200; // ms
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const sql = postgres(postgresUrl);
    
    try {
      await sql`SELECT pg_advisory_lock(727001)`;
      try {
        const exists = await sql`SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'tenant'
        )`;

        if (exists[0].exists) {
          console.log('[Migration] Schema already exists, skipping.');
          return;
        }

        const migrationPath = join(__dirname, 'packages/ledger/migrations/0001_init.sql');
        const migrationSql = readFileSync(migrationPath, 'utf-8');

        console.log('[Migration] Running ledger schema migration...');
        await sql.unsafe(migrationSql);
        console.log('[Migration] Schema migration complete.');
        return; // Success
      } finally {
        await sql`SELECT pg_advisory_unlock(727001)`;
      }
    } catch (err) {
      const error = err as Error;
      console.warn(`[Migration] Attempt ${attempt}/${maxRetries} failed: ${error.message}`);
      
      if (attempt === maxRetries) {
        await sql.end();
        throw new Error(`Migration failed after ${maxRetries} attempts: ${error.message}`, { cause: error });
      }
      
      await sql.end();
      
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
  
  if (skipStalwart) {
    console.log('[Vitest Global Setup] Skipping Stalwart (unit test mode via SKIP_STALWART).');
  }
  
  // Skip Stalwart for unit tests - they don't need it and it requires stalwart-cli
  const testEnv = await startTestEnvironment(skipStalwart);

  process.env.TEST_DATABASE_URL = testEnv.postgres.connectionString;

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
    console.log('  - Stalwart: Skipped');
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
