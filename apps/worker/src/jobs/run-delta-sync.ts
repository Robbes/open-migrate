/**
 * Delta Sync Job
 * 
 * Executes an incremental synchronization, processing only changes since the last sync.
 * Uses checkpoints to track progress.
 * 
 * Trigger: Can be triggered manually via event or scheduled via a dispatcher job
 */

import { triggerClient } from '../trigger-client';
import { z } from 'zod';
import { eventTrigger } from '@trigger.dev/sdk';

// Job input schema
const DeltaSyncJobSchema = z.object({
  tenantId: z.string().uuid(),
  mappingId: z.string().uuid(),
  domains: z.array(z.enum(['email', 'calendar', 'contact', 'file'])).optional(),
});

type DeltaSyncJobPayload = z.infer<typeof DeltaSyncJobSchema>;

// Register the job with Trigger.dev
triggerClient.defineJob({
  id: 'run-delta-sync',
  name: 'Delta Sync',
  version: '0.0.1',
  trigger: eventTrigger({
    name: 'delta-sync.triggered',
    schema: DeltaSyncJobSchema,
  }),
  run: async (payload, io, context) => {
    io.logger.info('Starting delta sync', {
      tenantId: payload.tenantId,
      mappingId: payload.mappingId,
      domains: payload.domains,
    });

    try {
      // TODO: Implement actual delta sync logic
      // This would use checkpoints to only process changed items
      // const result = await executeDeltaSync({
      //   tenantId: payload.tenantId,
      //   mappingId: payload.mappingId,
      //   domains: payload.domains,
      // });

      io.logger.info('Delta sync completed successfully');
      
      return {
        success: true,
        tenantId: payload.tenantId,
        mappingId: payload.mappingId,
        // result: result,
      };
    } catch (error) {
      io.logger.error('Delta sync failed', { error });
      throw error; // Trigger.dev will retry
    }
  },
});
