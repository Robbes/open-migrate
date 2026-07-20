// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

/**
 * Pure formatter for the self-host `/status` payload (workplan 0010 T2). Turns
 * per-mapping migration_status rows into a JSON-serializable report. Errors are
 * surfaced verbatim (SAD §11.2 — never mask). Kept pure so it is unit-testable
 * without a database.
 */

import type { MigrationStatus } from '@openmig/shared';

export interface MappingStatusInput {
  readonly mappingId: string;
  readonly statuses: readonly MigrationStatus[];
}

export interface DomainStatusReport {
  readonly domain: MigrationStatus['domain'];
  readonly state: MigrationStatus['state'];
  readonly itemsSynced: number;
  readonly itemsFailed: number;
  readonly bytesTransferred: number;
  readonly lastSyncedAt?: string;
  readonly lastError?: string;
}

export interface StatusReport {
  readonly status: 'ok';
  readonly mappings: ReadonlyArray<{
    readonly mappingId: string;
    readonly domains: readonly DomainStatusReport[];
  }>;
}

export function buildStatusReport(inputs: readonly MappingStatusInput[]): StatusReport {
  return {
    status: 'ok',
    mappings: inputs.map(({ mappingId, statuses }) => ({
      mappingId,
      domains: statuses.map((s) => ({
        domain: s.domain,
        state: s.state,
        itemsSynced: s.itemsSynced,
        itemsFailed: s.itemsFailed,
        bytesTransferred: s.bytesTransferred,
        ...(s.completedAt ? { lastSyncedAt: s.completedAt } : {}),
        ...(s.lastError ? { lastError: s.lastError } : {}),
      })),
    })),
  };
}
