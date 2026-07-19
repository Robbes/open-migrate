// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

/**
 * Integration tests for the real run-history endpoints
 * (GET /api/migrations/:mappingId/runs and .../runs/:runId).
 *
 * Proves the endpoints return real ledger `run`/`run_event` data (not the former
 * fabricated mock), map ledger status/kind to the API shape, surface event logs
 * verbatim, and are RLS-scoped.
 *
 * UUID Family: 5f3b0000-e29b-41d4-a716-44665544xxxx
 *
 * Runs against a Testcontainers Postgres (pnpm test:integration).
 */

process.env.JWT_SECRET = 'test-secret-for-integration-tests';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import supertest from 'supertest';
import jwt from 'jsonwebtoken';

const PG_CONNECTION_STRING = process.env.TEST_DATABASE_URL;
if (!PG_CONNECTION_STRING) {
  throw new Error('TEST_DATABASE_URL is not set. Run: pnpm test:integration');
}

const appUserUrl = (u: string): string => {
  const url = new URL(u);
  url.username = 'app_user';
  url.password = 'app_password';
  return url.toString();
};
process.env.APP_DATABASE_URL = appUserUrl(PG_CONNECTION_STRING);

import app from '../../index.js';

const P = '5f3b0000-e29b-41d4-a716-4466554431';
const TENANT_A = `${P}01`;
const TENANT_B = `${P}02`;
const SRC_CONN = `${P}c1`;
const TGT_CONN = `${P}c2`;
const SRC_MBOX = `${P}b1`;
const TGT_MBOX = `${P}b2`;
const MAPPING = `${P}d1`;
const RUN_DELTA = `${P}e1`;
const RUN_FULL = `${P}e2`;

function token(tenantId: string): string {
  return jwt.sign(
    { sub: `user-${tenantId}`, tenantId, role: 'owner', email: `user@${tenantId}.test` },
    process.env.JWT_SECRET!,
  );
}

describe('Real run-history endpoints', () => {
  let pool: Pool;
  let request: ReturnType<typeof supertest>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_CONNECTION_STRING });

    await pool.query(
      `INSERT INTO tenant (id, name, status, settings) VALUES ($1,'Runs A','active','{}'),($2,'Runs B','active','{}')
       ON CONFLICT (id) DO NOTHING`,
      [TENANT_A, TENANT_B],
    );
    await pool.query(
      `INSERT INTO connection (id, tenant_id, role, kind, display_name, config)
       VALUES ($1,$3,'source','o365','src','{}'),($2,$3,'target','nextcloud','tgt','{}')
       ON CONFLICT (id) DO NOTHING`,
      [SRC_CONN, TGT_CONN, TENANT_A],
    );
    await pool.query(
      `INSERT INTO mailbox (id, tenant_id, connection_id, kind, external_id)
       VALUES ($1,$3,$4,'user','s'),($2,$3,$5,'user','t')
       ON CONFLICT (id) DO NOTHING`,
      [SRC_MBOX, TGT_MBOX, TENANT_A, SRC_CONN, TGT_CONN],
    );
    await pool.query(
      `INSERT INTO mailbox_mapping (id, tenant_id, source_mailbox_id, target_mailbox_id, mode, status)
       VALUES ($1,$2,$3,$4,'mirror','active') ON CONFLICT (id) DO NOTHING`,
      [MAPPING, TENANT_A, SRC_MBOX, TGT_MBOX],
    );

    // Two runs: a newer succeeded delta and an older failed full.
    await pool.query(
      `INSERT INTO run (id, tenant_id, mapping_id, kind, trigger, status, stats, started_at, finished_at, created_at)
       VALUES
        ($1,$3,$4,'incremental','schedule','succeeded','{"itemsProcessed":45,"errors":0}', NOW() - interval '10 min', NOW() - interval '9 min', NOW()),
        ($2,$3,$4,'initial_copy','manual','failed','{"itemsProcessed":10,"errors":2}', NOW() - interval '2 hour', NOW() - interval '1 hour', NOW() - interval '1 hour')`,
      [RUN_DELTA, RUN_FULL, TENANT_A, MAPPING],
    );
    await pool.query(
      `INSERT INTO run_event (id, tenant_id, run_id, level, message, at)
       VALUES (gen_random_uuid(), $1, $2, 'error', 'connector auth failed: 401', NOW() - interval '90 min')`,
      [TENANT_A, RUN_FULL],
    );

    request = supertest(app);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM run_event WHERE tenant_id = $1`, [TENANT_A]);
    await pool.query(`DELETE FROM run WHERE tenant_id = $1`, [TENANT_A]);
    await pool.query(`DELETE FROM mailbox_mapping WHERE tenant_id = $1`, [TENANT_A]);
    await pool.query(`DELETE FROM mailbox WHERE tenant_id = $1`, [TENANT_A]);
    await pool.query(`DELETE FROM connection WHERE tenant_id = $1`, [TENANT_A]);
    await pool.query(`DELETE FROM tenant WHERE id IN ($1,$2)`, [TENANT_A, TENANT_B]);
    await pool.end();
  });

  it('lists real runs newest-first with mapped kind/status', async () => {
    const res = await request
      .get(`/api/migrations/${MAPPING}/runs`)
      .set('Authorization', `Bearer ${token(TENANT_A)}`);

    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(2);
    expect(res.body.runs[0]).toMatchObject({ id: RUN_DELTA, type: 'delta', status: 'success', itemsProcessed: 45, errors: 0 });
    expect(res.body.runs[1]).toMatchObject({ id: RUN_FULL, type: 'full', status: 'failed', itemsProcessed: 10, errors: 2 });
  });

  it('returns a single run with its event log (errors verbatim)', async () => {
    const res = await request
      .get(`/api/migrations/${MAPPING}/runs/${RUN_FULL}`)
      .set('Authorization', `Bearer ${token(TENANT_A)}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: RUN_FULL, type: 'full', status: 'failed', errors: 2 });
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({ level: 'error', message: 'connector auth failed: 401' });
  });

  it('404s for an unknown run', async () => {
    const res = await request
      .get(`/api/migrations/${MAPPING}/runs/5f3b0000-e29b-41d4-a716-446655449999`)
      .set('Authorization', `Bearer ${token(TENANT_A)}`);
    expect(res.status).toBe(404);
  });

  it('is RLS-scoped: tenant B sees none of tenant A runs', async () => {
    const res = await request
      .get(`/api/migrations/${MAPPING}/runs`)
      .set('Authorization', `Bearer ${token(TENANT_B)}`);
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(0);
  });

  it('401s without a token', async () => {
    const res = await request.get(`/api/migrations/${MAPPING}/runs`);
    expect(res.status).toBe(401);
  });
});
