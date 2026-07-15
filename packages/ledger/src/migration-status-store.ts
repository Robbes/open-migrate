import {
  type MigrationStatusStore,
  type MigrationStatus,
  type TenantId,
  type MappingId,
} from '@openmig/shared';
import type { PgDatabase } from './db';
import { eq, and, sql } from 'drizzle-orm';
import * as schemaPg from './schema-pg';

/**
 * PostgreSQL implementation of MigrationStatusStore.
 * State is maintained (pending/in_progress/completed/failed/skipped),
 * while item counts are DERIVED from the item ledger records.
 */
export class PgMigrationStatusStore implements MigrationStatusStore {
  private readonly db: PgDatabase;

  constructor(db: PgDatabase) {
    this.db = db;
  }

  async initDomainStatus(
    tenantId: TenantId,
    mappingId: MappingId,
    domain: 'email' | 'calendar' | 'contact' | 'file',
  ): Promise<void> {
    // Idempotent upsert: insert if not exists, otherwise no-op
    await this.db
      .insert(schemaPg.migrationStatus)
      .values({
        id: sql`gen_random_uuid()`,
        tenantId,
        mappingId,
        domain,
        state: 'pending',
        startedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .onConflictDoNothing();
  }

  async markInProgress(
    tenantId: TenantId,
    mappingId: MappingId,
    domain: 'email' | 'calendar' | 'contact' | 'file',
  ): Promise<void> {
    await this.db
      .update(schemaPg.migrationStatus)
      .set({
        state: 'in_progress',
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(schemaPg.migrationStatus.tenantId, tenantId),
          eq(schemaPg.migrationStatus.mappingId, mappingId),
          eq(schemaPg.migrationStatus.domain, domain),
        ),
      );
  }

  async markCompleted(
    tenantId: TenantId,
    mappingId: MappingId,
    domain: 'email' | 'calendar' | 'contact' | 'file',
  ): Promise<void> {
    await this.db
      .update(schemaPg.migrationStatus)
      .set({
        state: 'completed',
        completedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(schemaPg.migrationStatus.tenantId, tenantId),
          eq(schemaPg.migrationStatus.mappingId, mappingId),
          eq(schemaPg.migrationStatus.domain, domain),
        ),
      );
  }

  async markFailed(
    tenantId: TenantId,
    mappingId: MappingId,
    domain: 'email' | 'calendar' | 'contact' | 'file',
    error: string,
  ): Promise<void> {
    await this.db
      .update(schemaPg.migrationStatus)
      .set({
        state: 'failed',
        lastError: error,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(schemaPg.migrationStatus.tenantId, tenantId),
          eq(schemaPg.migrationStatus.mappingId, mappingId),
          eq(schemaPg.migrationStatus.domain, domain),
        ),
      );
  }

  async markSkipped(
    tenantId: TenantId,
    mappingId: MappingId,
    domain: 'email' | 'calendar' | 'contact' | 'file',
  ): Promise<void> {
    await this.db
      .update(schemaPg.migrationStatus)
      .set({
        state: 'skipped',
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(schemaPg.migrationStatus.tenantId, tenantId),
          eq(schemaPg.migrationStatus.mappingId, mappingId),
          eq(schemaPg.migrationStatus.domain, domain),
        ),
      );
  }

  async getStatus(
    tenantId: TenantId,
    mappingId: MappingId,
  ): Promise<MigrationStatus[]> {
    // Join migration_status with item to derive counts
    const rows = await this.db
      .select({
        status: schemaPg.migrationStatus,
        itemsSynced: sql<number>`COUNT(CASE WHEN ${schemaPg.item.status} IN ('copied', 'updated', 'skipped') THEN 1 END)`,
        itemsFailed: sql<number>`COUNT(CASE WHEN ${schemaPg.item.status} = 'failed' THEN 1 END)`,
        bytesTransferred: sql<number | null>`COALESCE(SUM(${schemaPg.item.sizeBytes}), 0)`,
      })
      .from(schemaPg.migrationStatus)
      .leftJoin(
        schemaPg.item,
        and(
          eq(schemaPg.item.tenantId, schemaPg.migrationStatus.tenantId),
          eq(schemaPg.item.mappingId, schemaPg.migrationStatus.mappingId),
          eq(schemaPg.item.domain, schemaPg.migrationStatus.domain),
        ),
      )
      .where(
        and(
          eq(schemaPg.migrationStatus.tenantId, tenantId),
          eq(schemaPg.migrationStatus.mappingId, mappingId),
        ),
      )
      .groupBy(
        schemaPg.migrationStatus.id,
        schemaPg.migrationStatus.tenantId,
        schemaPg.migrationStatus.mappingId,
        schemaPg.migrationStatus.domain,
        schemaPg.migrationStatus.state,
        schemaPg.migrationStatus.startedAt,
        schemaPg.migrationStatus.updatedAt,
        schemaPg.migrationStatus.completedAt,
        schemaPg.migrationStatus.lastError,
      )
      .orderBy(schemaPg.migrationStatus.domain);

    return rows.map((row) => ({
      id: row.status.id,
      tenantId: row.status.tenantId as TenantId,
      mappingId: row.status.mappingId as MappingId,
      domain: row.status.domain as 'email' | 'calendar' | 'contact' | 'file',
      state: row.status.state as
        | 'pending'
        | 'in_progress'
        | 'completed'
        | 'failed'
        | 'skipped',
      itemsSynced: Number(row.itemsSynced),
      itemsFailed: Number(row.itemsFailed),
      bytesTransferred: Number(row.bytesTransferred ?? 0),
      startedAt: row.status.startedAt instanceof Date
        ? row.status.startedAt.toISOString()
        : row.status.startedAt,
      updatedAt: row.status.updatedAt instanceof Date
        ? row.status.updatedAt.toISOString()
        : row.status.updatedAt,
      completedAt: row.status.completedAt instanceof Date
        ? row.status.completedAt.toISOString()
        : row.status.completedAt,
      lastError: row.status.lastError ?? undefined,
    }));
  }
}
