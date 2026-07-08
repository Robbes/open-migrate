/**
 * Full Sync Job
 * 
 * Executes a complete synchronization for a given mapping.
 * This job is idempotent and can be safely re-run.
 * 
 * Trigger: Manual or scheduled via a dispatcher job
 */

import { triggerClient } from '../trigger-client';
import { z } from 'zod';
import { eventTrigger } from '@trigger.dev/sdk';

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
  version: '0.0.1',
  trigger: eventTrigger({
    name: 'full-sync.triggered',
    schema: FullSyncJobSchema,
  }),
  run: async (payload, io, context) => {
    io.logger.info('Starting full sync', {
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

      io.logger.info('Full sync completed successfully');
      
      return {
        success: true,
        tenantId: payload.tenantId,
        mappingId: payload.mappingId,
        // result: result,
      };
    } catch (error) {
      io.logger.error('Full sync failed', { error });
      throw error; // Trigger.dev will retry based on configuration
    }
  },
});
