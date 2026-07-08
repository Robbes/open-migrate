/**
 * Full Sync Job
 * 
 * Executes a complete synchronization for a given mapping.
 * This job is idempotent and can be safely re-run.
 * 
 * Trigger: Manual or scheduled via cron
 */

import { triggerClient } from '../trigger-client';
import { z } from 'zod';

// Job input schema
const FullSyncJobSchema = z.object({
  tenantId: z.string().uuid(),
  mappingId: z.string().uuid(),
  options: z.object({
    forceFullScan: z.boolean().default(false),
    maxItems: z.number().optional(),
  }).default({}),
});

type FullSyncJobPayload = z.infer<typeof FullSyncJobSchema>;

// Register the job with Trigger.dev
triggerClient.defineJob({
  id: 'run-full-sync',
  name: 'Full Sync',
  description: 'Execute a complete synchronization for a mapping',
  version: '0.0.1',
  trigger: triggerClient.cron({
    cron: '0 2 * * *', // Daily at 2 AM
    name: 'Daily Full Sync',
  }),
  inputSchema: FullSyncJobSchema,
  run: async (payload, { ctx, logger }) => {
    logger.info('Starting full sync', {
      tenantId: payload.tenantId,
      mappingId: payload.mappingId,
      options: payload.options,
    });

    try {
      // TODO: Implement actual sync logic
      // This would call the core migration engine
      // const result = await executeFullSync({
      //   tenantId: payload.tenantId,
      //   mappingId: payload.mappingId,
      //   ...payload.options,
      // });

      logger.info('Full sync completed successfully');
      
      return {
        success: true,
        tenantId: payload.tenantId,
        mappingId: payload.mappingId,
        // result: result,
      };
    } catch (error) {
      logger.error('Full sync failed', { error });
      throw error; // Trigger.dev will retry based on configuration
    }
  },
});
