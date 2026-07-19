// Copyright 2026 OpenHands Agent (Apache-2.0)
/**
 * Cutover Lifecycle Integration Tests
 * 
 * Tests the complete cutover flow including state persistence across worker restarts.
 * Validates the full lifecycle from PREPARING to COMPLETED, including worker restart mid-flow.
 * 
 * See docs/architecture/solution-architecture.md §11 (shadow & cutover)
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createPgDb } from '@openmig/ledger';
import { CutoverStore } from '@openmig/ledger';
import { asTenantId, asMappingId } from '@openmig/shared';

// Connection string from Testcontainers
const PG_CONNECTION_STRING = process.env.TEST_DATABASE_URL;
if (!PG_CONNECTION_STRING) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Integration tests require Testcontainers to be running. ' +
    'Run: pnpm test:integration'
  );
}

// Fixed UUIDs for testing
const TEST_TENANT_ID = asTenantId('5e1b0000-e29b-41d4-a716-446655440201' as never);
const TEST_MAPPING_ID = asMappingId('5e1b0000-e29b-41d4-a716-446655440202' as never);

describe('Cutover Lifecycle (integration)', () => {
  let db: ReturnType<typeof createPgDb>;
  let cutoverPersistence: CutoverStore;

  beforeAll(async () => {
    db = createPgDb(PG_CONNECTION_STRING);
    cutoverPersistence = new CutoverStore(db);

    // Setup test tenant and mapping
    await db.execute(sql`
      INSERT INTO tenant (id, name, status)
      VALUES (${TEST_TENANT_ID}, 'Test Tenant', 'active')
      ON CONFLICT (id) DO NOTHING
    `);

    await db.execute(sql`
      INSERT INTO connection (id, tenant_id, role, kind, display_name, config, status)
      VALUES (
        '5e1b0000-e29b-41d4-a716-446655440201',
        ${TEST_TENANT_ID},
        'source',
        'o365',
        'O365 Source',
        '{}',
        'connected'
      )
      ON CONFLICT (id) DO NOTHING
    `);

    await db.execute(sql`
      INSERT INTO connection (id, tenant_id, role, kind, display_name, config, status)
      VALUES (
        '5e1b0000-e29b-41d4-a716-446655440202',
        ${TEST_TENANT_ID},
        'target',
        'selfhosted_mail',
        'Stalwart Target',
        '{}',
        'connected'
      )
      ON CONFLICT (id) DO NOTHING
    `);

    await db.execute(sql`
      INSERT INTO mailbox (id, tenant_id, connection_id, external_id, kind, display_name, status)
      VALUES (
        '5e1b0000-e29b-41d4-a716-446655440201',
        ${TEST_TENANT_ID},
        '5e1b0000-e29b-41d4-a716-446655440201',
        'inbox-source',
        'user',
        'Inbox',
        'active'
      )
      ON CONFLICT (id) DO NOTHING
    `);

    await db.execute(sql`
      INSERT INTO mailbox (id, tenant_id, connection_id, external_id, kind, display_name, status)
      VALUES (
        '5e1b0000-e29b-41d4-a716-446655440202',
        ${TEST_TENANT_ID},
        '5e1b0000-e29b-41d4-a716-446655440202',
        'inbox-target',
        'user',
        'Inbox',
        'active'
      )
      ON CONFLICT (id) DO NOTHING
    `);

    await db.execute(sql`
      INSERT INTO mailbox_mapping (id, tenant_id, source_mailbox_id, target_mailbox_id, status, mode)
      VALUES (
        ${TEST_MAPPING_ID},
        ${TEST_TENANT_ID},
        '5e1b0000-e29b-41d4-a716-446655440201',
        '5e1b0000-e29b-41d4-a716-446655440202',
        'active',
        'mirror'
      )
      ON CONFLICT (id) DO NOTHING
    `);
  });

  beforeEach(async () => {
    // Clean up cutover state
    await db.execute(sql`
      DELETE FROM cutover_event
      WHERE tenant_id = ${TEST_TENANT_ID} AND mapping_id = ${TEST_MAPPING_ID}
    `);

    await db.execute(sql`
      DELETE FROM cutover_state
      WHERE tenant_id = ${TEST_TENANT_ID} AND mapping_id = ${TEST_MAPPING_ID}
    `);
  });

  /**
   * T1: Full lifecycle - PREPARING → READY_FOR_CUTOVER → APPROVED → CUTOVER_IN_PROGRESS → GRACE_PERIOD → COMPLETED
   */
  it('should complete full cutover lifecycle', async () => {
    // Step 1: Initialize cutover (PREPARING)
    const initialState = await cutoverPersistence.initializeCutover({
      tenantId: TEST_TENANT_ID,
      mappingId: TEST_MAPPING_ID,
      targetMailServer: 'mail.example.com',
      startedBy: 'test',
    });

    expect(initialState.currentState).toBe('PREPARING');
    expect(initialState.tenantId).toBe(TEST_TENANT_ID);
    expect(initialState.mappingId).toBe(TEST_MAPPING_ID);
    expect(initialState.targetMailServer).toBe('mail.example.com');

    // Step 2: Transition to READY_FOR_CUTOVER
    const readyState = await cutoverPersistence.transitionState(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'READY_FOR_CUTOVER',
      { readyAt: new Date().toISOString(), reason: 'Verification passed' }
    );

    expect(readyState.currentState).toBe('READY_FOR_CUTOVER');

    // Step 3: Approve cutover
    const approvedState = await cutoverPersistence.transitionState(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'APPROVED',
      { approvedBy: 'test-user', timestamp: new Date().toISOString(), reason: 'Approved for cutover' }
    );

    expect(approvedState.currentState).toBe('APPROVED');

    // Step 4: Execute cutover (CUTOVER_IN_PROGRESS)
    const inProgressState = await cutoverPersistence.transitionState(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'CUTOVER_IN_PROGRESS',
      { startedAt: new Date().toISOString(), reason: 'Cutover started' }
    );

    expect(inProgressState.currentState).toBe('CUTOVER_IN_PROGRESS');

    // Step 5: Enter grace period (mandatory after cutover)
    const graceState = await cutoverPersistence.transitionState(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'GRACE_PERIOD',
      { gracePeriodStartedAt: new Date().toISOString(), reason: 'Grace period started' }
    );

    expect(graceState.currentState).toBe('GRACE_PERIOD');

    // Step 6: Complete cutover (after grace period)
    const completedState = await cutoverPersistence.transitionState(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'COMPLETED',
      { completedAt: new Date().toISOString(), reason: 'Grace period completed successfully' }
    );

    expect(completedState.currentState).toBe('COMPLETED');
    expect(completedState.completedAt).toBeDefined();

    // Verify event history
    const events = await cutoverPersistence.getEventHistory(TEST_TENANT_ID, TEST_MAPPING_ID, 10);
    expect(events.length).toBe(6); // 1 init + 5 transitions

    // Verify events are in order
    expect(events[0]?.eventType).toBe('CUTOVER_INITIALIZED');
    expect(events[1]?.eventType).toBe('STATE_TRANSITION');
    expect(events[2]?.eventType).toBe('STATE_TRANSITION');
    expect(events[3]?.eventType).toBe('STATE_TRANSITION');
    expect(events[4]?.eventType).toBe('STATE_TRANSITION');
    expect(events[5]?.eventType).toBe('STATE_TRANSITION');
  });

  /**
   * T2: Worker restart mid-flow - state survives and can continue
   */
  it('should persist state across worker restarts', async () => {
    // Simulate first worker session
    await cutoverPersistence.initializeCutover({
      tenantId: TEST_TENANT_ID,
      mappingId: TEST_MAPPING_ID,
      targetMailServer: 'mail.example.com',
      startedBy: 'test',
    });

    await cutoverPersistence.transitionState(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'READY_FOR_CUTOVER',
      { readyAt: new Date().toISOString(), reason: 'Verification passed' }
    );

    await cutoverPersistence.transitionState(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'APPROVED',
      { approvedBy: 'test-user', timestamp: new Date().toISOString(), reason: 'Approved for cutover' }
    );

    await cutoverPersistence.transitionState(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'CUTOVER_IN_PROGRESS',
      { startedAt: new Date().toISOString(), reason: 'Cutover started' }
    );

    // Simulate worker restart - create new persistence instance
    const newCutoverStore = new CutoverStore(db);

    // Rehydrate state
    const rehydratedState = await newCutoverStore.loadCutoverState(
      TEST_TENANT_ID,
      TEST_MAPPING_ID
    );

    expect(rehydratedState).toBeDefined();
    expect(rehydratedState?.currentState).toBe('CUTOVER_IN_PROGRESS');
    expect(rehydratedState?.targetMailServer).toBe('mail.example.com');

    // Continue from CUTOVER_IN_PROGRESS state - enter grace period
    const graceState = await newCutoverStore.transitionState(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'GRACE_PERIOD',
      { gracePeriodStartedAt: new Date().toISOString(), reason: 'Grace period started' }
    );

    expect(graceState.currentState).toBe('GRACE_PERIOD');

    // Complete the cutover (after grace period)
    const completedState = await newCutoverStore.transitionState(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'COMPLETED',
      { completedAt: new Date().toISOString(), reason: 'Grace period completed successfully' }
    );

    expect(completedState.currentState).toBe('COMPLETED');
  });

  /**
   * T3: Illegal transitions are rejected
   */
  it('should reject illegal state transitions', async () => {
    // Initialize cutover
    await cutoverPersistence.initializeCutover({
      tenantId: TEST_TENANT_ID,
      mappingId: TEST_MAPPING_ID,
      targetMailServer: 'mail.example.com',
      startedBy: 'test',
    });

    // Try to jump directly to COMPLETED (illegal - must go through APPROVED first)
    await expect(
      cutoverPersistence.transitionState(
        TEST_TENANT_ID,
        TEST_MAPPING_ID,
        'COMPLETED',
        { completedAt: new Date().toISOString() }
      )
    ).rejects.toThrow('Invalid transition from PREPARING to COMPLETED');

    // Verify state is still PREPARING
    const state = await cutoverPersistence.loadCutoverState(TEST_TENANT_ID, TEST_MAPPING_ID);
    expect(state?.currentState).toBe('PREPARING');
  });

  /**
   * T4: Events are queryable in order
   */
  it('should maintain ordered event history', async () => {
    // Perform a sequence of transitions
    await cutoverPersistence.initializeCutover({
      tenantId: TEST_TENANT_ID,
      mappingId: TEST_MAPPING_ID,
      targetMailServer: 'mail.example.com',
      startedBy: 'test',
    });

    await cutoverPersistence.transitionState(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'READY_FOR_CUTOVER',
      { readyAt: new Date().toISOString(), note: 'First transition' }
    );

    // Small delay to ensure different timestamps
    await new Promise(resolve => setTimeout(resolve, 10));

    await cutoverPersistence.transitionState(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'APPROVED',
      { approvedBy: 'test-user', timestamp: new Date().toISOString(), note: 'Second transition' }
    );

    // Get event history
    const events = await cutoverPersistence.getEventHistory(TEST_TENANT_ID, TEST_MAPPING_ID, 10);

    expect(events.length).toBe(3); // 1 init + 2 transitions

    // Verify chronological order (compare as Date objects since timestamps are ISO strings)
    for (let i = 1; i < events.length; i++) {
      expect(new Date(events[i]!.timestamp).getTime()).toBeGreaterThanOrEqual(new Date(events[i - 1]!.timestamp).getTime());
    }

    // Verify event details
    expect(events[0]?.eventType).toBe('CUTOVER_INITIALIZED');
    expect(events[0]?.fromState).toBeNull();
    expect(events[0]?.toState).toBe('PREPARING');

    expect(events[1]?.eventType).toBe('STATE_TRANSITION');
    expect(events[1]?.fromState).toBe('PREPARING');
    expect(events[1]?.toState).toBe('READY_FOR_CUTOVER');

    expect(events[2]?.eventType).toBe('STATE_TRANSITION');
    expect(events[2]?.fromState).toBe('READY_FOR_CUTOVER');
    expect(events[2]?.toState).toBe('APPROVED');
  });

  /**
   * T5: Rollback from any state
   */
  it('should allow rollback from CUTOVER_IN_PROGRESS', async () => {
    // Get to CUTOVER_IN_PROGRESS state
    await cutoverPersistence.initializeCutover({
      tenantId: TEST_TENANT_ID,
      mappingId: TEST_MAPPING_ID,
      targetMailServer: 'mail.example.com',
      startedBy: 'test',
    });

    await cutoverPersistence.transitionState(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'READY_FOR_CUTOVER',
      { readyAt: new Date().toISOString() }
    );

    await cutoverPersistence.transitionState(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'APPROVED',
      { approvedBy: 'test-user', timestamp: new Date().toISOString() }
    );

    await cutoverPersistence.transitionState(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'CUTOVER_IN_PROGRESS',
      { startedAt: new Date().toISOString() }
    );

    // Rollback
    const rolledBackState = await cutoverPersistence.transitionState(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'ROLLED_BACK',
      {
        rolledBackAt: new Date().toISOString(),
        rolledBackBy: 'test-user',
        rollbackReason: 'Test rollback',
      }
    );

    expect(rolledBackState.currentState).toBe('ROLLED_BACK');
    expect(rolledBackState.rolledBackAt).toBeDefined();
    expect(rolledBackState.rollbackReason).toBe('Test rollback');

    // Verify rollback event was logged
    const events = await cutoverPersistence.getEventHistory(TEST_TENANT_ID, TEST_MAPPING_ID, 10);
    const rollbackEvent = events.find(e => e.eventType === 'STATE_TRANSITION' && e.toState === 'ROLLED_BACK');
    expect(rollbackEvent).toBeDefined();
  });

  /**
   * T6: Failed cutover state
   */
  it('should handle failed cutover state', async () => {
    await cutoverPersistence.initializeCutover({
      tenantId: TEST_TENANT_ID,
      mappingId: TEST_MAPPING_ID,
      targetMailServer: 'mail.example.com',
      startedBy: 'test',
    });

    // Simulate failure
    const failedState = await cutoverPersistence.transitionState(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'FAILED',
      {
        failedAt: new Date().toISOString(),
        failureReason: 'Verification failed: DNS propagation timeout',
      }
    );

    expect(failedState.currentState).toBe('FAILED');
    expect(failedState.failedAt).toBeDefined();
    expect(failedState.failureReason).toBe('Verification failed: DNS propagation timeout');

    // Verify failure event
    const events = await cutoverPersistence.getEventHistory(TEST_TENANT_ID, TEST_MAPPING_ID, 10);
    const failureEvent = events.find(e => e.eventType === 'STATE_TRANSITION' && e.toState === 'FAILED');
    expect(failureEvent).toBeDefined();
    expect(failureEvent?.description).toContain('Verification failed');
  });
});
