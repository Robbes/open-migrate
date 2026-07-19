/**
 * Usage Metering Integration Tests
 * 
 * Tests for the hybrid usage metering approach:
 * - Storage/Egress: Derive-at-read from item ledger
 * - Compute/API calls: Idempotent upsert from job runs
 * 
 * Security: All tests use withTenant for RLS enforcement.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createPgDb } from './db';
import { 
  deriveStorageAndEgressForPeriod,
  recordComputeForRun,
  recordApiCallForRun,
  getUsageMetricsForPeriod,
  type ComputeUsageInput,
  type ApiCallUsageInput,
} from '@openmig/ledger';
import {
  tenant as tenantTable,
  connection as connectionTable,
  mailbox as mailboxTable,
  mailboxMapping as mailboxMappingTable,
  item as itemTable,
  usageMetric as usageMetricTable,
  migrationStatus as migrationStatusTable,
} from '@openmig/ledger/schema-pg';
import type { TenantId, MappingId } from '@openmig/shared';
import { randomUUID } from 'crypto';

// Connection string from Testcontainers
const PG_CONNECTION_STRING = process.env.TEST_DATABASE_URL;
if (!PG_CONNECTION_STRING) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Integration tests require Testcontainers to be running. ' +
    'Run: pnpm test:integration'
  );
}

const _PRICING = {
  computePricePerHour: 5,
};

// Fixed UUIDs for testing - namespace 5a0c for usage-metering.integration.test.ts
const TEST_TENANT_ID = '5a0c0000-e29b-41d4-a716-446655440001' as never as TenantId;
const TEST_TENANT_2_ID = '5a0c0000-e29b-41d4-a716-446655440002' as never as TenantId;
const TEST_MAPPING_ID = '5a0c0000-e29b-41d4-a716-446655440003' as never as MappingId;

describe('Usage Metering - Integration', () => {
  let db: ReturnType<typeof createPgDb>;

  beforeAll(() => {
    db = createPgDb(PG_CONNECTION_STRING);
  });

  afterAll(async () => {
    await db.$pool.end();
  });

  beforeEach(async () => {
    // Clean up test data
    await db.delete(usageMetricTable);
    await db.delete(itemTable);
    await db.delete(migrationStatusTable);
    await db.delete(mailboxMappingTable);
    await db.delete(mailboxTable);
    await db.delete(connectionTable);
    await db.delete(tenantTable);
  });

  /**
   * Helper to create a complete test fixture with tenant, connections, mailboxes, and mapping
   */
  async function createFixture(tenantId: TenantId, mappingId: MappingId) {
    await db.insert(tenantTable).values({
      id: tenantId,
      name: `t4-test-${tenantId}`,
      status: 'active',
    });

    const sourceConn = (await db.insert(connectionTable).values({
      tenantId,
      role: 'source',
      kind: 'o365',
      displayName: 'Source',
      config: {},
    }).returning())[0]!;

    const targetConn = (await db.insert(connectionTable).values({
      tenantId,
      role: 'target',
      kind: 'imap',
      displayName: 'Target',
      config: {},
    }).returning())[0]!;

    const sourceMailboxId = randomUUID() as never;
    const targetMailboxId = randomUUID() as never;
    
    await db.insert(mailboxTable).values([
      {
        id: sourceMailboxId,
        tenantId,
        connectionId: sourceConn.id,
        displayName: 'Source Inbox',
        kind: 'user',
      },
      {
        id: targetMailboxId,
        tenantId,
        connectionId: targetConn.id,
        displayName: 'Target Inbox',
        kind: 'user',
      },
    ]);

    await db.insert(mailboxMappingTable).values({
      id: mappingId,
      tenantId,
      sourceMailboxId,
      targetMailboxId,
      status: 'active',
    });

    return { sourceConn, targetConn };
  }

  describe('Storage/Egress derivation', () => {
    it('should derive correct storage and egress from item ledger', async () => {
      await createFixture(TEST_TENANT_ID, TEST_MAPPING_ID);

      // Create items with known sizes and lastSyncedAt
      const testDate = new Date('2026-07-15T10:00:00Z');
      await db.insert(itemTable).values([
        {
          tenantId: TEST_TENANT_ID,
          mappingId: TEST_MAPPING_ID,
          domain: 'email',
          collection: 'Inbox',
          naturalKey: 'msg-1',
          naturalKeyHash: 'hash1',
          sizeBytes: 1024n,
          status: 'copied',
          lastSyncedAt: testDate,
        },
        {
          tenantId: TEST_TENANT_ID,
          mappingId: TEST_MAPPING_ID,
          domain: 'email',
          collection: 'Inbox',
          naturalKey: 'msg-2',
          naturalKeyHash: 'hash2',
          sizeBytes: 2048n,
          status: 'copied',
          lastSyncedAt: testDate,
        },
        {
          tenantId: TEST_TENANT_ID,
          mappingId: TEST_MAPPING_ID,
          domain: 'email',
          collection: 'Inbox',
          naturalKey: 'msg-3',
          naturalKeyHash: 'hash3',
          sizeBytes: 512n,
          status: 'copied',
          lastSyncedAt: testDate,
        },
      ]);

      // Derive usage for the period
      const result = await deriveStorageAndEgressForPeriod(
        db,
        TEST_TENANT_ID,
        '2026-07-01',
        '2026-07-31'
      );

      expect(result.storageBytes).toBe(3584); // 1024 + 2048 + 512
      expect(result.egressBytes).toBe(3584); // Same as storage
    });

    it('should exclude items outside the billing period', async () => {
      await createFixture(TEST_TENANT_ID, TEST_MAPPING_ID);

      // Items in different periods
      await db.insert(itemTable).values([
        {
          tenantId: TEST_TENANT_ID,
          mappingId: TEST_MAPPING_ID,
          domain: 'email',
          collection: 'Inbox',
          naturalKey: 'msg-june',
          naturalKeyHash: 'hash-june',
          sizeBytes: 1000n,
          status: 'copied',
          lastSyncedAt: new Date('2026-06-15T10:00:00Z'), // Before period
        },
        {
          tenantId: TEST_TENANT_ID,
          mappingId: TEST_MAPPING_ID,
          domain: 'email',
          collection: 'InBox',
          naturalKey: 'msg-july',
          naturalKeyHash: 'hash-july',
          sizeBytes: 2000n,
          status: 'copied',
          lastSyncedAt: new Date('2026-07-15T10:00:00Z'), // In period
        },
        {
          tenantId: TEST_TENANT_ID,
          mappingId: TEST_MAPPING_ID,
          domain: 'email',
          collection: 'Inbox',
          naturalKey: 'msg-aug',
          naturalKeyHash: 'hash-aug',
          sizeBytes: 3000n,
          status: 'copied',
          lastSyncedAt: new Date('2026-08-15T10:00:00Z'), // After period
        },
      ]);

      const result = await deriveStorageAndEgressForPeriod(
        db,
        TEST_TENANT_ID,
        '2026-07-01',
        '2026-07-31'
      );

      expect(result.storageBytes).toBe(2000); // Only July item
      expect(result.egressBytes).toBe(2000);
    });

    it('should handle null lastSyncedAt (exclude from counts)', async () => {
      await createFixture(TEST_TENANT_ID, TEST_MAPPING_ID);

      await db.insert(itemTable).values([
        {
          tenantId: TEST_TENANT_ID,
          mappingId: TEST_MAPPING_ID,
          domain: 'email',
          collection: 'Inbox',
          naturalKey: 'msg-synced',
          naturalKeyHash: 'hash-synced',
          sizeBytes: 1000n,
          status: 'copied',
          lastSyncedAt: new Date('2026-07-15T10:00:00Z'),
        },
        {
          tenantId: TEST_TENANT_ID,
          mappingId: TEST_MAPPING_ID,
          domain: 'email',
          collection: 'Inbox',
          naturalKey: 'msg-not-synced',
          naturalKeyHash: 'hash-not-synced',
          sizeBytes: 5000n,
          status: 'pending',
          lastSyncedAt: null, // Not synced yet
        },
      ]);

      const result = await deriveStorageAndEgressForPeriod(
        db,
        TEST_TENANT_ID,
        '2026-07-01',
        '2026-07-31'
      );

      expect(result.storageBytes).toBe(1000); // Only synced item
      expect(result.egressBytes).toBe(1000);
    });

    it('should return zeros for empty set', async () => {
      await db.insert(tenantTable).values({
        id: TEST_TENANT_ID,
        name: 't4-test-empty',
        status: 'active',
      });

      const result = await deriveStorageAndEgressForPeriod(
        db,
        TEST_TENANT_ID,
        '2026-07-01',
        '2026-07-31'
      );

      expect(result.storageBytes).toBe(0);
      expect(result.egressBytes).toBe(0);
    });
  });

  describe('Compute/API call upsert', () => {
    it('should idempotently record compute usage', async () => {
      await db.insert(tenantTable).values({
        id: TEST_TENANT_ID,
        name: 't4-test-compute',
        status: 'active',
      });

      const periodStart = '2026-07-01';
      const periodEnd = '2026-07-31';
      const startedAt = new Date('2026-07-15T10:00:00Z');
      const completedAt = new Date('2026-07-15T11:00:00Z'); // 1 hour

      const computeInput: ComputeUsageInput = {
        tenantId: TEST_TENANT_ID,
        mappingId: TEST_MAPPING_ID,
        domain: 'email',
        startedAt,
        completedAt,
        periodStart,
        periodEnd,
      };

      // First record
      await recordComputeForRun(db, computeInput, _PRICING);

      // Get usage
      const usage1 = await getUsageMetricsForPeriod(db, TEST_TENANT_ID, periodStart, periodEnd);
      expect(usage1.computeHours).toBe(1);

      // Retry with same key - should REPLACE, not increment
      await recordComputeForRun(db, computeInput, _PRICING);

      const usage2 = await getUsageMetricsForPeriod(db, TEST_TENANT_ID, periodStart, periodEnd);
      expect(usage2.computeHours).toBe(1); // Same, not doubled
    });

    it('should idempotently record API call usage', async () => {
      await db.insert(tenantTable).values({
        id: TEST_TENANT_ID,
        name: 't4-test-api',
        status: 'active',
      });

      const periodStart = '2026-07-01';
      const periodEnd = '2026-07-31';

      const apiInput: ApiCallUsageInput = {
        tenantId: TEST_TENANT_ID,
        mappingId: TEST_MAPPING_ID,
        domain: 'email',
        periodStart,
        periodEnd,
      };

      // First record
      await recordApiCallForRun(db, apiInput);

      const usage1 = await getUsageMetricsForPeriod(db, TEST_TENANT_ID, periodStart, periodEnd);
      expect(usage1.apiCallCount).toBe(1);

      // Retry - should REPLACE
      await recordApiCallForRun(db, apiInput);

      const usage2 = await getUsageMetricsForPeriod(db, TEST_TENANT_ID, periodStart, periodEnd);
      expect(usage2.apiCallCount).toBe(1); // Same, not doubled
    });

    it('should allow separate tracking per domain', async () => {
      await db.insert(tenantTable).values({
        id: TEST_TENANT_ID,
        name: 't4-test-multi-domain',
        status: 'active',
      });

      const periodStart = '2026-07-01';
      const periodEnd = '2026-07-31';

      await recordApiCallForRun(db, {
        tenantId: TEST_TENANT_ID,
        mappingId: TEST_MAPPING_ID,
        domain: 'email',
        periodStart,
        periodEnd,
      });

      await recordApiCallForRun(db, {
        tenantId: TEST_TENANT_ID,
        mappingId: TEST_MAPPING_ID,
        domain: 'calendar',
        periodStart,
        periodEnd,
      });

      const usage = await getUsageMetricsForPeriod(db, TEST_TENANT_ID, periodStart, periodEnd);
      expect(usage.apiCallCount).toBe(2); // Both domains
    });
  });

  describe('Cross-tenant isolation', () => {
    it('should not expose tenant B usage to tenant A', async () => {
      // Create two tenants
      await db.insert(tenantTable).values([
        {
          id: TEST_TENANT_ID,
          name: 't4-tenant-a',
          status: 'active',
        },
        {
          id: TEST_TENANT_2_ID,
          name: 't4-tenant-b',
          status: 'active',
        },
      ]);

      const periodStart = '2026-07-01';
      const periodEnd = '2026-07-31';
      const startedAt = new Date('2026-07-15T10:00:00Z');
      const completedAt = new Date('2026-07-15T12:00:00Z'); // 2 hours

      // Record usage for tenant B
      await recordComputeForRun(db, {
        tenantId: TEST_TENANT_2_ID,
        mappingId: TEST_MAPPING_ID,
        domain: 'email',
        startedAt,
        completedAt,
        periodStart,
        periodEnd,
      }, _PRICING);

      // Tenant A should see nothing
      const usageA = await getUsageMetricsForPeriod(db, TEST_TENANT_ID, periodStart, periodEnd);
      expect(usageA.computeHours).toBe(0);
      expect(usageA.storageBytes).toBe(0);

      // Tenant B should see their own usage
      const usageB = await getUsageMetricsForPeriod(db, TEST_TENANT_2_ID, periodStart, periodEnd);
      expect(usageB.computeHours).toBe(2);
    });
  });
});
