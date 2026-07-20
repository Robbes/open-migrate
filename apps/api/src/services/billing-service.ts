/**
 * Billing Service
 *
 * Pricing types and the single cost-calculation function (ADR-0014 cost-recovery
 * pricing, integer cents). The live billing data path is Drizzle-backed
 * (routes/billing + services/invoice-generation); the previous in-memory
 * `billingApi` mock was removed once those moved to real persistence.
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
  id: string;
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

// Cost calculation — integer cents throughout (each component is rounded, so no
// floating-point drift reaches the invoice).
export function calculateCost(metrics: Partial<UsageMetrics>, pricing: PricingConfig = defaultPricing): {
  storage: number;
  egress: number;
  compute: number;
  subtotal: number;
  tax: number;
  total: number;
} {
  const storageCost = Math.round((metrics.storageUsedGB ?? 0) * pricing.storagePricePerGB);
  const egressCost = Math.round((metrics.egressGB ?? 0) * pricing.egressPricePerGB);
  const computeCost = Math.round((metrics.computeHours ?? 0) * pricing.computePricePerHour);

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
