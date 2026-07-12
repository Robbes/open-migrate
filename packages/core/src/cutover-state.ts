/**
 * Cutover State Machine
 * 
 * Manages the migration cutover process from initial preparation through completion.
 * Follows a strict state machine to ensure safe, non-destructive transitions.
 * 
 * States:
 * - PREPARING: Initial setup, verification pending
 * - READY_FOR_CUTOVER: All verifications passed, ready to begin
 * - CUTOVER_IN_PROGRESS: DNS changes being made, final sync running
 * - GRACE_PERIOD: Both systems active, monitoring for discrepancies
 * - COMPLETED: Migration complete, only target system active
 * - ROLLED_BACK: Migration rolled back to source system
 * - FAILED: Error occurred, requires manual intervention
 * 
 * All state transitions are logged and must be explicit.
 */

import type { TenantId, MappingId } from '@openmig/shared';

/** Cutover state values */
export type CutoverState = 
  | 'PREPARING'
  | 'READY_FOR_CUTOVER'
  | 'APPROVED'
  | 'CUTOVER_IN_PROGRESS'
  | 'GRACE_PERIOD'
  | 'COMPLETED'
  | 'ROLLED_BACK'
  | 'FAILED';

/** Cutover phase for better UX */
export type CutoverPhase = 
  | 'PREPARATION'
  | 'VERIFICATION'
  | 'CUTOVER'
  | 'GRACE'
  | 'COMPLETION'
  | 'ROLLBACK'
  | 'ERROR';

/** Cutover status record */
export interface CutoverStatus {
  tenantId: TenantId;
  mappingId: MappingId;
  state: CutoverState;
  phase: CutoverPhase;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  
  // Verification results
  verificationStatus: 'PENDING' | 'PASS' | 'WARN' | 'FAIL';
  verificationReport?: string;
  
  // Cutover details
  cutoverStartedAt?: string;
  cutoverCompletedAt?: string;
  gracePeriodStartedAt?: string;
  gracePeriodEndsAt?: string;
  
  // Statistics
  totalItemsMigrated: number;
  itemsVerified: number;
  discrepanciesFound: number;
  
  // Error handling
  errorMessage?: string;
  errorDetails?: string;
  
  // Rollback support
  rollbackAvailable: boolean;
  rollbackReason?: string;
  
  // Extended properties for CLI and runbook
  currentState?: CutoverState; // Alias for state, for CLI compatibility
  targetMailServer?: string;
  startedBy?: string;
  rolledBackAt?: string;
  failedAt?: string;
  failureReason?: string;
  gracePeriodCompletedAt?: string;
  metadata?: Record<string, unknown>;
  
  // Rollback-specific properties
  dnsRecordsUpdated?: boolean;
  dnsVerifiedAt?: string;
  dnsRestored?: boolean;
  rollbackNotes?: string;
  itemsAddedDuringCutover?: number;
}

/** Cutover configuration */
export interface CutoverConfig {
  tenantId: TenantId;
  mappingId: MappingId;
  
  // Grace period settings
  gracePeriodDurationHours: number; // Default: 72 hours (3 days)
  autoCompleteAfterGrace: boolean; // Default: true
  
  // Verification thresholds
  requiredVerificationScore: number; // Default: 0.95 (95%)
  maxDiscrepancyPercentage: number; // Default: 0.01 (1%)
  
  // Notifications
  notifyOnStateChange: boolean; // Default: true
  notifyOnDiscrepancy: boolean; // Default: true
  
  // Safety
  requireManualApproval: boolean; // Default: true
  dryRun: boolean; // Default: false
}

/** Cutover result */
export interface CutoverResult {
  success: boolean;
  state: CutoverState;
  message: string;
  details?: Record<string, unknown>;
}

/** Cutover event for logging/auditing */
export interface CutoverEvent {
  tenantId: TenantId;
  mappingId: MappingId;
  timestamp: string;
  fromState: CutoverState | null; // null for initialization events
  toState: CutoverState;
  triggeredBy: string; // 'system' or user ID
  reason?: string;
  metadata?: Record<string, unknown>;
  
  // Extended properties for CLI compatibility
  eventType?: 'CUTOVER_INITIALIZED' | 'STATE_TRANSITION'; // Type of event
  description?: string; // Human-readable description
}

/** Cutover manager interface */
export interface CutoverManager {
  // State management
  getState(tenantId: TenantId, mappingId: MappingId): Promise<CutoverStatus | undefined>;
  transitionTo(
    tenantId: TenantId,
    mappingId: MappingId,
    toState: CutoverState,
    reason: string
  ): Promise<CutoverResult>;
  
  // Cutover lifecycle
  startCutover(tenantId: TenantId, mappingId: MappingId): Promise<CutoverResult>;
  verifyCutover(tenantId: TenantId, mappingId: MappingId): Promise<CutoverResult>;
  approveCutover(tenantId: TenantId, mappingId: MappingId): Promise<CutoverResult>;
  executeCutover(tenantId: TenantId, mappingId: MappingId): Promise<CutoverResult>;
  startGracePeriod(tenantId: TenantId, mappingId: MappingId): Promise<CutoverResult>;
  completeCutover(tenantId: TenantId, mappingId: MappingId): Promise<CutoverResult>;
  rollbackCutover(tenantId: TenantId, mappingId: MappingId, reason: string): Promise<CutoverResult>;
  
  // Monitoring
  checkGracePeriodStatus(tenantId: TenantId, mappingId: MappingId): Promise<CutoverResult>;
  getDiscrepancies(tenantId: TenantId, mappingId: MappingId): Promise<Array<Record<string, unknown>>>;
  
  // Events
  getEventHistory(tenantId: TenantId, mappingId: MappingId): Promise<CutoverEvent[]>;
}

/** Valid state transitions */
const VALID_TRANSITIONS: Record<CutoverState, CutoverState[]> = {
  PREPARING: ['READY_FOR_CUTOVER', 'FAILED'],
  READY_FOR_CUTOVER: ['APPROVED', 'PREPARING', 'FAILED'],
  APPROVED: ['CUTOVER_IN_PROGRESS', 'READY_FOR_CUTOVER', 'FAILED', 'ROLLED_BACK'],
  CUTOVER_IN_PROGRESS: ['GRACE_PERIOD', 'COMPLETED', 'FAILED', 'ROLLED_BACK'],
  GRACE_PERIOD: ['COMPLETED', 'ROLLED_BACK', 'FAILED'],
  COMPLETED: ['ROLLED_BACK'], // Allow rollback even after completion
  ROLLED_BACK: [], // Terminal state
  FAILED: ['PREPARING', 'ROLLED_BACK'], // Can retry or rollback
};

/** State to phase mapping */
const STATE_TO_PHASE: Record<CutoverState, CutoverPhase> = {
  PREPARING: 'PREPARATION',
  READY_FOR_CUTOVER: 'VERIFICATION',
  APPROVED: 'VERIFICATION',
  CUTOVER_IN_PROGRESS: 'CUTOVER',
  GRACE_PERIOD: 'GRACE',
  COMPLETED: 'COMPLETION',
  ROLLED_BACK: 'ROLLBACK',
  FAILED: 'ERROR',
};

/**
 * Validate if a state transition is allowed
 */
export function isValidTransition(from: CutoverState, to: CutoverState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Get the phase for a given state
 */
export function getStatePhase(state: CutoverState): CutoverPhase {
  return STATE_TO_PHASE[state];
}

/**
 * Check if the cutover can be rolled back from current state
 */
export function canRollback(state: CutoverState): boolean {
  return state === 'CUTOVER_IN_PROGRESS' || state === 'GRACE_PERIOD';
}

/**
 * Check if the cutover is in a terminal state
 */
export function isTerminalState(state: CutoverState): boolean {
  return state === 'COMPLETED' || state === 'ROLLED_BACK' || state === 'FAILED';
}

/**
 * Create initial cutover status
 */
export function createInitialCutoverStatus(
  tenantId: TenantId,
  mappingId: MappingId,
  config: Partial<CutoverConfig> = {}
): CutoverStatus {
  const now = new Date().toISOString();
  return {
    tenantId,
    mappingId,
    state: 'PREPARING',
    currentState: 'PREPARING', // Alias for state
    phase: 'PREPARATION',
    startedAt: now,
    updatedAt: now,
    verificationStatus: 'PENDING',
    totalItemsMigrated: 0,
    itemsVerified: 0,
    discrepanciesFound: 0,
    rollbackAvailable: false,
    ...config,
  };
}

/**
 * Update cutover status with state transition
 */
export function updateCutoverStatus(
  status: CutoverStatus,
  newState: CutoverState,
  reason?: string
): CutoverStatus {
  if (!isValidTransition(status.state, newState)) {
    throw new Error(
      `Invalid state transition from ${status.state} to ${newState}`
    );
  }

  const baseUpdate: Partial<CutoverStatus> = {
    state: newState,
    currentState: newState, // Alias for state, for CLI compatibility
    phase: getStatePhase(newState),
    updatedAt: new Date().toISOString(),
    rollbackAvailable: canRollback(newState),
    ...(newState === 'COMPLETED' ? { completedAt: new Date().toISOString() } : {}),
    ...(reason ? { errorMessage: undefined, errorDetails: undefined } : {}),
  };

  // Handle FAILED state - preserve failure info
  if (newState === 'FAILED') {
    baseUpdate.failedAt = new Date().toISOString();
    baseUpdate.failureReason = reason;
  }

  // Handle ROLLED_BACK state - preserve rollback info
  if (newState === 'ROLLED_BACK') {
    baseUpdate.rolledBackAt = new Date().toISOString();
    baseUpdate.rollbackReason = reason;
  }

  return {
    ...status,
    ...baseUpdate,
  };
}

/**
 * Create a cutover event
 */
export function createCutoverEvent(
  tenantId: TenantId,
  mappingId: MappingId,
  fromState: CutoverState | null,
  toState: CutoverState,
  triggeredBy: string,
  reason?: string,
  metadata?: Record<string, unknown>,
  eventType?: 'CUTOVER_INITIALIZED' | 'STATE_TRANSITION',
  description?: string
): CutoverEvent {
  return {
    tenantId,
    mappingId,
    timestamp: new Date().toISOString(),
    fromState,
    toState,
    triggeredBy,
    reason,
    metadata,
    eventType: eventType ?? 'STATE_TRANSITION',
    description: description ?? (fromState ? `Transitioned from ${fromState} to ${toState}` : `Cutover initialized to ${toState}`),
  };
}
