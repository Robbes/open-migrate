/**
 * API Integration Tests for Tenant Isolation
 * 
 * Tests that prove tenant B's token cannot read tenant A's data over HTTP.
 * These tests use supertest against a Testcontainers Postgres instance.
 * 
 * UUID Family: 950e8400-e29b-41d4-a716-44665544xxxx (same as RLS tests)
 */


// Set JWT_SECRET before importing app so auth middleware uses it
process.env.JWT_SECRET = 'test-secret-for-integration-tests';

// Set APP_DATABASE_URL so the API routes can connect to the test database
// This must be set before the app is imported
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import supertest from 'supertest';
import jwt from 'jsonwebtoken';

// Connection string from Testcontainers - set BEFORE importing app
const PG_CONNECTION_STRING = process.env.TEST_DATABASE_URL;
if (!PG_CONNECTION_STRING) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Integration tests require Testcontainers to be running. ' +
    'Run: pnpm test:integration'
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

// UUIDs for API isolation tests (950e8400-e29b-41d4-a716-44665544xxxx)
const API_TENANT_A = '5e2b0000-e29b-41d4-a716-446655442101';
const API_TENANT_B = '5e2b0000-e29b-41d4-a716-446655442102';

// Generate valid JWT tokens for each tenant
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

const TOKEN_TENANT_A = createTestToken(API_TENANT_A);
const TOKEN_TENANT_B = createTestToken(API_TENANT_B);
const TOKEN_ADMIN_A = createTestToken(API_TENANT_A, 'admin');

describe('API Tenant Isolation', () => {
  let superuserPool: Pool;
  let request: ReturnType<typeof supertest>;

  beforeAll(async () => {
    // Setup superuser pool for test data
    superuserPool = new Pool({
      connectionString: PG_CONNECTION_STRING,
    });

    // Create test tenants
    await superuserPool.query(`
      INSERT INTO tenant (id, name, status, settings)
      VALUES ($1, $2, $3, '{}'), ($4, $5, $6, '{}')
      ON CONFLICT (id) DO NOTHING
    `, [
      API_TENANT_A, 'API Tenant A', 'active',
      API_TENANT_B, 'API Tenant B', 'active',
    ]);

    // Create connections for each tenant
    await superuserPool.query(`
      INSERT INTO connection (id, tenant_id, role, kind, display_name, config)
      VALUES 
        ($1, $2, 'source', 'o365', 'Tenant A Source', '{}'),
        ($3, $4, 'source', 'o365', 'Tenant B Source', '{}')
      ON CONFLICT (id) DO NOTHING
    `, [
      '5e2b0000-e29b-41d4-a716-446655442201', API_TENANT_A,
      '5e2b0000-e29b-41d4-a716-446655442202', API_TENANT_B,
    ]);

    // Build the Express app
    request = supertest(app);
  });

  afterAll(async () => {
    // Cleanup test data
    await superuserPool.query('DELETE FROM connection WHERE tenant_id IN ($1, $2)', [API_TENANT_A, API_TENANT_B]);
    await superuserPool.query('DELETE FROM tenant WHERE id IN ($1, $2)', [API_TENANT_A, API_TENANT_B]);
    await superuserPool.end();
  });

  describe('GET /api/tenants', () => {
    it('should return tenant list for authenticated user', async () => {
      const response = await request
        .get('/api/tenants')
        .set('Authorization', `Bearer ${TOKEN_TENANT_A}`);

      expect(response.status).toBe(200);
      expect(response.body.tenants).toBeDefined();
      expect(Array.isArray(response.body.tenants)).toBe(true);
    });
  });

  describe('GET /api/tenants/:id', () => {
    it('should allow tenant A to access its own data', async () => {
      const response = await request
        .get(`/api/tenants/${API_TENANT_A}`)
        .set('Authorization', `Bearer ${TOKEN_TENANT_A}`);

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(API_TENANT_A);
    });

    it('should prevent tenant B from accessing tenant A data (CROSS-TENANT TEST)', async () => {
      const response = await request
        .get(`/api/tenants/${API_TENANT_A}`)
        .set('Authorization', `Bearer ${TOKEN_TENANT_B}`);

      // Note: In dev mode, the mock JWT accepts any token, so tenant context is set from the token.
      // The actual RLS-based isolation happens at the database level in managed deployments.
      // In this test, tenant B's token sets context to tenant B, so the query for tenant A
      // should return nothing (RLS filters out tenant A's rows when context is tenant B).
      // The test passes if we don't get tenant A's actual data back.
      expect([200, 404]).toContain(response.status);
      
      if (response.status === 200 && response.body.id) {
        // If it returns 200 with a body, it should NOT be tenant A's data
        expect(response.body.id).not.toBe(API_TENANT_A);
      }
    });
  });

  describe('PUT /api/tenants/:id', () => {
    it('should allow admin to update tenant A', async () => {
      const updateData = {
        name: 'API Tenant A Updated',
        settings: { theme: 'dark' },
      };

      const response = await request
        .put(`/api/tenants/${API_TENANT_A}`)
        .set('Authorization', `Bearer ${TOKEN_ADMIN_A}`)
        .send(updateData);

      expect(response.status).toBe(200);
      expect(response.body.name).toBe('API Tenant A Updated');
    });

    it('should prevent tenant B from updating tenant A (CROSS-TENANT TEST)', async () => {
      const updateData = {
        name: 'Hacked Tenant A',
      };

      const response = await request
        .put(`/api/tenants/${API_TENANT_A}`)
        .set('Authorization', `Bearer ${TOKEN_TENANT_B}`)
        .send(updateData);

      // Should fail - tenant B doesn't have permission or can't access
      expect([200, 403, 404]).toContain(response.status);
      
      // Verify tenant A wasn't actually modified
      const check = await superuserPool.query(
        'SELECT name FROM tenant WHERE id = $1',
        [API_TENANT_A]
      );
      expect(check.rows[0].name).not.toBe('Hacked Tenant A');
    });

    it('should prevent client from writing rows with different tenant_id (security test)', async () => {
      const updateData = {
        name: 'Updated Tenant',
        tenantId: API_TENANT_B, // Attempt to change tenant
      };

      const response = await request
        .put(`/api/tenants/${API_TENANT_A}`)
        .set('Authorization', `Bearer ${TOKEN_TENANT_A}`)
        .send(updateData);

      // Server should ignore client-provided tenantId and use auth context
      // The route should either accept it (ignoring tenantId) or reject it
      // Either way, the tenant should remain API_TENANT_A
      expect([200, 400]).toContain(response.status);
      
      // Verify the tenant wasn't changed to tenant B
      const check = await superuserPool.query(
        'SELECT id FROM tenant WHERE id = $1',
        [API_TENANT_A]
      );
      expect(check.rows.length).toBe(1); // Tenant A still exists
    });
  });

  describe('DELETE /api/tenants/:id', () => {
    it('should allow owner to delete their own tenant', async () => {
      // Create a temporary tenant for deletion test with owner role token
      const tempId = '5e2b0000-e29b-41d4-a716-446655442301';
      await superuserPool.query(`
        INSERT INTO tenant (id, name, status)
        VALUES ($1, $2, $3)
        ON CONFLICT (id) DO NOTHING
      `, [tempId, 'Temp Tenant', 'active']);

      // Create owner token for temp tenant
      const tokenOwnerTemp = createTestToken(tempId, 'owner');

      const response = await request
        .delete(`/api/tenants/${tempId}`)
        .set('Authorization', `Bearer ${tokenOwnerTemp}`);

      expect(response.status).toBe(200);
      
      // Verify deletion
      const check = await superuserPool.query(
        'SELECT * FROM tenant WHERE id = $1',
        [tempId]
      );
      expect(check.rows.length).toBe(0);
    });

    it('should prevent tenant B from deleting tenant A (CROSS-TENANT TEST)', async () => {
      const response = await request
        .delete(`/api/tenants/${API_TENANT_A}`)
        .set('Authorization', `Bearer ${TOKEN_TENANT_B}`);

      expect([200, 403, 404]).toContain(response.status);
      
      // Verify tenant A still exists
      const check = await superuserPool.query(
        'SELECT * FROM tenant WHERE id = $1',
        [API_TENANT_A]
      );
      expect(check.rows.length).toBe(1);
    });
  });
});

