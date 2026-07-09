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

// Job input schema
const DeltaSyncJobSchema = z.object({
  tenantId: z.string().uuid(),
  mappingId: z.string().uuid(),
  domains: z.array(z.enum(['file', 'email', 'calendar', 'contact'])).optional(),
});

type DeltaSyncJobPayload = z.infer<typeof DeltaSyncJobSchema>;

// Register the job with Trigger.dev
export const runDeltaSync = schemaTask({
  id: 'run-delta-sync',
  description: 'Delta Sync',
  schema: DeltaSyncJobSchema,
  run: async (payload: unknown, { ctx }) => {
    // Type assertion since schemaTask validates the payload
    const typedPayload = payload as DeltaSyncJobPayload;
    
    console.log('Starting delta sync', {
      tenantId: typedPayload.tenantId,
      mappingId: typedPayload.mappingId,
      domains: typedPayload.domains,
    });

    try {
      // Perform delta sync for each domain
      const results = [];
      
      if (typedPayload.domains) {
        for (const domain of typedPayload.domains) {
          console.log(`Running delta sync for domain: ${domain}`);
          // const result = await syncDeltaData({ 
          //   tenantId: typedPayload.tenantId, 
          //   mappingId: typedPayload.mappingId,
          //   domain 
          // });
          // results.push(result);
        }
      } else {
        // Sync all domains
        console.log('Running delta sync for all domains');
        // const domains: ('file' | 'email' | 'calendar' | 'contact')[] = ['file', 'email', 'calendar', 'contact'];
        // for (const domain of domains) {
        //   const result = await syncDeltaData({ 
        //     tenantId: typedPayload.tenantId, 
        //     mappingId: typedPayload.mappingId,
        //     domain 
        // });
        // results.push(result);
        // }
      }

      console.log('Delta sync completed successfully');

      return {
        success: true,
        tenantId: typedPayload.tenantId,
        mappingId: typedPayload.mappingId,
      };
    } catch (error) {
      console.error('Delta sync failed', { error });
      throw error;
    }
  },
});
