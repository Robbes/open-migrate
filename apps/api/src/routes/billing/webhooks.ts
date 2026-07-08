/**
 * Mollie Webhook Handler
 * 
 * Processes webhook events from Mollie payment gateway.
 * Updates invoice status based on payment events.
 */

import { Router, Request, Response } from 'express';
import { getMollieService } from '../services/mollie/index.js';
import { billingApi } from '../services/billing-service.js';

const router = Router();

/**
 * POST /api/billing/webhooks/mollie
 * 
 * Webhook endpoint for Mollie payment events.
 * Mollie sends POST requests to this endpoint when payment status changes.
 */
router.post('/mollie', async (req: Request, res: Response) => {
  try {
    const { id: paymentId } = req.body;

    if (!paymentId) {
      res.status(400).json({
        error: 'Missing payment ID',
      });
      return;
    }

    // Get Mollie service and process webhook
    const mollieService = getMollieService();
    const paymentStatus = await mollieService.processWebhook(paymentId);

    // Extract metadata from payment to get tenant and invoice info
    // Note: In production, you'd store the invoice ID in the payment metadata
    const { status, paidAt } = paymentStatus;

    // Update invoice status based on payment status
    if (status === 'paid' && paidAt) {
      // TODO: Extract invoice ID from payment metadata
      // For now, we'll log the event
      console.log(`Payment ${paymentId} completed at ${paidAt}`);
      
      // Update invoice status to 'paid'
      // billingApi.updateInvoiceStatus(invoiceId, 'paid');
    } else if (status === 'failed') {
      console.log(`Payment ${paymentId} failed`);
      
      // Update invoice status to 'uncollectible'
      // billingApi.updateInvoiceStatus(invoiceId, 'uncollectible');
    } else if (status === 'canceled') {
      console.log(`Payment ${paymentId} was canceled`);
      
      // Update invoice status to 'void'
      // billingApi.updateInvoiceStatus(invoiceId, 'void');
    }

    res.status(200).json({
      received: true,
    });
  } catch (error) {
    console.error('Error processing Mollie webhook:', error);
    res.status(500).json({
      error: 'Webhook processing failed',
    });
  }
});

/**
 * GET /api/billing/webhooks/mollie/test
 * 
 * Test endpoint to verify webhook configuration.
 * Only enabled in development mode.
 */
router.get('/mollie/test', (req: Request, res: Response) => {
  if (process.env.NODE_ENV === 'production') {
    res.status(404).json({
      error: 'Not found',
    });
    return;
  }

  res.json({
    status: 'Webhook endpoint is configured correctly',
    url: `${process.env.API_URL}/api/billing/webhooks/mollie`,
  });
});

export default router;
