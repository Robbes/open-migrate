import {
  type DiscoveryStore,
  type DiscoveryRecord,
  type DiscoveryDomain,
  type DomainDiscovery,
  type TenantId,
  type MappingId,
} from '@openmig/shared';
import type { PgDatabase } from './db';
import { eq, and, sql } from 'drizzle-orm';
import * as schemaPg from './schema-pg';

/**
 * PostgreSQL implementation of {@link DiscoveryStore} (workplan 0013 T2).
 * One row per (tenant, mapping, domain); re-discovery overwrites via upsert. Tenant-scoped by RLS
 * (migration 0014) — production callers run inside `withTenant` as the non-owner `app_user`.
 */
export class PgDiscoveryStore implements DiscoveryStore {
  private readonly db: PgDatabase;

  constructor(db: PgDatabase) {
    this.db = db;
  }

  async upsertDiscovery(
    tenantId: TenantId,
    mappingId: MappingId,
    domain: DiscoveryDomain,
    discovery: DomainDiscovery,
  ): Promise<void> {
    const bytes = discovery.bytes ?? null;
    const perCollection = discovery.perCollection ?? null;
    await this.db
      .insert(schemaPg.migrationDiscovery)
      .values({
        tenantId,
        mappingId,
        domain,
        collections: discovery.collections,
        items: discovery.items,
        bytes,
        perCollection,
        lastError: null,
        discoveredAt: sql`now()`,
      })
      .onConflictDoUpdate({
        target: [
          schemaPg.migrationDiscovery.tenantId,
          schemaPg.migrationDiscovery.mappingId,
          schemaPg.migrationDiscovery.domain,
        ],
        set: {
          collections: discovery.collections,
          items: discovery.items,
          bytes,
          perCollection,
          lastError: null,
          discoveredAt: sql`now()`,
        },
      });
  }

  async recordDiscoveryError(
    tenantId: TenantId,
    mappingId: MappingId,
    domain: DiscoveryDomain,
    error: string,
  ): Promise<void> {
    await this.db
      .insert(schemaPg.migrationDiscovery)
      .values({
        tenantId,
        mappingId,
        domain,
        collections: 0,
        items: 0,
        bytes: null,
        perCollection: null,
        lastError: error,
        discoveredAt: sql`now()`,
      })
      .onConflictDoUpdate({
        target: [
          schemaPg.migrationDiscovery.tenantId,
          schemaPg.migrationDiscovery.mappingId,
          schemaPg.migrationDiscovery.domain,
        ],
        // Keep whatever counts a prior successful pass recorded; only stamp the error + time.
        set: {
          lastError: error,
          discoveredAt: sql`now()`,
        },
      });
  }

  async getDiscovery(tenantId: TenantId, mappingId: MappingId): Promise<DiscoveryRecord[]> {
    const rows = await this.db
      .select()
      .from(schemaPg.migrationDiscovery)
      .where(
        and(
          eq(schemaPg.migrationDiscovery.tenantId, tenantId),
          eq(schemaPg.migrationDiscovery.mappingId, mappingId),
        ),
      )
      .orderBy(schemaPg.migrationDiscovery.domain);

    return rows.map((row) => {
      const record: DiscoveryRecord = {
        domain: row.domain as DiscoveryDomain,
        collections: row.collections,
        items: row.items,
        discoveredAt:
          row.discoveredAt instanceof Date ? row.discoveredAt.toISOString() : String(row.discoveredAt),
        ...(row.bytes != null ? { bytes: Number(row.bytes) } : {}),
        ...(row.perCollection
          ? { perCollection: row.perCollection as DiscoveryRecord['perCollection'] }
          : {}),
        ...(row.lastError ? { lastError: row.lastError } : {}),
      };
      return record;
    });
  }
}
