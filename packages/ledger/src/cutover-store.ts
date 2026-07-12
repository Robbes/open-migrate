/**
 * Cutover State Store
 * 
 * Provides persistent storage and retrieval of cutover state machine data.
 * Rehydrates state from the database and logs all state transitions as events.
 * 
 * See docs/architecture/solution-architecture.md §11 (shadow & cutover)
 */

import type { TenantId, MappingId } from '@openmig/shared';
import { eq, and, asc } from 'drizzle-orm';
import * as schema from './schema-pg';

// Generic database type that works with both pg and postgres-js drivers
// We use unknown and cast at call sites to avoid version mismatch issues
export type AnyPgDatabase = unknown;
import type {
  CutoverState,
  CutoverPhase,
  CutoverStatus,
  CutoverEvent,
} from '@openmig/core/cutover-state';

/**
 * Port interface for cutover state persistence.
 * This is the contract that the core cutover orchestrators depend on.
 */
export interface CutoverStateStore {
  initializeCutover(params: {
    tenantId: TenantId;
    mappingId: MappingId;
    targetMailServer?: string;
    startedBy?: string;
  }): Promise<CutoverStatus>;

  saveCutoverState(status: CutoverStatus): Promise<void>;

  loadCutoverState(
    tenantId: TenantId,
    mappingId: MappingId
  ): Promise<CutoverStatus | undefined>;

  loadEvents(
    tenantId: TenantId,
    mappingId: MappingId,
    limit?: number
  ): Promise<CutoverEvent[]>;

  getEventHistory(
    tenantId: TenantId,
    mappingId: MappingId,
    limit?: number
  ): Promise<CutoverEvent[]>;

  transitionState(
    tenantId: TenantId,
    mappingId: MappingId,
    toState: CutoverState,
    metadataOrReason?: string | Record<string, unknown>
  ): Promise<CutoverStatus>;
}

/**
 * Implementation of CutoverStateStore using PostgreSQL.
 * Works with both pg and postgres-js drivers via structural typing.
 */
export class CutoverStore implements CutoverStateStore {
  private readonly db: unknown;

  constructor(db: unknown) {
    this.db = db;
  }

  // Type assertion helper for internal use
  private getDb() {
    return this.db as ReturnType<typeof import('drizzle-orm/postgres-js').drizzle>;
  }

  /**
   * Initialize a new cutover and return the status
   */
  async initializeCutover(params: {
    tenantId: TenantId;
    mappingId: MappingId;
    targetMailServer?: string;
    startedBy?: string;
  }): Promise<CutoverStatus> {
    const now = new Date().toISOString();
    const status: CutoverStatus = {
      tenantId: params.tenantId,
      mappingId: params.mappingId,
      state: 'PREPARING',
      phase: 'PREPARATION',
      startedAt: now,
      updatedAt: now,
      verificationStatus: 'PENDING',
      totalItemsMigrated: 0,
      itemsVerified: 0,
      discrepanciesFound: 0,
      rollbackAvailable: false,
      currentState: 'PREPARING',
      targetMailServer: params.targetMailServer,
      startedBy: params.startedBy,
    };

    await this.saveCutoverState(status);

    // Log initialization event
    const initEvent: CutoverEvent = {
      tenantId: params.tenantId,
      mappingId: params.mappingId,
      timestamp: now,
      fromState: null,
      toState: 'PREPARING',
      triggeredBy: params.startedBy || 'system',
      eventType: 'CUTOVER_INITIALIZED',
      description: 'Cutover initialized',
    };
    await this.logCutoverEvent(initEvent);

    return status;
  }

  /**
   * Save cutover state to the database
   */
  async saveCutoverState(status: CutoverStatus): Promise<void> {
    const now = new Date().toISOString();
    
    await this.getDb().insert(schema.cutoverState).values({
      id: status.tenantId,
      tenantId: status.tenantId,
      mappingId: status.mappingId,
      state: this.mapStateToDb(status.state),
      phase: this.mapPhaseToDb(status.phase),
      verificationStatus: this.mapVerificationStatus(status.verificationStatus),
      verificationReport: status.verificationReport ? JSON.parse(status.verificationReport) : {},
      gracePeriodHours: this.extractGracePeriodHours(status),
      gracePeriodStartedAt: status.gracePeriodStartedAt ? new Date(status.gracePeriodStartedAt) : null,
      gracePeriodCompletedAt: status.gracePeriodCompletedAt ? new Date(status.gracePeriodCompletedAt) : null,
      targetMailServer: status.targetMailServer ?? null,
      metadata: this.buildMetadata(status),
      createdAt: new Date(now),
      updatedAt: new Date(now),
    }).onConflictDoUpdate({
      target: [schema.cutoverState.tenantId, schema.cutoverState.mappingId],
      set: {
        state: this.mapStateToDb(status.state),
        phase: this.mapPhaseToDb(status.phase),
        verificationStatus: this.mapVerificationStatus(status.verificationStatus),
        verificationReport: status.verificationReport ? JSON.parse(status.verificationReport) : {},
        gracePeriodHours: this.extractGracePeriodHours(status),
        gracePeriodStartedAt: status.gracePeriodStartedAt ? new Date(status.gracePeriodStartedAt) : null,
        gracePeriodCompletedAt: status.gracePeriodCompletedAt ? new Date(status.gracePeriodCompletedAt) : null,
        targetMailServer: status.targetMailServer ?? null,
        metadata: this.buildMetadata(status),
        updatedAt: new Date(now),
      },
    });
  }

  /**
   * Load cutover state from the database
   */
  async loadCutoverState(
    tenantId: TenantId,
    mappingId: MappingId
  ): Promise<CutoverStatus | undefined> {
    const result = await this.getDb()
      .select()
      .from(schema.cutoverState)
      .where(
        and(
          eq(schema.cutoverState.tenantId, tenantId),
          eq(schema.cutoverState.mappingId, mappingId)
        )
      )
      .limit(1);

    if (result.length === 0) {
      return undefined;
    }

    const row = result[0]!;
    return this.mapRowToStatus(row);
  }

  /**
   * Log a cutover event to the database
   */
  async logCutoverEvent(event: CutoverEvent): Promise<void> {
    const insertData = {
      tenantId: event.tenantId,
      mappingId: event.mappingId,
      timestamp: new Date(event.timestamp),
      fromState: event.fromState ? this.mapStateToDb(event.fromState) : null,
      toState: this.mapStateToDb(event.toState),
      triggeredBy: event.triggeredBy,
      reason: event.reason || null,
      eventType: event.eventType || 'STATE_TRANSITION',
      metadata: event.metadata ? JSON.parse(JSON.stringify(event.metadata)) : {},
    };
    await this.getDb().insert(schema.cutoverEvent).values(insertData);
  }
  /**
   * Load cutover events from the database
   */
  async loadEvents(
    tenantId: TenantId,
    mappingId: MappingId,
    limit?: number
  ): Promise<CutoverEvent[]> {
    const query = this.getDb()
      .select()
      .from(schema.cutoverEvent)
      .where(
        and(
          eq(schema.cutoverEvent.tenantId, tenantId),
          eq(schema.cutoverEvent.mappingId, mappingId)
        )
      );
    
    const orderedQuery = query.orderBy(asc(schema.cutoverEvent.timestamp));
    
    const rows = limit ? await orderedQuery.limit(limit) : await orderedQuery;

    return rows.map((row: typeof schema.cutoverEvent.$inferSelect) => {
      const baseDescription = row.eventType === 'CUTOVER_INITIALIZED'
        ? 'Cutover initialized'
        : row.toState === 'ROLLED_BACK'
          ? row.fromState
            ? `${row.fromState} rolled back to ${row.toState}`
            : `Rolled back to ${row.toState}`
          : row.fromState
            ? `Transitioned from ${row.fromState} to ${row.toState}`
            : `Transitioned to ${row.toState}`;
      // Include reason in description if available
      const description = row.reason ? `${baseDescription}: ${row.reason}` : baseDescription;
      
      return {
        tenantId: row.tenantId as TenantId,
        mappingId: row.mappingId as MappingId,
        timestamp: row.timestamp.toISOString(),
        fromState: row.fromState,
        toState: row.toState,
        triggeredBy: row.triggeredBy,
        reason: row.reason ?? undefined,
        metadata: row.metadata as Record<string, unknown>,
        eventType: row.eventType ?? 'STATE_TRANSITION',
        description,
      };
    });
  }

  /**
   * Get event history for a mapping
   */
  async getEventHistory(
    tenantId: TenantId,
    mappingId: MappingId,
    limit?: number
  ): Promise<CutoverEvent[]> {
    return this.loadEvents(tenantId, mappingId, limit);
  }

  /**
   * Transition cutover state and log the event
   */
  async transitionState(
    tenantId: TenantId,
    mappingId: MappingId,
    toState: CutoverState,
    metadataOrReason?: string | Record<string, unknown>
  ): Promise<CutoverStatus> {
    // Load current state
    const current = await this.loadCutoverState(tenantId, mappingId);
    if (!current) {
      throw new Error(`No cutover state found for mapping ${mappingId}`);
    }

    // Validate transition (import from cutover-state)
    const { isValidTransition } = await import('@openmig/core/cutover-state');
    if (!isValidTransition(current.state, toState)) {
      const reason = typeof metadataOrReason === 'string' ? metadataOrReason : 'No reason provided';
      throw new Error(
        `Invalid transition from ${current.state} to ${toState}. Reason: ${reason}`
      );
    }

    // Extract reason and metadata from the parameter
    let reason: string | undefined;
    let metadata: Record<string, unknown> | undefined;
    
    if (typeof metadataOrReason === 'string') {
      reason = metadataOrReason;
    } else if (metadataOrReason && typeof metadataOrReason === 'object') {
      metadata = metadataOrReason;
      // Extract reason from various possible fields depending on the transition
      reason = (metadata.reason as string) || (metadata.failureReason as string) || (metadata.rollbackReason as string);
    }

    // Create event
    const event: CutoverEvent = {
      tenantId,
      mappingId,
      timestamp: new Date().toISOString(),
      fromState: current.state,
      toState,
      triggeredBy: typeof metadataOrReason === 'string' ? 'system' : 'cli',
      reason,
      metadata,
      eventType: 'STATE_TRANSITION',
      description: reason ? `Transitioned from ${current.state} to ${toState}: ${reason}` : `Transitioned from ${current.state} to ${toState}`,
    };

    // Log event
    await this.logCutoverEvent(event);

    // Update state
    const { updateCutoverStatus } = await import('@openmig/core/cutover-state');
    const updated = updateCutoverStatus(current, toState, reason);
    
    // Debug logging
    console.log('[transitionState] toState:', toState);
    console.log('[transitionState] updated.state:', updated.state);
    console.log('[transitionState] updated:', JSON.stringify(updated, null, 2));

    // Merge metadata into the status if provided
    if (metadata) {
      Object.assign(updated, metadata);
    }

    await this.saveCutoverState(updated);

    return updated;
  }

  // Helper methods

  private mapStateToDb(state: CutoverState): 'PREPARING' | 'READY_FOR_CUTOVER' | 'APPROVED' | 'CUTOVER_IN_PROGRESS' | 'GRACE_PERIOD' | 'COMPLETED' | 'FAILED' | 'ROLLED_BACK' {
    const stateMap: Record<CutoverState, 'PREPARING' | 'READY_FOR_CUTOVER' | 'APPROVED' | 'CUTOVER_IN_PROGRESS' | 'GRACE_PERIOD' | 'COMPLETED' | 'FAILED' | 'ROLLED_BACK'> = {
      'PREPARING': 'PREPARING',
      'READY_FOR_CUTOVER': 'READY_FOR_CUTOVER',
      'APPROVED': 'APPROVED',
      'CUTOVER_IN_PROGRESS': 'CUTOVER_IN_PROGRESS',
      'GRACE_PERIOD': 'GRACE_PERIOD',
      'COMPLETED': 'COMPLETED',
      'FAILED': 'FAILED',
      'ROLLED_BACK': 'ROLLED_BACK',
    };
    return stateMap[state] || 'PREPARING';
  }

  private mapPhaseToDb(phase: CutoverPhase): 'verification' | 'cutover' | 'grace' | 'completion' | 'rollback' {
    const phaseMap: Record<CutoverPhase, 'verification' | 'cutover' | 'grace' | 'completion' | 'rollback'> = {
      'PREPARATION': 'verification',
      'VERIFICATION': 'verification',
      'CUTOVER': 'cutover',
      'GRACE': 'grace',
      'COMPLETION': 'completion',
      'ROLLBACK': 'rollback',
      'ERROR': 'rollback',
    };
    return phaseMap[phase] || 'verification';
  }

  private mapVerificationStatus(status: string): 'pending' | 'pass' | 'fail' | 'warn' | 'skipped' {
    const statusMap: Record<string, 'pending' | 'pass' | 'fail' | 'warn' | 'skipped'> = {
      'PENDING': 'pending',
      'PASS': 'pass',
      'WARN': 'warn',
      'FAIL': 'fail',
    };
    return statusMap[status] || 'pending';
  }

  private extractGracePeriodHours(status: CutoverStatus): number {
    if (status.metadata) {
      try {
        const meta = typeof status.metadata === 'string' 
          ? JSON.parse(status.metadata) 
          : status.metadata;
        return meta.gracePeriodDurationHours || 72;
      } catch {
        return 72;
      }
    }
    return 72;
  }

  private buildMetadata(status: CutoverStatus): Record<string, unknown> {
    const meta: Record<string, unknown> = {
      gracePeriodDurationHours: 72,
      autoCompleteAfterGrace: true,
    };
    
    if (status.errorMessage) {
      meta.errorMessage = status.errorMessage;
    }
    if (status.errorDetails) {
      meta.errorDetails = status.errorDetails;
    }
    
    return meta;
  }

  private mapRowToStatus(row: typeof schema.cutoverState.$inferSelect): CutoverStatus {
    const verificationStatusMap: Record<string, 'PENDING' | 'PASS' | 'WARN' | 'FAIL'> = {
      'pending': 'PENDING',
      'pass': 'PASS',
      'warn': 'WARN',
      'fail': 'FAIL',
    };

    const dbPhaseToPhase: Record<string, CutoverPhase> = {
      'verification': 'PREPARATION',
      'cutover': 'CUTOVER',
      'grace': 'GRACE',
      'completion': 'COMPLETION',
      'rollback': 'ROLLBACK',
    };

    const metadata = row.metadata;

    return {
      tenantId: row.tenantId as TenantId,
      mappingId: row.mappingId as MappingId,
      state: row.state,
      phase: dbPhaseToPhase[row.phase] || 'PREPARATION',
      startedAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      completedAt: row.gracePeriodCompletedAt?.toISOString() as string,
      verificationStatus: verificationStatusMap[row.verificationStatus] || 'PENDING',
      verificationReport: typeof row.verificationReport === 'string'
        ? row.verificationReport
        : JSON.stringify(row.verificationReport || {}),
      cutoverStartedAt: undefined,
      cutoverCompletedAt: undefined,
      gracePeriodStartedAt: row.gracePeriodStartedAt?.toISOString() as string,
      gracePeriodEndsAt: undefined,
      totalItemsMigrated: 0,
      itemsVerified: 0,
      discrepanciesFound: 0,
      rollbackAvailable: false,
      currentState: row.state,
      targetMailServer: row.targetMailServer ?? undefined,
      metadata: metadata as Record<string, unknown>,
    };
  }
}
