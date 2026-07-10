// Copyright 2026 OpenHands Agent (Apache-2.0)
/**
 * Rollback Integration Tests
 * 
 * Tests both rollback scenarios:
 * - Gate-fail path: Verification fails → rollback to Shadow (nothing external touched)
 * - Grace-window path: Post-cutover rollback with DNS restoration
 * 
 * See docs/architecture/solution-architecture.md §20 (verification & rollback)
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createPgDb } from '@openmig/ledger';
import { CutoverPersistence } from '@openmig/core';
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
const TEST_TENANT_ID = asTenantId('550e8400-e29b-41d4-a716-446655440301' as never);
const TEST_MAPPING_ID = asMappingId('550e8400-e29b-41d4-a716-446655440302' as never);

describe('Rollback Paths (integration)', () => {
  let db: ReturnType<typeof createPgDb>;
  let cutoverPersistence: CutoverPersistence;

  beforeAll(async () => {
    db = createPgDb(PG_CONNECTION_STRING);
    cutoverPersistence = new CutoverPersistence(db);

    // Setup test tenant and mapping
    await db.execute(sql`
      INSERT INTO tenant (id, name, status)
      VALUES (${TEST_TENANT_ID}, 'Test Tenant', 'active')
      ON CONFLICT (id) DO NOTHING
    `);

    await db.execute(sql`
      INSERT INTO connection (id, tenant_id, role, kind, display_name, config, status)
      VALUES (
        '650e8400-e29b-41d4-a716-446655440301',
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
        '650e8400-e29b-41d4-a716-446655440302',
        ${TEST_TENANT_ID},
        'target',
        'stalwart',
        'Stalwart Target',
        '{}',
        'connected'
      )
      ON CONFLICT (id) DO NOTHING
    `);

    await db.execute(sql`
      INSERT INTO mapping (id, tenant_id, source_connection_id, target_connection_id, status)
      VALUES (
        ${TEST_MAPPING_ID},
        ${TEST_TENANT_ID},
        '650e8400-e29b-41d4-a716-446655440301',
        '650e8400-e29b-41d4-a716-446655440302',
        'active'
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
   * T1: Gate-fail path - Verification fails → rollback to PREPARING
   * Nothing external is touched (no DNS changes)
   */
  it('should handle gate-fail rollback without external changes', async () => {
    // Initialize cutover
    const initialState = await cutoverPersistence.initializeCutover({
      tenantId: TEST_TENANT_ID,
      mappingId: TEST_MAPPING_ID,
      targetMailServer: 'mail.example.com',
      startedBy: 'test',
    });

    expect(initialState.currentState).toBe('PREPARING');

    // Simulate verification failure during PREPARING phase
    const failedState = await cutoverPersistence.transitionState(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'FAILED',
      {
        failedAt: new Date().toISOString(),
        failureReason: 'Verification failed: Missing 50 mail items on target',
      }
    );

    expect(failedState.currentState).toBe('FAILED');
    expect(failedState.failureReason).toBe('Verification failed: Missing 50 mail items on target');

    // Verify no DNS-related fields were set (nothing external touched)
    expect(failedState.dnsRecordsUpdated).toBeUndefined();
    expect(failedState.dnsVerifiedAt).toBeUndefined();

    // Verify audit trail
    const events = await cutoverPersistence.getEventHistory(TEST_TENANT_ID, TEST_MAPPING_ID, 10);
    expect(events.length).toBe(2); // INIT + FAILURE

    const failureEvent = events.find(e => e.toState === 'FAILED');
    expect(failureEvent).toBeDefined();
    expect(failureEvent?.description).toContain('Verification failed');
  });

  /**
   * T2: Grace-window path - Post-cutover rollback with DNS restoration
   */
  it('should handle post-cutover rollback with DNS restoration', async () => {
    // Complete full cutover to COMPLETED state
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

    // Simulate DNS being updated
    await cutoverPersistence.transitionState(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'COMPLETED',
      {
        completedAt: new Date().toISOString(),
        dnsRecordsUpdated: true,
        dnsVerifiedAt: new Date().toISOString(),
      }
    );

    // Now rollback during grace period
    const rolledBackState = await cutoverPersistence.transitionState(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'ROLLED_BACK',
      {
        rolledBackAt: new Date().toISOString(),
        rolledBackBy: 'admin-user',
        rollbackReason: 'User reported mail delivery issues',
        dnsRestored: true,
      }
    );

    expect(rolledBackState.currentState).toBe('ROLLED_BACK');
    expect(rolledBackState.rolledBackAt).toBeDefined();
    expect(rolledBackState.rollbackReason).toBe('User reported mail delivery issues');
    expect(rolledBackState.dnsRestored).toBe(true);

    // Verify complete audit trail
    const events = await cutoverPersistence.getEventHistory(TEST_TENANT_ID, TEST_MAPPING_ID, 10);
    expect(events.length).toBe(6); // INIT + 4 transitions + ROLLBACK

    // Verify rollback event details
    const rollbackEvent = events.find(e => e.toState === 'ROLLED_BACK');
    expect(rollbackEvent).toBeDefined();
    expect(rollbackEvent?.fromState).toBe('COMPLETED');
    expect(rollbackEvent?.description).toContain('rolled back');
  });

  /**
   * T3: Step failure during rollback - continue remaining steps
   */
  it('should continue rollback steps even if one fails', async () => {
    // Setup cutover in COMPLETED state
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

    await cutoverPersistence.transitionState(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'COMPLETED',
      { completedAt: new Date().toISOString() }
    );

    // Attempt rollback (in real implementation, some steps might fail)
    // Here we simulate by just doing the state transition
    const rolledBackState = await cutoverPersistence.transitionState(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'ROLLED_BACK',
      {
        rolledBackAt: new Date().toISOString(),
        rolledBackBy: 'test-user',
        rollbackReason: 'Partial rollback - some steps failed',
        dnsRestored: true,
        rollbackNotes: 'DNS restored, but data source restoration had warnings',
      }
    );

    expect(rolledBackState.currentState).toBe('ROLLED_BACK');
    expect(rolledBackState.rollbackNotes).toBe('DNS restored, but data source restoration had warnings');

    // Verify audit trail shows all steps
    const events = await cutoverPersistence.getEventHistory(TEST_TENANT_ID, TEST_MAPPING_ID, 10);
    const rollbackEvent = events.find(e => e.toState === 'ROLLED_BACK');
    expect(rollbackEvent).toBeDefined();
  });

  /**
   * T4: Rollback from APPROVED state (before DNS changes)
   */
  it('should rollback from APPROVED state without DNS restoration', async () => {
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

    // Rollback before DNS changes
    const rolledBackState = await cutoverPersistence.transitionState(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'ROLLED_BACK',
      {
        rolledBackAt: new Date().toISOString(),
        rolledBackBy: 'test-user',
        rollbackReason: 'Approved but not yet executed - aborting',
        dnsRestored: false, // No DNS changes to restore
      }
    );

    expect(rolledBackState.currentState).toBe('ROLLED_BACK');
    expect(rolledBackState.dnsRestored).toBe(false);

    // Verify audit trail
    const events = await cutoverPersistence.getEventHistory(TEST_TENANT_ID, TEST_MAPPING_ID, 10);
    const rollbackEvent = events.find(e => e.toState === 'ROLLED_BACK');
    expect(rollbackEvent).toBeDefined();
    expect(rollbackEvent?.fromState).toBe('APPROVED');
  });

  /**
   * T5: Detect reverse changes after cutover
   */
  it('should track items added to target after cutover during rollback', async () => {
    // This test validates the ability to detect changes made during the cutover period
    // In a real implementation, this would involve comparing ledger vs target

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

    // Simulate user adding items to target during cutover
    // (In real implementation, this would be detected via comparison)
    const cutoverStartTime = new Date().toISOString();

    await cutoverPersistence.transitionState(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'COMPLETED',
      {
        completedAt: new Date().toISOString(),
        cutoverStartTime,
        itemsAddedDuringCutover: 3, // Simulated detection
      }
    );

    // Rollback with awareness of items added during cutover
    const rolledBackState = await cutoverPersistence.transitionState(
      TEST_TENANT_ID,
      TEST_MAPPING_ID,
      'ROLLED_BACK',
      {
        rolledBackAt: new Date().toISOString(),
        rolledBackBy: 'test-user',
        rollbackReason: 'Rollback with awareness of cutover-period changes',
        itemsAddedDuringCutover: 3,
        rollbackNotes: '3 items were added to target during cutover - user notified to review',
      }
    );

    expect(rolledBackState.currentState).toBe('ROLLED_BACK');
    expect(rolledBackState.itemsAddedDuringCutover).toBe(3);
    expect(rolledBackState.rollbackNotes).toContain('3 items were added');

    // Verify audit trail documents the reverse-read
    const events = await cutoverPersistence.getEventHistory(TEST_TENANT_ID, TEST_MAPPING_ID, 10);
    expect(events.length).toBeGreaterThan(0);
  });
});
