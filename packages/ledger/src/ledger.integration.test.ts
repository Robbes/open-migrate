// Copyright 2026 OpenHands Agent (Apache-2.0)
// Integration tests for the SQL-backed ledger against PostgreSQL.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createPgDb } from './db';
import { PgLedger } from './ledger';
import { PgCursorStore } from './cursor-store';
import type { LedgerRecord } from '@openmig/shared';
import { asTenantId, asMappingId } from '@openmig/shared';
import type { PgDatabase } from './db';

// Connection string from Testcontainers (set by vitest.global-setup.ts)
// Fails loudly if TEST_DATABASE_URL is not set, rather than silently using wrong defaults.
const PG_CONNECTION_STRING = process.env.TEST_DATABASE_URL;
if (!PG_CONNECTION_STRING) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Integration tests require Testcontainers to be running. ' +
    'Run: pnpm test:integration'
  );
}

// Fixed UUIDs for testing (valid UUID format)
const TEST_TENANT_ID = asTenantId('550e8400-e29b-41d4-a716-446655440001' as never);
const TEST_MAPPING_ID = asMappingId('550e8400-e29b-41d4-a716-446655440002' as never);
const TEST_TENANT_2_ID = asTenantId('550e8400-e29b-41d4-a716-446655440003' as never);
const TEST_MAPPING_2_ID = asMappingId('550e8400-e29b-41d4-a716-446655440004' as never);

describe('PgLedger (integration)', () => {
  let ledger: PgLedger;
  let db: PgDatabase;

  beforeAll(async () => {
    db = createPgDb(PG_CONNECTION_STRING);
    ledger = new PgLedger(db);

    // Create test data (tenant, connection, mailbox, mapping)
    // Insert tenant
    await db.execute(sql`
      INSERT INTO tenant (id, name, status)
      VALUES (${TEST_TENANT_ID}, 'Test Tenant', 'active')
      ON CONFLICT (id) DO NOTHING
    `);

    // Insert second tenant for isolation tests
    await db.execute(sql`
      INSERT INTO tenant (id, name, status)
      VALUES (${TEST_TENANT_2_ID}, 'Test Tenant 2', 'active')
      ON CONFLICT (id) DO NOTHING
    `);

    // Insert source connection
    const sourceConnId = '650e8400-e29b-41d4-a716-446655440001';
    await db.execute(sql`
      INSERT INTO connection (id, tenant_id, role, kind, display_name, config, status)
      VALUES (${sourceConnId}, ${TEST_TENANT_ID}, 'source', 'o365', 'O365 Source', '{}', 'connected')
      ON CONFLICT (id) DO NOTHING
    `);

    // Insert target connection
    const targetConnId = '650e8400-e29b-41d4-a716-446655440002';
    await db.execute(sql`
      INSERT INTO connection (id, tenant_id, role, kind, display_name, config, status)
      VALUES (${targetConnId}, ${TEST_TENANT_ID}, 'target', 'imap', 'IMAP Target', '{}', 'connected')
      ON CONFLICT (id) DO NOTHING
    `);

    // Insert source mailbox
    const sourceMailboxId = '750e8400-e29b-41d4-a716-446655440001';
    await db.execute(sql`
      INSERT INTO mailbox (id, tenant_id, connection_id, external_id, kind, display_name, status)
      VALUES (${sourceMailboxId}, ${TEST_TENANT_ID}, ${sourceConnId}, 'source@dev.local', 'user', 'Source Mailbox', 'active')
      ON CONFLICT (id) DO NOTHING
    `);

    // Insert target mailbox
    const targetMailboxId = '750e8400-e29b-41d4-a716-446655440002';
    await db.execute(sql`
      INSERT INTO mailbox (id, tenant_id, connection_id, external_id, kind, display_name, status)
      VALUES (${targetMailboxId}, ${TEST_TENANT_ID}, ${targetConnId}, 'target@dev.local', 'user', 'Target Mailbox', 'active')
      ON CONFLICT (id) DO NOTHING
    `);

    // Insert mailbox mapping
    await db.execute(sql`
      INSERT INTO mailbox_mapping (id, tenant_id, source_mailbox_id, target_mailbox_id, mode, status)
      VALUES (${TEST_MAPPING_ID}, ${TEST_TENANT_ID}, ${sourceMailboxId}, ${targetMailboxId}, 'mirror', 'active')
      ON CONFLICT (id) DO NOTHING
    `);

    // Insert second mapping for isolation tests
    const sourceMailboxId2 = '750e8400-e29b-41d4-a716-446655440003';
    const targetMailboxId2 = '750e8400-e29b-41d4-a716-446655440004';
    await db.execute(sql`
      INSERT INTO mailbox (id, tenant_id, connection_id, external_id, kind, display_name, status)
      VALUES (${sourceMailboxId2}, ${TEST_TENANT_2_ID}, ${sourceConnId}, 'source2@dev.local', 'user', 'Source Mailbox 2', 'active')
      ON CONFLICT (id) DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO mailbox (id, tenant_id, connection_id, external_id, kind, display_name, status)
      VALUES (${targetMailboxId2}, ${TEST_TENANT_2_ID}, ${targetConnId}, 'target2@dev.local', 'user', 'Target Mailbox 2', 'active')
      ON CONFLICT (id) DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO mailbox_mapping (id, tenant_id, source_mailbox_id, target_mailbox_id, mode, status)
      VALUES (${TEST_MAPPING_2_ID}, ${TEST_TENANT_2_ID}, ${sourceMailboxId2}, ${targetMailboxId2}, 'mirror', 'active')
      ON CONFLICT (id) DO NOTHING
    `);
  });

  beforeEach(async () => {
    // Clean up test data before each test
    await db.execute(sql`DELETE FROM item WHERE tenant_id = ${TEST_TENANT_ID}`);
  });

  it('should return undefined for non-existent record', async () => {
    const result = await ledger.find(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'mail',
      'hash-abc123',
    );
    expect(result).toBeUndefined();
  });

  it('should record a new ledger entry', async () => {
    const record: LedgerRecord = {
      tenantId: TEST_TENANT_ID,
      itemType: 'mail',
      mappingId: TEST_MAPPING_ID,
      naturalKeyHash: 'hash-abc123',
      contentHash: 'content-xyz',
      targetId: 'target-456',
      createdAt: new Date().toISOString(),
    };

    const result = await ledger.recordIfAbsent(record);
    expect(result).toBeDefined();
    expect(result.tenantId).toBe(TEST_TENANT_ID);
    expect(result.mappingId).toBe(TEST_MAPPING_ID);
    expect(result.naturalKeyHash).toBe('hash-abc123');
    expect(result.targetId).toBe('target-456');
  });

  it('should be idempotent - recordIfAbsent should not overwrite existing entries', async () => {
    const record: LedgerRecord = {
      tenantId: TEST_TENANT_ID,
      itemType: 'mail',
      mappingId: TEST_MAPPING_ID,
      naturalKeyHash: 'hash-def456',
      contentHash: 'content-abc',
      targetId: 'target-789',
      createdAt: new Date().toISOString(),
    };

    const first = await ledger.recordIfAbsent(record);
    const second = await ledger.recordIfAbsent(record);

    // Should return the same record
    expect(first.naturalKeyHash).toBe(second.naturalKeyHash);
    expect(first.targetId).toBe(second.targetId);
  });

  it('should find a previously recorded entry', async () => {
    const record: LedgerRecord = {
      tenantId: TEST_TENANT_ID,
      itemType: 'mail',
      mappingId: TEST_MAPPING_ID,
      naturalKeyHash: 'hash-ghi789',
      contentHash: 'content-def',
      targetId: 'target-012',
      createdAt: new Date().toISOString(),
    };

    await ledger.recordIfAbsent(record);
    const found = await ledger.find(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'mail',
      'hash-ghi789',
    );

    expect(found).toBeDefined();
    expect(found?.naturalKeyHash).toBe('hash-ghi789');
    expect(found?.targetId).toBe('target-012');
  });

  it('should not find entries with different tenant or mapping', async () => {
    const record: LedgerRecord = {
      tenantId: TEST_TENANT_2_ID,
      itemType: 'mail',
      mappingId: TEST_MAPPING_2_ID,
      naturalKeyHash: 'hash-jkl012',
      contentHash: 'content-ghi',
      targetId: 'target-345',
      createdAt: new Date().toISOString(),
    };

    await ledger.recordIfAbsent(record);

    // Try to find with different tenant
    const found1 = await ledger.find(
      TEST_TENANT_ID,
      TEST_MAPPING_2_ID,
      'mail',
      'hash-jkl012',
    );
    expect(found1).toBeUndefined();

    // Try to find with different mapping
    const found2 = await ledger.find(
      TEST_TENANT_2_ID,
      TEST_MAPPING_ID,
      'mail',
      'hash-jkl012',
    );
    expect(found2).toBeUndefined();
  });
});

describe('PgCursorStore (integration)', () => {
  let cursorStore: PgCursorStore;
  let db: PgDatabase;

  beforeAll(async () => {
    db = createPgDb(PG_CONNECTION_STRING);
    cursorStore = new PgCursorStore(db);

    // Create test data (tenant, connection, mailbox, mapping)
    // Insert tenant
    await db.execute(sql`
      INSERT INTO tenant (id, name, status)
      VALUES (${TEST_TENANT_ID}, 'Test Tenant', 'active')
      ON CONFLICT (id) DO NOTHING
    `);

    // Insert source connection
    const sourceConnId = '650e8400-e29b-41d4-a716-446655440001';
    await db.execute(sql`
      INSERT INTO connection (id, tenant_id, role, kind, display_name, config, status)
      VALUES (${sourceConnId}, ${TEST_TENANT_ID}, 'source', 'imap', 'IMAP Source', '{}', 'connected')
      ON CONFLICT (id) DO NOTHING
    `);

    // Insert target connection
    const targetConnId = '650e8400-e29b-41d4-a716-446655440002';
    await db.execute(sql`
      INSERT INTO connection (id, tenant_id, role, kind, display_name, config, status)
      VALUES (${targetConnId}, ${TEST_TENANT_ID}, 'target', 'imap', 'IMAP Target', '{}', 'connected')
      ON CONFLICT (id) DO NOTHING
    `);

    // Insert source mailbox
    const sourceMailboxId = '750e8400-e29b-41d4-a716-446655440001';
    await db.execute(sql`
      INSERT INTO mailbox (id, tenant_id, connection_id, external_id, kind, display_name, status)
      VALUES (${sourceMailboxId}, ${TEST_TENANT_ID}, ${sourceConnId}, 'source@dev.local', 'user', 'Source Mailbox', 'active')
      ON CONFLICT (id) DO NOTHING
    `);

    // Insert target mailbox
    const targetMailboxId = '750e8400-e29b-41d4-a716-446655440002';
    await db.execute(sql`
      INSERT INTO mailbox (id, tenant_id, connection_id, external_id, kind, display_name, status)
      VALUES (${targetMailboxId}, ${TEST_TENANT_ID}, ${targetConnId}, 'target@dev.local', 'user', 'Target Mailbox', 'active')
      ON CONFLICT (id) DO NOTHING
    `);

    // Insert mailbox mapping
    await db.execute(sql`
      INSERT INTO mailbox_mapping (id, tenant_id, source_mailbox_id, target_mailbox_id, mode, status)
      VALUES (${TEST_MAPPING_ID}, ${TEST_TENANT_ID}, ${sourceMailboxId}, ${targetMailboxId}, 'mirror', 'active')
      ON CONFLICT (id) DO NOTHING
    `);
  });

  beforeEach(async () => {
    // Clean up cursor data before each test
    await db.execute(sql`DELETE FROM cursor WHERE tenant_id = ${TEST_TENANT_ID}`);
  });

  it('should return undefined for non-existent cursor', async () => {
    const result = await cursorStore.get(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'INBOX',
    );
    expect(result).toBeUndefined();
  });

  it('should set and get a cursor', async () => {
    const cursor = { value: '12345:67890' };

    await cursorStore.set(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'INBOX',
      cursor,
    );

    const result = await cursorStore.get(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'INBOX',
    );

    expect(result).toBeDefined();
    expect(result?.value).toBe('12345:67890');
  });

  it('should update an existing cursor', async () => {
    const cursor1 = { value: '11111:22222' };
    const cursor2 = { value: '33333:44444' };

    await cursorStore.set(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'Sent',
      cursor1,
    );

    await cursorStore.set(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'Sent',
      cursor2,
    );

    const result = await cursorStore.get(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'Sent',
    );

    expect(result).toBeDefined();
    expect(result?.value).toBe('33333:44444');
  });

  it('should maintain separate cursors for different folders', async () => {
    const cursor1 = { value: 'folder1:100' };
    const cursor2 = { value: 'folder2:200' };

    await cursorStore.set(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'INBOX',
      cursor1,
    );

    await cursorStore.set(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'Sent',
      cursor2,
    );

    const inboxCursor = await cursorStore.get(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'INBOX',
    );
    const sentCursor = await cursorStore.get(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'Sent',
    );

    expect(inboxCursor?.value).toBe('folder1:100');
    expect(sentCursor?.value).toBe('folder2:200');
  });
});
