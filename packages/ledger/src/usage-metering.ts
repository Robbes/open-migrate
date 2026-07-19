/**
 * Usage Metering Service
 * 
 * Handles usage metering from real migration runs.
 * Implements hybrid approach:
 * - Storage/Egress: Derive-at-read from item ledger (perfect idempotency)
 * - Compute/API calls: Idempotent upsert from job runs (retry-safe)
 * 
 * Security: All operations use withTenant for RLS enforcement.
 */

import { type PgDatabase } from './db';
import { and, eq, inArray, gte, lte, sql, type SQL } from 'drizzle-orm';
import * as schema from './schema-pg';
import type { TenantId, MappingId } from '@openmig/shared';

export interface UsageMetricsResult {
  storageBytes: number;
  egressBytes: number;
  computeHours: number;
  apiCallCount: number;
}

export interface ComputeUsageInput {
  tenantId: TenantId;
  mappingId: MappingId;
  domain: 'email' | 'calendar' | 'contact' | 'file';
  startedAt: Date;
  completedAt: Date;
  periodStart: string;
  periodEnd: string;
}

export interface ApiCallUsageInput {
  tenantId: TenantId;
  mappingId: MappingId;
  domain: 'email' | 'calendar' | 'contact' | 'file';
  periodStart: string;
  periodEnd: string;
}

/**
 * Derive storage and egress usage from item ledger for a billing period.
 * 
 * Uses derive-at-read approach: no writes, computed on-demand from immutable ledger.
 * Filters items by lastSyncedAt to get period-specific usage.
 * 
 * @param db - PostgreSQL database client (already tenant-scoped via withTenant)
 * @param tenantId - Tenant ID (for validation, RLS already enforced)
 * @param periodStart - Period start date (YYYY-MM-DD format)
 * @param periodEnd - Period end date (YYYY-MM-DD format)
 * @returns Storage and egress bytes (identical values)
 */
export async function deriveStorageAndEgressForPeriod(
  db: PgDatabase,
  tenantId: TenantId,
  periodStart: string,
  periodEnd: string
): Promise<{ storageBytes: number; egressBytes: number }> {
  // Build WHERE conditions
  const conditions: SQL[] = [
    eq(schema.item.tenantId, tenantId),
    inArray(schema.item.status, ['copied', 'updated', 'skipped']),
    // Filter by lastSyncedAt - items with NULL are automatically excluded
    gte(schema.item.lastSyncedAt, new Date(periodStart)),
    lte(schema.item.lastSyncedAt, new Date(periodEnd)),
  ];

  const result = await db.select({
    storageBytes: sql<number>`COALESCE(SUM(${schema.item.sizeBytes}), 0)`,
  })
  .from(schema.item)
  .where(and(...conditions));

  const storageBytes = Number(result[0]?.storageBytes ?? 0);
  
  // Egress = Storage (every synced byte is both read AND retained)
  return {
    storageBytes,
    egressBytes: storageBytes,
  };
}

/**
 * Record compute usage via idempotent upsert.
 * 
 * Called at job completion to record the duration of a sync run.
 * Uses onConflictDoUpdate to REPLACE rather than increment, making it retry-safe.
 * 
 * Key: (tenantId, periodStart, metricType, resource)
 * where resource = `domain-${domain}` for compute
 * 
 * @param db - PostgreSQL database client (already tenant-scoped)
 * @param input - Compute usage input with timing info
 * @param pricing - Pricing configuration
 */
export async function recordComputeForRun(
  db: PgDatabase,
  input: ComputeUsageInput,
  pricing: { computePricePerHour: number }
): Promise<void> {
  const durationMinutes = (input.completedAt.getTime() - input.startedAt.getTime()) / (1000 * 60);
  const durationHours = durationMinutes / 60;
  const cost = Math.round(durationHours * pricing.computePricePerHour);

  await db.insert(schema.usageMetric)
    .values({
      tenantId: input.tenantId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      metricType: 'compute',
      resource: `domain-${input.domain}`,
      quantity: String(durationHours),
      unit: 'hours',
      unitPrice: String(pricing.computePricePerHour),
      totalCost: String(cost),
      metadata: {
        mappingId: input.mappingId,
        domain: input.domain,
        startedAt: input.startedAt.toISOString(),
        completedAt: input.completedAt.toISOString(),
        durationMinutes,
      },
    })
    .onConflictDoUpdate({
      target: [
        schema.usageMetric.tenantId,
        schema.usageMetric.periodStart,
        schema.usageMetric.metricType,
        schema.usageMetric.resource,
      ],
      set: {
        quantity: String(durationHours),
        totalCost: String(cost),
        updatedAt: new Date(),
      },
    });
}

/**
 * Record API call usage via idempotent upsert.
 * 
 * Called at job completion to record one sync operation.
 * Uses onConflictDoUpdate to REPLACE rather than increment.
 * 
 * Key: (tenantId, periodStart, metricType, resource)
 * where resource = `sync-${domain}` for api_calls
 * 
 * @param db - PostgreSQL database client (already tenant-scoped)
 * @param input - API call usage input
 */
export async function recordApiCallForRun(
  db: PgDatabase,
  input: ApiCallUsageInput
): Promise<void> {
  await db.insert(schema.usageMetric)
    .values({
      tenantId: input.tenantId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      metricType: 'api_calls',
      resource: `sync-${input.domain}`,
      quantity: '1',
      unit: 'request',
      unitPrice: '0',
      totalCost: '0',
      metadata: {
        mappingId: input.mappingId,
        domain: input.domain,
      },
    })
    .onConflictDoUpdate({
      target: [
        schema.usageMetric.tenantId,
        schema.usageMetric.periodStart,
        schema.usageMetric.metricType,
        schema.usageMetric.resource,
      ],
      set: {
        quantity: '1',
        updatedAt: new Date(),
      },
    });
}

/**
 * Get all usage metrics for a tenant and period.
 * 
 * Combines derived metrics (storage/egress) with upserted metrics (compute/api_calls).
 * 
 * @param db - PostgreSQL database client (already tenant-scoped)
 * @param tenantId - Tenant ID
 * @param periodStart - Period start date
 * @param periodEnd - Period end date
 * @returns Complete usage metrics
 */
export async function getUsageMetricsForPeriod(
  db: PgDatabase,
  tenantId: TenantId,
  periodStart: string,
  periodEnd: string
): Promise<UsageMetricsResult> {
  // Get derived storage/egress
  const { storageBytes, egressBytes } = await deriveStorageAndEgressForPeriod(
    db,
    tenantId,
    periodStart,
    periodEnd
  );

  // Get upserted compute and api_calls
  const metrics = await db.select({
    metricType: schema.usageMetric.metricType,
    quantity: schema.usageMetric.quantity,
    resource: schema.usageMetric.resource,
  })
  .from(schema.usageMetric)
  .where(
    and(
      eq(schema.usageMetric.tenantId, tenantId),
      eq(schema.usageMetric.periodStart, periodStart),
    )
  );

  let computeHours = 0;
  let apiCallCount = 0;

  for (const metric of metrics) {
    if (metric.metricType === 'compute') {
      computeHours += Number(metric.quantity);
    } else if (metric.metricType === 'api_calls') {
      apiCallCount += Number(metric.quantity);
    }
  }

  return {
    storageBytes,
    egressBytes,
    computeHours,
    apiCallCount,
  };
}
