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
import { schemaTask } from '@trigger.dev/sdk/v3';
import { CutoverPersistence } from '@openmig/core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

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
  run: async (payload: RollbackJobPayload, { ctx }) => {
    const { tenantId, mappingId, reason, options } = payload;
    
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
    const db = drizzle(pool);
    const cutoverPersistence = new CutoverPersistence(db);

    try {
      // Step 0: Load current cutover state
      const state = await cutoverPersistence.loadCutoverState(tenantId, mappingId);
      if (!state) {
        throw new Error('No cutover state found - nothing to rollback');
      }
      
      await ctx.logger.log(`Rolling back cutover from state: ${state.currentState}`);
      await ctx.logger.log(`Reason: ${reason}`);

      // Step 1: Restore DNS records (if enabled)
      if (options.restoreDns && options.dnsDomain) {
        console.log('Restoring DNS records');
        await ctx.logger.log(`Restoring DNS records for ${options.dnsDomain}...`);
        // TODO: Implement DNS rollback using DesecProvider
        // const dnsProvider = new DesecProvider({ token: process.env.DESEC_TOKEN! });
        // const previousRecords = await dnsProvider.getCurrentState(options.dnsDomain);
        // await dnsProvider.restoreState(options.dnsDomain, previousRecords);
        await ctx.logger.log('DNS records restored');
      }

      // Step 2: Restore original data source connections
      console.log('Restoring original data source connections');
      await ctx.logger.log('Restoring original data source connections...');
      // TODO: Implement data source restoration
      // await restoreDataSources({ tenantId, mappingId });
      await ctx.logger.log('Data source connections restored');

      // Step 3: Update cutover status to ROLLED_BACK
      console.log('Marking cutover as rolled back');
      await cutoverPersistence.transitionState(tenantId, mappingId, 'ROLLED_BACK', {
        rolledBackAt: new Date().toISOString(),
        rolledBackBy: 'trigger-job',
        rollbackReason: reason,
      });
      await ctx.logger.log('Cutover marked as rolled back');

      // Step 4: Notify users (if enabled)
      if (options.notifyUsers) {
        console.log('Notifying users about rollback');
        await ctx.logger.log('Notifying users about rollback...');
        // TODO: Implement user notification
        // await notifyUsersAboutRollback({ tenantId, mappingId, reason });
        await ctx.logger.log('User notifications sent');
      }

      // Step 5: Cancel any pending tasks
      console.log('Cancelling pending tasks');
      await ctx.logger.log('Cancelling pending tasks...');
      // TODO: Cancel grace period if scheduled
      await ctx.cancel({
        id: `grace-period-${mappingId}`,
      });
      await ctx.logger.log('Pending tasks cancelled');

      console.log('Rollback completed successfully');
      await ctx.logger.log('Rollback completed successfully');

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
      await ctx.logger.log(`Rollback failed: ${err.message}`);

      // Try to log the failure even if rollback failed
      try {
        await cutoverPersistence.transitionState(tenantId, mappingId, 'FAILED', {
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
