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
import { runShadowPass, runCalendarSync, runContactSync, runFileSync } from '@openmig/core';
import type { TenantId, MappingId } from '@openmig/shared';
import { buildDepsFromMapping, buildDomainDepsFromMapping } from '../build-deps-from-mapping';
import { 
  withTenant, 
  PgMigrationStatusStore,
  recordComputeForRun,
  recordApiCallForRun,
} from '@openmig/ledger';

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

// Pricing configuration (should come from config/env in production)
const PRICING = {
  computePricePerHour: 5, // €0.05/hour
};

/**
 * Get current billing period dates
 */
function getCurrentPeriod(): { periodStart: string; periodEnd: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-11
  
  const periodStart = `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month + 1, 0).getDate();
  const periodEnd = `${year}-${String(month + 1).padStart(2, '0')}-${lastDay}`;
  
  return { periodStart, periodEnd };
}

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
      const { periodStart, periodEnd } = getCurrentPeriod();

      for (const domain of domains) {
        console.log(`Running delta sync for domain: ${domain}`);

        try {
          if (domain === 'email') {
            // SECURITY: Build deps with tenant scoping (RLS enforced).
            // buildDepsFromMapping wraps all DB ops in withTenant() and manages
            // the email domain's migration_status itself.
            const deps = await buildDepsFromMapping(pool, tenantId, mappingId);
            const result = await runShadowPass(deps);
            console.log(`Mail sync completed: ${result.created} created, ${result.skipped} skipped`);
          } else {
            // Native DAV domains (calendar/contact/file) via the generalized
            // domain-sync loop. Track migration_status explicitly (mirrors the
            // worker's runAllDomains) so status pages + metering see the run.
            await withTenant(pool, tenantId, async (db) => {
              await new PgMigrationStatusStore(db).markInProgress(tenantId, mappingId, domain);
            });
            let result: { created: number; skipped: number };
            if (domain === 'calendar') {
              result = await runCalendarSync(await buildDomainDepsFromMapping(pool, tenantId, mappingId, 'calendar'));
            } else if (domain === 'contact') {
              result = await runContactSync(await buildDomainDepsFromMapping(pool, tenantId, mappingId, 'contact'));
            } else {
              result = await runFileSync(await buildDomainDepsFromMapping(pool, tenantId, mappingId, 'file'));
            }
            await withTenant(pool, tenantId, async (db) => {
              await new PgMigrationStatusStore(db).markCompleted(tenantId, mappingId, domain);
            });
            console.log(`${domain} sync completed: ${result.created} created, ${result.skipped} skipped`);
          }

          // Metering (all domains): record compute + one sync op from the run's
          // migration_status timing. Guarded — skips cleanly if status is absent.
          await withTenant(pool, tenantId, async (db) => {
            const statusStore = new PgMigrationStatusStore(db);
            const statusList = await statusStore.getStatus(tenantId, mappingId);
            const domainStatus = statusList.find((s) => s.domain === domain);
            if (domainStatus && domainStatus.completedAt) {
              await recordComputeForRun(db, {
                tenantId,
                mappingId,
                domain,
                startedAt: new Date(domainStatus.startedAt),
                completedAt: new Date(domainStatus.completedAt),
                periodStart,
                periodEnd,
              }, PRICING);
              await recordApiCallForRun(db, { tenantId, mappingId, domain, periodStart, periodEnd });
            }
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          console.error(`Domain ${domain} sync failed:`, errorMessage);
          // Mark the domain failed (best-effort) before surfacing the error.
          if (domain !== 'email') {
            try {
              await withTenant(pool, tenantId, async (db) => {
                await new PgMigrationStatusStore(db).markFailed(tenantId, mappingId, domain, errorMessage);
              });
            } catch (statusErr) {
              console.error('Failed to mark domain status failed:', statusErr);
            }
          }
          // Re-throw so Trigger.dev records the failure (hard rule 9 — no masking).
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
