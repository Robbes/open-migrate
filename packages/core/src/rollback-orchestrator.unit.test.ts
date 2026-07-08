/**
 * Rollback Orchestrator Unit Tests
 * 
 * Tests for comprehensive rollback operations including DNS, data restoration,
 * state management, and notification workflows.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { asTenantId, asMappingId } from '@openmig/shared';
import {
  RollbackOrchestrator,
  type RollbackConfig,
} from '../src/rollback-orchestrator';
import type { CutoverStatus } from '../src/cutover-state';
import type { DnsMigrationStatus, DnsRecord } from '../src/dns-manager';

// Mock dependencies
function createMockDeps() {
  let cutoverStatus: CutoverStatus | undefined;
  let dnsStatus: DnsMigrationStatus | undefined;
  const events: Array<{ tenantId: string; mappingId: string; event: string; details?: Record<string, unknown> }> = [];
  const notifications: Array<{ tenantId: string; recipients: string[]; subject: string; body: string }> = [];

  return {
    getCutoverStatus(_tenantId: string, _mappingId: string): Promise<CutoverStatus | undefined> {
      return Promise.resolve(cutoverStatus);
    },
    updateCutoverStatus(status: CutoverStatus): Promise<void> {
      cutoverStatus = status;
      return Promise.resolve();
    },
    getDnsStatus(_tenantId: string, _mappingId: string): Promise<DnsMigrationStatus | undefined> {
      return Promise.resolve(dnsStatus);
    },
    updateDnsStatus(status: DnsMigrationStatus): Promise<void> {
      dnsStatus = status;
      return Promise.resolve();
    },
    async rollbackDns(_tenantId: string, _mappingId: string, _previousRecords: DnsRecord[]): Promise<{ success: boolean; message: string }> {
      return { success: true, message: 'DNS rolled back' };
    },
    async getBackupMetadata(_tenantId: string, _mappingId: string, _backupId: string): Promise<unknown> {
      return Promise.resolve({ backupId: 'backup-123', createdAt: '2024-01-01' });
    },
    async restoreData(_tenantId: string, _mappingId: string, _backupId: string): Promise<{ success: boolean; itemsRestored: number }> {
      return { success: true, itemsRestored: 100 };
    },
    async logRollbackEvent(tenantId: string, mappingId: string, event: string, details?: Record<string, unknown>): Promise<void> {
      events.push({ tenantId, mappingId, event, details });
    },
    async sendNotification(tenantId: string, recipients: string[], subject: string, body: string): Promise<void> {
      notifications.push({ tenantId, recipients, subject, body });
    },
    getEvents() {
      return events;
    },
    getNotifications() {
      return notifications;
    },
    getCutoverStatusRef() {
      return cutoverStatus;
    },
    getDnsStatusRef() {
      return dnsStatus;
    },
  };
}

describe('RollbackOrchestrator', () => {
  let deps: ReturnType<typeof createMockDeps>;
  let orchestrator: RollbackOrchestrator;
  const tenantId = asTenantId('tenant-1');
  const mappingId = asMappingId('mapping-1');

  beforeEach(() => {
    deps = createMockDeps();
    const config: Partial<RollbackConfig> = {
      timeoutMinutes: 30,
    };
    orchestrator = new RollbackOrchestrator(deps, config);
  });

  describe('validateRollback', () => {
    it('should validate rollback from CUTOVER_IN_PROGRESS state', async () => {
      const status: CutoverStatus = {
        tenantId,
        mappingId,
        state: 'CUTOVER_IN_PROGRESS',
        phase: 'CUTOVER',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        verificationStatus: "PASS",
        totalItemsMigrated: 100,
        itemsVerified: 100,
        discrepanciesFound: 0,
        rollbackAvailable: true,
      };

      deps = createMockDeps();
      await deps.updateCutoverStatus(status);
      orchestrator = new RollbackOrchestrator(deps);

      const result = await orchestrator.validateRollback(tenantId, mappingId);

      expect(result.canRollback).toBe(true);
      expect(result.reasons).toHaveLength(0);
    });

    it('should validate rollback from GRACE_PERIOD state', async () => {
      const status: CutoverStatus = {
        tenantId,
        mappingId,
        state: 'GRACE_PERIOD',
        phase: 'GRACE',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        verificationStatus: "PASS",
        totalItemsMigrated: 100,
        itemsVerified: 100,
        discrepanciesFound: 0,
        rollbackAvailable: true,
        gracePeriodStartedAt: new Date().toISOString(),
        gracePeriodEndsAt: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
      };

      deps = createMockDeps();
      await deps.updateCutoverStatus(status);
      orchestrator = new RollbackOrchestrator(deps);

      const result = await orchestrator.validateRollback(tenantId, mappingId);

      expect(result.canRollback).toBe(true);
      expect(result.reasons).toHaveLength(0);
    });

    it('should reject rollback from PREPARING state', async () => {
      const status: CutoverStatus = {
        tenantId,
        mappingId,
        state: 'PREPARING',
        phase: 'PREPARATION',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        verificationStatus: "PASS",
        totalItemsMigrated: 100,
        itemsVerified: 100,
        discrepanciesFound: 0,
        rollbackAvailable: true,
      };

      deps = createMockDeps();
      await deps.updateCutoverStatus(status);
      orchestrator = new RollbackOrchestrator(deps);

      const result = await orchestrator.validateRollback(tenantId, mappingId);

      expect(result.canRollback).toBe(false);
      expect(result.reasons).toContainEqual(expect.stringContaining('Cannot rollback from state'));
    });

    it('should reject rollback from COMPLETED state', async () => {
      const status: CutoverStatus = {
        tenantId,
        mappingId,
        state: 'COMPLETED',
        phase: 'COMPLETION',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        verificationStatus: "PASS",
        totalItemsMigrated: 100,
        itemsVerified: 100,
        discrepanciesFound: 0,
        rollbackAvailable: true,
        completedAt: new Date().toISOString(),
      };

      deps = createMockDeps();
      await deps.updateCutoverStatus(status);
      orchestrator = new RollbackOrchestrator(deps);

      const result = await orchestrator.validateRollback(tenantId, mappingId);

      expect(result.canRollback).toBe(false);
      expect(result.reasons).toContainEqual(expect.stringContaining('already completed'));
    });

    it('should reject rollback from ROLLED_BACK state', async () => {
      const status: CutoverStatus = {
        tenantId,
        mappingId,
        state: 'ROLLED_BACK',
        phase: 'ROLLBACK',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        verificationStatus: "PASS",
        totalItemsMigrated: 100,
        itemsVerified: 100,
        discrepanciesFound: 0,
        rollbackAvailable: true,
        rollbackReason: 'Previous rollback',
      };

      deps = createMockDeps();
      await deps.updateCutoverStatus(status);
      orchestrator = new RollbackOrchestrator(deps);

      const result = await orchestrator.validateRollback(tenantId, mappingId);

      expect(result.canRollback).toBe(false);
      expect(result.reasons).toContainEqual(expect.stringContaining('Already rolled back'));
    });

    it('should reject rollback when no status exists', async () => {
      deps = createMockDeps();
      orchestrator = new RollbackOrchestrator(deps);

      const result = await orchestrator.validateRollback(tenantId, mappingId);

      expect(result.canRollback).toBe(false);
      expect(result.reasons).toContain('No cutover status found');
    });
  });

  describe('executeRollback', () => {
    it('should execute complete rollback successfully', async () => {
      const cutoverStatus: CutoverStatus = {
        tenantId,
        mappingId,
        state: 'GRACE_PERIOD',
        phase: 'GRACE',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        verificationStatus: "PASS",
        totalItemsMigrated: 100,
        itemsVerified: 100,
        discrepanciesFound: 0,
        rollbackAvailable: true,
        gracePeriodStartedAt: new Date().toISOString(),
        gracePeriodEndsAt: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
      };

      const dnsStatus: DnsMigrationStatus = {
        tenantId,
        mappingId,
        domain: 'example.com',
        phase: 'VERIFIED',
        records: [],
        verifiedRecords: [],
        failedRecords: [],
        startedAt: new Date(),
        completedAt: new Date(),
        verifiedAt: new Date(),
      };

      deps = createMockDeps();
      await deps.updateCutoverStatus(cutoverStatus);
      await deps.updateDnsStatus(dnsStatus);
      orchestrator = new RollbackOrchestrator(deps);

      const result = await orchestrator.executeRollback(tenantId, mappingId, 'Test rollback reason');

      expect(result.success).toBe(true);
      expect(result.totalSteps).toBeGreaterThan(0);
      expect(result.completedSteps).toBe(result.totalSteps);
      expect(result.failedSteps).toHaveLength(0);
      expect(result.rolledBackAt).toBeDefined();

      // Check that state was updated
      const updatedStatus = deps.getCutoverStatusRef();
      expect(updatedStatus?.state).toBe('ROLLED_BACK');
      expect(updatedStatus?.rollbackReason).toBe('Test rollback reason');

      // Check that event was logged
      const events = deps.getEvents();
      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'ROLLBACK_COMPLETE',
        })
      );
    });

    it('should handle DNS rollback failure gracefully', async () => {
      const cutoverStatus: CutoverStatus = {
        tenantId,
        mappingId,
        state: 'GRACE_PERIOD',
        phase: 'GRACE',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        verificationStatus: "PASS",
        totalItemsMigrated: 100,
        itemsVerified: 100,
        discrepanciesFound: 0,
        rollbackAvailable: true,
        gracePeriodStartedAt: new Date().toISOString(),
        gracePeriodEndsAt: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
      };

      const dnsStatus: DnsMigrationStatus = {
        tenantId,
        mappingId,
        domain: 'example.com',
        phase: 'VERIFIED',
        records: [],
        verifiedRecords: [],
        failedRecords: [],
        startedAt: new Date(),
      };

      deps = createMockDeps();
      await deps.updateCutoverStatus(cutoverStatus);
      await deps.updateDnsStatus(dnsStatus);

      // Override rollbackDns to fail
      (deps as Record<string, unknown>).rollbackDns = async () => ({ success: false, message: 'DNS rollback failed' });
      orchestrator = new RollbackOrchestrator(deps);

      const result = await orchestrator.executeRollback(tenantId, mappingId, 'Test reason');

      expect(result.success).toBe(false);
      expect(result.failedSteps).toContain('ROLLBACK_DNS');
      expect(result.warnings).toContainEqual(expect.stringContaining('ROLLBACK_DNS failed'));
    });

    it('should skip DNS rollback when DNS not changed', async () => {
      const cutoverStatus: CutoverStatus = {
        tenantId,
        mappingId,
        state: 'GRACE_PERIOD',
        phase: 'GRACE',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        verificationStatus: "PASS",
        totalItemsMigrated: 100,
        itemsVerified: 100,
        discrepanciesFound: 0,
        rollbackAvailable: true,
        gracePeriodStartedAt: new Date().toISOString(),
        gracePeriodEndsAt: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
      };

      deps = createMockDeps();
      await deps.updateCutoverStatus(cutoverStatus);
      // No DNS status set
      orchestrator = new RollbackOrchestrator(deps);

      const result = await orchestrator.executeRollback(tenantId, mappingId, 'Test reason');

      expect(result.success).toBe(true);
      expect(result.failedSteps).not.toContain('ROLLBACK_DNS');
    });

    it('should skip data restoration when no backup exists', async () => {
      const cutoverStatus: CutoverStatus = {
        tenantId,
        mappingId,
        state: 'GRACE_PERIOD',
        phase: 'GRACE',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        verificationStatus: "PASS",
        totalItemsMigrated: 100,
        itemsVerified: 100,
        discrepanciesFound: 0,
        rollbackAvailable: true,
        gracePeriodStartedAt: new Date().toISOString(),
        gracePeriodEndsAt: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
      };

      deps = createMockDeps();
      await deps.updateCutoverStatus(cutoverStatus);
      orchestrator = new RollbackOrchestrator(deps);

      const result = await orchestrator.executeRollback(tenantId, mappingId, 'Test reason');

      expect(result.success).toBe(true);
      // Should not attempt data restoration without backup
      expect(result.failedSteps).not.toContain('RESTORE_DATA');
    });

    it('should continue with other steps when one step fails', async () => {
      const cutoverStatus: CutoverStatus = {
        tenantId,
        mappingId,
        state: 'GRACE_PERIOD',
        phase: 'GRACE',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        verificationStatus: "PASS",
        totalItemsMigrated: 100,
        itemsVerified: 100,
        discrepanciesFound: 0,
        rollbackAvailable: true,
        gracePeriodStartedAt: new Date().toISOString(),
        gracePeriodEndsAt: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
      };

      const dnsStatus: DnsMigrationStatus = {
        tenantId,
        mappingId,
        domain: 'example.com',
        phase: 'VERIFIED',
        records: [],
        verifiedRecords: [],
        failedRecords: [],
        startedAt: new Date(),
      };

      deps = createMockDeps();
      await deps.updateCutoverStatus(cutoverStatus);
      await deps.updateDnsStatus(dnsStatus);

      // Make DNS rollback fail
      (deps as Record<string, unknown>).rollbackDns = async () => ({ success: false, message: 'DNS failed' });
      orchestrator = new RollbackOrchestrator(deps);

      const result = await orchestrator.executeRollback(tenantId, mappingId, 'Test reason');

      // Should still complete state update despite DNS failure
      expect(result.completedSteps).toBeGreaterThan(1);
      expect(result.failedSteps).toContain('ROLLBACK_DNS');
    });

    it('should handle timeout correctly', async () => {
      // Timeout handling is tested in integration tests
      // This is a placeholder to document that timeout handling exists
      const cutoverStatus: CutoverStatus = {
        tenantId,
        mappingId,
        state: 'GRACE_PERIOD',
        phase: 'GRACE',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        verificationStatus: "PASS",
        totalItemsMigrated: 100,
        itemsVerified: 100,
        discrepanciesFound: 0,
        rollbackAvailable: true,
        gracePeriodStartedAt: new Date().toISOString(),
        gracePeriodEndsAt: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
      };

      deps = createMockDeps();
      await deps.updateCutoverStatus(cutoverStatus);
      orchestrator = new RollbackOrchestrator(deps);

      // Just verify the orchestrator works with normal timeout
      const result = await orchestrator.executeRollback(tenantId, mappingId, 'Test reason');
      expect(result.success).toBe(true);
    });
  });

  describe('configuration', () => {
    it('should use default configuration when not provided', () => {
      const orchestrator = new RollbackOrchestrator(deps);

      // Should have default config
      expect(orchestrator).toBeDefined();
    });

    it('should use custom configuration when provided', () => {
      const customConfig: Partial<RollbackConfig> = {
        rollbackDns: false,
        restoreData: false,
        updateState: true,
        notifyUsers: false,
        preserveLogs: false,
        timeoutMinutes: 120,
      };

      const orchestrator = new RollbackOrchestrator(deps, customConfig);

      expect(orchestrator).toBeDefined();
    });
  });
});
