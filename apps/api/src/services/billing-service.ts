/**
 * Billing Service
 * 
 * Handles usage metering, cost calculation, and billing operations.
 * Integrates with Mollie for payment processing.
 */

import { z } from 'zod';

// Pricing configuration
export interface PricingConfig {
  baseFee: number; // Monthly base fee in cents
  storagePricePerGB: number; // Price per GB per month in cents
  egressPricePerGB: number; // Price per GB egress in cents
  computePricePerHour: number; // Price per compute hour in cents
}

export const defaultPricing: PricingConfig = {
  baseFee: 999, // €9.99/month
  storagePricePerGB: 10, // €0.10/GB/month
  egressPricePerGB: 20, // €0.20/GB
  computePricePerHour: 5, // €0.05/hour
};

// Usage metrics
export interface UsageMetrics {
  tenantId: string;
  period: string; // YYYY-MM
  storageUsedGB: number;
  egressGB: number;
  computeHours: number;
  syncCount: number;
  lastUpdated: string;
}

export const UsageMetricsSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  period: z.string(),
  storageUsedGB: z.number(),
  egressGB: z.number(),
  computeHours: z.number(),
  syncCount: z.number(),
  lastUpdated: z.string(),
});

export type UsageMetricsType = z.infer<typeof UsageMetricsSchema>;

// Invoice
export interface Invoice {
  id: string;
  tenantId: string;
  period: string;
  status: 'draft' | 'open' | 'paid' | 'uncollectible' | 'void';
  subtotal: number;
  tax: number;
  total: number;
  currency: string;
  createdAt: string;
  dueDate: string;
  paidAt?: string;
  mollieInvoiceId?: string;
}

export const InvoiceSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  period: z.string(),
  status: z.enum(['draft', 'open', 'paid', 'uncollectible', 'void']),
  subtotal: z.number(),
  tax: z.number(),
  total: z.number(),
  currency: z.string(),
  createdAt: z.string(),
  dueDate: z.string(),
  paidAt: z.string().optional(),
  mollieInvoiceId: z.string().optional(),
});

export type InvoiceType = z.infer<typeof InvoiceSchema>;

// Payment method
export interface PaymentMethod {
  id: string;
  tenantId: string;
  mollieCustomerId?: string;
  type: 'card' | 'banktransfer' | 'other';
  last4?: string;
  brand?: string;
  expiryMonth?: number;
  expiryYear?: number;
  isDefault: boolean;
  createdAt: string;
}

export const PaymentMethodSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  mollieCustomerId: z.string().optional(),
  type: z.enum(['card', 'banktransfer', 'other']),
  last4: z.string().optional(),
  brand: z.string().optional(),
  expiryMonth: z.number().optional(),
  expiryYear: z.number().optional(),
  isDefault: z.boolean(),
  createdAt: z.string(),
});

export type PaymentMethodType = z.infer<typeof PaymentMethodSchema>;

// Cost calculation
export function calculateCost(metrics: UsageMetrics, pricing: PricingConfig = defaultPricing): {
  storage: number;
  egress: number;
  compute: number;
  subtotal: number;
  tax: number;
  total: number;
} {
  const storageCost = Math.round(metrics.storageUsedGB * pricing.storagePricePerGB);
  const egressCost = Math.round(metrics.egressGB * pricing.egressPricePerGB);
  const computeCost = Math.round(metrics.computeHours * pricing.computePricePerHour);
  
  const subtotal = pricing.baseFee + storageCost + egressCost + computeCost;
  const tax = Math.round(subtotal * 0.21); // 21% VAT
  const total = subtotal + tax;

  return {
    storage: storageCost,
    egress: egressCost,
    compute: computeCost,
    subtotal,
    tax,
    total,
  };
}

// Mock database (replace with actual database calls)
const mockUsageMetrics: Map<string, UsageMetrics> = new Map();
const mockInvoices: Map<string, Invoice> = new Map();
const mockPaymentMethods: Map<string, PaymentMethod> = new Map();

export const billingApi = {
  // Usage Metrics
  recordUsage: (metrics: Omit<UsageMetrics, 'id' | 'lastUpdated'>) => {
    const id = `usage-${Date.now()}`;
    const newMetrics: UsageMetrics = {
      ...metrics,
      id,
      lastUpdated: new Date().toISOString(),
    };
    mockUsageMetrics.set(id, newMetrics);
    return newMetrics;
  },

  getUsage: (tenantId: string, period: string) => {
    const key = `${tenantId}-${period}`;
    return mockUsageMetrics.get(key);
  },

  listUsage: (tenantId: string) => {
    return Array.from(mockUsageMetrics.values()).filter(
      (m) => m.tenantId === tenantId
    );
  },

  // Invoices
  createInvoice: (tenantId: string, period: string, metrics: UsageMetrics) => {
    const cost = calculateCost(metrics);
    const invoice: Invoice = {
      id: `inv-${Date.now()}`,
      tenantId,
      period,
      status: 'draft',
      ...cost,
      currency: 'EUR',
      createdAt: new Date().toISOString(),
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    };
    mockInvoices.set(invoice.id, invoice);
    return invoice;
  },

  getInvoice: (invoiceId: string) => {
    return mockInvoices.get(invoiceId);
  },

  listInvoices: (tenantId: string) => {
    return Array.from(mockInvoices.values())
      .filter((i) => i.tenantId === tenantId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  updateInvoiceStatus: (invoiceId: string, status: Invoice['status']) => {
    const invoice = mockInvoices.get(invoiceId);
    if (invoice) {
      invoice.status = status;
      if (status === 'paid') {
        invoice.paidAt = new Date().toISOString();
      }
      return invoice;
    }
    return null;
  },

  // Payment Methods
  createPaymentMethod: (tenantId: string, data: Partial<PaymentMethod>) => {
    const id = `pm-${Date.now()}`;
    const paymentMethod: PaymentMethod = {
      id,
      tenantId,
      type: data.type || 'card',
      isDefault: false,
      createdAt: new Date().toISOString(),
      ...data,
    };
    mockPaymentMethods.set(id, paymentMethod);
    return paymentMethod;
  },

  getPaymentMethods: (tenantId: string) => {
    return Array.from(mockPaymentMethods.values()).filter(
      (pm) => pm.tenantId === tenantId
    );
  },

  setDefaultPaymentMethod: (tenantId: string, paymentMethodId: string) => {
    // Set all to non-default
    mockPaymentMethods.forEach((pm) => {
      if (pm.tenantId === tenantId) {
        pm.isDefault = false;
      }
    });
    
    // Set requested as default
    const pm = mockPaymentMethods.get(paymentMethodId);
    if (pm && pm.tenantId === tenantId) {
      pm.isDefault = true;
      return pm;
    }
    return null;
  },

  // Cost estimation
  estimateCost: (
    tenantId: string,
    metrics: Partial<UsageMetrics>
  ) => {
    const defaultMetrics: UsageMetrics = {
      id: 'estimate',
      tenantId,
      period: new Date().toISOString().slice(0, 7),
      storageUsedGB: metrics.storageUsedGB || 0,
      egressGB: metrics.egressGB || 0,
      computeHours: metrics.computeHours || 0,
      syncCount: metrics.syncCount || 0,
      lastUpdated: new Date().toISOString(),
    };
    
    return calculateCost(defaultMetrics);
  },
};
