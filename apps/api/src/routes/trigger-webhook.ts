/**
 * Trigger.dev Webhook Handler
 * 
 * Handles incoming webhooks from Trigger.dev for job status updates.
 * These webhooks are used to track job execution and update the database.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import crypto from 'crypto';

const router = Router();

/**
 * Webhook payload interface from Trigger.dev
 */
interface WebhookPayload {
  id: string;
  eventType: string;
  job: {
    id: string;
    name: string;
  };
  run: {
    id: string;
    status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled';
    startedAt?: string;
    finishedAt?: string;
    error?: string;
  };
  payload: Record<string, unknown>;
  createdAt: string;
}

/**
 * Verify a webhook signature in constant time. Returns false (never throws) for
 * a malformed/wrong-length signature, so a garbage header yields a clean 401
 * rather than a 500. Exported for unit testing.
 */
export function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  // timingSafeEqual throws on differing lengths — guard first (an attacker
  // controls the signature length).
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

/**
 * POST /api/webhooks/trigger
 * 
 * Receives job status updates from Trigger.dev
 */
router.post(
  '/trigger',
  async (req: Request, res: Response) => {
    const signature = req.headers['x-trigger-signature'];
    const secret = process.env.TRIGGER_WEBHOOK_SECRET;

    // When a secret is configured, EVERY request must carry a valid signature —
    // a missing header must NOT bypass verification (that would let anyone forge
    // a webhook). Without a secret configured we can't verify, so we skip.
    if (secret) {
      const payload = JSON.stringify(req.body);
      if (typeof signature !== 'string' || !verifySignature(payload, signature, secret)) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }
    
    const webhook: WebhookPayload = req.body;
    
    try {
      // Extract tenant and mapping from job payload
      const { tenantId, mappingId } = webhook.payload as Record<string, string>;
      
      // Update run status in database
      // This would use the ledger to track job execution
      console.log('Received webhook:', {
        jobId: webhook.job.id,
        runId: webhook.run.id,
        status: webhook.run.status,
        tenantId,
        mappingId,
      });
      
      // TODO: Update run table with job status
      // await db.update(run).set({
      //   status: webhook.run.status,
      //   orchestratorRef: webhook.run.id,
      //   startedAt: webhook.run.startedAt ? new Date(webhook.run.startedAt) : null,
      //   finishedAt: webhook.run.finishedAt ? new Date(webhook.run.finishedAt) : null,
      // }).where(eq(run.id, mappingId));
      
      // Log errors if job failed
      if (webhook.run.status === 'failed' && webhook.run.error) {
        console.error(`Job ${webhook.job.id} failed:`, webhook.run.error);
        
        // TODO: Log to run_event table
        // await db.insert(runEvent).values({
        //   tenantId,
        //   runId: mappingId,
        //   level: 'error',
        //   message: webhook.run.error,
        // });
      }
      
      res.json({ received: true });
    } catch (error) {
      console.error('Error processing webhook:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /api/webhooks/trigger
 * 
 * Health check endpoint for webhook receiver
 */
router.get('/trigger', (req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'trigger-webhook-handler' });
});

export default router;
