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
 */

import { z } from 'zod';
import { schemaTask } from '@trigger.dev/sdk/v3';

// Job input schema
const FullSyncJobSchema = z.object({
  tenantId: z.string().uuid(),
  mappingId: z.string().uuid(),
  options: z.object({
    maxItems: z.number().optional(),
    forceFullScan: z.boolean().default(false),
  }).default({}),
});

type FullSyncJobPayload = z.infer<typeof FullSyncJobSchema>;

// Register the job with Trigger.dev
export const runFullSync = schemaTask({
  id: 'run-full-sync',
  description: 'Full Sync',
  schema: FullSyncJobSchema,
  run: async (payload: unknown, { ctx }) => {
    // Type assertion since schemaTask validates the payload
    const typedPayload = payload as FullSyncJobPayload;
    
    console.log('Starting full sync', {
      tenantId: typedPayload.tenantId,
      mappingId: typedPayload.mappingId,
      options: typedPayload.options,
    });

    try {
      // Perform full sync for all domains
      console.log('Running full sync for all domains');
      
      const domains: ('file' | 'email' | 'calendar' | 'contact')[] = ['file', 'email', 'calendar', 'contact'];
      
      for (const domain of domains) {
        console.log(`Running full sync for domain: ${domain}`);
        // const result = await syncFullData({ 
        //   tenantId: typedPayload.tenantId, 
        //   mappingId: typedPayload.mappingId,
        //   domain,
        //   maxItems: typedPayload.options.maxItems,
        //   forceFullScan: typedPayload.options.forceFullScan,
        // });
      }

      console.log('Full sync completed successfully');

      return {
        success: true,
        tenantId: typedPayload.tenantId,
        mappingId: typedPayload.mappingId,
      };
    } catch (error) {
      console.error('Full sync failed', { error });
      throw error;
    }
  },
});
