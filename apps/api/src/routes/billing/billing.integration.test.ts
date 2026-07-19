/**
 * API Integration Tests for Billing Routes
 *
 * Tests that prove tenant isolation for billing endpoints using RLS.
 * These tests use supertest against a Testcontainers Postgres instance.
 * Tests connect as the non-owner app_user role to ensure RLS is enforced.
 *
 * UUID Family: 950e8400-e29b-41d4-a716-44665544xxxx
 *
 * NOTE: POST /api/billing/usage has been removed. Usage is now recorded
 * by T4 metering functions (recordComputeForRun, recordApiCallForRun, etc.)
 * during migration job execution. Billing GET /usage reads from the real
 * source of truth (migration_status + item ledger).
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
const API_TENANT_A = '5f0b0000-e29b-41d4-a716-446655443101';
const API_TENANT_B = '5f0b0000-e29b-41d4-a716-446655443102';

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

describe('Billing Route Isolation', () => {
  let superuserPool: Pool;
  let request: ReturnType<typeof supertest>;

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
      API_TENANT_A, 'Billing Tenant A', 'active',
      API_TENANT_B, 'Billing Tenant B', 'active',
    ]);

    request = supertest(app);
  });

  afterAll(async () => {
    // Cleanup test data
    await superuserPool.query(`DELETE FROM usage_metric WHERE tenant_id IN ($1, $2)`, [
      API_TENANT_A,
      API_TENANT_B,
    ]);
    await superuserPool.query(`DELETE FROM invoice WHERE tenant_id IN ($1, $2)`, [
      API_TENANT_A,
      API_TENANT_B,
    ]);
    await superuserPool.query(`DELETE FROM payment_method WHERE tenant_id IN ($1, $2)`, [
      API_TENANT_A,
      API_TENANT_B,
    ]);
    await superuserPool.query(`DELETE FROM tenant WHERE id IN ($1, $2)`, [
      API_TENANT_A,
      API_TENANT_B,
    ]);
    await superuserPool.end();
  });

  describe('GET /api/billing/usage', () => {
    it('should return usage for authenticated tenant', async () => {
      // Get current period
      const now = new Date();
      const periodStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);

      // Record usage using T4 metering schema (usageMetric table)
      const runId = randomUUID();
      
      // Record compute usage (10 hours)
      await superuserPool.query(`
        INSERT INTO usage_metric (id, tenant_id, period_start, period_end, metric_type, resource, quantity, unit, unit_price, total_cost, metadata, created_at)
        VALUES ($1, $2, $3, $4, 'compute', 'domain-test', $5, 'hours', $6, $7, '{"mappingId":"m1","domain":"test"}', NOW())
      `, [runId, API_TENANT_A, periodStart, periodEnd, 10, 5, 50]);

      // Record API call usage (1 sync)
      const runId2 = randomUUID();
      await superuserPool.query(`
        INSERT INTO usage_metric (id, tenant_id, period_start, period_end, metric_type, resource, quantity, unit, unit_price, total_cost, metadata, created_at)
        VALUES ($1, $2, $3, $4, 'api_calls', 'sync-test', $5, 'request', $6, $7, '{}', NOW())
      `, [runId2, API_TENANT_A, periodStart, periodEnd, 1, 0, 0]);

      const response = await request
        .get('/api/billing/usage')
        .set('Authorization', `Bearer ${TOKEN_TENANT_A}`);

      expect(response.status).toBe(200);
      expect(response.body.usage.tenantId).toBe(API_TENANT_A);
      expect(response.body.usage.computeHours).toBe(10);
      expect(response.body.usage.syncCount).toBe(1);
    });

    it('should prevent tenant B from accessing tenant A usage', async () => {
      const response = await request
        .get('/api/billing/usage')
        .set('Authorization', `Bearer ${TOKEN_TENANT_B}`);

      expect(response.status).toBe(200);
      // RLS should filter out tenant A's data
      expect(response.body.usage.computeHours).toBe(0);
      expect(response.body.usage.syncCount).toBe(0);
    });

    it('should return 401 without token', async () => {
      const response = await request.get('/api/billing/usage');
      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/billing/usage/history', () => {
    it('should return usage history for authenticated tenant', async () => {
      const response = await request
        .get('/api/billing/usage/history')
        .set('Authorization', `Bearer ${TOKEN_TENANT_A}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.usage)).toBe(true);
    });

    it('should prevent tenant B from accessing tenant A history', async () => {
      const responseA = await request
        .get('/api/billing/usage/history')
        .set('Authorization', `Bearer ${TOKEN_TENANT_A}`);

      const responseB = await request
        .get('/api/billing/usage/history')
        .set('Authorization', `Bearer ${TOKEN_TENANT_B}`);

      // Both should succeed but return different data
      expect(responseA.status).toBe(200);
      expect(responseB.status).toBe(200);
      // Tenant B should not see tenant A's data
      expect(responseB.body.usage).not.toEqual(responseA.body.usage);
    });
  });

  describe('POST /api/billing/estimate', () => {
    it('should calculate cost estimate without DB access', async () => {
      const response = await request
        .post('/api/billing/estimate')
        .set('Authorization', `Bearer ${TOKEN_TENANT_A}`)
        .send({
          storageUsedGB: 100,
          egressGB: 50,
          computeHours: 20,
        });

      expect(response.status).toBe(200);
      expect(response.body.estimate).toBeGreaterThan(0);
      expect(response.body.breakdown).toBeDefined();
    });

    it('should require authentication', async () => {
      const response = await request
        .post('/api/billing/estimate')
        .send({ storageUsedGB: 10 });

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/billing/invoices', () => {
    it('should return empty invoices for tenant with no invoices', async () => {
      const response = await request
        .get('/api/billing/invoices')
        .set('Authorization', `Bearer ${TOKEN_TENANT_A}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.invoices)).toBe(true);
    });

    it('should prevent tenant B from accessing tenant A invoices', async () => {
      // Create an invoice for tenant A
      const invoiceId = randomUUID();
      await superuserPool.query(`
        INSERT INTO invoice (id, tenant_id, period_start, period_end, status, subtotal, tax_rate, tax_amount, total, currency)
        VALUES ($1, $2, '2024-06-01', '2024-06-30', 'draft', '1000', '210', '210', '1210', 'EUR')
      `, [
        invoiceId,
        API_TENANT_A,
      ]);

      const response = await request
        .get('/api/billing/invoices')
        .set('Authorization', `Bearer ${TOKEN_TENANT_B}`);

      expect(response.status).toBe(200);
      expect(response.body.invoices).toEqual([]);
    });
  });

  describe('GET /api/billing/invoices/:invoiceId', () => {
    it('should return invoice for authenticated tenant', async () => {
      const invoiceId = randomUUID();
      const result = await superuserPool.query(`
        INSERT INTO invoice (id, tenant_id, period_start, period_end, status, subtotal, tax_rate, tax_amount, total, currency)
        VALUES ($1, $2, '2024-07-01', '2024-07-31', 'draft', '1000', '210', '210', '1210', 'EUR')
        RETURNING id
      `, [
        invoiceId,
        API_TENANT_A,
      ]);

      const invoiceIdFromDb = result.rows[0].id;

      const response = await request
        .get(`/api/billing/invoices/${invoiceIdFromDb}`)
        .set('Authorization', `Bearer ${TOKEN_TENANT_A}`);

      expect(response.status).toBe(200);
      expect(response.body.invoice.id).toBe(invoiceIdFromDb);
    });

    it('should return 404 for tenant B trying to access tenant A invoice', async () => {
      // Create an invoice for tenant A with a different period
      const invoiceId = randomUUID();
      await superuserPool.query(`
        INSERT INTO invoice (id, tenant_id, period_start, period_end, status, subtotal, tax_rate, tax_amount, total, currency)
        VALUES ($1, $2, '2024-08-01', '2024-08-31', 'draft', '1000', '210', '210', '1210', 'EUR')
      `, [
        invoiceId,
        API_TENANT_A,
      ]);

      const response = await request
        .get(`/api/billing/invoices/${invoiceId}`)
        .set('Authorization', `Bearer ${TOKEN_TENANT_B}`);

      // Should return 404 because RLS filters out tenant A's invoice
      expect(response.status).toBe(404);
    });
  });

  describe('Payment Methods', () => {
    it('should list payment methods for authenticated tenant', async () => {
      const response = await request
        .get('/api/billing/payment-methods')
        .set('Authorization', `Bearer ${TOKEN_TENANT_A}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.paymentMethods)).toBe(true);
    });

    it('should create payment method for authenticated tenant', async () => {
      const response = await request
        .post('/api/billing/payment-methods')
        .set('Authorization', `Bearer ${TOKEN_TENANT_A}`)
        .send({
          type: 'card',
          brand: 'visa',
          last4: '4242',
        });

      expect(response.status).toBe(201);
      expect(response.body.paymentMethod.tenantId).toBe(API_TENANT_A);
    });

    it('should prevent tenant B from accessing tenant A payment methods', async () => {
      const response = await request
        .get('/api/billing/payment-methods')
        .set('Authorization', `Bearer ${TOKEN_TENANT_B}`);

      expect(response.status).toBe(200);
      // Should not see tenant A's payment methods
      expect(response.body.paymentMethods).toEqual([]);
    });
  });
});
