// Copyright 2026 The Open Migration Stack authors (Apache-2.0)
//
// Integration tests for the 0013 discovery/confirm API routes: GET /api/scope-manifest,
// GET/POST /api/migrations/:id/discovery|discover|start, and the paused-sync guard. Runs against
// Testcontainers Postgres (pnpm test:integration). The happy-path /discover + /sync ENQUEUE is a
// thin string-id call to Trigger.dev (covered by the T3 job unit test); here we cover the paths
// that don't require a live Trigger.dev.
//
// UUID Family: e0d15000-e29b-41d4-a716-4466554400xx

process.env.JWT_SECRET = 'test-secret-for-integration-tests';
process.env.SECRET_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import supertest from 'supertest';
import jwt from 'jsonwebtoken';

const PG = process.env.TEST_DATABASE_URL;
if (!PG) throw new Error('TEST_DATABASE_URL is not set. Run: pnpm test:integration');

const appUserUrl = (u: string): string => {
  const url = new URL(u);
  url.username = 'app_user';
  url.password = 'app_password';
  return url.toString();
};
process.env.APP_DATABASE_URL = appUserUrl(PG);

import app from '../../index.js';

const TENANT = 'e0d15000-e29b-41d4-a716-446655440001';
const CONN = 'e0d15000-e29b-41d4-a716-446655440010';
const SRC_MB = 'e0d15000-e29b-41d4-a716-446655440020';
const TGT_MB = 'e0d15000-e29b-41d4-a716-446655440021';
const MAPPING = 'e0d15000-e29b-41d4-a716-446655440030'; // paused, used for discovery + guard + start
const NO_SUCH = 'e0d15000-e29b-41d4-a716-4466554400ff';

function token(tenantId: string): string {
  return jwt.sign(
    { sub: `user-${tenantId}`, tenantId, role: 'owner', email: `user@${tenantId}.test` },
    process.env.JWT_SECRET!,
  );
}

describe('discovery/confirm routes (0013 T4/T5)', () => {
  let pool: Pool;
  const request = supertest(app);

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG });
    await pool.query(`INSERT INTO tenant (id, name, status, settings) VALUES ($1,'Disc T','active','{}') ON CONFLICT DO NOTHING`, [TENANT]);
    await pool.query(`INSERT INTO connection (id, tenant_id, role, kind, display_name, config, status) VALUES ($1,$2,'source','imap','src','{}','connected') ON CONFLICT DO NOTHING`, [CONN, TENANT]);
    await pool.query(`INSERT INTO mailbox (id, tenant_id, connection_id, kind, status) VALUES ($1,$3,$2,'user','active'),($4,$3,$2,'user','active') ON CONFLICT DO NOTHING`, [SRC_MB, CONN, TENANT, TGT_MB]);
    await pool.query(
      `INSERT INTO mailbox_mapping (id, tenant_id, source_mailbox_id, target_mailbox_id, mode, status) VALUES ($1,$2,$3,$4,'mirror','paused') ON CONFLICT DO NOTHING`,
      [MAPPING, TENANT, SRC_MB, TGT_MB],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM tenant WHERE id = $1`, [TENANT]);
    await pool.end();
  });

  it('GET /api/scope-manifest returns the §11.2 manifest', async () => {
    const res = await request.get('/api/scope-manifest');
    expect(res.status).toBe(200);
    expect(res.body.version).toBeTruthy();
    expect(Array.isArray(res.body.migrates)).toBe(true);
    expect(Array.isArray(res.body.partial)).toBe(true);
    expect(Array.isArray(res.body.doesNotMigrate)).toBe(true);
    expect(res.body.doesNotMigrate.some((e: { item: string }) => /Teams/i.test(e.item))).toBe(true);
  });

  it('GET /:id/discovery is empty before any pass', async () => {
    const res = await request.get(`/api/migrations/${MAPPING}/discovery`).set('Authorization', `Bearer ${token(TENANT)}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mappingId: MAPPING, discovered: false });
    expect(res.body.domains).toEqual([]);
  });

  it('POST /:id/sync is refused (409) while the mapping is paused', async () => {
    const res = await request.post(`/api/migrations/${MAPPING}/sync`).set('Authorization', `Bearer ${token(TENANT)}`).send({});
    expect(res.status).toBe(409);
  });

  it('GET /:id/discovery reflects stored counts', async () => {
    await pool.query(
      `INSERT INTO migration_discovery (tenant_id, mapping_id, domain, collections, items, bytes)
       VALUES ($1,$2,'email',2,10,1024) ON CONFLICT (tenant_id, mapping_id, domain) DO UPDATE SET items = EXCLUDED.items`,
      [TENANT, MAPPING],
    );
    const res = await request.get(`/api/migrations/${MAPPING}/discovery`).set('Authorization', `Bearer ${token(TENANT)}`);
    expect(res.status).toBe(200);
    expect(res.body.discovered).toBe(true);
    expect(res.body.domains).toHaveLength(1);
    expect(res.body.domains[0]).toMatchObject({ domain: 'email', collections: 2, items: 10, bytes: 1024 });
  });

  it('POST /:id/start activates the mapping (idempotent)', async () => {
    const res = await request.post(`/api/migrations/${MAPPING}/start`).set('Authorization', `Bearer ${token(TENANT)}`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: MAPPING, status: 'active' });

    const row = await pool.query(`SELECT status FROM mailbox_mapping WHERE id = $1`, [MAPPING]);
    expect(row.rows[0].status).toBe('active');

    // Idempotent second call.
    const again = await request.post(`/api/migrations/${MAPPING}/start`).set('Authorization', `Bearer ${token(TENANT)}`).send({});
    expect(again.status).toBe(200);
  });

  it('404s for a mapping that does not exist', async () => {
    const auth = { Authorization: `Bearer ${token(TENANT)}` };
    expect((await request.get(`/api/migrations/${NO_SUCH}/discovery`).set(auth)).status).toBe(404);
    expect((await request.post(`/api/migrations/${NO_SUCH}/start`).set(auth).send({})).status).toBe(404);
    expect((await request.post(`/api/migrations/${NO_SUCH}/discover`).set(auth).send({})).status).toBe(404);
  });
});
