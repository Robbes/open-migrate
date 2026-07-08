/**
 * Billing Routes
 * 
 * API endpoints for billing, invoices, and payment methods.
 * All endpoints require authentication and enforce tenant isolation.
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../index.js';
import { billingApi, UsageMetrics, calculateCost } from '../services/billing-service.js';
import { getMollieService } from '../services/mollie/index.js';

const router = Router();

// Schema validation
const EstimateCostSchema = z.object({
  storageUsedGB: z.number().optional(),
  egressGB: z.number().optional(),
  computeHours: z.number().optional(),
  syncCount: z.number().optional(),
});

/**
 * GET /api/billing/usage
 * 
 * Get current usage metrics for the tenant
 */
router.get('/usage', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { tenantId } = req;
    const period = new Date().toISOString().slice(0, 7); // YYYY-MM

    // Get or create current period usage
    let usage = billingApi.getUsage(tenantId, period);
    
    if (!usage) {
      // Create initial usage record
      usage = billingApi.recordUsage({
        tenantId,
        period,
        storageUsedGB: 0,
        egressGB: 0,
        computeHours: 0,
        syncCount: 0,
      });
    }

    // Calculate current cost
    const cost = calculateCost(usage);

    res.json({
      usage,
      currentCost: cost,
      period,
    });
  } catch (error) {
    console.error('Error getting usage:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to get usage metrics',
    });
  }
});

/**
 * POST /api/billing/usage
 * 
 * Record usage metrics (called by worker after sync)
 */
router.post('/usage', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { tenantId } = req;
    const body = z.object({
      period: z.string(),
      storageUsedGB: z.number(),
      egressGB: z.number(),
      computeHours: z.number(),
      syncCount: z.number(),
    }).parse(req.body);

    const usage = billingApi.recordUsage({
      tenantId,
      ...body,
    });

    const cost = calculateCost(usage);

    res.json({
      usage,
      cost,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: error.errors,
      });
    } else {
      console.error('Error recording usage:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to record usage',
      });
    }
  }
});

/**
 * GET /api/billing/usage/history
 * 
 * Get usage history for the tenant
 */
router.get('/usage/history', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { tenantId } = req;
    const usage = billingApi.listUsage(tenantId);

    res.json({
      usage: usage.map((u) => ({
        ...u,
        cost: calculateCost(u),
      })),
    });
  } catch (error) {
    console.error('Error getting usage history:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to get usage history',
    });
  }
});

/**
 * POST /api/billing/estimate
 * 
 * Estimate cost based on projected usage
 */
router.post('/estimate', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { tenantId } = req;
    const body = EstimateCostSchema.parse(req.body);

    const cost = billingApi.estimateCost(tenantId, body);

    res.json({
      estimate: cost,
      breakdown: {
        baseFee: 999,
        storage: cost.storage,
        egress: cost.egress,
        compute: cost.compute,
        tax: cost.tax,
        total: cost.total,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: error.errors,
      });
    } else {
      console.error('Error estimating cost:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to estimate cost',
      });
    }
  }
});

/**
 * GET /api/billing/invoices
 * 
 * List all invoices for the tenant
 */
router.get('/invoices', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { tenantId } = req;
    const invoices = billingApi.listInvoices(tenantId);

    res.json({
      invoices,
    });
  } catch (error) {
    console.error('Error listing invoices:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to list invoices',
    });
  }
});

/**
 * GET /api/billing/invoices/:invoiceId
 * 
 * Get invoice details
 */
router.get('/invoices/:invoiceId', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { invoiceId } = req.params;
    const invoice = billingApi.getInvoice(invoiceId);

    if (!invoice) {
      res.status(404).json({
        error: 'Not found',
        message: 'Invoice not found',
      });
      return;
    }

    res.json({ invoice });
  } catch (error) {
    console.error('Error getting invoice:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to get invoice',
    });
  }
});

/**
 * POST /api/billing/invoices/:invoiceId/pay
 * 
 * Create payment for invoice using Mollie
 */
router.post('/invoices/:invoiceId/pay', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { invoiceId } = req.params;
    const { tenantId } = req;

    const invoice = billingApi.getInvoice(invoiceId);
    
    if (!invoice) {
      res.status(404).json({
        error: 'Not found',
        message: 'Invoice not found',
      });
      return;
    }

    if (invoice.tenantId !== tenantId) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Access denied to this invoice',
      });
      return;
    }

    // Get Mollie service
    const mollieService = getMollieService();

    // Create payment via Mollie
    const payment = await mollieService.createPayment({
      tenantId,
      amount: invoice.total, // Amount in cents
      description: `Invoice ${invoice.id} for period ${invoice.period}`,
      redirectUrl: `${process.env.WEB_URL || 'http://localhost:3123'}/billing/invoices/${invoiceId}`,
      webhookUrl: `${process.env.API_URL || 'http://localhost:3001'}/api/billing/webhooks/mollie`,
    });

    // Store mollie payment ID
    invoice.mollieInvoiceId = payment.id;
    billingApi.updateInvoiceStatus(invoiceId, 'open');

    res.json({
      paymentUrl: payment.redirectUrl,
      paymentId: payment.id,
      status: payment.status,
    });
  } catch (error: any) {
    console.error('Error creating payment:', error);
    
    if (error.message?.includes('MOLLIE_API_KEY')) {
      res.status(500).json({
        error: 'Configuration error',
        message: 'Mollie API key not configured',
      });
    } else {
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to create payment',
      });
    }
  }
});

/**
 * GET /api/billing/payment-methods
 * 
 * List payment methods for the tenant
 */
router.get('/payment-methods', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { tenantId } = req;
    const paymentMethods = billingApi.getPaymentMethods(tenantId);

    res.json({
      paymentMethods,
    });
  } catch (error) {
    console.error('Error listing payment methods:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to list payment methods',
    });
  }
});

/**
 * POST /api/billing/payment-methods
 * 
 * Add a new payment method
 */
router.post('/payment-methods', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { tenantId } = req;
    const body = z.object({
      type: z.enum(['card', 'banktransfer', 'other']),
      last4: z.string().optional(),
      brand: z.string().optional(),
      expiryMonth: z.number().optional(),
      expiryYear: z.number().optional(),
    }).parse(req.body);

    const paymentMethod = billingApi.createPaymentMethod(tenantId, body);

    res.status(201).json({
      paymentMethod,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: error.errors,
      });
    } else {
      console.error('Error creating payment method:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to create payment method',
      });
    }
  }
});

/**
 * PATCH /api/billing/payment-methods/:paymentMethodId/default
 * 
 * Set default payment method
 */
router.patch(
  '/payment-methods/:paymentMethodId/default',
  authenticate,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { paymentMethodId } = req.params;
      const { tenantId } = req;

      const paymentMethod = billingApi.setDefaultPaymentMethod(tenantId, paymentMethodId);

      if (!paymentMethod) {
        res.status(404).json({
          error: 'Not found',
          message: 'Payment method not found',
        });
        return;
      }

      res.json({
        paymentMethod,
      });
    } catch (error) {
      console.error('Error setting default payment method:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to set default payment method',
      });
    }
  }
);

export default router;
