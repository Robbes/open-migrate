// Copyright 2026 OpenHands Agent (Apache-2.0); assertions corrected 2026-07-20;
// generalized to multi-domain 2026-07-22 (issue #114 follow-up).
//
// E2E test for restart-resume idempotency (workplan 0010 T5, extended to
// calendar/contacts by issue #114's follow-up — WebDAV files remains deferred).
//
// Black-box test against an ALREADY-RUNNING self-host compose stack: for each
// ENABLED domain in the mapping, run a pass, restart the app, run again, and assert
// the ledger item count did NOT grow (zero duplicates) — the §5 "intermittently-on
// host resumes cleanly" property. Originally proved email/JMAP only; now proves it
// for calendar (CalDAV) and contacts (CardDAV) too, against a real cross-account
// Nextcloud pair (e2e-source -> e2e-target), closing the gap #114 explicitly left
// out of scope ("Restart-resume for the DAV domains... mail-scoped for now").
//
// PREREQUISITES (this test does NOT bring the stack up, seed the source, or activate):
//   1. Seed the sources with KNOWN, NON-ZERO sets of items — the assertion is only
//      meaningful when the first pass actually creates items:
//        - Stalwart (mail): test/e2e/seed-imap-source.mjs
//        - Nextcloud e2e-source account (calendar + contacts): test/e2e/seed-dav-source.mjs
//   2. Place a mapping in the (git-ignored) config dir and bring the stack up:
//        cp test/e2e/fixtures/selfhost-restart-resume.mapping.json \
//           deploy/selfhost/config/mapping.json
//        docker compose -f deploy/selfhost/compose.yml up -d
//   3. GREEN-LIGHT the mapping. Since workplan 0013 T7 the appliance loads every
//      mapping PAUSED and only schedules it after an explicit start, so it never
//      syncs on its own:
//        curl -X POST http://127.0.0.1:${SELFHOST_PORT}/mappings/<mappingId>/start
//   4. Run this test (manual e2e; NOT part of automated CI). The e2e.yml workflow
//      does steps 1–3 for you before invoking this.
//
// Idempotency signal: `/status` exposes `itemsSynced` per domain (DERIVED from the
// item ledger). After the first pass it is N; after the restart + second pass it
// must still be N — a second pass that created duplicates would grow it.

import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

const COMPOSE_FILE = 'deploy/selfhost/compose.yml';
const SELFHOST_PORT = process.env.SELFHOST_PORT || '8081';
const SELFHOST_BIND = process.env.SELFHOST_BIND || '127.0.0.1';

const HEALTH_URL = `http://${SELFHOST_BIND}:${SELFHOST_PORT}/healthz`;
const STATUS_URL = `http://${SELFHOST_BIND}:${SELFHOST_PORT}/status`;

// Domains this gate proves restart-resume for. WebDAV files remains deferred (issue
// #114 follow-up scope) — its target-write path is proven by the integration test
// (packages/core/src/dav-sync.integration.test.ts) but not yet this restart-resume
// property. Comma-separated override via E2E_DOMAINS lets a partial dispatch (e.g.
// while only Stalwart is up) still exercise a subset.
const DOMAINS: string[] = (process.env.E2E_DOMAINS || 'email,calendar,contact')
  .split(',')
  .map((d) => d.trim())
  .filter((d) => d.length > 0);

interface DomainStatus {
  domain: string;
  state: string;
  itemsSynced: number;
  itemsFailed: number;
  lastSyncedAt?: string;
}
interface StatusPayload {
  status: 'ok';
  mappings: Array<{ mappingId: string; domains: DomainStatus[] }>;
}

async function waitForHealth(maxAttempts = 30, delayMs = 2000): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const result = execSync(`curl -sf ${HEALTH_URL}`, { encoding: 'utf8', stdio: 'pipe' });
      if (result.includes('ok')) return;
    } catch {
      // not ready yet
    }
    await setTimeout(delayMs);
  }
  throw new Error(`App did not become healthy at ${HEALTH_URL}`);
}

function getStatus(): StatusPayload {
  return JSON.parse(execSync(`curl -sf ${STATUS_URL}`, { encoding: 'utf8' })) as StatusPayload;
}

/** The first mapping's status for a given domain, or null. */
function getDomainStatus(domain: string): DomainStatus | null {
  const status = getStatus();
  const domains = status.mappings?.[0]?.domains;
  return domains?.find((d) => d.domain === domain) ?? null;
}

describe('Restart-Resume Idempotency Gate (T5)', () => {
  beforeAll(async () => {
    await waitForHealth();
  }, 60000);

  // NOTE: this test does NOT tear the stack down (it never brought it up — see the
  // PREREQUISITES header). Whoever owns the stack owns teardown: the e2e.yml workflow's
  // Cleanup step, or a by-hand runner. A previous `afterAll` here ran `docker compose down`,
  // which removed the app container before failure diagnostics (its logs) could be captured.

  // Cross-test state per domain (a `this`-based approach does NOT work — the `it`
  // callbacks are arrow functions, so `this` is not the test context).
  const firstPassSynced: Record<string, number> = {};
  const firstPassLastSyncedAt: Record<string, string | undefined> = {};

  for (const domain of DOMAINS) {
    it(`${domain}: first pass syncs the seeded items`, async () => {
      // Wait for a completed pass that actually synced something.
      let status: DomainStatus | null = null;
      for (let i = 0; i < 60; i++) {
        status = getDomainStatus(domain);
        if (status && status.state === 'completed' && status.itemsSynced > 0) break;
        await setTimeout(2000);
      }

      expect(status, `no completed ${domain} pass with items — is the source seeded?`).toBeTruthy();
      expect(status!.itemsSynced).toBeGreaterThan(0);

      firstPassSynced[domain] = status!.itemsSynced;
      firstPassLastSyncedAt[domain] = status!.lastSyncedAt;
      console.log(`[e2e] ${domain} first pass: itemsSynced=${status!.itemsSynced}`);
    }, 180000);
  }

  it('restarts the app and every domain resumes with zero duplicates', async () => {
    for (const domain of DOMAINS) {
      expect(firstPassSynced[domain], `${domain} first-pass test must run first and observe items`).toBeGreaterThan(0);
    }

    execSync(`docker compose -f ${COMPOSE_FILE} restart app`, { stdio: 'inherit' });
    await setTimeout(5000);
    await waitForHealth();

    for (const domain of DOMAINS) {
      // Wait for a NEW pass after the restart (lastSyncedAt advances past the first).
      let status: DomainStatus | null = null;
      for (let i = 0; i < 60; i++) {
        status = getDomainStatus(domain);
        if (
          status &&
          status.state === 'completed' &&
          status.lastSyncedAt &&
          status.lastSyncedAt !== firstPassLastSyncedAt[domain]
        ) {
          break;
        }
        await setTimeout(2000);
      }

      expect(status, `no second pass observed for ${domain} after restart`).toBeTruthy();

      // The property: the ledger item count did NOT grow — the second pass created
      // zero duplicates (it re-read the source but every item was already present).
      console.log(`[e2e] ${domain} second pass: itemsSynced=${status!.itemsSynced} (first was ${firstPassSynced[domain]})`);
      expect(status!.itemsSynced).toBe(firstPassSynced[domain]);
      expect(status!.itemsFailed).toBe(0);
    }
  }, 300000);
});
