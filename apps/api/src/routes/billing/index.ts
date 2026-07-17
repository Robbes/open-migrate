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
import { getMollieService } from '../../services/mollie/index';
import { eq, and, desc, sql } from 'drizzle-orm';
import * as schema from '@openmig/ledger';
import type { PgDatabase } from '@openmig/ledger';

const router = Router();
const pool = getDbPool();

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
 * Aggregates all metric types (storage, egress, compute, api_calls) for the current period
 */
router.get('/usage', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Tenant ID required' });
    }
    
    const periodStart = new Date().toISOString().slice(0, 7) + '-01'; // First day of current month
    const periodEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString().slice(0, 10); // Last day of current month

    // Get all usage metrics for current period, grouped by metric_type
    const metrics = await withTenantDb(tenantId, pool, async (db) => {
      return await db.select({
        metricType: schema.usageMetric.metricType,
        quantity: schema.usageMetric.quantity,
        unit: schema.usageMetric.unit,
        totalCost: schema.usageMetric.totalCost,
        resource: schema.usageMetric.resource,
      })
      .from(schema.usageMetric)
      .where(
        and(
          eq(schema.usageMetric.tenantId, tenantId),
          eq(schema.usageMetric.periodStart, periodStart),
        )
      );
    });

    // Aggregate metrics into the format expected by the UI
    const usage = {
      tenantId,
      period: periodStart.slice(0, 7), // YYYY-MM
      storageUsedGB: 0,
      egressGB: 0,
      computeHours: 0,
      syncCount: 0,
      lastUpdated: new Date().toISOString(),
    };

    for (const metric of metrics) {
      switch (metric.metricType) {
        case 'storage':
          usage.storageUsedGB = Number(metric.quantity);
          break;
        case 'egress':
          usage.egressGB = Number(metric.quantity);
          break;
        case 'compute':
          usage.computeHours = Number(metric.quantity);
          break;
        case 'api_calls':
          usage.syncCount = Number(metric.quantity);
          break;
      }
    }

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
 * POST /api/billing/usage
 * 
 * Record usage metrics (called by worker after sync)
 * Creates/updates individual metric rows for each metric type
 */
router.post('/usage', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Tenant ID required' });
    }
    
    const body = z.object({
      period: z.string(), // YYYY-MM format
      storageUsedGB: z.number(),
      egressGB: z.number(),
      computeHours: z.number(),
      syncCount: z.number(),
    }).parse(req.body);

    // Convert period (YYYY-MM) to period_start and period_end dates
    const [year, month] = body.period.split('-').map(Number);
    const periodStart = `${body.period}-01`;
    const periodEnd = new Date(year, month, 0).toISOString().slice(0, 10); // Last day of month

    // Use default pricing from billing service
    const defaultPricing = {
      baseFee: 999,
      storagePricePerGB: 10,
      egressPricePerGB: 20,
      computePricePerHour: 5,
    };

    // Calculate costs for each metric
    const storageCost = Math.round(body.storageUsedGB * defaultPricing.storagePricePerGB);
    const egressCost = Math.round(body.egressGB * defaultPricing.egressPricePerGB);
    const computeCost = Math.round(body.computeHours * defaultPricing.computePricePerHour);
    const syncCost = 0; // API calls are free for now

    // Insert/update each metric type
    await withTenantDb(tenantId, pool, async (db: PgDatabase) => {
      // Storage metric
      await db.insert(schema.usageMetric)
        .values({
          tenantId,
          periodStart,
          periodEnd,
          metricType: 'storage',
          resource: 'storage',
          quantity: String(body.storageUsedGB),
          unit: 'GB',
          unitPrice: String(defaultPricing.storagePricePerGB),
          totalCost: String(storageCost),
          metadata: {},
        })
        .onConflictDoUpdate({
          target: [schema.usageMetric.tenantId, schema.usageMetric.periodStart, schema.usageMetric.metricType, schema.usageMetric.resource],
          set: {
            quantity: String(body.storageUsedGB),
            totalCost: String(storageCost),
            updatedAt: new Date(),
          },
        });

      // Egress metric
      await db.insert(schema.usageMetric)
        .values({
          tenantId,
          periodStart,
          periodEnd,
          metricType: 'egress',
          resource: 'egress',
          quantity: String(body.egressGB),
          unit: 'GB',
          unitPrice: String(defaultPricing.egressPricePerGB),
          totalCost: String(egressCost),
          metadata: {},
        })
        .onConflictDoUpdate({
          target: [schema.usageMetric.tenantId, schema.usageMetric.periodStart, schema.usageMetric.metricType, schema.usageMetric.resource],
          set: {
            quantity: String(body.egressGB),
            totalCost: String(egressCost),
            updatedAt: new Date(),
          },
        });

      // Compute metric
      await db.insert(schema.usageMetric)
        .values({
          tenantId,
          periodStart,
          periodEnd,
          metricType: 'compute',
          resource: 'compute',
          quantity: String(body.computeHours),
          unit: 'hours',
          unitPrice: String(defaultPricing.computePricePerHour),
          totalCost: String(computeCost),
          metadata: {},
        })
        .onConflictDoUpdate({
          target: [schema.usageMetric.tenantId, schema.usageMetric.periodStart, schema.usageMetric.metricType, schema.usageMetric.resource],
          set: {
            quantity: String(body.computeHours),
            totalCost: String(computeCost),
            updatedAt: new Date(),
          },
        });

      // API calls metric
      await db.insert(schema.usageMetric)
        .values({
          tenantId,
          periodStart,
          periodEnd,
          metricType: 'api_calls',
          resource: 'sync',
          quantity: String(body.syncCount),
          unit: 'requests',
          unitPrice: '0',
          totalCost: '0',
          metadata: {},
        })
        .onConflictDoUpdate({
          target: [schema.usageMetric.tenantId, schema.usageMetric.periodStart, schema.usageMetric.metricType, schema.usageMetric.resource],
          set: {
            quantity: String(body.syncCount),
            updatedAt: new Date(),
          },
        });
    });

    // Return the aggregated usage
    const usage = {
      tenantId,
      period: body.period,
      storageUsedGB: body.storageUsedGB,
      egressGB: body.egressGB,
      computeHours: body.computeHours,
      syncCount: body.syncCount,
      lastUpdated: new Date().toISOString(),
    };

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
 * Aggregates metrics by period
 */
router.get('/usage/history', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Tenant ID required' });
    }

    // Get all usage metrics grouped by period
    const metrics = await withTenantDb(tenantId, pool, async (db) => {
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

    const invoices = await withTenantDb(tenantId, pool, async (db) => {
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

    const invoices = await withTenantDb(tenantId, pool, async (db) => {
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
    const invoices = await withTenantDb(tenantId, pool, async (db) => {
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

    // Get Mollie service
    const mollieService = getMollieService();

    // Create payment via Mollie
    const payment = await mollieService.createPayment({
      tenantId,
      amount: Number(invoice.total), // Amount in cents
      description: `Invoice ${invoice.id} for period ${invoice.periodStart} to ${invoice.periodEnd}`,
      redirectUrl: `${process.env.WEB_URL || 'http://localhost:3123'}/billing/invoices/${invoiceId}`,
      webhookUrl: `${process.env.API_URL || 'http://localhost:3001'}/api/billing/webhooks/mollie`,
    });

    // Update invoice status in database
    await withTenantDb(tenantId, pool, async (db) => {
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

    const paymentMethods = await withTenantDb(tenantId, pool, async (db) => {
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

    const [paymentMethod] = await withTenantDb(tenantId, pool, async (db) => {
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
      await withTenantDb(tenantId, pool, async (db) => {
        await db.update(schema.paymentMethod)
          .set({ isDefault: false })
          .where(eq(schema.paymentMethod.tenantId, tenantId));
      });

      // Then set the requested payment method as default
      const [paymentMethod] = await withTenantDb(tenantId, pool, async (db) => {
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
