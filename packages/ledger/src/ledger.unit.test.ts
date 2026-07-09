// Copyright 2026 OpenHands Agent (Apache-2.0)
// Unit tests for the SQL-backed ledger implementation.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { SqliteLedger } from './sqlite-ledger';
import * as schemaSqlite from './schema-sqlite';
import type { LedgerRecord } from '@openmig/shared';
import { asTenantId, asMappingId } from '@openmig/shared';

describe('SqliteLedger', () => {
  let db: ReturnType<typeof drizzle<typeof schemaSqlite>>;
  let sqlite: InstanceType<typeof Database>;
  let ledger: SqliteLedger;

  beforeAll(() => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite, { schema: schemaSqlite });
    
    // Create all tables
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS cursor (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        mapping_id TEXT NOT NULL,
        folder_path TEXT NOT NULL,
        cursor_value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT '',
        UNIQUE(tenant_id, mapping_id, folder_path)
      );
    `);
    
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS item (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        mapping_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        collection TEXT NOT NULL,
        natural_key TEXT NOT NULL,
        natural_key_hash TEXT NOT NULL,
        content_hash TEXT,
        size_bytes INTEGER,
        source_ref TEXT NOT NULL DEFAULT '{}',
        target_ref TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        first_seen_at TEXT NOT NULL DEFAULT '',
        last_synced_at TEXT,
        updated_at TEXT NOT NULL DEFAULT '',
        UNIQUE(tenant_id, mapping_id, natural_key_hash)
      );
    `);
    
    ledger = new SqliteLedger(db);
  });

  afterAll(() => {
    sqlite.close();
  });

  it('should return undefined for non-existent record', async () => {
    const result = await ledger.find(asTenantId('tenant-1'), asMappingId('mapping-1'), 'mail', 'hash-abc123');
    expect(result).toBeUndefined();
  });

  it('should record a new ledger entry', async () => {
    const record: LedgerRecord = {
      tenantId: asTenantId('tenant-1'),
      itemType: 'mail',
      mappingId: asMappingId('mapping-1'),
      naturalKeyHash: 'hash-abc123',
      contentHash: 'content-xyz',
      targetId: 'target-456',
      createdAt: new Date().toISOString(),
    };

    const result = await ledger.recordIfAbsent(record);
    expect(result).toBeDefined();
    expect(result.tenantId).toBe(asTenantId('tenant-1'));
    expect(result.mappingId).toBe(asMappingId('mapping-1'));
    expect(result.naturalKeyHash).toBe('hash-abc123');
    expect(result.targetId).toBe('target-456');
  });

  it('should be idempotent - recordIfAbsent should not overwrite existing entries', async () => {
    const record: LedgerRecord = {
      tenantId: asTenantId('tenant-1'),
      itemType: 'mail',
      mappingId: asMappingId('mapping-1'),
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
      tenantId: asTenantId('tenant-1'),
      itemType: 'mail',
      mappingId: asMappingId('mapping-1'),
      naturalKeyHash: 'hash-ghi789',
      contentHash: 'content-def',
      targetId: 'target-012',
      createdAt: new Date().toISOString(),
    };

    await ledger.recordIfAbsent(record);
    const found = await ledger.find(asTenantId('tenant-1'), asMappingId('mapping-1'), 'mail', 'hash-ghi789');

    expect(found).toBeDefined();
    expect(found?.naturalKeyHash).toBe('hash-ghi789');
    expect(found?.targetId).toBe('target-012');
  });

  it('should not find entries with different tenant or mapping', async () => {
    const record: LedgerRecord = {
      tenantId: asTenantId('tenant-2'),
      itemType: 'mail',
      mappingId: asMappingId('mapping-2'),
      naturalKeyHash: 'hash-jkl012',
      contentHash: 'content-ghi',
      targetId: 'target-345',
      createdAt: new Date().toISOString(),
    };

    await ledger.recordIfAbsent(record);
    
    // Try to find with different tenant
    const found1 = await ledger.find(asTenantId('tenant-1'), asMappingId('mapping-2'), 'mail', 'hash-jkl012');
    expect(found1).toBeUndefined();

    // Try to find with different mapping
    const found2 = await ledger.find(asTenantId('tenant-2'), asMappingId('mapping-1'), 'mail', 'hash-jkl012');
    expect(found2).toBeUndefined();
  });
});
