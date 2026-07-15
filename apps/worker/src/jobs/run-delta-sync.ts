/**
 * Delta Sync Job
 *
 * Performs an incremental sync of changes since the last sync.
 * This job is typically run on a frequent schedule (e.g., every 5-15 minutes).
 *
 * Trigger: Scheduled (cron)
 */

import { z } from 'zod';
import { schemaTask } from '@trigger.dev/sdk/v3';
import { createPgDb, PgLedger, PgCursorStore, PgMigrationStatusStore } from '@openmig/ledger';
import { runShadowPass, type ReconcileDeps } from '@openmig/core';
import type { SourceConnector, TargetWriter, TenantId, MappingId } from '@openmig/shared';

// Job input schema
const DeltaSyncJobSchema = z.object({
  tenantId: z.string().uuid(),
  mappingId: z.string().uuid(),
  domains: z.array(z.enum(['file', 'email', 'calendar', 'contact'])).optional(),
});

type DeltaSyncJobPayload = z.infer<typeof DeltaSyncJobSchema>;

// Database connection string from environment
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

// Register the job with Trigger.dev
export const runDeltaSync = schemaTask({
  id: 'run-delta-sync',
  description: 'Delta Sync',
  schema: DeltaSyncJobSchema,
  run: async (payload: unknown, _context) => {
    // Type assertion since schemaTask validates the payload
    const typedPayload = payload as DeltaSyncJobPayload;
    
    console.log('Starting delta sync', {
      tenantId: typedPayload.tenantId,
      mappingId: typedPayload.mappingId,
      domains: typedPayload.domains,
    });

    // Initialize database and status store
    const db = createPgDb(DATABASE_URL);
    const statusStore = new PgMigrationStatusStore(db);
    const ledger = new PgLedger(db);
    const cursors = new PgCursorStore(db);

    try {
      // Perform delta sync for each domain
      const domains = typedPayload.domains ?? ['email', 'calendar', 'contact', 'file'];
      const tenantId = typedPayload.tenantId as TenantId;
      const mappingId = typedPayload.mappingId as MappingId;

      for (const domain of domains) {
        console.log(`Running delta sync for domain: ${domain}`);

        // Initialize status for this domain
        await statusStore.initDomainStatus(tenantId, mappingId, domain);
        await statusStore.markInProgress(tenantId, mappingId, domain);

        try {
          if (domain === 'email') {
            // Mail sync using runShadowPass
            // Note: This is a placeholder - actual source/target creation needs proper config
            const source = null as unknown as SourceConnector;
            const target = null as unknown as TargetWriter;
            const result = await runShadowPass({
              tenantId,
              mappingId,
              source,
              target,
              ledger,
              cursors,
            } as ReconcileDeps);

            console.log(`Mail sync completed: ${result.created} created, ${result.skipped} skipped`);
            await statusStore.markCompleted(tenantId, mappingId, domain);
          } else {
            // Other domains (calendar, contact, file) - stub for now
            console.log(`Domain ${domain} not yet implemented`);
            await statusStore.markSkipped(tenantId, mappingId, domain);
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          console.error(`Domain ${domain} sync failed:`, errorMessage);
          await statusStore.markFailed(tenantId, mappingId, domain, errorMessage);
          throw error;
        }
      }

      console.log('Delta sync completed successfully');

      return {
        success: true,
        tenantId: typedPayload.tenantId,
        mappingId: typedPayload.mappingId,
      };
    } finally {
      await db.close();
    }
  },
});
