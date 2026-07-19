/**
 * Billing Routes
 * 
 * API endpoints for billing, invoices, and payment methods.
 * All endpoints require authentication and enforce tenant isolation.
 * 
 * SECURITY: All tenant-data queries use withTenantDb for RLS enforcement.
 * tenant_id is ALWAYS from req.tenantId (authenticated context), never from client input.
 */

import { Router } from 'express';
import type { Response } from 'express';
import { z } from 'zod';
import { authenticate, getDbPool, withTenantDb } from '../../middleware/auth';
import type { AuthenticatedRequest } from '../../types/api';
import { calculateCost } from '../../services/billing-service';
import { generateInvoiceForPeriod } from '../../services/invoice-generation';
import { getMollieService } from '../../services/mollie/index';
import { eq, and, desc } from 'drizzle-orm';
import * as schema from '@openmig/ledger';
import { getUsageMetricsForPeriod } from '@openmig/ledger';

const router = Router();

// Lazy pool initialization - created on first use, not at module load
let _dbPool: ReturnType<typeof getDbPool> | null = null;
function getSharedPool() {
  if (!_dbPool) {
    _dbPool = getDbPool();
  }
  return _dbPool;
}

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
 * Uses T4's metering: storage/egress DERIVED from item ledger, compute/api_calls from upserts
 * Returns REAL usage from the actual migration runs - NOT from client input
 */
router.get('/usage', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Tenant ID required' });
    }
    
    const periodStart = new Date().toISOString().slice(0, 7) + '-01'; // First day of current month
    const _periodEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString().slice(0, 10); // Last day of current month

    // Get REAL usage via T4's metering - derive storage/egress from item ledger, read compute/api from upserts
    const metrics = await withTenantDb(tenantId, getSharedPool(), async (db) => {
      return await getUsageMetricsForPeriod(db, tenantId as never as import('@openmig/shared').TenantId, periodStart, _periodEnd);
    });

    // Map T4's result to the UI response shape
    const usage = {
      tenantId,
      period: periodStart.slice(0, 7), // YYYY-MM
      storageUsedGB: metrics.storageBytes / (1024 * 1024 * 1024), // Convert bytes to GB
      egressGB: metrics.egressBytes / (1024 * 1024 * 1024), // Convert bytes to GB
      computeHours: metrics.computeHours,
      syncCount: metrics.apiCallCount,
      lastUpdated: new Date().toISOString(),
    };

    // Calculate current cost
    const cost = calculateCost(usage);

    res.json({
      usage,
      currentCost: cost,
      period: periodStart.slice(0, 7),
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
 * GET /api/billing/usage/history
 *
 * Get usage history for the tenant
 * Aggregates metrics by period
 */
router.get('/usage/history', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Tenant ID required' });
    }

    // Get all usage metrics grouped by period
    const metrics = await withTenantDb(tenantId, getSharedPool(), async (db) => {
      return await db.select({
        periodStart: schema.usageMetric.periodStart,
        periodEnd: schema.usageMetric.periodEnd,
        metricType: schema.usageMetric.metricType,
        quantity: schema.usageMetric.quantity,
        totalCost: schema.usageMetric.totalCost,
      })
      .from(schema.usageMetric)
      .where(eq(schema.usageMetric.tenantId, tenantId))
      .orderBy(desc(schema.usageMetric.periodStart));
    });

    // Aggregate metrics by period
    const periodMap = new Map<string, {
      period: string;
      storageUsedGB: number;
      egressGB: number;
      computeHours: number;
      syncCount: number;
      totalCost: number;
    }>();

    for (const metric of metrics) {
      const period = metric.periodStart.slice(0, 7); // YYYY-MM
      if (!periodMap.has(period)) {
        periodMap.set(period, {
          period,
          storageUsedGB: 0,
          egressGB: 0,
          computeHours: 0,
          syncCount: 0,
          totalCost: 0,
        });
      }

      const usage = periodMap.get(period)!;
      switch (metric.metricType) {
        case 'storage':
          usage.storageUsedGB += Number(metric.quantity);
          break;
        case 'egress':
          usage.egressGB += Number(metric.quantity);
          break;
        case 'compute':
          usage.computeHours += Number(metric.quantity);
          break;
        case 'api_calls':
          usage.syncCount += Number(metric.quantity);
          break;
      }
      usage.totalCost += Number(metric.totalCost);
    }

    // Convert to array and calculate full cost breakdown
    const usageHistory = Array.from(periodMap.values()).map((u) => {
      const cost = calculateCost({
        storageUsedGB: u.storageUsedGB,
        egressGB: u.egressGB,
        computeHours: u.computeHours,
        syncCount: u.syncCount,
      });
      return {
        ...u,
        cost,
      };
    });

    res.json({
      usage: usageHistory,
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
 * Pure calculation - no DB access needed
 */
router.post('/estimate', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Tenant ID required' });
    }
    const body = EstimateCostSchema.parse(req.body);

    const cost = calculateCost({
      storageUsedGB: body.storageUsedGB || 0,
      egressGB: body.egressGB || 0,
      computeHours: body.computeHours || 0,
      syncCount: body.syncCount || 0,
    });

    res.json({
      estimate: cost.total,
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
 * POST /api/billing/invoices/generate
 *
 * Generate (or refresh) the invoice for a billing period from metered usage.
 * Body: { period?: "YYYY-MM" } — defaults to the current month. Idempotent; a
 * paid/void invoice is returned unchanged. Intended to be called by a
 * managed-mode scheduled job at period close (self-host never loads billing).
 */
router.post('/invoices/generate', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) {
      res.status(401).json({ error: 'Unauthorized', message: 'Tenant ID required' });
      return;
    }

    const parsed = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional() }).safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Bad Request', message: 'period must be YYYY-MM' });
      return;
    }

    const ym = parsed.data.period ?? new Date().toISOString().slice(0, 7);
    const [year, month] = ym.split('-').map(Number) as [number, number];
    const periodStart = `${ym}-01`;
    const periodEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);

    const invoice = await withTenantDb(tenantId, getSharedPool(), async (db) =>
      generateInvoiceForPeriod(db, tenantId, periodStart, periodEnd),
    );

    res.status(201).json({ invoice });
  } catch (error) {
    console.error('Error generating invoice:', error);
    res.status(500).json({ error: 'Internal server error', message: 'Failed to generate invoice' });
  }
});

/**
 * GET /api/billing/invoices
 *
 * List all invoices for the tenant
 */
router.get('/invoices', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Tenant ID required' });
    }

    const invoices = await withTenantDb(tenantId, getSharedPool(), async (db) => {
      return await db.select({
        id: schema.invoice.id,
        tenantId: schema.invoice.tenantId,
        periodStart: schema.invoice.periodStart,
        periodEnd: schema.invoice.periodEnd,
        status: schema.invoice.status,
        subtotal: schema.invoice.subtotal,
        taxRate: schema.invoice.taxRate,
        taxAmount: schema.invoice.taxAmount,
        total: schema.invoice.total,
        currency: schema.invoice.currency,
        paymentMethod: schema.invoice.paymentMethod,
        paymentId: schema.invoice.paymentId,
        paidAt: schema.invoice.paidAt,
        dueDate: schema.invoice.dueDate,
        sentAt: schema.invoice.sentAt,
        metadata: schema.invoice.metadata,
        createdAt: schema.invoice.createdAt,
        updatedAt: schema.invoice.updatedAt,
      })
      .from(schema.invoice)
      .where(eq(schema.invoice.tenantId, tenantId))
      .orderBy(desc(schema.invoice.createdAt));
    });

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
    const invoiceId = req.params.invoiceId;
    if (!invoiceId) {
      return res.status(400).json({ error: 'Bad Request', message: 'Invoice ID required' });
    }
    const tenantId = req.tenantId;
    if (!tenantId) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Tenant ID required' });
    }

    const invoices = await withTenantDb(tenantId, getSharedPool(), async (db) => {
      return await db.select({
        id: schema.invoice.id,
        tenantId: schema.invoice.tenantId,
        periodStart: schema.invoice.periodStart,
        periodEnd: schema.invoice.periodEnd,
        status: schema.invoice.status,
        subtotal: schema.invoice.subtotal,
        taxRate: schema.invoice.taxRate,
        taxAmount: schema.invoice.taxAmount,
        total: schema.invoice.total,
        currency: schema.invoice.currency,
        paymentMethod: schema.invoice.paymentMethod,
        paymentId: schema.invoice.paymentId,
        paidAt: schema.invoice.paidAt,
        dueDate: schema.invoice.dueDate,
        sentAt: schema.invoice.sentAt,
        metadata: schema.invoice.metadata,
        createdAt: schema.invoice.createdAt,
        updatedAt: schema.invoice.updatedAt,
      })
      .from(schema.invoice)
      .where(
        and(
          eq(schema.invoice.id, invoiceId),
          eq(schema.invoice.tenantId, tenantId),
        )
      );
    });

    if (invoices.length === 0) {
      res.status(404).json({
        error: 'Not found',
        message: 'Invoice not found',
      });
      return;
    }

    res.json({ invoice: invoices[0] });
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
    const invoiceId = req.params.invoiceId;
    if (!invoiceId) {
      return res.status(400).json({ error: 'Bad Request', message: 'Invoice ID required' });
    }
    const tenantId = req.tenantId;
    if (!tenantId) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Tenant ID required' });
    }

    // Get invoice from database
    const invoices = await withTenantDb(tenantId, getSharedPool(), async (db) => {
      return await db.select({
        id: schema.invoice.id,
        tenantId: schema.invoice.tenantId,
        periodStart: schema.invoice.periodStart,
        periodEnd: schema.invoice.periodEnd,
        status: schema.invoice.status,
        total: schema.invoice.total,
      })
      .from(schema.invoice)
      .where(
        and(
          eq(schema.invoice.id, invoiceId),
          eq(schema.invoice.tenantId, tenantId),
        )
      );
    });

    if (invoices.length === 0) {
      res.status(404).json({
        error: 'Not found',
        message: 'Invoice not found',
      });
      return;
    }

    const invoice = invoices[0];
    if (!invoice) {
      res.status(404).json({
        error: 'Not found',
        message: 'Invoice not found',
      });
      return;
    }

    // Get Mollie service
    const mollieService = getMollieService();

    // Create payment via Mollie
    const payment = await mollieService.createPayment({
      tenantId,
      amount: Number(invoice.total), // Amount in cents
      description: `Invoice ${invoice.id} for period ${invoice.periodStart} to ${invoice.periodEnd}`,
      redirectUrl: `${process.env.WEB_URL || 'http://localhost:3123'}/billing/invoices/${invoiceId}`,
      webhookUrl: `${process.env.API_URL || 'http://localhost:3001'}/api/billing/webhooks/mollie`,
      // Round-trip the invoice + tenant so the webhook can correlate the payment
      // back to the exact invoice under the right RLS context.
      metadata: { invoiceId },
    });

    // Update invoice status in database
    await withTenantDb(tenantId, getSharedPool(), async (db) => {
      await db.update(schema.invoice)
        .set({
          status: 'sent',
          paymentId: payment.id,
          metadata: { mollieInvoiceId: payment.id },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.invoice.id, invoiceId),
            eq(schema.invoice.tenantId, tenantId),
          )
        );
    });

    res.json({
      paymentUrl: payment.redirectUrl,
      paymentId: payment.id,
      status: payment.status,
    });
  } catch (error: unknown) {
    console.error('Error creating payment:', error);
    
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    if (errorMessage.includes('MOLLIE_API_KEY')) {
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
    const tenantId = req.tenantId;
    if (!tenantId) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Tenant ID required' });
    }

    const paymentMethods = await withTenantDb(tenantId, getSharedPool(), async (db) => {
      return await db.select({
        id: schema.paymentMethod.id,
        tenantId: schema.paymentMethod.tenantId,
        mollieId: schema.paymentMethod.mollieId,
        type: schema.paymentMethod.type,
        brand: schema.paymentMethod.brand,
        lastFour: schema.paymentMethod.lastFour,
        expiryMonth: schema.paymentMethod.expiryMonth,
        expiryYear: schema.paymentMethod.expiryYear,
        isDefault: schema.paymentMethod.isDefault,
        status: schema.paymentMethod.status,
        createdAt: schema.paymentMethod.createdAt,
        updatedAt: schema.paymentMethod.updatedAt,
      })
      .from(schema.paymentMethod)
      .where(eq(schema.paymentMethod.tenantId, tenantId));
    });

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
    const tenantId = req.tenantId;
    if (!tenantId) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Tenant ID required' });
    }
    const body = z.object({
      type: z.enum(['card', 'banktransfer', 'other']),
      last4: z.string().optional(),
      brand: z.string().optional(),
      expiryMonth: z.number().optional(),
      expiryYear: z.number().optional(),
      mollieId: z.string().optional(),
    }).parse(req.body);

    const [paymentMethod] = await withTenantDb(tenantId, getSharedPool(), async (db) => {
      return await db.insert(schema.paymentMethod).values({
        tenantId,
        mollieId: body.mollieId || `pm-${Date.now()}`,
        type: body.type,
        brand: body.brand,
        lastFour: body.last4,
        expiryMonth: body.expiryMonth,
        expiryYear: body.expiryYear,
        isDefault: false,
        status: 'active',
      }).returning();
    });

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
      const paymentMethodId = req.params.paymentMethodId;
      if (!paymentMethodId) {
        return res.status(400).json({ error: 'Bad Request', message: 'Payment method ID required' });
      }
      const tenantId = req.tenantId;
      if (!tenantId) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Tenant ID required' });
      }

      // First, unset all default payment methods for this tenant
      await withTenantDb(tenantId, getSharedPool(), async (db) => {
        await db.update(schema.paymentMethod)
          .set({ isDefault: false })
          .where(eq(schema.paymentMethod.tenantId, tenantId));
      });

      // Then set the requested payment method as default
      const [paymentMethod] = await withTenantDb(tenantId, getSharedPool(), async (db) => {
        return await db.update(schema.paymentMethod)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(
            and(
              eq(schema.paymentMethod.id, paymentMethodId),
              eq(schema.paymentMethod.tenantId, tenantId),
            )
          )
          .returning();
      });

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
