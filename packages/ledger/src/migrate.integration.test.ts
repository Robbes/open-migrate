// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

/**
 * Integration tests for the startup migration runner (workplan 0010 T1),
 * proving the SAD §22.1 gates: fresh install empty→latest, idempotent re-run,
 * concurrent double-start applies once, and the newer-schema refusal.
 *
 * Each test runs against a throwaway database it creates + drops, so it doesn't
 * touch the shared Testcontainers schema. Requires TEST_DATABASE_URL (Docker).
 */

import { describe, it, expect } from 'vitest';
import { Pool } from 'pg';
import { runMigrations, listMigrationVersions } from './migrate';

const ADMIN_URL = process.env.TEST_DATABASE_URL;
if (!ADMIN_URL) {
  throw new Error('TEST_DATABASE_URL is not set. Run: pnpm test:integration');
}

/** Create a fresh empty database and return its connection string. */
async function withFreshDb<T>(fn: (connectionString: string) => Promise<T>): Promise<T> {
  const dbName = `migrate_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new Pool({ connectionString: ADMIN_URL });
  try {
    await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }
  const url = new URL(ADMIN_URL!);
  url.pathname = `/${dbName}`;
  try {
    return await fn(url.toString());
  } finally {
    const cleanup = new Pool({ connectionString: ADMIN_URL });
    try {
      // Terminate stragglers, then drop.
      await cleanup.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName],
      );
      await cleanup.query(`DROP DATABASE IF EXISTS ${dbName}`);
    } finally {
      await cleanup.end();
    }
  }
}

const ALL_VERSIONS = listMigrationVersions();
const HIGHEST = ALL_VERSIONS[ALL_VERSIONS.length - 1]!;

async function appliedVersions(connectionString: string): Promise<string[]> {
  const pool = new Pool({ connectionString });
  try {
    const res = await pool.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version');
    return res.rows.map((r) => r.version);
  } finally {
    await pool.end();
  }
}

describe('runMigrations', () => {
  it('applies all migrations on a fresh database (empty → latest)', async () => {
    await withFreshDb(async (url) => {
      const result = await runMigrations({ connectionString: url, logger: () => {} });
      expect(result.applied).toEqual(ALL_VERSIONS);
      expect(result.currentVersion).toBe(HIGHEST);
      expect(await appliedVersions(url)).toEqual([...ALL_VERSIONS].sort());
    });
  });

  it('is idempotent: re-running applies nothing', async () => {
    await withFreshDb(async (url) => {
      await runMigrations({ connectionString: url, logger: () => {} });
      const second = await runMigrations({ connectionString: url, logger: () => {} });
      expect(second.applied).toEqual([]);
      expect(second.currentVersion).toBe(HIGHEST);
    });
  });

  it('applies each migration exactly once under concurrent double-start', async () => {
    await withFreshDb(async (url) => {
      const [a, b] = await Promise.all([
        runMigrations({ connectionString: url, logger: () => {} }),
        runMigrations({ connectionString: url, logger: () => {} }),
      ]);
      // Union of applied == all versions, and no version applied by both.
      const union = new Set([...a.applied, ...b.applied]);
      expect([...union].sort()).toEqual([...ALL_VERSIONS].sort());
      expect(a.applied.length + b.applied.length).toBe(ALL_VERSIONS.length);
      // Exactly one row per migration in the DB (no duplicates / no error).
      expect(await appliedVersions(url)).toEqual([...ALL_VERSIONS].sort());
    });
  });

  it('refuses to start when the DB schema is newer than the build', async () => {
    await withFreshDb(async (url) => {
      await runMigrations({ connectionString: url, logger: () => {} });
      // Simulate a future migration applied by a newer build.
      const pool = new Pool({ connectionString: url });
      try {
        await pool.query('INSERT INTO schema_migrations (version) VALUES ($1)', ['9999_from_the_future.sql']);
      } finally {
        await pool.end();
      }
      await expect(runMigrations({ connectionString: url, logger: () => {} })).rejects.toThrow(
        /newer than this build understands/,
      );
    });
  });
});
