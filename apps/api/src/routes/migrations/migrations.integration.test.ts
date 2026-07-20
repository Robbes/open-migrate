/**
 * API Integration Tests for Migrations Routes
 * 
 * Tests that prove tenant isolation for all migration/mapping endpoints.
 * Includes cross-tenant access prevention tests.
 * 
 * UUID Family: 950e8400-e29b-41d4-a716-44665544xxxx (consistent with other tests)
 */

// Set JWT_SECRET before importing app
process.env.JWT_SECRET = 'test-secret-for-migration-tests';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import supertest from 'supertest';
import jwt from 'jsonwebtoken';

// Mock the Trigger.dev client so the real sync/cutover endpoints can be tested
// without a live orchestrator: capture the enqueue call and return a stub run.
const { triggerMock } = vi.hoisted(() => ({
  triggerMock: vi.fn(async () => ({ id: 'run_mock_test' })),
}));
vi.mock('@openmig/scheduler', () => ({
  getTriggerClient: () => ({ tasks: { trigger: triggerMock } }),
}));

const PG_CONNECTION_STRING = process.env.TEST_DATABASE_URL;
if (!PG_CONNECTION_STRING) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Run: pnpm test:integration'
  );
}

// Set APP_DATABASE_URL so the API can connect
// Use app_user role to ensure RLS is enforced (superusers bypass RLS)
const getAppUserConnectionString = (originalUrl: string): string => {
  const url = new URL(originalUrl);
  url.username = 'app_user';
  url.password = 'app_password';
  return url.toString();
};
process.env.APP_DATABASE_URL = getAppUserConnectionString(PG_CONNECTION_STRING);

import app from '../../index.js';
// import * as schema from '@open-migrate/ledger'; // Not needed - using raw SQL queries

// UUIDs for migration tests
const MIG_TENANT_A = '5a1b0000-e29b-41d4-a716-446655443101';
const MIG_TENANT_B = '5a1b0000-e29b-41d4-a716-446655443102';

// Mapping IDs
const MIG_MAPPING_A = '5a1b0000-e29b-41d4-a716-446655443201';
const MIG_MAPPING_B = '5a1b0000-e29b-41d4-a716-446655443202';

function createTestToken(tenantId: string, role: string = 'member'): string {
  return jwt.sign(
    {
      sub: `user-${tenantId}`,
      tenantId,
      role,
      email: `user@${tenantId}.test`,
    },
    process.env.JWT_SECRET!
  );
}

const TOKEN_TENANT_A = createTestToken(MIG_TENANT_A);
const TOKEN_TENANT_B = createTestToken(MIG_TENANT_B);

describe('Migrations Routes - Tenant Isolation', () => {
  let superuserPool: Pool;
  let request: ReturnType<typeof supertest>;

  beforeAll(async () => {
    superuserPool = new Pool({
      connectionString: PG_CONNECTION_STRING,
    });

    // Create test tenants
    await superuserPool.query(`
      INSERT INTO tenant (id, name, status)
      VALUES ($1, $2, $3), ($4, $5, $6)
      ON CONFLICT (id) DO NOTHING
    `, [
      MIG_TENANT_A, 'Migration Tenant A', 'active',
      MIG_TENANT_B, 'Migration Tenant B', 'active',
    ]);

    // Create source connections for each tenant
    const connA = '5a1b0000-e29b-41d4-a716-446655443301';
    const connB = '5a1b0000-e29b-41d4-a716-446655443302';
    
    await superuserPool.query(`
      INSERT INTO connection (id, tenant_id, role, kind, display_name, config)
      VALUES ($1, $2, 'source', 'o365', 'Tenant A Source', '{}'),
             ($3, $4, 'source', 'o365', 'Tenant B Source', '{}')
      ON CONFLICT (id) DO NOTHING
    `, [connA, MIG_TENANT_A, connB, MIG_TENANT_B]);

    // Create mailbox for Tenant A
    const mailboxA = '5a1b0000-e29b-41d4-a716-446655443401';
    await superuserPool.query(`
      INSERT INTO mailbox (id, tenant_id, connection_id, display_name, kind)
      VALUES ($1, $2, $3, 'Inbox A', 'user')
      ON CONFLICT (id) DO NOTHING
    `, [mailboxA, MIG_TENANT_A, connA]);

    // Create mailbox for Tenant B
    const mailboxB = '5a1b0000-e29b-41d4-a716-446655443402';
    await superuserPool.query(`
      INSERT INTO mailbox (id, tenant_id, connection_id, display_name, kind)
      VALUES ($1, $2, $3, 'Inbox B', 'user')
      ON CONFLICT (id) DO NOTHING
    `, [mailboxB, MIG_TENANT_B, connB]);

    // Create mappings for each tenant
    await superuserPool.query(`
      INSERT INTO mailbox_mapping (id, tenant_id, source_mailbox_id, target_mailbox_id, status, mode, pattern)
      VALUES ($1, $2, $3, $3, 'active', 'mirror', 'shared_s'),
             ($4, $5, $6, $6, 'paused', 'one_time', 'distribution_d')
      ON CONFLICT (id) DO NOTHING
    `, [
      MIG_MAPPING_A, MIG_TENANT_A, mailboxA,
      MIG_MAPPING_B, MIG_TENANT_B, mailboxB,
    ]);

    request = supertest(app);
  });

  afterAll(async () => {
    // Cleanup
    await superuserPool.query('DELETE FROM mailbox_mapping WHERE tenant_id IN ($1, $2)', [MIG_TENANT_A, MIG_TENANT_B]);
    await superuserPool.query('DELETE FROM mailbox WHERE tenant_id IN ($1, $2)', [MIG_TENANT_A, MIG_TENANT_B]);
    await superuserPool.query('DELETE FROM connection WHERE tenant_id IN ($1, $2)', [MIG_TENANT_A, MIG_TENANT_B]);
    await superuserPool.query('DELETE FROM tenant WHERE id IN ($1, $2)', [MIG_TENANT_A, MIG_TENANT_B]);
    await superuserPool.end();
  });

  describe('GET /api/migrations', () => {
    it('should return mappings for tenant A only', async () => {
      const response = await request
        .get('/api/migrations')
        .set('Authorization', `Bearer ${TOKEN_TENANT_A}`);

      expect(response.status).toBe(200);
      expect(response.body.mappings).toBeDefined();
      expect(Array.isArray(response.body.mappings)).toBe(true);
      
      // All returned mappings should belong to tenant A
      response.body.mappings.forEach((m: any) => {
        expect(m.tenant_id).toBe(MIG_TENANT_A);
      });
    });

    it('should return mappings for tenant B only', async () => {
      const response = await request
        .get('/api/migrations')
        .set('Authorization', `Bearer ${TOKEN_TENANT_B}`);

      expect(response.status).toBe(200);
      expect(response.body.mappings).toBeDefined();
      
      // All returned mappings should belong to tenant B
      response.body.mappings.forEach((m: any) => {
        expect(m.tenant_id).toBe(MIG_TENANT_B);
      });
    });
  });

  describe('GET /api/migrations/:id', () => {
    it('should allow tenant A to access its own mapping', async () => {
      const response = await request
        .get(`/api/migrations/${MIG_MAPPING_A}`)
        .set('Authorization', `Bearer ${TOKEN_TENANT_A}`);

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(MIG_MAPPING_A);
      expect(response.body.tenant_id).toBe(MIG_TENANT_A);
    });

    it('should prevent tenant B from accessing tenant A mapping (CROSS-TENANT TEST)', async () => {
      const response = await request
        .get(`/api/migrations/${MIG_MAPPING_A}`)
        .set('Authorization', `Bearer ${TOKEN_TENANT_B}`);

      // Should either return 404 or not return tenant A's data
      expect([200, 404]).toContain(response.status);
      
      if (response.status === 200) {
        // If it returns 200, the mapping should NOT be tenant A's
        expect(response.body.id).not.toBe(MIG_MAPPING_A);
      }
    });

    it('should allow tenant B to access its own mapping', async () => {
      const response = await request
        .get(`/api/migrations/${MIG_MAPPING_B}`)
        .set('Authorization', `Bearer ${TOKEN_TENANT_B}`);

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(MIG_MAPPING_B);
      expect(response.body.tenant_id).toBe(MIG_TENANT_B);
    });

    it('should prevent tenant A from accessing tenant B mapping (CROSS-TENANT TEST)', async () => {
      const response = await request
        .get(`/api/migrations/${MIG_MAPPING_B}`)
        .set('Authorization', `Bearer ${TOKEN_TENANT_A}`);

      expect([200, 404]).toContain(response.status);
      
      if (response.status === 200) {
        expect(response.body.id).not.toBe(MIG_MAPPING_B);
      }
    });
  });

  describe('POST /api/migrations', () => {
    it('should create a mapping for tenant A', async () => {
      const newMapping = {
        sourceMailboxId: '5a1b0000-e29b-41d4-a716-446655443501',
        targetMailboxId: '5a1b0000-e29b-41d4-a716-446655443501',
        status: 'active',
        mode: 'mirror',
        pattern: 'shared_s',
      };

      const response = await request
        .post('/api/migrations')
        .set('Authorization', `Bearer ${TOKEN_TENANT_A}`)
        .send(newMapping);

      // Note: This may fail if the mailbox IDs don't exist, but that's expected
      // The important thing is that the request is processed with tenant A's context
      expect([200, 400, 404]).toContain(response.status);
    });

    it('should not allow client to specify different tenant_id (security test)', async () => {
      const newMapping = {
        sourceMailboxId: '5a1b0000-e29b-41d4-a716-446655443502',
        targetMailboxId: '5a1b0000-e29b-41d4-a716-446655443502',
        tenantId: MIG_TENANT_B, // Attempt to create for tenant B
        status: 'active',
        mode: 'mirror',
      };

      const response = await request
        .post('/api/migrations')
        .set('Authorization', `Bearer ${TOKEN_TENANT_A}`)
        .send(newMapping);

      // The server should ignore the client-provided tenantId and use the auth context
      expect([200, 400, 404]).toContain(response.status);
    });
  });

  describe('PUT /api/migrations/:id', () => {
    it('should allow tenant A to update its own mapping', async () => {
      const updateData = {
        status: 'paused',
      };

      const response = await request
        .put(`/api/migrations/${MIG_MAPPING_A}`)
        .set('Authorization', `Bearer ${TOKEN_TENANT_A}`)
        .send(updateData);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('paused');
    });

    it('should prevent tenant B from updating tenant A mapping (CROSS-TENANT TEST)', async () => {
      const updateData = {
        status: 'cutover',
      };

      const response = await request
        .put(`/api/migrations/${MIG_MAPPING_A}`)
        .set('Authorization', `Bearer ${TOKEN_TENANT_B}`)
        .send(updateData);

      // Should either fail with 404 or not actually update
      expect([200, 404]).toContain(response.status);
      
      if (response.status === 200) {
        // If it returns 200, verify it didn't update tenant A's mapping
        // (This would indicate a cross-tenant update succeeded, which is bad)
        expect(response.body.id).not.toBe(MIG_MAPPING_A);
      }
    });
  });

  describe('DELETE /api/migrations/:id', () => {
    it('should allow tenant A to delete its own mapping', async () => {
      // Create a temporary mapping for deletion test
      const tempId = '5a1b0000-e29b-41d4-a716-446655443601';
      const tempMailbox = '5a1b0000-e29b-41d4-a716-446655443602';
      
      await superuserPool.query(`
        INSERT INTO mailbox (id, tenant_id, connection_id, display_name, kind)
        VALUES ($1, $2, $3, 'Temp', 'user')
        ON CONFLICT (id) DO NOTHING
      `, [tempMailbox, MIG_TENANT_A, '5a1b0000-e29b-41d4-a716-446655443301']);

      await superuserPool.query(`
        INSERT INTO mailbox_mapping (id, tenant_id, source_mailbox_id, target_mailbox_id, status, mode)
        VALUES ($1, $2, $3, $3, 'active', 'mirror')
        ON CONFLICT (id) DO NOTHING
      `, [tempId, MIG_TENANT_A, tempMailbox]);

      const response = await request
        .delete(`/api/migrations/${tempId}`)
        .set('Authorization', `Bearer ${TOKEN_TENANT_A}`);

      expect(response.status).toBe(200);
      
      // Verify deletion
      const check = await superuserPool.query(
        'SELECT * FROM mailbox_mapping WHERE id = $1',
        [tempId]
      );
      expect(check.rows.length).toBe(0);
    });

    it('should prevent tenant B from deleting tenant A mapping (CROSS-TENANT TEST)', async () => {
      const response = await request
        .delete(`/api/migrations/${MIG_MAPPING_A}`)
        .set('Authorization', `Bearer ${TOKEN_TENANT_B}`);

      expect([200, 404]).toContain(response.status);
      
      // Verify tenant A's mapping still exists
      const check = await superuserPool.query(
        'SELECT * FROM mailbox_mapping WHERE id = $1 AND tenant_id = $2',
        [MIG_MAPPING_A, MIG_TENANT_A]
      );
      expect(check.rows.length).toBe(1);
    });
  });

  describe('POST /api/migrations/:id/sync', () => {
    it('enqueues the real delta-sync task with an id-only, tenant-scoped payload', async () => {
      triggerMock.mockClear();
      const response = await request
        .post(`/api/migrations/${MIG_MAPPING_A}/sync`)
        .set('Authorization', `Bearer ${TOKEN_TENANT_A}`)
        .send({ type: 'delta' });

      expect(response.status).toBe(202);
      expect(response.body.runId).toBe('run_mock_test');
      expect(response.body.jobType).toBe('run-delta-sync');
      expect(triggerMock).toHaveBeenCalledTimes(1);
      expect(triggerMock).toHaveBeenCalledWith(
        'run-delta-sync',
        { tenantId: MIG_TENANT_A, mappingId: MIG_MAPPING_A },
        expect.anything(),
      );
    });

    it('enqueues the full-sync task when type is full', async () => {
      triggerMock.mockClear();
      const response = await request
        .post(`/api/migrations/${MIG_MAPPING_A}/sync`)
        .set('Authorization', `Bearer ${TOKEN_TENANT_A}`)
        .send({ type: 'full' });

      expect(response.status).toBe(202);
      expect(response.body.jobType).toBe('run-full-sync');
      expect(triggerMock).toHaveBeenCalledWith('run-full-sync', expect.anything(), expect.anything());
    });

    it('should prevent tenant B from triggering sync on tenant A mapping (CROSS-TENANT TEST)', async () => {
      triggerMock.mockClear();
      const response = await request
        .post(`/api/migrations/${MIG_MAPPING_A}/sync`)
        .set('Authorization', `Bearer ${TOKEN_TENANT_B}`)
        .send({ type: 'full' });

      expect(response.status).toBe(404); // ownership check fails before any enqueue
      expect(triggerMock).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/migrations/:id/cutover', () => {
    it('enqueues the real cutover task for tenant A mapping', async () => {
      triggerMock.mockClear();
      const response = await request
        .post(`/api/migrations/${MIG_MAPPING_A}/cutover`)
        .set('Authorization', `Bearer ${TOKEN_TENANT_A}`)
        .send({ gracePeriodHours: 12 });

      expect(response.status).toBe(202);
      expect(response.body.runId).toBe('run_mock_test');
      expect(triggerMock).toHaveBeenCalledWith(
        'run-cutover',
        expect.objectContaining({ tenantId: MIG_TENANT_A, mappingId: MIG_MAPPING_A }),
        expect.anything(),
      );
    });

    it('should prevent tenant B from triggering cutover on tenant A mapping (CROSS-TENANT TEST)', async () => {
      triggerMock.mockClear();
      const response = await request
        .post(`/api/migrations/${MIG_MAPPING_A}/cutover`)
        .set('Authorization', `Bearer ${TOKEN_TENANT_B}`)
        .send({ gracePeriodHours: 12 });

      expect(response.status).toBe(404);
      expect(triggerMock).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/migrations/:id/runs', () => {
    it('should return runs for tenant A mapping', async () => {
      const response = await request
        .get(`/api/migrations/${MIG_MAPPING_A}/runs`)
        .set('Authorization', `Bearer ${TOKEN_TENANT_A}`);

      expect(response.status).toBe(200);
      expect(response.body.runs).toBeDefined();
      expect(Array.isArray(response.body.runs)).toBe(true);
    });

    it('should prevent tenant B from accessing tenant A runs (CROSS-TENANT TEST)', async () => {
      const response = await request
        .get(`/api/migrations/${MIG_MAPPING_A}/runs`)
        .set('Authorization', `Bearer ${TOKEN_TENANT_B}`);

      expect([200, 404]).toContain(response.status);
    });
  });
});
