/**
 * API Integration Tests for Members Routes
 *
 * Tests that prove tenant isolation for members endpoints using RLS.
 * These tests use supertest against a Testcontainers Postgres instance.
 * Tests connect as the non-owner app_user role to ensure RLS is enforced.
 *
 * UUID Family: 950e8400-e29b-41d4-a716-44665544xxxx
 */

// Set JWT_SECRET before importing app
process.env.JWT_SECRET = 'test-secret-for-integration-tests';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import supertest from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';

const PG_CONNECTION_STRING = process.env.TEST_DATABASE_URL;
if (!PG_CONNECTION_STRING) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Integration tests require Testcontainers to be running. ' +
    'Run: pnpm test:integration'
  );
}

// Set APP_DATABASE_URL with app_user role to ensure RLS is enforced
const getAppUserConnectionString = (originalUrl: string): string => {
  const url = new URL(originalUrl);
  url.username = 'app_user';
  url.password = 'app_password';
  return url.toString();
};
process.env.APP_DATABASE_URL = getAppUserConnectionString(PG_CONNECTION_STRING);

import app from '../../index.js';

// UUIDs for API isolation tests (950e8400-e29b-41d4-a716-44665544xxxx)
const API_TENANT_A = '5d2b0000-e29b-41d4-a716-446655444101';
const API_TENANT_B = '5d2b0000-e29b-41d4-a716-446655444102';

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
const TOKEN_OWNER_A = createTestToken(API_TENANT_A, 'owner');

describe('Members Route Isolation', () => {
  let superuserPool: Pool;
  let request: ReturnType<typeof supertest>;
  let memberAId: string;
  let ownerAId: string;

  beforeAll(async () => {
    superuserPool = new Pool({
      connectionString: PG_CONNECTION_STRING,
    });

    // Create test tenants
    await superuserPool.query(`
      INSERT INTO tenant (id, name, status, settings)
      VALUES ($1, $2, $3, '{}'), ($4, $5, $6, '{}')
      ON CONFLICT (id) DO NOTHING
    `, [
      API_TENANT_A, 'Members Tenant A', 'active',
      API_TENANT_B, 'Members Tenant B', 'active',
    ]);

    // Create members for tenant A
    const memberId = randomUUID();
    const result = await superuserPool.query(`
      INSERT INTO tenant_member (id, tenant_id, user_id, email, role, status)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `, [
      memberId,
      API_TENANT_A,
      'user-member-001',
      'member@example.com',
      'member',
      'active',
    ]);
    memberAId = result.rows[0].id;

    // Create an owner for tenant A (needed for "prevent removing last owner" test)
    const ownerId = randomUUID();
    await superuserPool.query(`
      INSERT INTO tenant_member (id, tenant_id, user_id, email, role, status)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      ownerId,
      API_TENANT_A,
      'user-owner-001',
      'owner@example.com',
      'owner',
      'active',
    ]);
    ownerAId = ownerId;

    request = supertest(app);
  });

  afterAll(async () => {
    // Cleanup test data
    await superuserPool.query(`DELETE FROM tenant_member WHERE tenant_id IN ($1, $2)`, [
      API_TENANT_A,
      API_TENANT_B,
    ]);
    await superuserPool.query(`DELETE FROM tenant WHERE id IN ($1, $2)`, [
      API_TENANT_A,
      API_TENANT_B,
    ]);
    await superuserPool.end();
  });

  describe('GET /api/tenants/:tenantId/members', () => {
    it('should list members for authenticated tenant', async () => {
      const response = await request
        .get(`/api/tenants/${API_TENANT_A}/members`)
        .set('Authorization', `Bearer ${TOKEN_TENANT_A}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.members)).toBe(true);
      expect(response.body.members.length).toBeGreaterThan(0);
    });

    it('should prevent tenant B from accessing tenant A members', async () => {
      const response = await request
        .get(`/api/tenants/${API_TENANT_A}/members`)
        .set('Authorization', `Bearer ${TOKEN_TENANT_B}`);

      expect(response.status).toBe(200);
      // RLS should filter out tenant A's members
      expect(response.body.members).toEqual([]);
    });

    it('should return 401 without token', async () => {
      const response = await request.get(`/api/tenants/${API_TENANT_A}/members`);
      expect(response.status).toBe(401);
    });
  });

  describe('POST /api/tenants/:tenantId/members', () => {
    it('should invite member as admin', async () => {
      const response = await request
        .post(`/api/tenants/${API_TENANT_A}/members`)
        .set('Authorization', `Bearer ${TOKEN_ADMIN_A}`)
        .send({
          email: 'newmember@example.com',
          role: 'member',
        });

      expect(response.status).toBe(201);
      expect(response.body.email).toBe('newmember@example.com');
      expect(response.body.role).toBe('member');
      expect(response.body.status).toBe('invited');
    });

    it('should prevent member role from inviting members', async () => {
      const response = await request
        .post(`/api/tenants/${API_TENANT_A}/members`)
        .set('Authorization', `Bearer ${TOKEN_TENANT_A}`)
        .send({
          email: 'hacker@example.com',
          role: 'admin',
        });

      expect(response.status).toBe(403);
    });

    it('should prevent tenant B from adding members to tenant A', async () => {
      const response = await request
        .post(`/api/tenants/${API_TENANT_A}/members`)
        .set('Authorization', `Bearer ${TOKEN_TENANT_B}`)
        .send({
          email: 'hacker@example.com',
          role: 'member',
        });

      // Should fail because tenant B is not a member of tenant A
      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/tenants/:tenantId/members/:memberId', () => {
    it('should get member details for authenticated tenant', async () => {
      const response = await request
        .get(`/api/tenants/${API_TENANT_A}/members/${memberAId}`)
        .set('Authorization', `Bearer ${TOKEN_TENANT_A}`);

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(memberAId);
      expect(response.body.email).toBe('member@example.com');
    });

    it('should return 404 for tenant B accessing tenant A member', async () => {
      const response = await request
        .get(`/api/tenants/${API_TENANT_A}/members/${memberAId}`)
        .set('Authorization', `Bearer ${TOKEN_TENANT_B}`);

      // RLS should filter out tenant A's member
      expect(response.status).toBe(404);
    });
  });

  describe('PATCH /api/tenants/:tenantId/members/:memberId', () => {
    it('should update member role as admin', async () => {
      const response = await request
        .patch(`/api/tenants/${API_TENANT_A}/members/${memberAId}`)
        .set('Authorization', `Bearer ${TOKEN_ADMIN_A}`)
        .send({
          role: 'admin',
        });

      expect(response.status).toBe(200);
      expect(response.body.role).toBe('admin');
    });

    it('should prevent member from updating roles', async () => {
      // Reset member role first
      await superuserPool.query(`
        UPDATE tenant_member SET role = 'member' WHERE id = $1
      `, [memberAId]);

      const response = await request
        .patch(`/api/tenants/${API_TENANT_A}/members/${memberAId}`)
        .set('Authorization', `Bearer ${TOKEN_TENANT_A}`)
        .send({
          role: 'admin',
        });

      expect(response.status).toBe(403);
    });

    it('should prevent tenant B from updating tenant A members', async () => {
      const response = await request
        .patch(`/api/tenants/${API_TENANT_A}/members/${memberAId}`)
        .set('Authorization', `Bearer ${TOKEN_TENANT_B}`)
        .send({
          role: 'owner',
        });

      expect(response.status).toBe(403);
    });
  });

  describe('DELETE /api/tenants/:tenantId/members/:memberId', () => {
    it('should remove member as admin', async () => {
      // Create a new member to delete
      const newMember = await superuserPool.query(`
        INSERT INTO tenant_member (id, tenant_id, user_id, email, role, status)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
      `, [
        randomUUID(),
        API_TENANT_A,
        'user-to-delete',
        'todelete@example.com',
        'member',
        'active',
      ]);

      const memberId = newMember.rows[0].id;

      const response = await request
        .delete(`/api/tenants/${API_TENANT_A}/members/${memberId}`)
        .set('Authorization', `Bearer ${TOKEN_OWNER_A}`);

      expect(response.status).toBe(204);

      // Verify member is deleted
      const verifyResponse = await request
        .get(`/api/tenants/${API_TENANT_A}/members/${memberId}`)
        .set('Authorization', `Bearer ${TOKEN_TENANT_A}`);
      
      expect(verifyResponse.status).toBe(404);
    });

    it('should prevent removing the last owner', async () => {
      // Try to delete the only owner (ownerAId is the sole owner)
      const response = await request
        .delete(`/api/tenants/${API_TENANT_A}/members/${ownerAId}`)
        .set('Authorization', `Bearer ${TOKEN_OWNER_A}`);

      // Should fail because it's the last owner
      expect(response.status).toBe(400);
    });

    it('should prevent tenant B from deleting tenant A members', async () => {
      const response = await request
        .delete(`/api/tenants/${API_TENANT_A}/members/${memberAId}`)
        .set('Authorization', `Bearer ${TOKEN_TENANT_B}`);

      expect(response.status).toBe(403);
    });
  });
});
