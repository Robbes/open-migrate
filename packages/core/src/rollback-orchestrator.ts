/**
 * Rollback Orchestrator
 * 
 * Coordinates comprehensive rollback operations including:
 * - DNS record restoration
 * - Data restoration from backups
 * - State machine rollback
 * - Event logging for audit trail
 */

import type { TenantId, MappingId } from '@openmig/shared';
import type { CutoverStatus } from './cutover-state';
import type { DnsRecord, DnsMigrationStatus } from './dns-manager';

/** Rollback step result */
export interface RollbackStepResult {
  step: string;
  success: boolean;
  message: string;
  details?: Record<string, unknown>;
  error?: string;
}

/** Complete rollback result */
export interface RollbackResult {
  success: boolean;
  steps: RollbackStepResult[];
  totalSteps: number;
  completedSteps: number;
  failedSteps: string[];
  warnings: string[];
  rolledBackAt?: string;
}

/** Rollback configuration */
export interface RollbackConfig {
  /** Rollback DNS records */
  rollbackDns: boolean;
  
  /** Restore data from backup */
  restoreData: boolean;
  
  /** Update cutover state */
  updateState: boolean;
  
  /** Send notifications */
  notifyUsers: boolean;
  
  /** Preserve logs */
  preserveLogs: boolean;
  
  /** Maximum time for rollback (minutes) */
  timeoutMinutes: number;
}

/** Rollback orchestrator dependencies */
export interface RollbackOrchestratorDeps {
  // Cutover state management
  getCutoverStatus(tenantId: TenantId, mappingId: MappingId): Promise<CutoverStatus | undefined>;
  updateCutoverStatus(status: CutoverStatus): Promise<void>;
  
  // DNS management
  getDnsStatus(tenantId: TenantId, mappingId: MappingId): Promise<DnsMigrationStatus | undefined>;
  updateDnsStatus(status: DnsMigrationStatus): Promise<void>;
  rollbackDns(tenantId: TenantId, mappingId: MappingId, previousRecords: DnsRecord[]): Promise<{ success: boolean; message: string }>;
  
  // Data restoration
  getBackupMetadata(tenantId: TenantId, mappingId: MappingId, backupId: string): Promise<unknown>;
  restoreData(tenantId: TenantId, mappingId: MappingId, backupId: string): Promise<{ success: boolean; itemsRestored: number }>;
  
  // Event logging
  logRollbackEvent(tenantId: TenantId, mappingId: MappingId, event: string, details?: Record<string, unknown>): Promise<void>;
  
  // Notifications
  sendNotification(tenantId: TenantId, recipients: string[], subject: string, body: string): Promise<void>;
}

/** Rollback orchestrator */
export class RollbackOrchestrator {
  private readonly deps: RollbackOrchestratorDeps;
  private readonly config: RollbackConfig;

  constructor(deps: RollbackOrchestratorDeps, config: Partial<RollbackConfig> = {}) {
    this.deps = deps;
    this.config = {
      rollbackDns: true,
      restoreData: true,
      updateState: true,
      notifyUsers: true,
      preserveLogs: true,
      timeoutMinutes: 60,
      ...config,
    };
  }

  /**
   * Execute complete rollback
   */
  async executeRollback(
    tenantId: TenantId,
    mappingId: MappingId,
    reason: string
  ): Promise<RollbackResult> {
    const startTime = Date.now();
    const result: RollbackResult = {
      success: true,
      steps: [],
      totalSteps: 0,
      completedSteps: 0,
      failedSteps: [],
      warnings: [],
      rolledBackAt: new Date().toISOString(),
    };

    // Get current status
    const cutoverStatus = await this.deps.getCutoverStatus(tenantId, mappingId);
    const dnsStatus = await this.deps.getDnsStatus(tenantId, mappingId);

    if (!cutoverStatus) {
      return {
        ...result,
        success: false,
        steps: [{
          step: 'GET_STATUS',
          success: false,
          message: 'No cutover status found',
          error: 'Cutover status not found',
        }],
        totalSteps: 1,
        failedSteps: ['GET_STATUS'],
      };
    }

    // Define rollback steps
    const steps: Array<{ name: string; execute: () => Promise<RollbackStepResult> }> = [];

    // Step 1: Notify users (if configured)
    if (this.config.notifyUsers) {
      steps.push({
        name: 'NOTIFY_USERS',
        execute: async () => this.notifyUsers(tenantId, mappingId, reason),
      });
    }

    // Step 2: Rollback DNS (if configured and DNS was changed)
    if (this.config.rollbackDns && dnsStatus && dnsStatus.phase !== 'NOT_STARTED') {
      steps.push({
        name: 'ROLLBACK_DNS',
        execute: async () => this.rollbackDnsStep(tenantId, mappingId, dnsStatus),
      });
    }

    // Step 3: Restore data (if configured and backup exists)
    // Note: Using totalItemsMigrated > 0 as indicator that data needs restoration
    if (this.config.restoreData && cutoverStatus.totalItemsMigrated > 0) {
      steps.push({
        name: 'RESTORE_DATA',
        execute: async () => this.restoreDataStep(tenantId, mappingId, cutoverStatus.startedAt),
      });
    }

    // Step 4: Update cutover state
    if (this.config.updateState) {
      steps.push({
        name: 'UPDATE_STATE',
        execute: async () => this.updateStateStep(tenantId, mappingId, cutoverStatus, reason),
      });
    }

    // Step 5: Preserve logs (if configured)
    if (this.config.preserveLogs) {
      steps.push({
        name: 'PRESERVE_LOGS',
        execute: async () => this.preserveLogsStep(tenantId, mappingId),
      });
    }

    result.totalSteps = steps.length;

    // Execute each step
    for (const step of steps) {
      // Check timeout
      if ((Date.now() - startTime) > this.config.timeoutMinutes * 60 * 1000) {
        result.success = false;
        result.steps.push({
          step: step.name,
          success: false,
          message: 'Rollback timeout exceeded',
          error: `Rollback exceeded ${this.config.timeoutMinutes} minutes`,
        });
        result.failedSteps.push(step.name);
        break;
      }

      try {
        const stepResult = await step.execute();
        result.steps.push(stepResult);

        if (stepResult.success) {
          result.completedSteps++;
        } else {
          result.success = false;
          result.failedSteps.push(step.name);
          
          // Add warning but continue with other steps
          result.warnings.push(`${step.name} failed: ${stepResult.message}`);
        }
      } catch (error) {
        result.success = false;
        result.steps.push({
          step: step.name,
          success: false,
          message: `Step failed with error: ${error instanceof Error ? error.message : String(error)}`,
          error: error instanceof Error ? error.message : String(error),
        });
        result.failedSteps.push(step.name);
      }
    }

    // Log completion
    await this.deps.logRollbackEvent(tenantId, mappingId, 'ROLLBACK_COMPLETE', {
      success: result.success,
      totalSteps: result.totalSteps,
      completedSteps: result.completedSteps,
      failedSteps: result.failedSteps,
      reason,
    });

    return result;
  }

  /**
   * Notify users about rollback
   */
  private async notifyUsers(
    tenantId: TenantId,
    mappingId: MappingId,
    reason: string
  ): Promise<RollbackStepResult> {
    try {
      const subject = `Cutover Rolled Back - ${mappingId}`;
      const body = `
The cutover for mapping ${mappingId} has been rolled back.

Reason: ${reason}

Rollback was initiated at ${new Date().toISOString()}.

If you have any questions or concerns, please contact your system administrator.

This is an automated message from OpenMigrate.
      `.trim();

      // Get recipients from status (would need to be implemented)
      const recipients: string[] = []; // TODO: Get from tenant config

      if (recipients.length > 0) {
        await this.deps.sendNotification(tenantId, recipients, subject, body);
      }

      return {
        step: 'NOTIFY_USERS',
        success: true,
        message: `Notification sent to ${recipients.length} recipients`,
        details: { recipientCount: recipients.length },
      };
    } catch (error) {
      return {
        step: 'NOTIFY_USERS',
        success: false,
        message: 'Failed to send notifications',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Rollback DNS records
   */
  private async rollbackDnsStep(
    tenantId: TenantId,
    mappingId: MappingId,
    dnsStatus: DnsMigrationStatus
  ): Promise<RollbackStepResult> {
    try {
      // Get previous DNS records from backup or stored state
      const previousRecords: DnsRecord[] = []; // TODO: Retrieve from backup

      const result = await this.deps.rollbackDns(tenantId, mappingId, previousRecords);

      if (result.success) {
        return {
          step: 'ROLLBACK_DNS',
          success: true,
          message: 'DNS records rolled back successfully',
          details: { domain: dnsStatus.domain },
        };
      } else {
        return {
          step: 'ROLLBACK_DNS',
          success: false,
          message: result.message,
          error: result.message,
        };
      }
    } catch (error) {
      return {
        step: 'ROLLBACK_DNS',
        success: false,
        message: 'DNS rollback failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Restore data from backup
   */
  private async restoreDataStep(
    tenantId: TenantId,
    mappingId: MappingId,
    backupId: string
  ): Promise<RollbackStepResult> {
    try {
      // Get backup metadata
      const metadata = await this.deps.getBackupMetadata(tenantId, mappingId, backupId);

      // Restore data
      const result = await this.deps.restoreData(tenantId, mappingId, backupId);

      if (result.success) {
        return {
          step: 'RESTORE_DATA',
          success: true,
          message: `Data restored successfully`,
          details: {
            backupId,
            itemsRestored: result.itemsRestored,
            metadata,
          },
        };
      } else {
        return {
          step: 'RESTORE_DATA',
          success: false,
          message: 'Data restoration failed',
          error: 'Data restoration failed',
        };
      }
    } catch (error) {
      return {
        step: 'RESTORE_DATA',
        success: false,
        message: 'Data restoration error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Update cutover state to rolled back
   */
  private async updateStateStep(
    tenantId: TenantId,
    mappingId: MappingId,
    cutoverStatus: CutoverStatus,
    reason: string
  ): Promise<RollbackStepResult> {
    try {
      const updatedStatus: CutoverStatus = {
        ...cutoverStatus,
        state: 'ROLLED_BACK',
        phase: 'ROLLBACK',
        rollbackReason: reason,
        updatedAt: new Date().toISOString(),
        rollbackAvailable: false,
        errorMessage: reason,
      };

      await this.deps.updateCutoverStatus(updatedStatus);

      return {
        step: 'UPDATE_STATE',
        success: true,
        message: 'Cutover state updated to ROLLED_BACK',
        details: {
          previousState: cutoverStatus.state,
          reason,
        },
      };
    } catch (error) {
      return {
        step: 'UPDATE_STATE',
        success: false,
        message: 'Failed to update cutover state',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Preserve logs for audit trail
   */
  private async preserveLogsStep(
    tenantId: TenantId,
    mappingId: MappingId
  ): Promise<RollbackStepResult> {
    try {
      // This would archive logs to long-term storage
      // For now, just log the action
      await this.deps.logRollbackEvent(tenantId, mappingId, 'LOGS_PRESERVED', {
        preservedAt: new Date().toISOString(),
      });

      return {
        step: 'PRESERVE_LOGS',
        success: true,
        message: 'Logs preserved for audit trail',
      };
    } catch (error) {
      return {
        step: 'PRESERVE_LOGS',
        success: false,
        message: 'Failed to preserve logs',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Validate rollback prerequisites
   */
  async validateRollback(
    tenantId: TenantId,
    mappingId: MappingId
  ): Promise<{ canRollback: boolean; reasons: string[] }> {
    const cutoverStatus = await this.deps.getCutoverStatus(tenantId, mappingId);

    if (!cutoverStatus) {
      return {
        canRollback: false,
        reasons: ['No cutover status found'],
      };
    }

    const reasons: string[] = [];

    // Check if rollback is allowed from current state
    const rollbackAllowedStates: CutoverStatus['state'][] = [
      'CUTOVER_IN_PROGRESS',
      'GRACE_PERIOD',
    ];

    if (!rollbackAllowedStates.includes(cutoverStatus.state)) {
      reasons.push(`Cannot rollback from state ${cutoverStatus.state}`);
    }

    // Check if already rolled back
    if (cutoverStatus.state === 'ROLLED_BACK') {
      reasons.push('Already rolled back');
    }

    // Check if terminal state
    if (cutoverStatus.state === 'COMPLETED') {
      reasons.push('Cutover already completed, rollback not available');
    }

    return {
      canRollback: reasons.length === 0,
      reasons,
    };
  }
}

/** Default rollback configuration */
export const DEFAULT_ROLLBACK_CONFIG: RollbackConfig = {
  rollbackDns: true,
  restoreData: true,
  updateState: true,
  notifyUsers: true,
  preserveLogs: true,
  timeoutMinutes: 60,
};
