// Database connection utilities for the ledger.
// PostgreSQL only (see ADR-0010, ADR-0016, ADR-0023).
// Uses the `pg` driver (node-postgres) with drizzle-orm/node-postgres.

import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schemaPg from './schema-pg';

export type PgDatabase = ReturnType<typeof drizzlePg<typeof schemaPg>>;

/**
 * Transaction-scoped helper that sets the tenant context for RLS.
 * 
 * This is the critical security gate for multi-tenant isolation. It:
 * 1. Acquires a client from the pool
 * 2. Begins a transaction
 * 3. Sets the tenant context via `SELECT set_config('app.current_tenant', $1, true)`
 * 4. Runs the provided function with a transaction-bound drizzle handle
 * 5. Commits on success, rolls back on error (re-throws the original error)
 * 
 * The use of `set_config(..., true)` ensures the context is transaction-local
 * and injection-safe (uses bind parameters, not string interpolation).
 * 
 * @param pool - The pg pool to acquire a client from
 * @param tenantId - The tenant ID to set as the current context
 * @param fn - The function to run within the tenant-scoped transaction
 * @returns The result of fn
 * 
 * @example
 * ```typescript
 * const result = await withTenant(pool, 'tenant-uuid', async (txDb) => {
 *   return await txDb.select().from(connection);
 * });
 * ```
 */
export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (db: PgDatabase) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  
  try {
    // Begin transaction
    await client.query('BEGIN');
    
    // Create a drizzle instance bound to this client (for transaction)
    const txDb = drizzlePg(client, { schema: schemaPg });
    
    // Set tenant context - use set_config with bind param for safety
    // The third parameter `true` makes it transaction-local (equivalent to SET LOCAL)
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    
    // Run the function with the transaction-scoped db
    const result = await fn(txDb as unknown as PgDatabase);
    
    // Commit transaction
    await client.query('COMMIT');
    
    return result;
  } catch (error) {
    // Rollback on error
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // Log rollback error but don't mask the original error
      console.error('Rollback failed after error:', rollbackError);
    }
    
    // Re-throw the original error (never swallow it - hard rule 9)
    throw error;
  } finally {
    // Always release the client back to the pool
    client.release();
  }
}

/**
 * Create a Postgres database handle for the ledger.
 * Returns an object with the db and a close method.
 */
export function createPgDb(connectionString: string): PgDatabase & { $pool: Pool; close: () => Promise<void> } {
  const pool = new Pool({ connectionString });
  const db = drizzlePg(pool, { schema: schemaPg });
  return Object.assign(db, {
    $pool: pool,
    close: async () => {
      await pool.end();
    },
  });
}
