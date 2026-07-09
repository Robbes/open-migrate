import {
  type Ledger,
  type LedgerRecord,
  type TenantId,
  type MappingId,
} from '@openmig/shared';
import type { SqliteDatabase } from './db';
import { eq, and } from 'drizzle-orm';
import * as schemaSqlite from './schema-sqlite';

/**
 * SQL-backed idempotency ledger for SQLite — workplan 0001, T0.
 * Backed by SQLite via Drizzle; see
 * `packages/ledger/migrations/0001_init.sql` and schema-sqlite.ts.
 * Idempotency anchor: UNIQUE(tenant_id, mapping_id, natural_key_hash). Non-destructive.
 */
export class SqliteLedger implements Ledger {
  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  async find(
    tenantId: TenantId,
    mappingId: MappingId,
    itemType: 'mail' | 'calendar' | 'contact' | 'file',
    naturalKeyHash: string,
  ): Promise<LedgerRecord | undefined> {
    const result = await this.db
      .select()
      .from(schemaSqlite.item)
      .where(
        and(
          eq(schemaSqlite.item.tenantId, tenantId),
          eq(schemaSqlite.item.mappingId, mappingId),
          eq(schemaSqlite.item.naturalKeyHash, naturalKeyHash),
          eq(schemaSqlite.item.domain, itemType === 'mail' ? 'email' : itemType),
        ),
      )
      .limit(1);

    if (result.length === 0) {
      return undefined;
    }

    const row = result[0]!;
    return this.mapRowToRecord(row);
  }

  async recordIfAbsent(record: LedgerRecord): Promise<LedgerRecord> {
    // Try to insert; if conflict, return existing row
    const inserted = await this.db
      .insert(schemaSqlite.item)
      .values({
        id: crypto.randomUUID(),
        tenantId: record.tenantId,
        mappingId: record.mappingId,
        domain: record.itemType === 'mail' ? 'email' : record.itemType,
        collection: '',
        naturalKey: '',
        naturalKeyHash: record.naturalKeyHash,
        contentHash: record.contentHash || null,
        status: 'copied',
        targetRef: JSON.stringify({ id: record.targetId }),
        firstSeenAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .returning();

    // If nothing was inserted, fetch the existing row
    if (inserted.length === 0) {
      const existing = await this.find(record.tenantId, record.mappingId, record.itemType, record.naturalKeyHash);
      if (!existing) {
        throw new Error(
          `Failed to insert or find record with naturalKeyHash: ${record.naturalKeyHash}`,
        );
      }
      return existing;
    }

    return this.mapRowToRecord(inserted[0]!);
  }

  private mapRowToRecord(row: typeof schemaSqlite.item.$inferSelect): LedgerRecord {
    return {
      tenantId: row.tenantId as TenantId,
      mappingId: row.mappingId as MappingId,
      itemType: row.domain === 'email' ? 'mail' : (row.domain as 'calendar' | 'contact' | 'file'),
      naturalKeyHash: row.naturalKeyHash,
      contentHash: row.contentHash ?? '',
      targetId: (() => {
        try {
          const ref = JSON.parse(row.targetRef as string);
          return ref?.id ?? '';
        } catch {
          return '';
        }
      })(),
      createdAt: row.firstSeenAt ?? '',
    };
  }
}
