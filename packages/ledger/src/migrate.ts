// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

/**
 * Startup migration runner (workplan 0010 T1).
 *
 * Applies `packages/ledger/migrations/*.sql` linearly under a Postgres advisory
 * lock, recording each applied version in a `schema_migrations` table. Used by
 * the self-host entrypoint on startup and reusable by the worker/managed edition.
 *
 * Properties (SAD §22.1):
 * - **Idempotent:** re-running applies nothing (a no-op).
 * - **Concurrency-safe:** two processes racing the advisory lock apply each
 *   migration exactly once — the loser waits, then sees them already applied.
 * - **Refuses to start** when the database reports a schema version NEWER than
 *   this build understands (a downgrade guard).
 *
 * Runs as the DB owner/superuser (migrations create roles + RLS policies —
 * 0008/0009); the application then connects as a less-privileged role in managed
 * mode, or as the owner in single-tenant self-host mode.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Pool, type PoolClient } from 'pg';

/** Dedicated advisory-lock key for schema migrations (distinct from app locks). */
const MIGRATION_ADVISORY_LOCK_KEY = 727_0010;

export interface RunMigrationsOptions {
  /** Owner/superuser connection string (migrations create roles + RLS). */
  connectionString: string;
  /** Override the migrations directory (defaults to this package's migrations/). */
  migrationsDir?: string;
  /** Optional logger; defaults to console.log. */
  logger?: (message: string) => void;
}

export interface RunMigrationsResult {
  /** Versions applied during this run (empty on a no-op re-run). */
  readonly applied: readonly string[];
  /** Versions already present before this run. */
  readonly alreadyApplied: readonly string[];
  /** Highest applied version after this run, or null on an empty DB. */
  readonly currentVersion: string | null;
}

function defaultMigrationsDir(): string {
  // packages/ledger/src/migrate.ts -> packages/ledger/migrations
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
}

/** List migration versions (filenames) in linear order. */
export function listMigrationVersions(migrationsDir = defaultMigrationsDir()): string[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // zero-padded numeric prefixes sort lexicographically == numerically
}

/**
 * Apply all pending migrations. Safe to call on every startup.
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<RunMigrationsResult> {
  const { connectionString } = options;
  const migrationsDir = options.migrationsDir ?? defaultMigrationsDir();
  const log = options.logger ?? ((m: string) => console.log(m));

  const versions = listMigrationVersions(migrationsDir);
  if (versions.length === 0) {
    throw new Error(`No migration files found in ${migrationsDir}`);
  }
  const highestKnown = versions[versions.length - 1]!;

  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    // Serialize concurrent migrators. The loser blocks here until the winner
    // releases the lock, then finds every migration already applied.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           version text PRIMARY KEY,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      );

      const appliedRows = await client.query<{ version: string }>(
        'SELECT version FROM schema_migrations',
      );
      const alreadyApplied = new Set(appliedRows.rows.map((r) => r.version));

      // Downgrade guard: refuse if the DB carries a version newer than we ship.
      const highestApplied = [...alreadyApplied].sort().pop();
      if (highestApplied && highestApplied > highestKnown) {
        throw new Error(
          `Database schema version ${highestApplied} is newer than this build understands ` +
            `(highest known: ${highestKnown}). Refusing to start — upgrade the application.`,
        );
      }

      const applied: string[] = [];
      for (const version of versions) {
        if (alreadyApplied.has(version)) continue;
        await applyOne(client, migrationsDir, version, log);
        applied.push(version);
      }

      const currentVersion =
        [...alreadyApplied, ...applied].sort().pop() ?? null;

      if (applied.length === 0) {
        log(`[migrate] schema up to date at ${currentVersion ?? 'empty'}`);
      } else {
        log(`[migrate] applied ${applied.length} migration(s); now at ${currentVersion}`);
      }

      return { applied, alreadyApplied: [...alreadyApplied], currentVersion };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

/** Apply a single migration file + record it, atomically. */
async function applyOne(
  client: PoolClient,
  migrationsDir: string,
  version: string,
  log: (m: string) => void,
): Promise<void> {
  const sql = readFileSync(join(migrationsDir, version), 'utf-8');
  log(`[migrate] applying ${version}`);
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(
      `Migration ${version} failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}
