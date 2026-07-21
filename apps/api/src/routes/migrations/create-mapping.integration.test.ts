// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

/**
 * Integration test for real create-mapping persistence (POST /api/migrations).
 *
 * Proves the mock is gone: the endpoint persists the full connection → mailbox →
 * mapping → scope_selection chain in one RLS-scoped transaction, ENCRYPTS
 * credentials (plaintext never hits the DB, and secret_ref round-trips through
 * SecretStore), stores the mapping name/schedule/domains, and stays tenant-isolated.
 *
 * UUID Family: 5f4b0000-e29b-41d4-a716-44665544xxxx
 *
 * Runs against a Testcontainers Postgres (pnpm test:integration).
 */

process.env.JWT_SECRET = 'test-secret-for-integration-tests';
// 32-byte key (64 hex chars) so SecretStore can encrypt/decrypt.
process.env.SECRET_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import supertest from 'supertest';
import jwt from 'jsonwebtoken';
import { SecretStore } from '@openmig/core/secret-store';

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

const TENANT_A = '5f4b0000-e29b-41d4-a716-446655443101';
const TENANT_B = '5f4b0000-e29b-41d4-a716-446655443102';

function token(tenantId: string): string {
  return jwt.sign(
    { sub: `user-${tenantId}`, tenantId, role: 'owner', email: `user@${tenantId}.test` },
    process.env.JWT_SECRET!,
  );
}

const SECRET_PASSWORD = 'super-secret-pw-42';

const body = {
  name: 'Acme mail migration',
  sourceType: 'imap' as const,
  targetType: 'jmap' as const,
  sourceConfig: { host: 'imap.src.test', port: 993, username: 'src@acme.test', password: SECRET_PASSWORD, useSsl: true },
  targetConfig: { host: 'jmap.tgt.test', port: 443, username: 'tgt@acme.test', password: SECRET_PASSWORD, useSsl: true },
  syncConfig: { domains: ['email', 'calendar'] as const, schedule: '*/15 * * * *' },
};

describe('POST /api/migrations — real persistence', () => {
  let pool: Pool;
  let request: ReturnType<typeof supertest>;
  let createdMappingId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_CONNECTION_STRING });
    await pool.query(
      `INSERT INTO tenant (id, name, status, settings) VALUES ($1,'Create A','active','{}'),($2,'Create B','active','{}')
       ON CONFLICT (id) DO NOTHING`,
      [TENANT_A, TENANT_B],
    );
    request = supertest(app);
  });

  afterAll(async () => {
    // Cascades clean connections/mailboxes/mappings/scope_selection.
    await pool.query(`DELETE FROM tenant WHERE id IN ($1,$2)`, [TENANT_A, TENANT_B]);
    await pool.end();
  });

  it('creates a mapping and returns its persisted shape', async () => {
    const res = await request
      .post('/api/migrations')
      .set('Authorization', `Bearer ${token(TENANT_A)}`)
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Acme mail migration',
      sourceType: 'imap',
      targetType: 'jmap',
      // 0013 T5: new mappings are created paused (draft) until the owner starts them.
      status: 'paused',
    });
    expect(res.body.id).toBeTruthy();
    expect(res.body.syncConfig.domains).toEqual(['email', 'calendar']);
    expect(res.body.syncConfig.schedule).toBe('*/15 * * * *');
    createdMappingId = res.body.id;
  });

  it('persists the full chain: 2 connections, 2 mailboxes, mapping, scope rows', async () => {
    const conns = await pool.query(`SELECT role, kind FROM connection WHERE tenant_id = $1`, [TENANT_A]);
    expect(conns.rows).toHaveLength(2);
    // sourceType 'imap' → kind 'imap'; targetType 'jmap' → kind 'jmap'.
    expect(conns.rows.find((r) => r.role === 'source')?.kind).toBe('imap');
    expect(conns.rows.find((r) => r.role === 'target')?.kind).toBe('jmap');

    const mboxes = await pool.query(`SELECT COUNT(*)::int AS n FROM mailbox WHERE tenant_id = $1`, [TENANT_A]);
    expect(mboxes.rows[0].n).toBe(2);

    const mapping = await pool.query(`SELECT name, schedule, status FROM mailbox_mapping WHERE id = $1`, [createdMappingId]);
    expect(mapping.rows[0]).toMatchObject({ name: 'Acme mail migration', schedule: '*/15 * * * *', status: 'paused' });

    const scopes = await pool.query(`SELECT domain FROM scope_selection WHERE mapping_id = $1 ORDER BY domain`, [createdMappingId]);
    expect(scopes.rows.map((r) => r.domain)).toEqual(['calendar', 'email']);
  });

  it('encrypts credentials: plaintext never hits secret_ref, and it round-trips', async () => {
    const conns = await pool.query(`SELECT role, secret_ref FROM connection WHERE tenant_id = $1`, [TENANT_A]);
    for (const row of conns.rows) {
      expect(row.secret_ref).toBeTruthy();
      // The plaintext password must not appear anywhere in the stored blob.
      expect(row.secret_ref).not.toContain(SECRET_PASSWORD);
      // And it must decrypt back to the original credentials.
      const creds = SecretStore.decryptCredentials(row.secret_ref);
      expect(creds.password).toBe(SECRET_PASSWORD);
    }
  });

  it('is tenant-isolated: tenant B cannot see tenant A mapping', async () => {
    const res = await request
      .get(`/api/migrations/${createdMappingId}`)
      .set('Authorization', `Bearer ${token(TENANT_B)}`);
    expect(res.status).toBe(404);
  });

  it('rejects an invalid body with 400', async () => {
    const res = await request
      .post('/api/migrations')
      .set('Authorization', `Bearer ${token(TENANT_A)}`)
      .send({ name: '' });
    expect(res.status).toBe(400);
  });
});
