// Copyright 2026 OpenHands Agent (Apache-2.0); assertions corrected 2026-07-20.
// E2E test for restart-resume idempotency (workplan 0010 T5).
//
// Black-box test against an ALREADY-RUNNING self-host compose stack: run a pass,
// restart the app, run again, and assert the ledger item count did NOT grow
// (zero duplicates) — the §5 "intermittently-on host resumes cleanly" property.
//
// PREREQUISITES (this test does NOT bring the stack up or seed the source):
//   1. Seed the source (Stalwart) with a KNOWN, NON-ZERO set of items — the
//      assertion is only meaningful when the first pass actually creates items.
//   2. Place a mapping in the (git-ignored) config dir and bring the stack up:
//        cp test/e2e/fixtures/selfhost-restart-resume.mapping.json \
//           deploy/selfhost/config/mapping.json
//        docker compose -f deploy/selfhost/compose.yml up -d
//   3. Run this test (manual e2e; NOT part of automated CI).
//
// Idempotency signal: `/status` exposes `itemsSynced` (DERIVED from the item
// ledger). After the first pass it is N; after the restart + second pass it must
// still be N — a second pass that created duplicates would grow it.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

const COMPOSE_FILE = 'deploy/selfhost/compose.yml';
const SELFHOST_PORT = process.env.SELFHOST_PORT || '8081';
const SELFHOST_BIND = process.env.SELFHOST_BIND || '127.0.0.1';

const HEALTH_URL = `http://${SELFHOST_BIND}:${SELFHOST_PORT}/healthz`;
const STATUS_URL = `http://${SELFHOST_BIND}:${SELFHOST_PORT}/status`;

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

// Cross-test state (a `this`-based approach does NOT work — the `it` callbacks
// are arrow functions, so `this` is not the test context).
let firstPassSynced = -1;
let firstPassLastSyncedAt: string | undefined;

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

/** The first mapping's email-domain status (the seeded domain), or null. */
function getEmailDomainStatus(): DomainStatus | null {
  const status = getStatus();
  const domains = status.mappings?.[0]?.domains;
  return domains?.find((d) => d.domain === 'email') ?? null;
}

describe('Restart-Resume Idempotency Gate (T5)', () => {
  beforeAll(async () => {
    await waitForHealth();
  }, 60000);

  afterAll(() => {
    try {
      execSync(`docker compose -f ${COMPOSE_FILE} down`, { stdio: 'inherit' });
    } catch {
      // best-effort cleanup
    }
  });

  it('first pass syncs the seeded items', async () => {
    // Wait for a completed pass that actually synced something.
    let status: DomainStatus | null = null;
    for (let i = 0; i < 60; i++) {
      status = getEmailDomainStatus();
      if (status && status.state === 'completed' && status.itemsSynced > 0) break;
      await setTimeout(2000);
    }

    expect(status, 'no completed email pass with items — is the source seeded?').toBeTruthy();
    expect(status!.itemsSynced).toBeGreaterThan(0);

    firstPassSynced = status!.itemsSynced;
    firstPassLastSyncedAt = status!.lastSyncedAt;
    console.log(`[e2e] first pass: itemsSynced=${firstPassSynced}`);
  }, 180000);

  it('restarts the app and resumes with zero duplicates', async () => {
    expect(firstPassSynced, 'first-pass test must run first and observe items').toBeGreaterThan(0);

    execSync(`docker compose -f ${COMPOSE_FILE} restart app`, { stdio: 'inherit' });
    await setTimeout(5000);
    await waitForHealth();

    // Wait for a NEW pass after the restart (lastSyncedAt advances past the first).
    let status: DomainStatus | null = null;
    for (let i = 0; i < 60; i++) {
      status = getEmailDomainStatus();
      if (
        status &&
        status.state === 'completed' &&
        status.lastSyncedAt &&
        status.lastSyncedAt !== firstPassLastSyncedAt
      ) {
        break;
      }
      await setTimeout(2000);
    }

    expect(status, 'no second pass observed after restart').toBeTruthy();

    // The property: the ledger item count did NOT grow — the second pass created
    // zero duplicates (it re-read the source but every item was already present).
    console.log(`[e2e] second pass: itemsSynced=${status!.itemsSynced} (first was ${firstPassSynced})`);
    expect(status!.itemsSynced).toBe(firstPassSynced);
    expect(status!.itemsFailed).toBe(0);
  }, 180000);
});
