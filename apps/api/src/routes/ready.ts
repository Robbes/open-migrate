// Copyright 2026 The Ownpace authors (Apache-2.0)

/**
 * `GET /ready` — the one health answer that can be NO (workplan 0094 T1).
 *
 * ## Why this exists next to `/health`
 *
 * `/health` returns `{ status: 'ok' }` from a literal. It never touches the
 * database, the identity provider, or anything else, so it answers exactly one
 * question — *is this process running* — and answers it correctly. Compose
 * healthchecks and the smoke script depend on that, and it stays.
 *
 * What it cannot do is tell a status page anything. A page probing `/health`
 * reports green while Postgres is unreachable and every request is 500ing,
 * which is worse than having no page: it is a green light somebody trusts.
 *
 * ## What it checks, and what it deliberately does not
 *
 * Only things whose failure means CUSTOMERS CANNOT BE SERVED:
 *
 *  - **the database** — nothing works without it, so this is the one that
 *    turns the whole answer to `down`;
 *  - **sign-in** — the issuer's discovery document, the same one `auth.ts`
 *    reads `jwks_uri` from. Its being unreachable does not stop existing
 *    sessions, so it is `degraded`, not `down`. That distinction is the
 *    difference between orange and red on the page.
 *
 * Not the worker, not Trigger.dev, not the demo backends. A sync that is behind
 * is a real thing to know and NOT a reason to tell the world the service is
 * down; it belongs on a queue-depth metric, not here.
 *
 * ## It says up or down and NOTHING else
 *
 * This is publicly reachable — the web image proxies `/api/*`, and a status
 * page has to be able to read it without a credential. So a check reports
 * `up`, `down` or `off` and the reason goes to the LOG, where an operator can
 * see it and a stranger cannot. A readiness endpoint that echoes
 * `getaddrinfo ENOTFOUND db.internal` has published an internal hostname to
 * everybody who asks.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { Pool } from 'pg';
import { log } from '@openmig/shared';
import { getDbPool } from '../middleware/auth.ts';

const router = Router();

/** One component's answer. `off` means "not configured here", not "broken". */
export type CheckState = 'up' | 'down' | 'off';

export interface Readiness {
  /** `down` when nothing can be served; `degraded` when something is off. */
  readonly status: 'ok' | 'degraded' | 'down';
  readonly database: CheckState;
  readonly signIn: CheckState;
}

/**
 * Roll the components up into one word.
 *
 * The database is the only check that can make it `down`, because it is the
 * only one whose absence means no request can be served at all. Everything else
 * degrades: the product keeps working for the people already inside it, and
 * saying "down" when that is true would cry wolf at exactly the service whose
 * value proposition is that somebody is looking after their mail.
 */
export function rollUp(checks: Omit<Readiness, 'status'>): Readiness['status'] {
  if (checks.database === 'down') return 'down';
  if (Object.values(checks).includes('down')) return 'degraded';
  return 'ok';
}

/** The pool is built once: a readiness probe that opens a pool per request is
 *  a load test pointed at the thing it is meant to be reassuring you about. */
let _pool: Pool | null = null;
function pool(): Pool {
  if (!_pool) _pool = getDbPool();
  return _pool;
}

/**
 * TEST SEAM ONLY. Point readiness at a different pool, or `null` to rebuild
 * from the environment.
 *
 * It exists because the case worth proving is the one where the database is
 * UNREACHABLE, and there is no other way to arrange that against a live
 * Postgres without taking it away from every other test sharing it.
 */
export function __setPoolForTests(replacement: Pool | null): void {
  _pool = replacement;
}

async function checkDatabase(): Promise<CheckState> {
  try {
    // Through the same pool the request path uses — including PgBouncer when
    // one is in front — so this proves the route customers take, not a
    // different one that happens to work.
    await pool().query('SELECT 1');
    return 'up';
  } catch (error) {
    log.error('[ready] database unreachable:', error);
    return 'down';
  }
}

async function checkSignIn(): Promise<CheckState> {
  const issuer = process.env.JWT_ISSUER;
  // No issuer configured is not a failure: the self-host edition has none, and
  // a managed deployment that has not run the identity setup yet is in a
  // documented state, not a broken one.
  if (!issuer) return 'off';

  try {
    const response = await fetch(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      log.error(`[ready] issuer answered ${response.status} at its discovery document`);
      return 'down';
    }
    return 'up';
  } catch (error) {
    log.error('[ready] issuer unreachable:', error);
    return 'down';
  }
}

/**
 * Both checks at once, not one after the other: a probe that takes the sum of
 * every timeout is a probe that times out itself and reports a red that is its
 * own fault.
 */
export async function readiness(): Promise<Readiness> {
  const [database, signIn] = await Promise.all([checkDatabase(), checkSignIn()]);
  const checks = { database, signIn };
  return { status: rollUp(checks), ...checks };
}

const handler = async (_req: Request, res: Response): Promise<void> => {
  const body = await readiness();
  // 503 only when nothing can be served. `degraded` is a 200 on purpose: the
  // API IS serving, and a load balancer that pulled it out of rotation for a
  // sign-in outage would turn a partial problem into a total one.
  res.status(body.status === 'down' ? 503 : 200).json(body);
};

router.get('/', handler);

export default router;
export { handler as readyHandler };
