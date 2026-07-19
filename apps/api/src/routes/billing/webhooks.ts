// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

/**
 * Mollie webhook handler (workplan 0011 T5).
 *
 * Mollie POSTs `id=<paymentId>` when a payment's status changes. The body is
 * untrusted, so we fetch the authoritative payment from Mollie (fetch-on-webhook
 * pattern) and use its round-tripped metadata (tenantId, invoiceId) to drive the
 * invoice/payment state machine under the correct RLS tenant context.
 *
 * Idempotent: Mollie may deliver the same event more than once. Re-applying a
 * terminal transition is a no-op — once an invoice is `paid`/`void` we do not
 * rewrite it, and we always answer 200 so Mollie stops retrying.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { and, eq } from 'drizzle-orm';
import * as schema from '@openmig/ledger';
import { getMollieService, type MolliePayment } from '../../services/mollie/index';
import { getDbPool, withTenantDb } from '../../middleware/auth';

const router = Router();

/** Map a Mollie payment status to the invoice status it drives. */
function invoiceStatusFor(paymentStatus: MolliePayment['status']): 'paid' | 'void' | null {
  switch (paymentStatus) {
    case 'paid':
      return 'paid';
    case 'failed':
    case 'canceled':
    case 'expired':
      return 'void';
    // open / pending / authorized: not terminal — leave the invoice as 'sent'.
    default:
      return null;
  }
}

/**
 * POST /api/billing/webhooks/mollie
 */
router.post('/mollie', async (req: Request, res: Response) => {
  try {
    const paymentId = req.body?.id;
    if (!paymentId || typeof paymentId !== 'string') {
      res.status(400).json({ error: 'Missing payment ID' });
      return;
    }

    // Fetch the authoritative payment (never trust the webhook body).
    const mollieService = getMollieService();
    const payment = await mollieService.processWebhook(paymentId);

    const tenantId = payment.metadata?.tenantId;
    const invoiceId = payment.metadata?.invoiceId;
    if (typeof tenantId !== 'string' || typeof invoiceId !== 'string') {
      // Nothing we can correlate — ack so Mollie stops retrying, but record it.
      console.warn(`Mollie webhook ${paymentId}: missing tenantId/invoiceId metadata`);
      res.status(200).json({ received: true });
      return;
    }

    const nextStatus = invoiceStatusFor(payment.status);
    if (!nextStatus) {
      // Non-terminal status (open/pending) — acknowledge without a state change.
      res.status(200).json({ received: true });
      return;
    }

    await withTenantDb(tenantId, getDbPool(), async (db) => {
      const rows = await db
        .select({ id: schema.invoice.id, status: schema.invoice.status })
        .from(schema.invoice)
        .where(
          and(
            eq(schema.invoice.id, invoiceId),
            eq(schema.invoice.tenantId, tenantId),
            eq(schema.invoice.paymentId, payment.id),
          ),
        );

      const invoice = rows[0];
      if (!invoice) {
        console.warn(`Mollie webhook ${paymentId}: no matching invoice ${invoiceId}`);
        return;
      }

      // Idempotency: a terminal invoice is never rewritten (double delivery = no-op).
      if (invoice.status === 'paid' || invoice.status === 'void') {
        return;
      }

      await db
        .update(schema.invoice)
        .set({
          status: nextStatus,
          paidAt: nextStatus === 'paid' ? new Date(payment.paidAt ?? Date.now()) : null,
          updatedAt: new Date(),
        })
        .where(
          and(eq(schema.invoice.id, invoiceId), eq(schema.invoice.tenantId, tenantId)),
        );
    });

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Error processing Mollie webhook:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

/**
 * GET /api/billing/webhooks/mollie/test — dev-only config check.
 */
router.get('/mollie/test', (req: Request, res: Response) => {
  if (process.env.NODE_ENV === 'production') {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json({
    status: 'Webhook endpoint is configured correctly',
    url: `${process.env.API_URL}/api/billing/webhooks/mollie`,
  });
});

export default router;
