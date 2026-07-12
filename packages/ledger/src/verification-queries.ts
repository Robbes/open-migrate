/**
 * Ledger verification queries - moved from core to ledger
 * 
 * Provides read-only queries against the ledger for verification purposes.
 * All queries are Postgres-only (ADR-0016).
 */

import type { TenantId, MappingId } from '@openmig/shared';
import { createPgDb } from './db';
import * as schema from './schema-pg';
import { eq, and, sql } from 'drizzle-orm';

/**
 * Port for reading verification data from the ledger.
 * Used by the verification orchestrator to compare source vs target state.
 */
export interface LedgerVerificationReader {
  /** Count items of a given type in the ledger for a mapping */
  countItems(tenantId: TenantId, mappingId: MappingId, domain: 'email' | 'calendar' | 'contact' | 'file'): Promise<number>;
  
  /** Get total bytes for items of a given type in the ledger */
  totalSizeBytes(tenantId: TenantId, mappingId: MappingId, domain: 'email' | 'calendar' | 'contact' | 'file'): Promise<number>;
  
  /** Get sample items for verification (ids + natural key hashes + content hashes) */
  getSamples(
    tenantId: TenantId,
    mappingId: MappingId,
    domain: 'email' | 'calendar' | 'contact' | 'file',
    count: number
  ): Promise<Array<{ id: string; naturalKeyHash: string; contentHash: string }>>;

  /** Get all natural key hashes for a given domain (used for discrepancy detection) */
  getAllNaturalKeyHashes(
    tenantId: TenantId,
    mappingId: MappingId,
    domain: 'email' | 'calendar' | 'contact' | 'file'
  ): Promise<string[]>;
}

/**
 * Configuration for creating a LedgerVerificationReader.
 */
export interface LedgerVerificationReaderConfig {
  /** Database connection string */
  connectionString: string;
}

/**
 * Create a LedgerVerificationReader backed by Postgres.
 * The reader is constructed with a concrete pg drizzle instance.
 */
export function createLedgerVerificationReader(config: LedgerVerificationReaderConfig): LedgerVerificationReader {
  const db = createPgDb(config.connectionString);
  
  return {
    async countItems(tenantId, mappingId, domain): Promise<number> {
      const result = await db
        .select({ 
          count: sql`count(*)`.mapWith(Number) 
        })
        .from(schema.item)
        .where(
          and(
            eq(schema.item.tenantId, tenantId),
            eq(schema.item.mappingId, mappingId),
            eq(schema.item.domain, domain)
          )
        );
      return result[0]?.count ?? 0;
    },
    
    async totalSizeBytes(tenantId, mappingId, domain): Promise<number> {
      const result = await db
        .select({ 
          total: sql`coalesce(sum(size_bytes), 0)`.mapWith(Number) 
        })
        .from(schema.item)
        .where(
          and(
            eq(schema.item.tenantId, tenantId),
            eq(schema.item.mappingId, mappingId),
            eq(schema.item.domain, domain)
          )
        );
      return result[0]?.total ?? 0;
    },
    
    async getSamples(tenantId, mappingId, domain, count): Promise<Array<{ id: string; naturalKeyHash: string; contentHash: string }>> {
      const result = await db
        .select({
          id: schema.item.id,
          naturalKeyHash: schema.item.naturalKeyHash,
          contentHash: schema.item.contentHash,
        })
        .from(schema.item)
        .where(
          and(
            eq(schema.item.tenantId, tenantId),
            eq(schema.item.mappingId, mappingId),
            eq(schema.item.domain, domain)
          )
        )
        .orderBy(schema.item.naturalKeyHash)
        .limit(count);
      
      return result.map((row) => ({
        id: row.id,
        naturalKeyHash: row.naturalKeyHash,
        contentHash: row.contentHash ?? '',
      }));
    },

    async getAllNaturalKeyHashes(tenantId, mappingId, domain): Promise<string[]> {
      const result = await db
        .select({
          naturalKeyHash: schema.item.naturalKeyHash,
        })
        .from(schema.item)
        .where(
          and(
            eq(schema.item.tenantId, tenantId),
            eq(schema.item.mappingId, mappingId),
            eq(schema.item.domain, domain)
          )
        );
      
      return result.map((row) => row.naturalKeyHash);
    },
  };
}
