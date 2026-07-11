import type { CursorStore, SyncCursor, TenantId, MappingId } from '@openmig/shared';
import type { PgDatabase } from './db';
import { eq, and, sql } from 'drizzle-orm';
import * as schemaPg from './schema-pg';

/**
 * SQL-backed cursor store for PostgreSQL.
 * Persists per-folder cursors for incremental sync.
 */
export class PgCursorStore implements CursorStore {
  private readonly db: PgDatabase;

  constructor(db: PgDatabase) {
    this.db = db;
  }

  async get(
    tenantId: TenantId,
    mappingId: MappingId,
    folderPath: string,
  ): Promise<SyncCursor | undefined> {
    const result = await this.db
      .select({ cursorValue: schemaPg.cursor.cursorValue })
      .from(schemaPg.cursor)
      .where(
        and(
          eq(schemaPg.cursor.tenantId, tenantId),
          eq(schemaPg.cursor.mappingId, mappingId),
          eq(schemaPg.cursor.folderPath, folderPath),
        ),
      )
      .limit(1);

    if (result.length === 0) {
      return undefined;
    }

    return { value: result[0]!.cursorValue };
  }

  async set(
    tenantId: TenantId,
    mappingId: MappingId,
    folderPath: string,
    cursor: SyncCursor,
  ): Promise<void> {
    await this.db
      .insert(schemaPg.cursor)
      .values({
        id: sql`gen_random_uuid()`,
        tenantId,
        mappingId,
        folderPath,
        cursorValue: cursor.value,
        updatedAt: sql`now()`,
      })
      .onConflictDoUpdate({
        target: [schemaPg.cursor.tenantId, schemaPg.cursor.mappingId, schemaPg.cursor.folderPath],
        set: {
          cursorValue: cursor.value,
          updatedAt: sql`now()`,
        },
      });
  }
}
