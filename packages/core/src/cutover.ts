/**
 * Cutover Manager
 * 
 * Orchestrates the complete cutover lifecycle from preparation through completion.
 * Provides safe, auditable transitions between cutover states.
 */

import type { TenantId, MappingId } from '@openmig/shared';
import {
  type CutoverStatus,
  type CutoverConfig,
  type CutoverResult,
  type CutoverEvent,
  createInitialCutoverStatus,
  updateCutoverStatus,
  createCutoverEvent,
  isValidTransition,
  isTerminalState,
  canRollback,
} from './cutover-state';
import {
  type VerificationResult,
  type VerificationConfig as _VerificationConfig,
  runVerification as _runVerification,
} from './verification';

/** Cutover manager dependencies */
export interface CutoverManagerDeps {
  // State persistence
  getStatus(tenantId: TenantId, mappingId: MappingId): Promise<CutoverStatus | undefined>;
  setStatus(status: CutoverStatus): Promise<void>;
  
  // Event logging
  logEvent(event: CutoverEvent): Promise<void>;
  
  // Verification
  runVerification(_tenantId: TenantId, _mappingId: MappingId): Promise<VerificationResult>;
  
  // Final sync
  runFinalSync(tenantId: TenantId, mappingId: MappingId): Promise<{ itemsSynced: number }>;
  
  // DNS verification (mock for now)
  verifyDnsPropagation(): Promise<boolean>;
  
  // Grace period monitoring
  monitorGracePeriod(tenantId: TenantId, mappingId: MappingId): Promise<{ discrepancies: number }>;
}

/** Default cutover configuration (without tenantId/mappingId which are provided at runtime) */
const DEFAULT_CUTOVER_CONFIG: Omit<CutoverConfig, 'tenantId' | 'mappingId'> = {
  gracePeriodDurationHours: 72, // 3 days
  autoCompleteAfterGrace: true,
  requiredVerificationScore: 0.95,
  maxDiscrepancyPercentage: 0.01,
  notifyOnStateChange: true,
  notifyOnDiscrepancy: true,
  requireManualApproval: true,
  dryRun: false,
};

/** Cutover manager implementation */
export class CutoverManagerImpl {
  private readonly deps: CutoverManagerDeps;
  private readonly config: Omit<CutoverConfig, 'tenantId' | 'mappingId'>;

  constructor(deps: CutoverManagerDeps, config: Partial<Omit<CutoverConfig, 'tenantId' | 'mappingId'>> = {}) {
    this.deps = deps;
    this.config = { ...DEFAULT_CUTOVER_CONFIG, ...config };
  }

  /**
   * Get current cutover status
   */
  async getState(
    tenantId: TenantId,
    mappingId: MappingId
  ): Promise<CutoverStatus | undefined> {
    return this.deps.getStatus(tenantId, mappingId);
  }

  /**
   * Transition to a new state
   */
  async transitionTo(
    tenantId: TenantId,
    mappingId: MappingId,
    toState: CutoverStatus['state'],
    reason: string
  ): Promise<CutoverResult> {
    const current = await this.deps.getStatus(tenantId, mappingId);
    
    if (!current) {
      return {
        success: false,
        state: 'FAILED',
        message: 'No cutover status found',
        details: { tenantId, mappingId },
      };
    }

    if (isTerminalState(current.state)) {
      return {
        success: false,
        state: current.state,
        message: `Cannot transition from terminal state ${current.state}`,
      };
    }

    if (!isValidTransition(current.state, toState)) {
      return {
        success: false,
        state: current.state,
        message: `Invalid transition from ${current.state} to ${toState}`,
        details: { reason },
      };
    }

    try {
      const newState = updateCutoverStatus(current, toState, reason);
      await this.deps.setStatus(newState);
      
      await this.deps.logEvent(
        createCutoverEvent(
          tenantId,
          mappingId,
          current.state,
          toState,
          'system',
          reason
        )
      );

      return {
        success: true,
        state: toState,
        message: `Successfully transitioned to ${toState}`,
        details: { reason },
      };
    } catch (error) {
      return {
        success: false,
        state: 'FAILED',
        message: `Failed to transition: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Start the cutover process
   */
  async startCutover(
    tenantId: TenantId,
    mappingId: MappingId
  ): Promise<CutoverResult> {
    const current = await this.deps.getStatus(tenantId, mappingId);
    
    if (!current) {
      const initial = createInitialCutoverStatus(tenantId, mappingId, this.config);
      await this.deps.setStatus(initial);
      return {
        success: true,
        state: 'PREPARING',
        message: 'Cutover process initialized',
      };
    }

    if (current.state !== 'PREPARING' && current.state !== 'READY_FOR_CUTOVER') {
      return {
        success: false,
        state: current.state,
        message: `Cannot start cutover from state ${current.state}`,
      };
    }

    return this.transitionTo(tenantId, mappingId, 'READY_FOR_CUTOVER', 'Starting cutover preparation');
  }

  /**
   * Verify cutover readiness
   */
  async verifyCutover(
    tenantId: TenantId,
    mappingId: MappingId
  ): Promise<CutoverResult> {
    const current = await this.deps.getStatus(tenantId, mappingId);
    
    if (!current || current.state !== 'READY_FOR_CUTOVER') {
      return {
        success: false,
        state: current?.state ?? 'PREPARING',
        message: 'Cutover must be in READY_FOR_CUTOVER state to verify',
      };
    }

    try {
      const verification = await this.deps.runVerification(tenantId, mappingId);
      
      const updatedStatus: CutoverStatus = {
        ...current,
        verificationStatus: verification.overallStatus.toLowerCase() as CutoverStatus['verificationStatus'],
        verificationReport: JSON.stringify(verification, null, 2),
        updatedAt: new Date().toISOString(),
      };

      await this.deps.setStatus(updatedStatus);

      if (verification.overallStatus === 'FAIL') {
        return {
          success: false,
          state: 'READY_FOR_CUTOVER',
          message: 'Verification failed. Fix issues before proceeding.',
          details: {
            score: verification.score,
            discrepancies: verification.totalDiscrepancies,
          },
        };
      }

      return {
        success: true,
        state: 'READY_FOR_CUTOVER',
        message: `Verification ${verification.overallStatus.toLowerCase()}. Score: ${(verification.score * 100).toFixed(2)}%`,
        details: {
          score: verification.score,
          canProceed: verification.canProceedToCutover,
        },
      };
    } catch (error) {
      return {
        success: false,
        state: 'READY_FOR_CUTOVER',
        message: `Verification error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Approve cutover (manual approval step)
   */
  async approveCutover(
    tenantId: TenantId,
    mappingId: MappingId,
    approverId: string
  ): Promise<CutoverResult> {
    const current = await this.deps.getStatus(tenantId, mappingId);
    
    if (!current || current.state !== 'READY_FOR_CUTOVER') {
      return {
        success: false,
        state: current?.state ?? 'PREPARING',
        message: 'Cutover must be in READY_FOR_CUTOVER state for approval',
      };
    }

    if (current.verificationStatus === 'FAIL') {
      return {
        success: false,
        state: 'READY_FOR_CUTOVER',
        message: 'Cannot approve failed verification. Fix issues first.',
      };
    }

    return this.transitionTo(
      tenantId,
      mappingId,
      'CUTOVER_IN_PROGRESS',
      `Approved by ${approverId}`
    );
  }

  /**
   * Execute the actual cutover
   */
  async executeCutover(
    tenantId: TenantId,
    mappingId: MappingId
  ): Promise<CutoverResult> {
    const current = await this.deps.getStatus(tenantId, mappingId);
    
    if (!current || current.state !== 'CUTOVER_IN_PROGRESS') {
      return {
        success: false,
        state: current?.state ?? 'PREPARING',
        message: 'Cutover must be in CUTOVER_IN_PROGRESS state to execute',
      };
    }

    try {
      // Run final sync
      const syncResult = await this.deps.runFinalSync(tenantId, mappingId);
      
      // Update status
      const updatedStatus: CutoverStatus = {
        ...current,
        cutoverStartedAt: current.cutoverStartedAt ?? new Date().toISOString(),
        cutoverCompletedAt: new Date().toISOString(),
        totalItemsMigrated: syncResult.itemsSynced,
        updatedAt: new Date().toISOString(),
      };

      await this.deps.setStatus(updatedStatus);

      return {
        success: true,
        state: 'CUTOVER_IN_PROGRESS',
        message: `Cutover executed successfully. Synced ${syncResult.itemsSynced} items.`,
        details: { itemsSynced: syncResult.itemsSynced },
      };
    } catch (error) {
      return {
        success: false,
        state: 'FAILED',
        message: `Cutover execution failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Start grace period monitoring
   */
  async startGracePeriod(
    tenantId: TenantId,
    mappingId: MappingId
  ): Promise<CutoverResult> {
    const current = await this.deps.getStatus(tenantId, mappingId);
    
    if (!current || current.state !== 'CUTOVER_IN_PROGRESS') {
      return {
        success: false,
        state: current?.state ?? 'PREPARING',
        message: 'Cutover must be in CUTOVER_IN_PROGRESS state to start grace period',
      };
    }

    try {
      // Verify DNS propagation
      const dnsReady = await this.deps.verifyDnsPropagation();
      
      if (!dnsReady) {
        return {
          success: false,
          state: 'CUTOVER_IN_PROGRESS',
          message: 'DNS propagation not complete. Wait before starting grace period.',
        };
      }

      const gracePeriodEndsAt = new Date(
        Date.now() + this.config.gracePeriodDurationHours * 60 * 60 * 1000
      ).toISOString();

      const updatedStatus: CutoverStatus = {
        ...current,
        state: 'GRACE_PERIOD',
        phase: 'GRACE',
        gracePeriodStartedAt: new Date().toISOString(),
        gracePeriodEndsAt,
        rollbackAvailable: true,
        updatedAt: new Date().toISOString(),
      };

      await this.deps.setStatus(updatedStatus);
      
      await this.deps.logEvent(
        createCutoverEvent(
          tenantId,
          mappingId,
          'CUTOVER_IN_PROGRESS',
          'GRACE_PERIOD',
          'system',
          `Grace period started (duration: ${this.config.gracePeriodDurationHours}h)`
        )
      );

      return {
        success: true,
        state: 'GRACE_PERIOD',
        message: `Grace period started. Ends at ${gracePeriodEndsAt}`,
        details: { gracePeriodEndsAt },
      };
    } catch (error) {
      return {
        success: false,
        state: 'CUTOVER_IN_PROGRESS',
        message: `Failed to start grace period: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Complete the cutover
   */
  async completeCutover(
    tenantId: TenantId,
    mappingId: MappingId
  ): Promise<CutoverResult> {
    const current = await this.deps.getStatus(tenantId, mappingId);
    
    if (!current || current.state !== 'GRACE_PERIOD') {
      return {
        success: false,
        state: current?.state ?? 'PREPARING',
        message: 'Cutover must be in GRACE_PERIOD state to complete',
      };
    }

    // Check for discrepancies
    const monitoring = await this.deps.monitorGracePeriod(tenantId, mappingId);
    
    if (monitoring.discrepancies > 10) {
      return {
        success: false,
        state: 'GRACE_PERIOD',
        message: `Too many discrepancies (${monitoring.discrepancies}). Investigate before completing.`,
      };
    }

    const updatedStatus: CutoverStatus = {
      ...current,
      state: 'COMPLETED',
      phase: 'COMPLETION',
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rollbackAvailable: false,
      discrepanciesFound: monitoring.discrepancies,
    };

    await this.deps.setStatus(updatedStatus);
    
    await this.deps.logEvent(
      createCutoverEvent(
        tenantId,
        mappingId,
        'GRACE_PERIOD',
        'COMPLETED',
        'system',
        'Grace period completed successfully'
      )
    );

    return {
      success: true,
      state: 'COMPLETED',
      message: 'Cutover completed successfully',
      details: { discrepancies: monitoring.discrepancies },
    };
  }

  /**
   * Rollback the cutover
   */
  async rollbackCutover(
    tenantId: TenantId,
    mappingId: MappingId,
    reason: string
  ): Promise<CutoverResult> {
    const current = await this.deps.getStatus(tenantId, mappingId);
    
    if (!current) {
      return {
        success: false,
        state: 'FAILED',
        message: 'No cutover status found',
      };
    }

    if (!canRollback(current.state)) {
      return {
        success: false,
        state: current.state,
        message: `Cannot rollback from state ${current.state}`,
      };
    }

    try {
      const updatedStatus: CutoverStatus = {
        ...current,
        state: 'ROLLED_BACK',
        phase: 'ROLLBACK',
        rollbackAvailable: false,
        rollbackReason: reason,
        updatedAt: new Date().toISOString(),
      };

      await this.deps.setStatus(updatedStatus);
      
      await this.deps.logEvent(
        createCutoverEvent(
          tenantId,
          mappingId,
          current.state,
          'ROLLED_BACK',
          'system',
          reason
        )
      );

      return {
        success: true,
        state: 'ROLLED_BACK',
        message: `Cutover rolled back: ${reason}`,
        details: { reason },
      };
    } catch (error) {
      return {
        success: false,
        state: current.state,
        message: `Rollback failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Check grace period status
   */
  async checkGracePeriodStatus(
    tenantId: TenantId,
    mappingId: MappingId
  ): Promise<CutoverResult> {
    const current = await this.deps.getStatus(tenantId, mappingId);
    
    if (!current || current.state !== 'GRACE_PERIOD') {
      return {
        success: false,
        state: current?.state ?? 'PREPARING',
        message: 'Not in grace period',
      };
    }

    const monitoring = await this.deps.monitorGracePeriod(tenantId, mappingId);
    
    return {
      success: true,
      state: 'GRACE_PERIOD',
      message: `Grace period active. Discrepancies: ${monitoring.discrepancies}`,
      details: { discrepancies: monitoring.discrepancies },
    };
  }

  /**
   * Get discrepancies
   */
  async getDiscrepancies(
    _tenantId: TenantId,
    _mappingId: MappingId
  ): Promise<Array<Record<string, unknown>>> {
    // This would query the actual discrepancy data
    // For now, return empty array
    return [];
  }

  /**
   * Get event history
   */
  async getEventHistory(
    _tenantId: TenantId,
    _mappingId: MappingId
  ): Promise<CutoverEvent[]> {
    // This would query the event log
    // For now, return empty array
    return [];
  }
}
