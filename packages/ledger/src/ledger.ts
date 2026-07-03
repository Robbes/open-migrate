import {
  NotImplementedError,
  type Ledger,
  type LedgerRecord,
  type TenantId,
  type MappingId,
} from '@openmig/shared';

/**
 * SQL-backed idempotency ledger — workplan 0001, T0.
 * Backed by PostgreSQL (managed) or SQLite (self-host) via Drizzle; see
 * `packages/ledger/migrations/0001_init.sql` and `packages/ledger/src/schema.ts`.
 * Idempotency anchor: UNIQUE(tenant_id, mapping_id, natural_key_hash). Non-destructive.
 *
 * The ledger is a fast CACHE + audit log of a fact that ALSO lives on the target (the natural
 * key — Message-ID / iCal UID / vCard UID / file path). If it is ever lost (e.g. a fresh
 * reinstall with no backup) it is rebuilt by reindexing the target rather than re-copying
 * everything; correctness does not depend on it surviving. See ADR-0020 and workplan T9.
 */
export class SqlLedger implements Ledger {
  // TODO(T0): inject a Drizzle db handle (node-postgres `pg` or better-sqlite3/libsql) via the constructor.

  async find(
    _tenantId: TenantId,
    _mappingId: MappingId,
    _naturalKeyHash: string,
  ): Promise<LedgerRecord | undefined> {
    // TODO(T0): SELECT * FROM ledger
    //           WHERE tenant_id = $1 AND mapping_id = $2 AND natural_key_hash = $3 LIMIT 1;
    throw new NotImplementedError('SqlLedger.find (workplan 0001, T0)');
  }

  async recordIfAbsent(_record: LedgerRecord): Promise<LedgerRecord> {
    // TODO(T0): INSERT INTO ledger
    //             (tenant_id, mapping_id, natural_key_hash, content_hash, target_id, created_at)
    //           VALUES (...)
    //           ON CONFLICT (tenant_id, mapping_id, natural_key_hash) DO NOTHING RETURNING *;
    //           If no row is returned, SELECT and return the existing row — so the write is a
    //           no-op when the natural key already exists (idempotent).
    throw new NotImplementedError('SqlLedger.recordIfAbsent (workplan 0001, T0)');
  }
}
