// Database connection utilities for the ledger.
// Supports both PostgreSQL (managed) and SQLite (self-host).
// See ADR-0010 (Postgres + SQLite) and ADR-0016 (ledger schema).

import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import postgres from 'postgres';
import Database from 'better-sqlite3';

import * as schemaPg from './schema-pg';
import * as schemaSqlite from './schema-sqlite';

export type PgDatabase = ReturnType<typeof drizzlePg<typeof schemaPg>>;
export type SqliteDatabase = ReturnType<typeof drizzleSqlite<typeof schemaSqlite>>;

/**
 * Create a Postgres database handle for the ledger.
 * Uses the `postgres` driver (postgres-js) which is compatible with Drizzle.
 * Returns an object with the db and a close method.
 */
export function createPgDb(connectionString: string): PgDatabase & { $client: postgres.Sql<Record<string, unknown>>; close: () => Promise<void> } {
  const client = postgres(connectionString);
  const db = drizzlePg(client, { schema: schemaPg });
  return Object.assign(db, {
    $client: client,
    close: async () => {
      await client.end();
    },
  });
}

/**
 * Create a SQLite database handle for the ledger.
 * Uses better-sqlite3 for synchronous operations in self-host mode.
 */
export function createSqliteDb(dbPath: string): SqliteDatabase {
  const sqlite = new Database(dbPath);
  return drizzleSqlite(sqlite, { schema: schemaSqlite });
}

/**
 * Type union for database handles.
 */
export type LedgerDb = PgDatabase | SqliteDatabase;
