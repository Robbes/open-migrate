// Database connection utilities for the ledger.
// PostgreSQL only (see ADR-0010, ADR-0016).
// Uses the `pg` driver (node-postgres) with drizzle-orm/node-postgres.

import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schemaPg from './schema-pg';

export type PgDatabase = ReturnType<typeof drizzlePg<typeof schemaPg>>;

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
