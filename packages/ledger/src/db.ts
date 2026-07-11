// Database connection utilities for the ledger.
// PostgreSQL only (see ADR-0010, ADR-0016).
// Uses the `postgres` driver (postgres-js) which is compatible with Drizzle.

import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schemaPg from './schema-pg';

export type PgDatabase = ReturnType<typeof drizzlePg<typeof schemaPg>>;

/**
 * Create a Postgres database handle for the ledger.
 * Returns an object with the db and a close method.
 */
export function createPgDb(connectionString: string): PgDatabase & { $client: postgres.Sql; close: () => Promise<void> } {
  const client = postgres(connectionString);
  const db = drizzlePg(client, { schema: schemaPg });
  return Object.assign(db, {
    $client: client,
    close: async () => {
      await client.end();
    },
  });
}
