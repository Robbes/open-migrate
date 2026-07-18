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
import { Pool } from 'pg';
import { runShadowPass } from '@openmig/core';
import type { TenantId, MappingId } from '@openmig/shared';
import { buildDepsFromMapping } from '../build-deps-from-mapping';

// Job input schema
const DeltaSyncJobSchema = z.object({
  tenantId: z.string().uuid(),
  mappingId: z.string().uuid(),
  domains: z.array(z.enum(['file', 'email', 'calendar', 'contact'])).optional(),
});

type DeltaSyncJobPayload = z.infer<typeof DeltaSyncJobSchema>;

// Database connection from environment
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

// Create a persistent pool for jobs
const pool = new Pool({ connectionString: DATABASE_URL });

// Register the job with Trigger.dev
export const runDeltaSync = schemaTask({
  id: 'run-delta-sync',
  description: 'Delta Sync',
  schema: DeltaSyncJobSchema,
  run: async (payload: unknown, _context) => {
    // Type assertion since schemaTask validates the payload
    const typedPayload = payload as DeltaSyncJobPayload;
    
    // SECURITY: Fail closed if tenantId missing
    if (!typedPayload.tenantId) {
      throw new Error('tenantId is required in job payload');
    }

    console.log('Starting delta sync', {
      tenantId: typedPayload.tenantId,
      mappingId: typedPayload.mappingId,
      domains: typedPayload.domains,
    });

    try {
      // Perform delta sync for each domain
      const domains = typedPayload.domains ?? ['email', 'calendar', 'contact', 'file'];
      const tenantId = typedPayload.tenantId as TenantId;
      const mappingId = typedPayload.mappingId as MappingId;

      for (const domain of domains) {
        console.log(`Running delta sync for domain: ${domain}`);

        try {
          if (domain === 'email') {
            // SECURITY: Build deps with tenant scoping (RLS enforced)
            // buildDepsFromMapping wraps all DB ops in withTenant()
            const deps = await buildDepsFromMapping(pool, tenantId, mappingId);
            
            // Run the actual shadow pass with real source/target
            const result = await runShadowPass(deps);

            console.log(`Mail sync completed: ${result.created} created, ${result.skipped} skipped`);
            
            // Status is already updated within buildDepsFromMapping's withTenant context
            // The ledger client is already scoped
          } else {
            // Other domains (calendar, contact, file) - stub for now
            console.log(`Domain ${domain} not yet implemented`);
            // TODO: Implement domain-specific sync with buildDomainDepsFromMapping
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          console.error(`Domain ${domain} sync failed:`, errorMessage);
          
          // Re-throw to let Trigger.dev handle the failure
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
      // Pool is persistent, don't close it
    }
  },
});
