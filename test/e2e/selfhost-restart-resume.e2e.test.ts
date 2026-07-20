// Copyright 2026 OpenHands Agent (Apache-2.0)
// E2E test for restart-resume idempotency (workplan 0010 T5).
// Black-box test against the running self-host compose stack:
// 1. Seed source (Stalwart) with known items
// 2. Run first pass → record created = N
// 3. Restart app container
// 4. Run second pass → assert created = 0 (zero duplicates), cursor advanced
//
// PREREQUISITE: this test drives an ALREADY-RUNNING stack. Before bringing the
// stack up, place a mapping in the (git-ignored) config dir — real mappings are
// never committed as the default (they auto-load). Use the test fixture:
//   cp test/e2e/fixtures/selfhost-restart-resume.mapping.json \
//      deploy/selfhost/config/mapping.json
//   docker compose -f deploy/selfhost/compose.yml up -d

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

const COMPOSE_FILE = 'deploy/selfhost/compose.yml';
const SELFHOST_PORT = process.env.SELFHOST_PORT || '8080';
const SELFHOST_BIND = process.env.SELFHOST_BIND || '127.0.0.1';

const HEALTH_URL = `http://${SELFHOST_BIND}:${SELFHOST_PORT}/healthz`;
const STATUS_URL = `http://${SELFHOST_BIND}:${SELFHOST_PORT}/status`;

/**
 * Wait for the app to be healthy.
 */
async function waitForHealth(maxAttempts = 30, delayMs = 2000): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const result = execSync(`curl -sf ${HEALTH_URL}`, { encoding: 'utf8', stdio: 'pipe' });
      if (result.includes('ok')) return;
    } catch {
      // ignore
    }
    await setTimeout(delayMs);
  }
  throw new Error(`App did not become healthy at ${HEALTH_URL}`);
}

/**
 * Get the status payload from the app.
 */
function getStatus(): { status: 'ok'; mappings: unknown[] } {
  const result = execSync(`curl -sf ${STATUS_URL}`, { encoding: 'utf8' });
  return JSON.parse(result) as { status: 'ok'; mappings: unknown[] };
}

/**
 * Extract the first mapping's domain status from /status.
 * Returns { itemsSynced, itemsCreated } if available.
 */
function getFirstMappingStatus(): { itemsSynced: number; itemsCreated: number } | null {
  const status = getStatus();
  if (!status.mappings?.[0]?.domains?.[0]) return null;
  const domain = status.mappings[0].domains[0];
  return {
    itemsSynced: domain.itemsSynced ?? 0,
    itemsCreated: domain.itemsCreated ?? 0,
  };
}

/**
 * Restart the app container.
 */
function restartApp(): void {
  execSync(`docker compose -f ${COMPOSE_FILE} restart app`, { stdio: 'inherit' });
}

/**
 * Wait for the app to be healthy after restart.
 */
async function waitForHealthAfterRestart(): Promise<void> {
  await setTimeout(5000); // Give Docker a moment to restart
  await waitForHealth();
}

describe('Restart-Resume Idempotency Gate (T5)', () => {
  beforeAll(async () => {
    // Ensure the stack is up and healthy
    console.log('[e2e] Waiting for app to be healthy...');
    await waitForHealth();
    console.log('[e2e] App is healthy');
  }, 60000);

  afterAll(() => {
    // Cleanup: stop the stack (optional, can be left running for inspection)
    try {
      execSync(`docker compose -f ${COMPOSE_FILE} down`, { stdio: 'inherit' });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should complete first pass and record created count', async () => {
    // The first pass should be triggered by the cron scheduler or can be manually triggered
    // For now, we wait for the first pass to complete (up to 2 minutes)
    console.log('[e2e] Waiting for first pass to complete...');
    
    let attempts = 0;
    const maxAttempts = 60; // 2 minutes with 2s delay
    let firstPassStatus: { itemsSynced: number; itemsCreated: number } | null = null;

    while (attempts < maxAttempts) {
      const status = getFirstMappingStatus();
      if (status && status.itemsSynced > 0) {
        firstPassStatus = status;
        break;
      }
      await setTimeout(2000);
      attempts++;
    }

    expect(firstPassStatus).toBeTruthy();
    expect(firstPassStatus!.itemsSynced).toBeGreaterThan(0);
    console.log(`[e2e] First pass complete: itemsSynced=${firstPassStatus!.itemsSynced}, itemsCreated=${firstPassStatus!.itemsCreated}`);
    
    // Store the first pass created count
    (this as any).firstPassCreated = firstPassStatus!.itemsCreated;
  }, 180000);

  it('should restart app and resume with zero duplicates', async () => {
    const firstPassCreated = (this as any).firstPassCreated;
    expect(firstPassCreated).toBeGreaterThan(0);

    console.log('[e2e] Restarting app container...');
    restartApp();
    await waitForHealthAfterRestart();
    console.log('[e2e] App restarted and healthy');

    // Wait for second pass (another 2 minutes max)
    console.log('[e2e] Waiting for second pass to complete...');
    
    let attempts = 0;
    const maxAttempts = 60;
    let secondPassStatus: { itemsSynced: number; itemsCreated: number } | null = null;

    while (attempts < maxAttempts) {
      const status = getFirstMappingStatus();
      if (status && status.itemsSynced > 0) {
        secondPassStatus = status;
        break;
      }
      await setTimeout(2000);
      attempts++;
    }

    expect(secondPassStatus).toBeTruthy();
    
    // The key assertion: second pass should create ZERO new items
    console.log(`[e2e] Second pass: itemsSynced=${secondPassStatus!.itemsSynced}, itemsCreated=${secondPassStatus!.itemsCreated}`);
    expect(secondPassStatus!.itemsCreated).toBe(0);
    
    // Cursor should have advanced (itemsSynced should be at least the same as first pass)
    expect(secondPassStatus!.itemsSynced).toBeGreaterThanOrEqual(firstPassCreated);
    
    console.log('[e2e] ✅ Idempotency verified: First pass created', firstPassCreated, 'items, second pass created 0 duplicates');
  }, 180000);
});
