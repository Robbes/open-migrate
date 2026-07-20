// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

/**
 * Unit tests for the sync/cutover job-resolution helpers (the pure core of the
 * real Trigger.dev wiring that replaced the placeholder mock endpoints).
 */

import { describe, it, expect } from 'vitest';
import { resolveSyncJob, resolveCutoverJob } from './job-resolution';

const TENANT = '00000000-0000-4000-8000-000000000001';
const MAPPING = '11111111-1111-4111-8111-111111111111';

describe('resolveSyncJob', () => {
  it('defaults to the incremental delta task with an id-only payload', () => {
    expect(resolveSyncJob(TENANT, MAPPING, {})).toEqual({
      taskId: 'run-delta-sync',
      payload: { tenantId: TENANT, mappingId: MAPPING },
    });
  });

  it("uses the full-sync task when type is 'full'", () => {
    expect(resolveSyncJob(TENANT, MAPPING, { type: 'full' })).toEqual({
      taskId: 'run-full-sync',
      payload: { tenantId: TENANT, mappingId: MAPPING, options: { forceFullScan: true } },
    });
  });

  it('uses the full-sync task when forceFullScan is set even without type', () => {
    expect(resolveSyncJob(TENANT, MAPPING, { forceFullScan: true }).taskId).toBe('run-full-sync');
  });

  it("uses delta for an explicit type 'delta'", () => {
    expect(resolveSyncJob(TENANT, MAPPING, { type: 'delta', forceFullScan: false }).taskId).toBe('run-delta-sync');
  });
});

describe('resolveCutoverJob', () => {
  it('maps to the cutover task with defaulted options', () => {
    expect(resolveCutoverJob(TENANT, MAPPING, {})).toEqual({
      taskId: 'run-cutover',
      payload: {
        tenantId: TENANT,
        mappingId: MAPPING,
        options: { skipFinalSync: false, skipVerification: false, gracePeriodHours: 24 },
      },
    });
  });

  it('passes through the provided options', () => {
    const { payload } = resolveCutoverJob(TENANT, MAPPING, {
      skipFinalSync: true,
      skipVerification: true,
      gracePeriodHours: 48,
    });
    expect(payload.options).toEqual({ skipFinalSync: true, skipVerification: true, gracePeriodHours: 48 });
  });
});
