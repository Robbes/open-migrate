// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

/**
 * Integration tests for workplan 0011 T5 — invoice generation + Mollie webhook.
 *
 * Proves: usage -> invoice reconciles to the cent; regeneration is idempotent;
 * the Mollie webhook drives the invoice to `paid` and double delivery is a no-op;
 * everything is RLS-scoped (tenant B cannot touch tenant A's invoice).
 *
 * UUID Family: 5f2b0000-e29b-41d4-a716-44665544xxxx
 *
 * Runs against a Testcontainers Postgres (pnpm test:integration). The Mollie
 * client is mocked so no network / real API key is needed.
 */

process.env.JWT_SECRET = 'test-secret-for-integration-tests';

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import supertest from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';

const PG_CONNECTION_STRING = process.env.TEST_DATABASE_URL;
if (!PG_CONNECTION_STRING) {
  throw new Error('TEST_DATABASE_URL is not set. Run: pnpm test:integration');
}

const getAppUserConnectionString = (originalUrl: string): string => {
  const url = new URL(originalUrl);
  url.username = 'app_user';
  url.password = 'app_password';
  return url.toString();
};
process.env.APP_DATABASE_URL = getAppUserConnectionString(PG_CONNECTION_STRING);

// Mock the Mollie client so the webhook can be exercised without the network.
// The mock is programmable per-test via `mollieWebhookResult`.
let mollieWebhookResult: {
  id: string;
  status: string;
  paidAt?: string;
  metadata: Record<string, unknown> | null;
};
vi.mock('../../services/mollie/index', () => ({
  getMollieService: () => ({
    processWebhook: async () => mollieWebhookResult,
  }),
}));

import app from '../../index.js';

const TENANT_A = '5f2b0000-e29b-41d4-a716-446655443101';
const TENANT_B = '5f2b0000-e29b-41d4-a716-446655443102';

function token(tenantId: string, role = 'owner'): string {
  return jwt.sign(
    { sub: `user-${tenantId}`, tenantId, role, email: `user@${tenantId}.test` },
    process.env.JWT_SECRET!,
  );
}

const PERIOD = '2026-05';
const PERIOD_START = '2026-05-01';
const PERIOD_END = '2026-05-31';

describe('T5 — invoice generation + Mollie webhook', () => {
  let superuserPool: Pool;
  let request: ReturnType<typeof supertest>;

  // Seed a metered usage row. `quantity` is what the T4 read model prices:
  // compute is priced at computePricePerHour (5 cents/hour by default).
  const seedUsage = async (tenantId: string, metricType: string, resource: string, quantity: number) => {
    await superuserPool.query(
      `INSERT INTO usage_metric (id, tenant_id, period_start, period_end, metric_type, resource, quantity, unit, unit_price, total_cost, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'hours', '5', '0', '{}', NOW())`,
      [randomUUID(), tenantId, PERIOD_START, PERIOD_END, metricType, resource, String(quantity)],
    );
  };

  beforeAll(async () => {
    superuserPool = new Pool({ connectionString: PG_CONNECTION_STRING });
    await superuserPool.query(
      `INSERT INTO tenant (id, name, status, settings) VALUES ($1,$2,'active','{}'),($3,$4,'active','{}')
       ON CONFLICT (id) DO NOTHING`,
      [TENANT_A, 'T5 Tenant A', TENANT_B, 'T5 Tenant B'],
    );
    request = supertest(app);
  });

  afterAll(async () => {
    for (const t of ['usage_metric', 'invoice']) {
      await superuserPool.query(`DELETE FROM ${t} WHERE tenant_id IN ($1,$2)`, [TENANT_A, TENANT_B]);
    }
    await superuserPool.query(`DELETE FROM tenant WHERE id IN ($1,$2)`, [TENANT_A, TENANT_B]);
    await superuserPool.end();
  });

  beforeEach(async () => {
    await superuserPool.query(`DELETE FROM invoice WHERE tenant_id IN ($1,$2)`, [TENANT_A, TENANT_B]);
    await superuserPool.query(`DELETE FROM usage_metric WHERE tenant_id IN ($1,$2)`, [TENANT_A, TENANT_B]);
  });

  describe('POST /api/billing/invoices/generate', () => {
    it('reconciles to the cent: baseFee + metered usage + 21% VAT', async () => {
      // 2 compute hours * 5 cents = 10 cents usage. baseFee = 999 → subtotal 1009.
      // (No item-ledger rows, so derived storage/egress are 0.)
      await seedUsage(TENANT_A, 'compute', 'sync', 2);

      const res = await request
        .post('/api/billing/invoices/generate')
        .set('Authorization', `Bearer ${token(TENANT_A)}`)
        .send({ period: PERIOD });

      expect(res.status).toBe(201);
      const inv = res.body.invoice;
      expect(inv.subtotal).toBe(1009); // 999 base + 10 compute
      expect(inv.taxAmount).toBe(Math.round(1009 * 0.21)); // 212
      expect(inv.total).toBe(1009 + Math.round(1009 * 0.21)); // 1221
      expect(inv.status).toBe('draft');
      expect(inv.costByDriver).toEqual({ base: 999, storage: 0, egress: 0, compute: 10 });
    });

    it('is idempotent: regenerating does not create a duplicate invoice', async () => {
      await seedUsage(TENANT_A, 'compute', 'sync', 1);

      await request.post('/api/billing/invoices/generate').set('Authorization', `Bearer ${token(TENANT_A)}`).send({ period: PERIOD });
      await request.post('/api/billing/invoices/generate').set('Authorization', `Bearer ${token(TENANT_A)}`).send({ period: PERIOD });

      const { rows } = await superuserPool.query(
        `SELECT COUNT(*)::int AS n FROM invoice WHERE tenant_id = $1 AND period_start = $2`,
        [TENANT_A, PERIOD_START],
      );
      expect(rows[0].n).toBe(1);
    });

    it('does not let tenant B generate against tenant A data', async () => {
      await seedUsage(TENANT_A, 'compute', 'sync', 500);

      // Tenant B generates for the same period: sees none of A's usage.
      const resB = await request
        .post('/api/billing/invoices/generate')
        .set('Authorization', `Bearer ${token(TENANT_B)}`)
        .send({ period: PERIOD });

      expect(resB.status).toBe(201);
      expect(resB.body.invoice.subtotal).toBe(999); // baseFee only — no A usage leaked
    });

    it('never overwrites a paid invoice on regenerate (finding #1)', async () => {
      // Generate a draft, then mark it paid with sentinel amounts (as the webhook
      // would), then seed more usage and regenerate. The paid invoice's stored
      // amounts + status must be untouched (the setWhere guard), and the call
      // reports it locked.
      await seedUsage(TENANT_A, 'compute', 'sync', 1);
      await request.post('/api/billing/invoices/generate').set('Authorization', `Bearer ${token(TENANT_A)}`).send({ period: PERIOD });

      await superuserPool.query(
        `UPDATE invoice SET status = 'paid', subtotal = '9999', tax_amount = '2100', total = '12099'
         WHERE tenant_id = $1 AND period_start = $2`,
        [TENANT_A, PERIOD_START],
      );

      // Usage that WOULD change the computed amounts if the invoice were rewritten.
      await seedUsage(TENANT_A, 'compute', 'sync', 250);

      const res = await request
        .post('/api/billing/invoices/generate')
        .set('Authorization', `Bearer ${token(TENANT_A)}`)
        .send({ period: PERIOD });

      expect(res.status).toBe(201);
      expect(res.body.invoice.status).toBe('paid');
      expect(res.body.invoice.locked).toBe(true);

      // The stored (paid) row is byte-for-byte unchanged.
      const { rows } = await superuserPool.query(
        `SELECT status, subtotal, tax_amount, total FROM invoice WHERE tenant_id = $1 AND period_start = $2`,
        [TENANT_A, PERIOD_START],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'paid', subtotal: '9999', tax_amount: '2100', total: '12099' });
    });
  });

  describe('POST /api/billing/webhooks/mollie', () => {
    // Seed an invoice already sent for payment with a known Mollie payment id.
    const seedSentInvoice = async (tenantId: string, paymentId: string): Promise<string> => {
      const invoiceId = randomUUID();
      await superuserPool.query(
        `INSERT INTO invoice (id, tenant_id, period_start, period_end, status, subtotal, tax_rate, tax_amount, total, currency, payment_id, metadata)
         VALUES ($1,$2,$3,$4,'sent','1000','0.21','210','1210','EUR',$5,'{}')`,
        [invoiceId, tenantId, PERIOD_START, PERIOD_END, paymentId],
      );
      return invoiceId;
    };

    const statusOf = async (invoiceId: string): Promise<string> => {
      const { rows } = await superuserPool.query(`SELECT status FROM invoice WHERE id = $1`, [invoiceId]);
      return rows[0]?.status;
    };

    it('drives the invoice to paid, and double delivery is a no-op', async () => {
      const paymentId = 'tr_paidtest';
      const invoiceId = await seedSentInvoice(TENANT_A, paymentId);
      mollieWebhookResult = {
        id: paymentId,
        status: 'paid',
        paidAt: '2026-05-15T10:00:00Z',
        metadata: { tenantId: TENANT_A, invoiceId },
      };

      const first = await request.post('/api/billing/webhooks/mollie').send({ id: paymentId });
      expect(first.status).toBe(200);
      expect(await statusOf(invoiceId)).toBe('paid');

      // Re-deliver the same event — must remain paid, still 200.
      const second = await request.post('/api/billing/webhooks/mollie').send({ id: paymentId });
      expect(second.status).toBe(200);
      expect(await statusOf(invoiceId)).toBe('paid');
    });

    it('voids the invoice on a failed payment', async () => {
      const paymentId = 'tr_failtest';
      const invoiceId = await seedSentInvoice(TENANT_A, paymentId);
      mollieWebhookResult = {
        id: paymentId,
        status: 'failed',
        metadata: { tenantId: TENANT_A, invoiceId },
      };

      const res = await request.post('/api/billing/webhooks/mollie').send({ id: paymentId });
      expect(res.status).toBe(200);
      expect(await statusOf(invoiceId)).toBe('void');
    });

    it('acknowledges but does nothing when correlation metadata is missing', async () => {
      mollieWebhookResult = { id: 'tr_nometa', status: 'paid', metadata: null };
      const res = await request.post('/api/billing/webhooks/mollie').send({ id: 'tr_nometa' });
      expect(res.status).toBe(200);
    });

    it('returns 400 when no payment id is supplied', async () => {
      const res = await request.post('/api/billing/webhooks/mollie').send({});
      expect(res.status).toBe(400);
    });
  });
});
