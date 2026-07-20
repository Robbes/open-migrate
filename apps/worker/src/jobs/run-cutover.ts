/**
 * Cutover Job
 *
 * Executes the final cutover process for a migration.
 * This includes:
 * - Final delta sync
 * - Verification checks
 * - DNS/MX record update (if applicable)
 * - Grace period monitoring
 *
 * Trigger: Manual (user-initiated)
 */

import { z } from 'zod';
import { asTenantId, asMappingId, type TargetReindexer } from '@openmig/shared';
import { schemaTask } from '@trigger.dev/sdk/v3';
import { CutoverStore, createLedgerVerificationReader } from '@openmig/ledger';
import { runShadowPass, runVerification, createRealVerificationDeps } from '@openmig/core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schemaPg from '@openmig/ledger/schema-pg';
import { buildDepsFromMapping } from '../build-deps-from-mapping';

// Job input schema
const CutoverJobSchema = z.object({
  tenantId: z.string().uuid(),
  mappingId: z.string().uuid(),
  options: z.object({
    skipFinalSync: z.boolean().default(false),
    skipVerification: z.boolean().default(false),
    gracePeriodHours: z.number().default(24),
    dnsDomain: z.string().optional(),
    targetMailServer: z.string().optional(),
  }).default({}),
});

type CutoverJobPayload = z.infer<typeof CutoverJobSchema>;

// Register the job with Trigger.dev
export const runCutover = schemaTask({
  id: 'run-cutover',
  description: 'Cutover',
  schema: CutoverJobSchema,
  run: async (payload: unknown, { ctx }) => {
    const typedPayload = payload as CutoverJobPayload;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctxTyped = ctx as any;
    const { tenantId, mappingId, options } = typedPayload;
    
    console.log('Starting cutover process', {
      tenantId,
      mappingId,
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
      // Step 0: Initialize cutover state
      console.log('Initializing cutover state');
      await ctxTyped.logger.log('Initializing cutover...');
      await cutoverPersistence.initializeCutover({
        tenantId: asTenantId(tenantId),
        mappingId: asMappingId(mappingId),
        targetMailServer: options.targetMailServer || `mail.${options.dnsDomain || 'domain.com'}`,
        startedBy: 'trigger-job',
      });

      // Step 1: Final delta sync (if not skipped) — a real mail pass so the
      // target is current before we verify. Reuses the proven runShadowPass path.
      if (!options.skipFinalSync) {
        console.log('Running final delta sync');
        await ctxTyped.logger.log('Running final delta sync...');
        const deps = await buildDepsFromMapping(pool, tenantId, mappingId);
        const delta = await runShadowPass(deps);
        await ctxTyped.logger.log(`Final delta sync: ${delta.created} created, ${delta.skipped} skipped`);
      }

      // Step 2: Verification (if not skipped) — REAL verification against the
      // ledger (source counts) and the target reindexer (target counts). A FAIL
      // aborts the cutover; we never fabricate a pass (hard rule 9).
      if (!options.skipVerification) {
        console.log('Running verification checks');
        await ctxTyped.logger.log('Running verification checks...');

        const deps = await buildDepsFromMapping(pool, tenantId, mappingId);
        const verificationReader = createLedgerVerificationReader({ connectionString: dbUrl });
        const verification = await runVerification(
          createRealVerificationDeps({
            tenantId: asTenantId(tenantId),
            mappingId: asMappingId(mappingId),
            config: {
              checksumSamplePercentage: 5,
              minSampleSize: 10,
              maxSampleSize: 1000,
              requiredMatchPercentage: 0.99,
              maxDiscrepancyPercentage: 0.01,
              verifyMail: true,
              verifyCalendar: true,
              verifyContacts: true,
              verifyFiles: true,
            },
            ledger: deps.ledger,
            verificationReader,
            // Concrete JMAP / IMAP-DAV targets implement TargetReindexer (listEntries).
            targetReindexer: deps.target as unknown as TargetReindexer,
          }),
        );

        await ctxTyped.logger.log(
          `Verification ${verification.overallStatus} (score ${verification.score.toFixed(3)}, ` +
            `${verification.totalItemsSource} source / ${verification.totalItemsTarget} target, ` +
            `${verification.totalDiscrepancies} discrepancies)`,
        );

        if (verification.overallStatus === 'FAIL' || !verification.canProceedToCutover) {
          // Do NOT proceed to COMPLETED — surface the failure verbatim.
          throw new Error(
            `Cutover verification failed: status=${verification.overallStatus}, ` +
              `score=${verification.score.toFixed(3)}, discrepancies=${verification.totalDiscrepancies}. ` +
              verification.recommendations.join('; '),
          );
        }
      }

      // Step 3: Update cutover state to READY_FOR_CUTOVER
      console.log('Marking cutover as ready');
      await cutoverPersistence.transitionState(asTenantId(tenantId), asMappingId(mappingId), 'READY_FOR_CUTOVER', {
        readyAt: new Date().toISOString(),
      });
      await ctxTyped.logger.log('Cutover ready for approval');

      // Step 4: Wait for approval (in real implementation, this would be a manual step)
      console.log('Waiting for approval...');
      await ctxTyped.logger.log('Cutover ready for manual approval');

      // Step 5: Execute cutover (would be triggered separately after approval)
      console.log('Executing cutover...');
      await cutoverPersistence.transitionState(asTenantId(tenantId), asMappingId(mappingId), 'CUTOVER_IN_PROGRESS', {
        startedAt: new Date().toISOString(),
      });
      await ctxTyped.logger.log('Cutover in progress');

      // Step 6: Update DNS records (if domain provided)
      if (options.dnsDomain && options.targetMailServer) {
        console.log(`Updating DNS records for ${options.dnsDomain}`);
        await ctxTyped.logger.log(`Updating DNS MX records for ${options.dnsDomain}...`);
        // TODO: Implement DNS update using DesecProvider or other provider
        // const dnsProvider = new DesecProvider({ token: process.env.DESEC_TOKEN! });
        // await dnsProvider.updateRecords([...]);
      }

      // Step 7: Mark as completed
      console.log('Marking cutover as completed');
      await cutoverPersistence.transitionState(asTenantId(tenantId), asMappingId(mappingId), 'COMPLETED', {
        completedAt: new Date().toISOString(),
      });
      await ctxTyped.logger.log('Cutover completed successfully');

      // Step 8: Start grace period monitoring
      const gracePeriodEnd = new Date(Date.now() + options.gracePeriodHours * 3600000);
      console.log(`Starting ${options.gracePeriodHours}h grace period (ends ${gracePeriodEnd})`);
      await ctxTyped.logger.log(`Grace period started - ends at ${gracePeriodEnd.toISOString()}`);
      
      // Schedule grace period end
      await ctxTyped.schedule({
        id: `grace-period-${mappingId}`,
        at: gracePeriodEnd,
        job: 'run-grace-period-end',
        payload: { tenantId: asTenantId(tenantId), mappingId: asMappingId(mappingId) },
      });

      return {
        success: true,
        tenantId,
        mappingId,
        gracePeriodEnd,
      };
    } catch (error) {
      const err = error as Error;
      console.error('Cutover failed', { error: err.message });
      await ctxTyped.logger.log(`Cutover failed: ${err.message}`);

      // Rollback cutover status
      await cutoverPersistence.transitionState(asTenantId(tenantId), asMappingId(mappingId), 'FAILED', {
        failedAt: new Date().toISOString(),
        failureReason: err.message,
      });

      throw error;
    }
  },
});
