// Copyright 2026 The Open Migration Stack authors (Apache-2.0)
//
// Integration tests for PgDiscoveryStore (workplan 0013 T2). Requires Postgres with the ledger
// schema + RLS (migration 0014) — run via `pnpm test:integration` (Testcontainers provides
// TEST_DATABASE_URL). Verifies upsert idempotency and cross-tenant RLS isolation (as the non-owner
// `app_user`, the way the discovery job runs in production).
//
// UUID family (discovery T2): d15c0000-e29b-41d4-a716-4466554400xx

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { createPgDb, withTenant } from './db';
import { PgDiscoveryStore } from './discovery-store';
import * as schemaPg from './schema-pg';
import { inArray } from 'drizzle-orm';
import type { TenantId, MappingId } from '@openmig/shared';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DB_URL) {
  throw new Error('TEST_DATABASE_URL is not set. Run: pnpm test:integration');
}

const TENANT_A = 'd15c0000-e29b-41d4-a716-446655440001' as TenantId;
const TENANT_B = 'd15c0000-e29b-41d4-a716-446655440002' as TenantId;
const MAPPING_A = 'd15c0000-e29b-41d4-a716-446655440011' as MappingId;
const MAPPING_B = 'd15c0000-e29b-41d4-a716-446655440012' as MappingId;

function appUserUrl(url: string): string {
  const u = new URL(url);
  u.username = 'app_user';
  u.password = 'app_password';
  return u.toString();
}

/** Seed the FK chain (connection → mailbox → mapping) for one tenant. */
async function seedTenant(
  db: ReturnType<typeof createPgDb>,
  tenantId: TenantId,
  mappingId: MappingId,
  suffix: string,
): Promise<void> {
  const connId = `d15c0000-e29b-41d4-a716-4466554401${suffix}`;
  const srcMb = `d15c0000-e29b-41d4-a716-4466554402${suffix}`;
  const tgtMb = `d15c0000-e29b-41d4-a716-4466554403${suffix}`;
  await db.insert(schemaPg.tenant).values({ id: tenantId, name: `T-${suffix}`, status: 'active', settings: {} }).onConflictDoNothing();
  await db.insert(schemaPg.connection).values({ id: connId, tenantId, role: 'source', kind: 'imap', displayName: 'src', config: {}, status: 'connected' }).onConflictDoNothing();
  await db.insert(schemaPg.mailbox).values({ id: srcMb, tenantId, connectionId: connId, kind: 'user', status: 'active' }).onConflictDoNothing();
  await db.insert(schemaPg.mailbox).values({ id: tgtMb, tenantId, connectionId: connId, kind: 'user', status: 'active' }).onConflictDoNothing();
  await db.insert(schemaPg.mailboxMapping).values({ id: mappingId, tenantId, sourceMailboxId: srcMb, targetMailboxId: tgtMb, mode: 'mirror', status: 'active' }).onConflictDoNothing();
}

describe('PgDiscoveryStore (0013 T2)', () => {
  let db: ReturnType<typeof createPgDb>;
  let appPool: Pool;

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    appPool = new Pool({ connectionString: appUserUrl(TEST_DB_URL) });
    await seedTenant(db, TENANT_A, MAPPING_A, '01');
    await seedTenant(db, TENANT_B, MAPPING_B, '02');
  });

  afterAll(async () => {
    await appPool.end();
    await db.close();
  });

  beforeEach(async () => {
    await db
      .delete(schemaPg.migrationDiscovery)
      .where(inArray(schemaPg.migrationDiscovery.tenantId, [TENANT_A, TENANT_B]));
  });

  it('upserts idempotently: re-discovery overwrites the same row', async () => {
    const store = new PgDiscoveryStore(db);
    await store.upsertDiscovery(TENANT_A, MAPPING_A, 'email', {
      collections: 2,
      items: 10,
      bytes: 1000,
      perCollection: [{ name: 'INBOX', items: 8, bytes: 800 }, { name: 'Sent', items: 2, bytes: 200 }],
    });
    await store.upsertDiscovery(TENANT_A, MAPPING_A, 'email', { collections: 3, items: 25 });

    const rows = await store.getDiscovery(TENANT_A, MAPPING_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ domain: 'email', collections: 3, items: 25 });
    // The second pass had no bytes → the column is cleared.
    expect(rows[0]?.bytes).toBeUndefined();
  });

  it('stores multiple domains and returns them ordered by domain', async () => {
    const store = new PgDiscoveryStore(db);
    await store.upsertDiscovery(TENANT_A, MAPPING_A, 'email', { collections: 1, items: 5 });
    await store.upsertDiscovery(TENANT_A, MAPPING_A, 'file', { collections: 2, items: 9, bytes: 4096 });
    await store.upsertDiscovery(TENANT_A, MAPPING_A, 'calendar', { collections: 1, items: 3 });

    const rows = await store.getDiscovery(TENANT_A, MAPPING_A);
    expect(rows.map((r) => r.domain)).toEqual(['calendar', 'email', 'file']);
    expect(rows.find((r) => r.domain === 'file')?.bytes).toBe(4096);
  });

  it('records a verbatim error without clobbering prior counts', async () => {
    const store = new PgDiscoveryStore(db);
    await store.upsertDiscovery(TENANT_A, MAPPING_A, 'contact', { collections: 1, items: 7 });
    await store.recordDiscoveryError(TENANT_A, MAPPING_A, 'contact', 'CardDAV 401 Unauthorized');

    const rows = await store.getDiscovery(TENANT_A, MAPPING_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ domain: 'contact', items: 7, lastError: 'CardDAV 401 Unauthorized' });
  });

  it('enforces RLS: a tenant cannot see another tenant’s discovery (as app_user)', async () => {
    // Insert tenant A's discovery as app_user within tenant A's context (exercises the INSERT policy).
    await withTenant(appPool, TENANT_A, async (txDb) => {
      await new PgDiscoveryStore(txDb).upsertDiscovery(TENANT_A, MAPPING_A, 'email', { collections: 1, items: 42 });
    });

    // Tenant A sees its row…
    const asA = await withTenant(appPool, TENANT_A, (txDb) => new PgDiscoveryStore(txDb).getDiscovery(TENANT_A, MAPPING_A));
    expect(asA).toHaveLength(1);
    expect(asA[0]?.items).toBe(42);

    // …tenant B cannot (RLS filters it out).
    const asB = await withTenant(appPool, TENANT_B, (txDb) => new PgDiscoveryStore(txDb).getDiscovery(TENANT_A, MAPPING_A));
    expect(asB).toHaveLength(0);
  });

  it('enforces RLS: cross-tenant INSERT is rejected (as app_user)', async () => {
    // While in tenant B's context, try to write a row for tenant A → WITH CHECK fails.
    await expect(
      withTenant(appPool, TENANT_B, async (txDb) => {
        await new PgDiscoveryStore(txDb).upsertDiscovery(TENANT_A, MAPPING_A, 'email', { collections: 1, items: 1 });
      }),
    ).rejects.toThrow();

    // Nothing was written for tenant A.
    const rows = await new PgDiscoveryStore(db).getDiscovery(TENANT_A, MAPPING_A);
    expect(rows).toHaveLength(0);
  });
});
