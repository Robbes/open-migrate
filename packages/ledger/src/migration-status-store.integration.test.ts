import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createPgDb } from './db';
import { PgMigrationStatusStore } from './migration-status-store';
import { PgLedger } from './ledger';
import * as schemaPg from './schema-pg';
import { eq, and } from 'drizzle-orm';

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/open_migrate_test';

describe('PgMigrationStatusStore', () => {
  let db: ReturnType<typeof createPgDb>;
  let statusStore: PgMigrationStatusStore;
  let ledger: PgLedger;

  // Fixed test UUIDs (disjoint from other tests)
  const TENANT_ID = '00000000-0000-0000-0000-000000000001' as const;
  const MAPPING_ID = '00000000-0000-0000-0000-000000000002' as const;
  const SOURCE_MAILBOX_ID = '00000000-0000-0000-0000-000000000003' as const;
  const TARGET_MAILBOX_ID = '00000000-0000-0000-0000-000000000004' as const;

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    statusStore = new PgMigrationStatusStore(db);
    ledger = new PgLedger(db);

    // Setup test data: tenant, mailbox_mapping
    await db.insert(schemaPg.tenant).values({
      id: TENANT_ID,
      name: 'Test Tenant',
      status: 'active',
      settings: {},
      createdAt: new Date(),
    }).onConflictDoNothing();

    // Create source and target mailboxes
    const connId = '00000000-0000-0000-0000-000000000005' as const;
    await db.insert(schemaPg.connection).values({
      id: connId,
      tenantId: TENANT_ID,
      role: 'source',
      kind: 'imap',
      displayName: 'Test Source',
      config: {},
      status: 'connected',
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing();

    await db.insert(schemaPg.mailbox).values({
      id: SOURCE_MAILBOX_ID,
      tenantId: TENANT_ID,
      connectionId: connId,
      kind: 'user',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing();

    await db.insert(schemaPg.mailbox).values({
      id: TARGET_MAILBOX_ID,
      tenantId: TENANT_ID,
      connectionId: connId,
      kind: 'user',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing();

    // Create mailbox mapping
    await db.insert(schemaPg.mailboxMapping).values({
      id: MAPPING_ID,
      tenantId: TENANT_ID,
      sourceMailboxId: SOURCE_MAILBOX_ID,
      targetMailboxId: TARGET_MAILBOX_ID,
      mode: 'mirror',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing();
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    // Clean up migration_status table before each test
    await db.delete(schemaPg.migrationStatus).where(
      eq(schemaPg.migrationStatus.tenantId, TENANT_ID)
    );

    // Clean up item table
    await db.delete(schemaPg.item).where(
      eq(schemaPg.item.tenantId, TENANT_ID)
    );
  });

  describe('initDomainStatus', () => {
    it('creates a new status row as pending', async () => {
      await statusStore.initDomainStatus(TENANT_ID, MAPPING_ID, 'email');

      const [row] = await db
        .select()
        .from(schemaPg.migrationStatus)
        .where(
          and(
            eq(schemaPg.migrationStatus.tenantId, TENANT_ID),
            eq(schemaPg.migrationStatus.mappingId, MAPPING_ID),
            eq(schemaPg.migrationStatus.domain, 'email'),
          ),
        );

      expect(row).toBeDefined();
      expect(row?.state).toBe('pending');
      expect(row?.tenantId).toBe(TENANT_ID);
      expect(row?.mappingId).toBe(MAPPING_ID);
      expect(row?.domain).toBe('email');
    });

    it('is idempotent - second call does not duplicate', async () => {
      await statusStore.initDomainStatus(TENANT_ID, MAPPING_ID, 'email');
      await statusStore.initDomainStatus(TENANT_ID, MAPPING_ID, 'email');

      const rows = await db
        .select()
        .from(schemaPg.migrationStatus)
        .where(
          and(
            eq(schemaPg.migrationStatus.tenantId, TENANT_ID),
            eq(schemaPg.migrationStatus.mappingId, MAPPING_ID),
            eq(schemaPg.migrationStatus.domain, 'email'),
          ),
        );

      expect(rows.length).toBe(1);
    });
  });

  describe('markInProgress', () => {
    it('transitions status from pending to in_progress', async () => {
      await statusStore.initDomainStatus(TENANT_ID, MAPPING_ID, 'email');
      await statusStore.markInProgress(TENANT_ID, MAPPING_ID, 'email');

      const [row] = await db
        .select()
        .from(schemaPg.migrationStatus)
        .where(eq(schemaPg.migrationStatus.id, (await getStatusRow()).id));

      expect(row?.state).toBe('in_progress');
    });
  });

  describe('markCompleted', () => {
    it('transitions status to completed with completed_at', async () => {
      await statusStore.initDomainStatus(TENANT_ID, MAPPING_ID, 'email');
      await statusStore.markInProgress(TENANT_ID, MAPPING_ID, 'email');
      await statusStore.markCompleted(TENANT_ID, MAPPING_ID, 'email');

      const [row] = await db
        .select()
        .from(schemaPg.migrationStatus)
        .where(eq(schemaPg.migrationStatus.id, (await getStatusRow()).id));

      expect(row?.state).toBe('completed');
      expect(row?.completedAt).toBeDefined();
    });
  });

  describe('markFailed', () => {
    it('transitions status to failed with last_error', async () => {
      const errorMessage = 'Connection timeout';
      await statusStore.initDomainStatus(TENANT_ID, MAPPING_ID, 'email');
      await statusStore.markFailed(TENANT_ID, MAPPING_ID, 'email', errorMessage);

      const [row] = await db
        .select()
        .from(schemaPg.migrationStatus)
        .where(eq(schemaPg.migrationStatus.id, (await getStatusRow()).id));

      expect(row?.state).toBe('failed');
      expect(row?.lastError).toBe(errorMessage);
    });
  });

  describe('markSkipped', () => {
    it('transitions status to skipped', async () => {
      await statusStore.initDomainStatus(TENANT_ID, MAPPING_ID, 'calendar');
      await statusStore.markSkipped(TENANT_ID, MAPPING_ID, 'calendar');

      const [row] = await db
        .select()
        .from(schemaPg.migrationStatus)
        .where(
          and(
            eq(schemaPg.migrationStatus.tenantId, TENANT_ID),
            eq(schemaPg.migrationStatus.mappingId, MAPPING_ID),
            eq(schemaPg.migrationStatus.domain, 'calendar'),
          ),
        );

      expect(row?.state).toBe('skipped');
    });
  });

  describe('getStatus with derived counts', () => {
    it('derives counts from item records', async () => {
      // Create status row
      await statusStore.initDomainStatus(TENANT_ID, MAPPING_ID, 'email');
      await statusStore.markInProgress(TENANT_ID, MAPPING_ID, 'email');

      // Seed item records
      await db.insert(schemaPg.item).values([
        {
          id: '00000000-0000-0000-0000-000000000010',
          tenantId: TENANT_ID,
          mappingId: MAPPING_ID,
          domain: 'email',
          collection: 'Inbox',
          naturalKey: 'msg1@example.com',
          naturalKeyHash: 'hash1',
          contentHash: 'ch1',
          sizeBytes: 1000,
          status: 'copied',
          sourceRef: {},
          targetRef: {},
          attemptCount: 0,
          firstSeenAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: '00000000-0000-0000-0000-000000000011',
          tenantId: TENANT_ID,
          mappingId: MAPPING_ID,
          domain: 'email',
          collection: 'Inbox',
          naturalKey: 'msg2@example.com',
          naturalKeyHash: 'hash2',
          contentHash: 'ch2',
          sizeBytes: 2000,
          status: 'copied',
          sourceRef: {},
          targetRef: {},
          attemptCount: 0,
          firstSeenAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: '00000000-0000-0000-0000-000000000012',
          tenantId: TENANT_ID,
          mappingId: MAPPING_ID,
          domain: 'email',
          collection: 'Inbox',
          naturalKey: 'msg3@example.com',
          naturalKeyHash: 'hash3',
          contentHash: 'ch3',
          sizeBytes: 500,
          status: 'failed',
          sourceRef: {},
          targetRef: {},
          attemptCount: 1,
          lastError: 'Sync error',
          firstSeenAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const status = await statusStore.getStatus(TENANT_ID, MAPPING_ID);
      const emailStatus = status.find((s) => s.domain === 'email');

      expect(emailStatus).toBeDefined();
      expect(emailStatus?.itemsSynced).toBe(2);
      expect(emailStatus?.itemsFailed).toBe(1);
      expect(emailStatus?.bytesTransferred).toBe(3000);
    });

    it('handles empty item set with zero counts', async () => {
      await statusStore.initDomainStatus(TENANT_ID, MAPPING_ID, 'contacts');
      await statusStore.markInProgress(TENANT_ID, MAPPING_ID, 'contacts');

      const status = await statusStore.getStatus(TENANT_ID, MAPPING_ID);
      const contactStatus = status.find((s) => s.domain === 'contacts');

      expect(contactStatus).toBeDefined();
      expect(contactStatus?.itemsSynced).toBe(0);
      expect(contactStatus?.itemsFailed).toBe(0);
      expect(contactStatus?.bytesTransferred).toBe(0);
    });
  });

  describe('crash recovery', () => {
    it('leaves in_progress state recoverable', async () => {
      await statusStore.initDomainStatus(TENANT_ID, MAPPING_ID, 'email');
      await statusStore.markInProgress(TENANT_ID, MAPPING_ID, 'email');

      // Simulate crash - no further updates
      const status = await statusStore.getStatus(TENANT_ID, MAPPING_ID);
      const emailStatus = status.find((s) => s.domain === 'email');

      expect(emailStatus?.state).toBe('in_progress');
      expect(emailStatus?.completedAt).toBeUndefined();
    });
  });

  async function getStatusRow() {
    const [row] = await db
      .select()
      .from(schemaPg.migrationStatus)
      .where(
        and(
          eq(schemaPg.migrationStatus.tenantId, TENANT_ID),
          eq(schemaPg.migrationStatus.mappingId, MAPPING_ID),
        ),
      )
      .limit(1);
    return row;
  }
});
