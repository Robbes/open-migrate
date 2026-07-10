/**
 * Cutover State Persistence Layer
 * 
 * Provides persistent storage and retrieval of cutover state machine data.
 * Rehydrates state from the database and logs all state transitions as events.
 * 
 * See docs/architecture/solution-architecture.md §11 (shadow & cutover)
 */

import type { TenantId, MappingId } from '@openmig/shared';
import type { PgDatabase, SqliteDatabase } from '@openmig/ledger';
import { eq, and, desc } from 'drizzle-orm';
import * as schemaPg from '@openmig/ledger/schema-pg';
import * as schemaSqlite from '@openmig/ledger/schema-sqlite';
import type {
  CutoverState,
  CutoverPhase,
  CutoverStatus,
  CutoverEvent,
} from './cutover-state';

// Type aliases for database-specific types
type DbKind = 'pg' | 'sqlite';

/**
 * Persistence layer for cutover state
 */
export class CutoverPersistence {
  private readonly db: PgDatabase | SqliteDatabase;
  private readonly dbKind: DbKind;

  constructor(db: PgDatabase | SqliteDatabase, dbKind: DbKind = 'pg') {
    this.db = db;
    this.dbKind = dbKind;
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
    return status;
  }

  /**
   * Save cutover state to the database
   */
  async saveCutoverState(status: CutoverStatus): Promise<void> {
    const now = new Date().toISOString();
    
    if (this.dbKind === 'pg') {
      const db = this.db as PgDatabase;
      await db.insert(schemaPg.cutoverState).values({
        id: status.tenantId, // Using tenantId as id for simplicity; can be changed to UUID
        tenantId: status.tenantId,
        mappingId: status.mappingId,
        state: status.state,
        phase: this.mapPhaseToDb(status.phase),
        verificationStatus: this.mapVerificationStatus(status.verificationStatus),
        verificationReport: status.verificationReport ? JSON.parse(status.verificationReport) : {},
        gracePeriodHours: this.extractGracePeriodHours(status),
        gracePeriodStartedAt: status.gracePeriodStartedAt,
        gracePeriodCompletedAt: status.gracePeriodCompletedAt,
        metadata: this.buildMetadata(status),
        createdAt: now,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: [schemaPg.cutoverState.tenantId, schemaPg.cutoverState.mappingId],
        set: {
          state: status.state,
          phase: this.mapPhaseToDb(status.phase),
          verificationStatus: this.mapVerificationStatus(status.verificationStatus),
          verificationReport: status.verificationReport ? JSON.parse(status.verificationReport) : {},
          gracePeriodHours: this.extractGracePeriodHours(status),
          gracePeriodStartedAt: status.gracePeriodStartedAt,
          gracePeriodCompletedAt: status.gracePeriodCompletedAt,
          metadata: this.buildMetadata(status),
          updatedAt: now,
        },
      });
    } else {
      const db = this.db as SqliteDatabase;
      await db.insert(schemaSqlite.cutoverState).values({
        id: status.tenantId,
        tenantId: status.tenantId,
        mappingId: status.mappingId,
        state: status.state,
        phase: this.mapPhaseToDb(status.phase),
        verificationStatus: this.mapVerificationStatus(status.verificationStatus),
        verificationReport: status.verificationReport || '{}',
        gracePeriodHours: this.extractGracePeriodHours(status),
        gracePeriodStartedAt: status.gracePeriodStartedAt,
        gracePeriodCompletedAt: status.gracePeriodCompletedAt,
        metadata: JSON.stringify(this.buildMetadata(status)),
        createdAt: now,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: [schemaSqlite.cutoverState.tenantId, schemaSqlite.cutoverState.mappingId],
        set: {
          state: status.state,
          phase: this.mapPhaseToDb(status.phase),
          verificationStatus: this.mapVerificationStatus(status.verificationStatus),
          verificationReport: status.verificationReport || '{}',
          gracePeriodHours: this.extractGracePeriodHours(status),
          gracePeriodStartedAt: status.gracePeriodStartedAt,
          gracePeriodCompletedAt: status.gracePeriodCompletedAt,
          metadata: JSON.stringify(this.buildMetadata(status)),
          updatedAt: now,
        },
      });
    }
  }

  /**
   * Load cutover state from the database
   */
  async loadCutoverState(
    tenantId: TenantId,
    mappingId: MappingId
  ): Promise<CutoverStatus | undefined> {
    let result: CutoverStatus[];

    if (this.dbKind === 'pg') {
      const db = this.db as PgDatabase;
      result = await db
        .select()
        .from(schemaPg.cutoverState)
        .where(
          and(
            eq(schemaPg.cutoverState.tenantId, tenantId),
            eq(schemaPg.cutoverState.mappingId, mappingId)
          )
        )
        .limit(1);
    } else {
      const db = this.db as SqliteDatabase;
      result = await db
        .select()
        .from(schemaSqlite.cutoverState)
        .where(
          and(
            eq(schemaSqlite.cutoverState.tenantId, tenantId),
            eq(schemaSqlite.cutoverState.mappingId, mappingId)
          )
        )
        .limit(1);
    }

    if (result.length === 0) {
      return undefined;
    }

    const row = result[0];
    return this.mapRowToStatus(row);
  }

  /**
   * Log a cutover event to the database
   */
  async logCutoverEvent(event: CutoverEvent): Promise<void> {
    if (this.dbKind === 'pg') {
      const db = this.db as PgDatabase;
      await db.insert(schemaPg.cutoverEvent).values({
        id: crypto.randomUUID(),
        tenantId: event.tenantId,
        mappingId: event.mappingId,
        timestamp: event.timestamp,
        fromState: event.fromState,
        toState: event.toState,
        triggeredBy: event.triggeredBy,
        reason: event.reason,
        metadata: event.metadata ? JSON.parse(JSON.stringify(event.metadata)) : {},
      });
    } else {
      const db = this.db as SqliteDatabase;
      await db.insert(schemaSqlite.cutoverEvent).values({
        id: crypto.randomUUID(),
        tenantId: event.tenantId,
        mappingId: event.mappingId,
        timestamp: event.timestamp,
        fromState: event.fromState,
        toState: event.toState,
        triggeredBy: event.triggeredBy,
        reason: event.reason,
        metadata: JSON.stringify(event.metadata || {}),
      });
    }
  }

  /**
   * Get event history for a cutover
   */
  async getEventHistory(
    tenantId: TenantId,
    mappingId: MappingId,
    limit?: number
  ): Promise<CutoverEvent[]> {
    let result: CutoverEvent[];

    if (this.dbKind === 'pg') {
      const db = this.db as PgDatabase;
      let query = db
        .select()
        .from(schemaPg.cutoverEvent)
        .where(
          and(
            eq(schemaPg.cutoverEvent.tenantId, tenantId),
            eq(schemaPg.cutoverEvent.mappingId, mappingId)
          )
        )
        .orderBy(desc(schemaPg.cutoverEvent.timestamp));
      
      if (limit) {
        query = query.limit(limit);
      }
      result = await query;
    } else {
      const db = this.db as SqliteDatabase;
      let query = db
        .select()
        .from(schemaSqlite.cutoverEvent)
        .where(
          and(
            eq(schemaSqlite.cutoverEvent.tenantId, tenantId),
            eq(schemaSqlite.cutoverEvent.mappingId, mappingId)
          )
        )
        .orderBy(schemaSqlite.cutoverEvent.timestamp.desc());
      
      if (limit) {
        query = query.limit(limit);
      }
      result = await query;
    }

    return result.map((row) => ({
      tenantId: row.tenantId,
      mappingId: row.mappingId,
      timestamp: row.timestamp,
      fromState: row.fromState,
      toState: row.toState,
      triggeredBy: row.triggeredBy,
      reason: row.reason,
      metadata: this.dbKind === 'pg' ? row.metadata : JSON.parse(row.metadata),
      eventType: row.fromState ? `${row.fromState}_to_${row.toState}` : undefined,
      description: `Transitioned from ${row.fromState} to ${row.toState}`,
    }));
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
    const { isValidTransition } = await import('./cutover-state');
    if (!isValidTransition(current.state, toState)) {
      const reason = typeof metadataOrReason === 'string' ? metadataOrReason : 'No reason provided';
      throw new Error(
        `Invalid state transition from ${current.state} to ${toState}. Reason: ${reason}`
      );
    }

    // Extract reason and metadata from the parameter
    let reason: string | undefined;
    let metadata: Record<string, unknown> | undefined;
    
    if (typeof metadataOrReason === 'string') {
      reason = metadataOrReason;
    } else if (metadataOrReason && typeof metadataOrReason === 'object') {
      metadata = metadataOrReason;
      // Extract reason from metadata if present
      reason = (metadata.reason as string) || (metadata.failureReason as string);
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
      eventType: `${current.state}_to_${toState}`,
      description: `Transitioned from ${current.state} to ${toState}`,
    };

    // Log event
    await this.logCutoverEvent(event);

    // Update state
    const { updateCutoverStatus } = await import('./cutover-state');
    const updated = updateCutoverStatus(current, toState, reason);

    // Merge metadata into the status if provided
    if (metadata) {
      Object.assign(updated, metadata);
    }

    await this.saveCutoverState(updated);

    return updated;
  }

  // Helper methods

  private mapPhaseToDb(phase: CutoverPhase): string {
    const phaseMap: Record<CutoverPhase, string> = {
      'PREPARATION': 'verification',
      'VERIFICATION': 'verification',
      'CUTOVER': 'cutover',
      'GRACE': 'grace',
      'COMPLETION': 'completion',
      'ROLLBACK': 'rollback',
      'ERROR': 'rollback',
    };
    return phaseMap[phase];
  }

  private mapVerificationStatus(status: string): string {
    const statusMap: Record<string, string> = {
      'PENDING': 'pending',
      'PASS': 'pass',
      'WARN': 'warn',
      'FAIL': 'fail',
    };
    return statusMap[status] || 'pending';
  }

  private extractGracePeriodHours(status: CutoverStatus): number {
    // Extract from metadata or use default
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

  private mapRowToStatus(row: CutoverStatus): CutoverStatus {
    const verificationStatusMap: Record<string, 'PENDING' | 'PASS' | 'WARN' | 'FAIL'> = {
      'pending': 'PENDING',
      'pass': 'PASS',
      'warn': 'WARN',
      'fail': 'FAIL',
    };

    const metadata = this.dbKind === 'pg' 
      ? row.metadata 
      : JSON.parse(row.metadata);

    return {
      tenantId: row.tenantId,
      mappingId: row.mappingId,
      state: row.state,
      phase: this.mapPhaseToDb(row.phase),
      startedAt: row.created_at || row.createdAt,
      updatedAt: row.updated_at || row.updatedAt,
      completedAt: row.grace_period_completed_at || row.gracePeriodCompletedAt,
      verificationStatus: verificationStatusMap[row.verification_status] || 'PENDING',
      verificationReport: typeof row.verification_report === 'string'
        ? row.verification_report
        : JSON.stringify(row.verification_report || {}),
      cutoverStartedAt: undefined, // Not in schema yet
      cutoverCompletedAt: undefined,
      gracePeriodStartedAt: row.grace_period_started_at || row.gracePeriodStartedAt,
      gracePeriodEndsAt: undefined,
      totalItemsMigrated: 0,
      itemsVerified: 0,
      discrepanciesFound: 0,
      errorMessage: metadata.errorMessage,
      errorDetails: metadata.errorDetails,
      rollbackAvailable: row.state === 'CUTOVER_IN_PROGRESS' || row.state === 'GRACE_PERIOD',
      metadata: typeof metadata === 'string' ? metadata : JSON.stringify(metadata),
    };
  }
}
