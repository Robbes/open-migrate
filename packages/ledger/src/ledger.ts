import {
  type Ledger,
  type LedgerRecord,
  type TenantId,
  type MappingId,
} from '@openmig/shared';
import type { PgDatabase } from './db';
import { eq, and, sql } from 'drizzle-orm';
import * as schemaPg from './schema-pg';

/**
 * SQL-backed idempotency ledger for PostgreSQL — workplan 0001, T0.
 * Backed by PostgreSQL via Drizzle; see
 * `packages/ledger/migrations/0001_init.sql` and schema-pg.ts.
 * Idempotency anchor: UNIQUE(tenant_id, mapping_id, natural_key_hash). Non-destructive.
 *
 * The ledger is a fast CACHE + audit log of a fact that ALSO lives on the target (the natural
 * key — Message-ID / iCal UID / vCard UID / file path). If it is ever lost (e.g. a fresh
 * reinstall with no backup) it is rebuilt by reindexing the target rather than re-copying
 * everything; correctness does not depend on it surviving. See ADR-0020 and workplan T9.
 */
export class PgLedger implements Ledger {
  private readonly db: PgDatabase;

  constructor(db: PgDatabase) {
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
      .from(schemaPg.item)
      .where(
        and(
          eq(schemaPg.item.tenantId, tenantId),
          eq(schemaPg.item.mappingId, mappingId),
          eq(schemaPg.item.naturalKeyHash, naturalKeyHash),
          eq(schemaPg.item.domain, itemType === 'mail' ? 'email' : itemType),
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
      .insert(schemaPg.item)
      .values({
        id: sql`gen_random_uuid()`,
        tenantId: record.tenantId,
        mappingId: record.mappingId,
        domain: record.itemType === 'mail' ? 'email' : record.itemType,
        collection: '', // Default for now
        naturalKey: '', // Will be set by caller if needed
        naturalKeyHash: record.naturalKeyHash,
        contentHash: record.contentHash,
        sizeBytes: record.sizeBytes !== undefined ? BigInt(record.sizeBytes) : null,
        status: record.status ?? 'copied',
        targetRef: JSON.stringify({ id: record.targetId }),
        firstSeenAt: sql`now()`,
        updatedAt: sql`now()`,
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

  private mapRowToRecord(row: typeof schemaPg.item.$inferSelect): LedgerRecord {
    return {
      tenantId: row.tenantId as TenantId,
      itemType: row.domain === 'email' ? 'mail' : (row.domain as 'calendar' | 'contact' | 'file'),
      mappingId: row.mappingId as MappingId,
      naturalKeyHash: row.naturalKeyHash,
      contentHash: row.contentHash ?? '',
      targetId: (row.targetRef as { id?: string })?.id ?? '',
      createdAt: row.firstSeenAt instanceof Date 
        ? row.firstSeenAt.toISOString() 
        : (row.firstSeenAt ?? ''),
      sizeBytes: row.sizeBytes !== null && row.sizeBytes !== undefined ? Number(row.sizeBytes) : undefined,
      status: row.status as LedgerRecord['status'],
    };
  }
}
