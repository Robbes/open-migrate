// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

import { describe, it, expect } from 'vitest';
import type { MigrationStatus } from '@openmig/shared';
import { buildStatusReport } from './status';

function status(over: Partial<MigrationStatus>): MigrationStatus {
  return {
    id: 'id',
    tenantId: 't' as MigrationStatus['tenantId'],
    mappingId: 'm' as MigrationStatus['mappingId'],
    domain: 'email',
    state: 'completed',
    itemsSynced: 0,
    itemsFailed: 0,
    bytesTransferred: 0,
    startedAt: '2026-07-20T00:00:00Z',
    updatedAt: '2026-07-20T00:01:00Z',
    ...over,
  };
}

describe('buildStatusReport', () => {
  it('maps per-mapping domain status into a serializable report', () => {
    const report = buildStatusReport([
      {
        mappingId: 'inbox',
        statuses: [
          status({ domain: 'email', state: 'completed', itemsSynced: 42, bytesTransferred: 1000, completedAt: '2026-07-20T00:02:00Z' }),
          status({ domain: 'calendar', state: 'in_progress' }),
        ],
      },
    ]);

    expect(report.status).toBe('ok');
    expect(report.mappings).toHaveLength(1);
    expect(report.mappings[0]!.mappingId).toBe('inbox');
    expect(report.mappings[0]!.domains[0]).toMatchObject({
      domain: 'email',
      state: 'completed',
      itemsSynced: 42,
      bytesTransferred: 1000,
      lastSyncedAt: '2026-07-20T00:02:00Z',
    });
    expect(report.mappings[0]!.domains[1]).toMatchObject({ domain: 'calendar', state: 'in_progress' });
    // JSON-serializable end to end.
    expect(() => JSON.stringify(report)).not.toThrow();
  });

  it('surfaces the last error verbatim (SAD §11.2)', () => {
    const report = buildStatusReport([
      { mappingId: 'm', statuses: [status({ state: 'failed', lastError: 'connector auth failed: 401' })] },
    ]);
    expect(report.mappings[0]!.domains[0]!.lastError).toBe('connector auth failed: 401');
  });

  it('omits lastError/lastSyncedAt when absent', () => {
    const report = buildStatusReport([{ mappingId: 'm', statuses: [status({ state: 'pending' })] }]);
    const d = report.mappings[0]!.domains[0]!;
    expect(d.lastError).toBeUndefined();
    expect(d.lastSyncedAt).toBeUndefined();
  });
});
