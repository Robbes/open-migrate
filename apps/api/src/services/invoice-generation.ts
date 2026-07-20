// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

/**
 * Invoice generation (workplan 0011 T5).
 *
 * Aggregates a tenant's metered usage for a billing period into a single
 * `invoice` row, using ADR-0014 cost-recovery pricing: a flat monthly base fee
 * + pass-through of storage/egress/compute (no margin), plus VAT.
 *
 * Usage comes from the T4 read model (`getUsageMetricsForPeriod`): storage/egress
 * are derived from the immutable `item` ledger, compute/api-calls from the
 * upserted `usage_metric` rows — so the invoice reflects every cost driver, and
 * pricing goes through the one `calculateCost` function shared with the estimate
 * and usage routes.
 *
 * Idempotent: keyed by the unique (tenant_id, period_start) invoice constraint.
 * Re-running refreshes a `draft`/`sent` invoice's amounts but NEVER overwrites an
 * invoice that has already been `paid` or `void` (that state comes from the
 * payment webhook and must not be clobbered).
 *
 * Managed-only: this module lives in apps/api and is never imported by the
 * self-host edition (hard rule 5 — self-host loads no billing code).
 */

import { and, eq, notInArray } from 'drizzle-orm';
import * as schema from '@openmig/ledger';
import { getUsageMetricsForPeriod, type PgDatabase } from '@openmig/ledger';
import type { TenantId } from '@openmig/shared';
import { calculateCost, defaultPricing, type PricingConfig } from './billing-service';

const VAT_RATE = 0.21;
const BYTES_PER_GB = 1_000_000_000;

export interface GeneratedInvoice {
  id: string;
  status: string;
  subtotal: number;
  taxAmount: number;
  total: number;
  currency: string;
  /** Per-driver cost (cents) that fed the subtotal. */
  costByDriver: { base: number; storage: number; egress: number; compute: number };
  /** True when the invoice already existed as paid/void and was left untouched. */
  locked: boolean;
}

/**
 * Generate (or refresh) the invoice for one tenant + period.
 *
 * Must be called inside a tenant-scoped transaction (withTenant/withTenantDb),
 * so RLS confines every read and write to `tenantId`.
 */
export async function generateInvoiceForPeriod(
  db: PgDatabase,
  tenantId: string,
  periodStart: string,
  periodEnd: string,
  pricing: PricingConfig = defaultPricing,
): Promise<GeneratedInvoice> {
  // T4 read model: storage/egress derived from the item ledger, compute/api-calls
  // from the upserted usage_metric rows.
  const usage = await getUsageMetricsForPeriod(
    db,
    tenantId as unknown as TenantId,
    periodStart,
    periodEnd,
  );

  const cost = calculateCost(
    {
      storageUsedGB: usage.storageBytes / BYTES_PER_GB,
      egressGB: usage.egressBytes / BYTES_PER_GB,
      computeHours: usage.computeHours,
      syncCount: usage.apiCallCount,
    },
    pricing,
  );

  const subtotal = cost.subtotal;
  const taxAmount = cost.tax;
  const total = cost.total;
  const costByDriver = {
    base: pricing.baseFee,
    storage: cost.storage,
    egress: cost.egress,
    compute: cost.compute,
  };

  // If a paid/void invoice already exists for this period, leave it untouched.
  const existing = await db
    .select({ id: schema.invoice.id, status: schema.invoice.status })
    .from(schema.invoice)
    .where(
      and(
        eq(schema.invoice.tenantId, tenantId),
        eq(schema.invoice.periodStart, periodStart),
      ),
    );

  const locked = existing.some((i) => i.status === 'paid' || i.status === 'void');
  if (locked && existing[0]) {
    return {
      id: existing[0].id,
      status: existing[0].status,
      subtotal,
      taxAmount,
      total,
      currency: 'EUR',
      costByDriver,
      locked: true,
    };
  }

  const metadata = { costByDriver, generatedAt: new Date().toISOString() };

  // Upsert the draft invoice — one per (tenant, period) via the unique index.
  // The `setWhere` guard makes the "never overwrite a paid/void invoice" rule
  // ATOMIC: if a payment webhook flips the invoice to paid/void between the
  // SELECT above and this statement, the ON CONFLICT UPDATE is skipped by the
  // database (not just by the earlier read), so a paid invoice's amounts can
  // never be rewritten.
  const [invoice] = await db
    .insert(schema.invoice)
    .values({
      tenantId,
      periodStart,
      periodEnd,
      status: 'draft',
      subtotal: String(subtotal),
      taxRate: String(VAT_RATE),
      taxAmount: String(taxAmount),
      total: String(total),
      currency: 'EUR',
      metadata,
    })
    .onConflictDoUpdate({
      target: [schema.invoice.tenantId, schema.invoice.periodStart],
      set: {
        subtotal: String(subtotal),
        taxRate: String(VAT_RATE),
        taxAmount: String(taxAmount),
        total: String(total),
        metadata,
        updatedAt: new Date(),
      },
      setWhere: notInArray(schema.invoice.status, ['paid', 'void']),
    })
    .returning({ id: schema.invoice.id, status: schema.invoice.status });

  if (!invoice) {
    // The row became paid/void after the SELECT above, so `setWhere` skipped the
    // update. Re-read and return it untouched (the payment state wins).
    const [current] = await db
      .select({ id: schema.invoice.id, status: schema.invoice.status })
      .from(schema.invoice)
      .where(
        and(
          eq(schema.invoice.tenantId, tenantId),
          eq(schema.invoice.periodStart, periodStart),
        ),
      );
    if (!current) {
      throw new Error('invoice upsert returned no row');
    }
    return {
      id: current.id,
      status: current.status,
      subtotal,
      taxAmount,
      total,
      currency: 'EUR',
      costByDriver,
      locked: true,
    };
  }

  return {
    id: invoice.id,
    status: invoice.status,
    subtotal,
    taxAmount,
    total,
    currency: 'EUR',
    costByDriver,
    locked: false,
  };
}
