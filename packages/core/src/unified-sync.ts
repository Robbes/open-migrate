/**
 * Unified Sync Engine - Stub Implementation
 * 
 * This is a stub that documents the API shape for multi-domain sync.
 * Full implementation requires:
 * 1. Generic sync engine that works across all domain types
 * 2. CalDAV/CardDAV/WebDAV source connectors  
 * 3. Target writers for all domain types
 * 4. Integration tests
 * 
 * See docs/workplans/0007-multi-domain-sync-completion.md for the full task list.
 */

import type { TenantId, MappingId } from '@openmig/shared';

export interface UnifiedSyncConfig {
  tenantId: TenantId;
  mappingId: MappingId;
  mail?: { enabled: boolean };
  calendar?: { enabled: boolean };
  contacts?: { enabled: boolean };
  files?: { enabled: boolean };
  concurrency?: number;
  dryRun?: boolean;
}

export interface TypeSyncStats {
  totalItems: number;
  createdCount: number;
  skippedCount: number;
  failureCount: number;
  bytesTransferred: number;
  durationSeconds: number;
  failures: Array<{ id: string; error: string }>;
}

export interface UnifiedSyncResult {
  mail: TypeSyncStats;
  calendar: TypeSyncStats;
  contacts: TypeSyncStats;
  files: TypeSyncStats;
  totalDurationSeconds: number;
}

export interface UnifiedSyncDeps {
  config: UnifiedSyncConfig;
  ledger: import('@openmig/shared').Ledger;
  cursors?: import('@openmig/shared').CursorStore;
}

export async function runUnifiedSync(
  _deps: UnifiedSyncDeps
): Promise<UnifiedSyncResult> {
  // Stub: return empty stats
  return {
    mail: { totalItems: 0, createdCount: 0, skippedCount: 0, failureCount: 0, bytesTransferred: 0, durationSeconds: 0, failures: [] },
    calendar: { totalItems: 0, createdCount: 0, skippedCount: 0, failureCount: 0, bytesTransferred: 0, durationSeconds: 0, failures: [] },
    contacts: { totalItems: 0, createdCount: 0, skippedCount: 0, failureCount: 0, bytesTransferred: 0, durationSeconds: 0, failures: [] },
    files: { totalItems: 0, createdCount: 0, skippedCount: 0, failureCount: 0, bytesTransferred: 0, durationSeconds: 0, failures: [] },
    totalDurationSeconds: 0,
  };
}
