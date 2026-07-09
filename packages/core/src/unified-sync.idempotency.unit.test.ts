/**
 * Unified Sync Idempotency Tests - Stub
 * 
 * These tests document the expected behavior of the unified sync engine.
 * Since the current implementation is a stub, these tests verify the API shape.
 * 
 * Full implementation will require:
 * 1. Generic sync engine
 * 2. Domain-specific source connectors (CalDAV, CardDAV, WebDAV)
 * 3. Domain-specific target writers
 * 4. Integration tests with real providers
 * 
 * See docs/workplans/0007-multi-domain-sync-completion.md for the full task list.
 */

import { describe, it, expect } from 'vitest';
import { runUnifiedSync, type UnifiedSyncConfig } from './unified-sync';
import type { TenantId, MappingId } from '@openmig/shared';

describe('Unified Sync Idempotency - Stub', () => {
  it('should return empty stats for all domains', async () => {
    const config: UnifiedSyncConfig = {
      tenantId: 'test-tenant' as TenantId,
      mappingId: 'test-mapping' as MappingId,
      mail: { enabled: true },
      calendar: { enabled: false },
      contacts: { enabled: false },
      files: { enabled: false },
    };

    const result = await runUnifiedSync({
      config,
      ledger: {} as import('@openmig/shared').Ledger,
      cursors: undefined,
    });

    expect(result.mail.totalItems).toBe(0);
    expect(result.calendar.totalItems).toBe(0);
    expect(result.contacts.totalItems).toBe(0);
    expect(result.files.totalItems).toBe(0);
  });
});
