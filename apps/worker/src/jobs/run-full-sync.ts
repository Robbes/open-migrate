/**
 * Full Sync Job
 *
 * Performs a complete sync of all data for a mapping.
 * This job is typically run:
 * - Initially when a new mapping is created
 * - After a rollback
 * - On-demand for re-sync
 *
 * Trigger: Manual or Scheduled (infrequent)
 *
 * DIFFERENCE FROM DELTA-SYNC:
 * - Full sync: Does NOT use cursors, scans ALL items from scratch
 * - Delta sync: Uses stored cursors, only scans items changed since last sync
 * 
 * Implementation: Pass undefined for cursors to runShadowPass, forcing a full scan.
 */

import { z } from 'zod';
import { schemaTask } from '@trigger.dev/sdk';
import { Pool } from 'pg';
import { runShadowPass } from '@openmig/core';
import type { TenantId, MappingId } from '@openmig/shared';
import { buildDepsFromMapping } from '../build-deps-from-mapping';

// Job input schema
const FullSyncJobSchema = z.object({
  tenantId: z.string().uuid(),
  mappingId: z.string().uuid(),
  options: z.object({
    maxItems: z.number().optional(),
    forceFullScan: z.boolean().default(true), // Always force full scan for full-sync job
  }).default({}),
});

type FullSyncJobPayload = z.infer<typeof FullSyncJobSchema>;

// Database connection from environment
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

// Create a persistent pool for jobs
const pool = new Pool({ connectionString: DATABASE_URL });

// Register the job with Trigger.dev
export const runFullSync = schemaTask({
  id: 'run-full-sync',
  description: 'Full Sync',
  schema: FullSyncJobSchema,
  run: async (payload: unknown, _context) => {
    // Type assertion since schemaTask validates the payload
    const typedPayload = payload as FullSyncJobPayload;
    
    // SECURITY: Fail closed if tenantId missing
    if (!typedPayload.tenantId) {
      throw new Error('tenantId is required in job payload');
    }

    console.log('Starting full sync', {
      tenantId: typedPayload.tenantId,
      mappingId: typedPayload.mappingId,
      options: typedPayload.options,
    });

    try {
      const tenantId = typedPayload.tenantId as TenantId;
      const mappingId = typedPayload.mappingId as MappingId;

      // Initialize status
      // Note: This needs to be done within withTenant context
      // For now, we'll let buildDepsFromMapping handle the initial status setup
      
      // SECURITY: Build deps with tenant scoping (RLS enforced)
      // Note: For full sync, we intentionally pass undefined for cursors
      // to force a complete rescan of all items
      const deps = await buildDepsFromMapping(pool, tenantId, mappingId);
      
      // Run the full shadow pass (without cursors = full scan)
      const result = await runShadowPass({
        ...deps,
        cursors: undefined, // Force full scan by not using cursors
      });

      console.log(`Full sync completed: ${result.scanned} scanned, ${result.created} created, ${result.skipped} skipped`);

      return {
        success: true,
        tenantId: typedPayload.tenantId,
        mappingId: typedPayload.mappingId,
        scanned: result.scanned,
        created: result.created,
        skipped: result.skipped,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Full sync failed:', errorMessage);
      throw error;
    }
  },
});
