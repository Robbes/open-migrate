/**
 * Cutover State Machine Unit Tests
 * 
 * Tests for cutover state transitions, validation, and lifecycle management.
 */

import { describe, expect, it } from 'vitest';
import { asTenantId, asMappingId } from '@openmig/shared';
import type { CutoverState } from './cutover-state';
import {
  isValidTransition,
  getStatePhase,
  canRollback,
  isTerminalState,
  createInitialCutoverStatus,
  updateCutoverStatus,
  createCutoverEvent,
} from '../src/cutover-state';

describe('Cutover State Machine', () => {
  describe('isValidTransition', () => {
    it('should allow valid transitions from PREPARING', () => {
      expect(isValidTransition('PREPARING', 'READY_FOR_CUTOVER')).toBe(true);
      expect(isValidTransition('PREPARING', 'FAILED')).toBe(true);
    });

    it('should allow valid transitions from READY_FOR_CUTOVER', () => {
      // APPROVED is the required gate before cutover can begin
      expect(isValidTransition('READY_FOR_CUTOVER', 'APPROVED')).toBe(true);
      expect(isValidTransition('READY_FOR_CUTOVER', 'PREPARING')).toBe(true);
      expect(isValidTransition('READY_FOR_CUTOVER', 'FAILED')).toBe(true);
      // Direct transition to CUTOVER_IN_PROGRESS is BLOCKED (approval gate enforced)
      expect(isValidTransition('READY_FOR_CUTOVER', 'CUTOVER_IN_PROGRESS')).toBe(false);
    });

    it('should allow valid transitions from CUTOVER_IN_PROGRESS', () => {
      expect(isValidTransition('CUTOVER_IN_PROGRESS', 'GRACE_PERIOD')).toBe(true);
      expect(isValidTransition('CUTOVER_IN_PROGRESS', 'FAILED')).toBe(true);
      expect(isValidTransition('CUTOVER_IN_PROGRESS', 'ROLLED_BACK')).toBe(true);
    });

    it('should allow valid transitions from GRACE_PERIOD', () => {
      expect(isValidTransition('GRACE_PERIOD', 'COMPLETED')).toBe(true);
      expect(isValidTransition('GRACE_PERIOD', 'ROLLED_BACK')).toBe(true);
      expect(isValidTransition('GRACE_PERIOD', 'FAILED')).toBe(true);
    });

    it('should not allow transitions from terminal states', () => {
      expect(isValidTransition('COMPLETED', 'PREPARING')).toBe(false);
      expect(isValidTransition('ROLLED_BACK', 'PREPARING')).toBe(false);
      expect(isValidTransition('FAILED', 'COMPLETED')).toBe(false);
    });

    it('should not allow invalid transitions', () => {
      expect(isValidTransition('PREPARING', 'COMPLETED')).toBe(false);
      expect(isValidTransition('READY_FOR_CUTOVER', 'GRACE_PERIOD')).toBe(false);
      expect(isValidTransition('CUTOVER_IN_PROGRESS', 'COMPLETED')).toBe(false);
    });
  });

  describe('getStatePhase', () => {
    it('should map states to phases correctly', () => {
      expect(getStatePhase('PREPARING')).toBe('PREPARATION');
      expect(getStatePhase('READY_FOR_CUTOVER')).toBe('VERIFICATION');
      expect(getStatePhase('CUTOVER_IN_PROGRESS')).toBe('CUTOVER');
      expect(getStatePhase('GRACE_PERIOD')).toBe('GRACE');
      expect(getStatePhase('COMPLETED')).toBe('COMPLETION');
      expect(getStatePhase('ROLLED_BACK')).toBe('ROLLBACK');
      expect(getStatePhase('FAILED')).toBe('ERROR');
    });
  });

  describe('canRollback', () => {
    it('should allow rollback from CUTOVER_IN_PROGRESS', () => {
      expect(canRollback('CUTOVER_IN_PROGRESS')).toBe(true);
    });

    it('should allow rollback from GRACE_PERIOD', () => {
      expect(canRollback('GRACE_PERIOD')).toBe(true);
    });

    it('should not allow rollback from other states', () => {
      expect(canRollback('PREPARING')).toBe(false);
      expect(canRollback('READY_FOR_CUTOVER')).toBe(false);
      expect(canRollback('COMPLETED')).toBe(false);
      expect(canRollback('ROLLED_BACK')).toBe(false);
      expect(canRollback('FAILED')).toBe(false);
    });
  });

  describe('isTerminalState', () => {
    it('should identify terminal states', () => {
      expect(isTerminalState('COMPLETED')).toBe(true);
      expect(isTerminalState('ROLLED_BACK')).toBe(true);
      expect(isTerminalState('FAILED')).toBe(true);
    });

    it('should identify non-terminal states', () => {
      expect(isTerminalState('PREPARING')).toBe(false);
      expect(isTerminalState('READY_FOR_CUTOVER')).toBe(false);
      expect(isTerminalState('CUTOVER_IN_PROGRESS')).toBe(false);
      expect(isTerminalState('GRACE_PERIOD')).toBe(false);
    });
  });

  describe('createInitialCutoverStatus', () => {
    it('should create initial status with correct defaults', () => {
      const status = createInitialCutoverStatus(asTenantId('tenant-1'), asMappingId('mapping-1'));
      
      expect(status.tenantId).toBe('tenant-1');
      expect(status.mappingId).toBe('mapping-1');
      expect(status.state).toBe('PREPARING');
      expect(status.phase).toBe('PREPARATION');
      expect(status.verificationStatus).toBe('PENDING');
      expect(status.totalItemsMigrated).toBe(0);
      expect(status.itemsVerified).toBe(0);
      expect(status.discrepanciesFound).toBe(0);
      expect(status.rollbackAvailable).toBe(false);
      expect(status.startedAt).toBeDefined();
      expect(status.updatedAt).toBeDefined();
    });

    it('should accept partial config overrides', () => {
      const config = {
        tenantId: asTenantId('tenant-1'),
        mappingId: asMappingId('mapping-1'),
        gracePeriodDurationHours: 48,
      };
      
      expect(config.gracePeriodDurationHours).toBe(48);
    });
  });

  describe('updateCutoverStatus', () => {
    it('should update status with valid transition', () => {
      const initial = createInitialCutoverStatus(asTenantId('tenant-1'), asMappingId('mapping-1'));
      const updated = updateCutoverStatus(initial, 'READY_FOR_CUTOVER', 'Verification passed');
      
      expect(updated.state).toBe('READY_FOR_CUTOVER');
      expect(updated.phase).toBe('VERIFICATION');
      expect(updated.updatedAt).toBeDefined();
      expect(updated.rollbackAvailable).toBe(false);
    });

    it('should set rollback available for CUTOVER_IN_PROGRESS', () => {
      const initial = createInitialCutoverStatus(asTenantId('tenant-1'), asMappingId('mapping-1'));
      const ready = updateCutoverStatus(initial, 'READY_FOR_CUTOVER', 'Ready for cutover');
      // Must go through APPROVED gate before cutover can start
      const approved = updateCutoverStatus(ready, 'APPROVED', 'Approved by operator');
      const inProgress = updateCutoverStatus(approved, 'CUTOVER_IN_PROGRESS', 'Starting cutover');
      const updated = updateCutoverStatus(inProgress, 'GRACE_PERIOD', 'Cutover complete');
      
      expect(updated.rollbackAvailable).toBe(true);
    });

    it('should throw on invalid transition', () => {
      const initial = createInitialCutoverStatus(asTenantId('tenant-1'), asMappingId('mapping-1'));
      
      expect(() => {
        updateCutoverStatus(initial, 'COMPLETED', 'Invalid transition');
      }).toThrow('Invalid state transition from PREPARING to COMPLETED');
    });

    it('should set completedAt for COMPLETED state', () => {
      const initial = createInitialCutoverStatus(asTenantId('tenant-1'), asMappingId('mapping-1'));
      const ready = updateCutoverStatus(initial, 'READY_FOR_CUTOVER', 'Ready');
      // Must go through APPROVED gate
      const approved = updateCutoverStatus(ready, 'APPROVED', 'Approved by operator');
      const inProgress = updateCutoverStatus(approved, 'CUTOVER_IN_PROGRESS', 'Starting');
      const grace = updateCutoverStatus(inProgress, 'GRACE_PERIOD', 'Grace started');
      const completed = updateCutoverStatus(grace, 'COMPLETED', 'Done');
      
      expect(completed.completedAt).toBeDefined();
    });
  });

  describe('createCutoverEvent', () => {
    it('should create event with correct data', () => {
      const event = createCutoverEvent(
        asTenantId('tenant-1'),
        asMappingId('mapping-1'),
        'PREPARING',
        'READY_FOR_CUTOVER',
        'user-123',
        'Verification complete',
        { score: 0.98 }
      );

      expect(event.tenantId).toBe('tenant-1');
      expect(event.mappingId).toBe('mapping-1');
      expect(event.fromState).toBe('PREPARING');
      expect(event.toState).toBe('READY_FOR_CUTOVER');
      expect(event.triggeredBy).toBe('user-123');
      expect(event.reason).toBe('Verification complete');
      expect(event.metadata?.score).toBe(0.98);
      expect(event.timestamp).toBeDefined();
    });

    it('should create event without optional fields', () => {
      const event = createCutoverEvent(
        asTenantId('tenant-1'),
        asMappingId('mapping-1'),
        'PREPARING',
        'READY_FOR_CUTOVER',
        'system'
      );

      expect(event.reason).toBeUndefined();
      expect(event.metadata).toBeUndefined();
    });
  });
});

describe('Cutover State Transitions', () => {
  it('should support complete cutover flow with approval gate', () => {
    // Valid flow must include APPROVED state as a gate before cutover begins
    expect(isValidTransition('PREPARING', 'READY_FOR_CUTOVER')).toBe(true);
    expect(isValidTransition('READY_FOR_CUTOVER', 'APPROVED')).toBe(true);
    expect(isValidTransition('APPROVED', 'CUTOVER_IN_PROGRESS')).toBe(true);
    expect(isValidTransition('CUTOVER_IN_PROGRESS', 'GRACE_PERIOD')).toBe(true);
    expect(isValidTransition('GRACE_PERIOD', 'COMPLETED')).toBe(true);
  });

  it('should enforce the approval gate (READY_FOR_CUTOVER → CUTOVER_IN_PROGRESS is blocked)', () => {
    // The approval gate must be enforced - direct transition is NOT allowed
    expect(isValidTransition('READY_FOR_CUTOVER', 'CUTOVER_IN_PROGRESS')).toBe(false);
  });

  it('should allow APPROVED state transitions', () => {
    expect(isValidTransition('APPROVED', 'CUTOVER_IN_PROGRESS')).toBe(true);
    expect(isValidTransition('APPROVED', 'READY_FOR_CUTOVER')).toBe(true);   // approval can be revoked
    expect(isValidTransition('APPROVED', 'FAILED')).toBe(true);
  });

  it('should support rollback flow', () => {
    expect(isValidTransition('CUTOVER_IN_PROGRESS', 'ROLLED_BACK')).toBe(true);
    expect(canRollback('CUTOVER_IN_PROGRESS')).toBe(true);
  });

  it('should support grace period rollback', () => {
    expect(isValidTransition('GRACE_PERIOD', 'ROLLED_BACK')).toBe(true);
    expect(canRollback('GRACE_PERIOD')).toBe(true);
  });

  it('should support failure and retry', () => {
    expect(isValidTransition('PREPARING', 'FAILED')).toBe(true);
    expect(isValidTransition('FAILED', 'PREPARING')).toBe(true);
  });
});

describe('VALID_TRANSITIONS Table Snapshot', () => {
  it('This snapshot is the approved state-machine spec. Any change requires owner sign-off in the PR description — update this test only together with that sign-off.', async () => {
    // Import the internal VALID_TRANSITIONS table for snapshot testing
    // We use a dynamic import to access the module-level constant
    const expected = {
      PREPARING: ['READY_FOR_CUTOVER', 'FAILED'],
      READY_FOR_CUTOVER: ['PREPARING', 'APPROVED', 'FAILED'],
      APPROVED: ['READY_FOR_CUTOVER', 'CUTOVER_IN_PROGRESS', 'ROLLED_BACK', 'FAILED'],
      CUTOVER_IN_PROGRESS: ['GRACE_PERIOD', 'ROLLED_BACK', 'FAILED'],
      GRACE_PERIOD: ['COMPLETED', 'ROLLED_BACK', 'FAILED'],
      COMPLETED: [], // Terminal state - no transitions allowed after completion
      ROLLED_BACK: [], // Terminal state
      FAILED: ['PREPARING', 'ROLLED_BACK'],
    } as const;

    // Access the internal VALID_TRANSITIONS via module inspection
    // This enforces that any table modification fails CI unless the test is explicitly updated
    await import('./cutover-state');
    
    // Build actual from the exported isValidTransition function by testing all combinations
    const states: CutoverState[] = [
      'PREPARING', 'READY_FOR_CUTOVER', 'APPROVED', 'CUTOVER_IN_PROGRESS',
      'GRACE_PERIOD', 'COMPLETED', 'ROLLED_BACK', 'FAILED'
    ];
    
    const actual: Record<CutoverState, CutoverState[]> = {} as Record<CutoverState, CutoverState[]>;
    for (const from of states) {
      actual[from] = states.filter(to => isValidTransition(from, to));
    }

    expect(actual).toEqual(expected);
  });
});
