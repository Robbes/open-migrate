// Copyright 2026 The Ownpace authors (Apache-2.0)
//
// `GET /ready` against a real database (workplan 0094 T1). Runs against
// Testcontainers Postgres (pnpm test:integration).
//
// The unit test covers the roll-up arithmetic. What only a real database can
// show is the half that matters: that the check actually TOUCHES it. A
// readiness endpoint that returns `database: 'up'` from a query it never ran
// is the same lie as `/health`, wearing a better name — and it is a lie that
// passes every unit test you could write about it.
//
// So both directions are here: up against a live Postgres, and down against a
// pool pointed at nothing.

process.env.JWT_SECRET = 'test-secret-for-integration-tests';

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Pool } from 'pg';
import supertest from 'supertest';

const PG = process.env.TEST_DATABASE_URL;
if (!PG) throw new Error('TEST_DATABASE_URL is not set. Run: pnpm test:integration');

const appUserUrl = (u: string): string => {
  const url = new URL(u);
  url.username = 'app_user';
  url.password = 'app_password';
  return url.toString();
};
process.env.APP_DATABASE_URL = appUserUrl(PG);

import app from '../index.ts';
import { __setPoolForTests } from './ready.ts';

describe('GET /ready', () => {
  const request = supertest(app);
  let dead: Pool;

  beforeAll(() => {
    // Port 1 is reserved and nothing listens on it, so this fails to connect
    // rather than hanging — which is what a readiness probe needs from a
    // database that is gone.
    dead = new Pool({
      connectionString: 'postgres://nobody:nobody@127.0.0.1:1/nothing',
      connectionTimeoutMillis: 2_000,
    });
  });

  afterAll(async () => {
    await dead.end();
  });

  afterEach(() => {
    __setPoolForTests(null);
  });

  it('answers 200 and says the database is up, having actually asked it', async () => {
    const res = await request.get('/api/ready');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', database: 'up' });
    // No issuer configured in this suite, which is a documented state and not
    // a failure — so it must not drag the roll-up away from ok.
    expect(res.body.signIn).toBe('off');
  });

  it('answers 503 when the database is unreachable', async () => {
    // The whole reason this endpoint exists. `/health` returns 200 here.
    __setPoolForTests(dead);

    const res = await request.get('/api/ready');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'down', database: 'down' });
  }, 15_000);

  it('still answers 200 from /health with the database gone — that is the point', async () => {
    // Not a criticism of /health: a liveness probe is meant to say "this
    // process is running", and it is. It is the reason a status page cannot be
    // pointed at it, and asserting the difference is what keeps somebody from
    // "simplifying" the two into one.
    __setPoolForTests(dead);

    expect((await request.get('/api/health')).status).toBe(200);
    expect((await request.get('/api/ready')).status).toBe(503);
  }, 15_000);

  it('publishes states and nothing that names our infrastructure', async () => {
    __setPoolForTests(dead);
    const res = await request.get('/api/ready');

    // The failure detail went to the log. What a stranger gets is three words.
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|nobody|postgres:\/\//i);
    expect(Object.keys(res.body).sort()).toEqual(['database', 'signIn', 'status']);
  }, 15_000);

  it('is reachable at both paths, like /health', async () => {
    // The web image's same-origin proxy forwards only /api/*, and the status
    // page reaches this through that proxy.
    expect((await request.get('/ready')).status).toBe(200);
    expect((await request.get('/api/ready')).status).toBe(200);
  });
});
