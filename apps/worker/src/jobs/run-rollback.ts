/**
 * Rollback Job
 *
 * Reverts a migration to its previous state.
 * This includes:
 * - Restoring original data sources
 * - Reverting DNS/MX records
 * - Notifying users of the rollback
 *
 * Trigger: Manual (user-initiated)
 */

import { z } from 'zod';
import { schemaTask } from '@trigger.dev/sdk';
import { CutoverStore } from '@openmig/ledger';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import * as schemaPg from '@openmig/ledger/schema-pg';
import { asTenantId, asMappingId } from '@openmig/shared';

// Job input schema
const RollbackJobSchema = z.object({
  tenantId: z.string().uuid(),
  mappingId: z.string().uuid(),
  reason: z.string(),
  options: z.object({
    restoreDns: z.boolean().default(true),
    notifyUsers: z.boolean().default(true),
    dnsDomain: z.string().optional(),
  }).default({}),
});

type RollbackJobPayload = z.infer<typeof RollbackJobSchema>;

// Register the job with Trigger.dev
export const runRollback = schemaTask({
  id: 'run-rollback',
  description: 'Rollback',
  schema: RollbackJobSchema,
  run: async (payload: unknown, { ctx }) => {
    const typedPayload = payload as RollbackJobPayload;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctxTyped = ctx as any;
    const { tenantId, mappingId, reason, options } = typedPayload;
    
    console.log('Starting rollback process', {
      tenantId,
      mappingId,
      reason,
      options,
    });

    // Initialize database
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      throw new Error('DATABASE_URL environment variable required');
    }
    const pool = new Pool({ connectionString: dbUrl });
    const db = drizzle(pool, { schema: schemaPg });
    const cutoverPersistence = new CutoverStore(db);

    try {
      // Step 0: Load current cutover state
      const state = await cutoverPersistence.loadCutoverState(asTenantId(tenantId), asMappingId(mappingId));
      if (!state) {
        throw new Error('No cutover state found - nothing to rollback');
      }
      
      await ctxTyped.logger.log(`Rolling back cutover from state: ${state.currentState || state.state}`);
      await ctxTyped.logger.log(`Reason: ${reason}`);

      // Step 1: DNS is DEFERRED by owner decision (verify-only DNS, 2026-07-16 —
      // deSEC provider writes not implemented). Do not claim a restore that did
      // not happen; the operator reverts the MX record manually.
      if (options.restoreDns && options.dnsDomain) {
        await ctxTyped.logger.log(
          `DNS restore for ${options.dnsDomain} is DEFERRED (verify-only DNS) — revert the MX record manually.`,
        );
      }

      // Step 2: Reactivate the mapping so shadow sync resumes with the original
      // source authoritative again (the real, in-scope rollback action).
      console.log('Reactivating mapping (status → active)');
      await ctxTyped.logger.log('Reactivating mapping so shadow sync resumes...');
      await db
        .update(schemaPg.mailboxMapping)
        .set({ status: 'active', updatedAt: new Date() })
        .where(
          and(
            eq(schemaPg.mailboxMapping.id, mappingId),
            eq(schemaPg.mailboxMapping.tenantId, tenantId),
          ),
        );

      // Step 3: Update cutover status to ROLLED_BACK
      console.log('Marking cutover as rolled back');
      await cutoverPersistence.transitionState(asTenantId(tenantId), asMappingId(mappingId), 'ROLLED_BACK', {
        rolledBackAt: new Date().toISOString(),
        rolledBackBy: 'trigger-job',
        rollbackReason: reason,
      });
      await ctxTyped.logger.log('Cutover marked as rolled back');

      // Step 4: User notification is not yet implemented — say so, don't fake it.
      if (options.notifyUsers) {
        await ctxTyped.logger.log('User notification requested but not yet implemented — skipping.');
      }

      // Step 5: Cancel any pending tasks
      console.log('Cancelling pending tasks');
      await ctxTyped.logger.log('Cancelling pending tasks...');
      // TODO: Cancel grace period if scheduled
      await ctxTyped.cancel({
        id: `grace-period-${mappingId}`,
      });
      await ctxTyped.logger.log('Pending tasks cancelled');

      console.log('Rollback completed successfully');
      await ctxTyped.logger.log('Rollback completed successfully');

      return {
        success: true,
        tenantId,
        mappingId,
        reason,
        rolledBackAt: new Date().toISOString(),
      };
    } catch (error) {
      const err = error as Error;
      console.error('Rollback failed', { error: err.message });
      await ctxTyped.logger.log(`Rollback failed: ${err.message}`);

      // Try to log the failure even if rollback failed
      try {
        await cutoverPersistence.transitionState(asTenantId(tenantId), asMappingId(mappingId), 'FAILED', {
          failedAt: new Date().toISOString(),
          failureReason: `Rollback failed: ${err.message}`,
        });
      } catch (rollbackError) {
        console.error('Failed to update cutover status after rollback failure', { error: rollbackError });
      }

      throw error;
    }
  },
});
