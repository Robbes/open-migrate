// Copyright 2026 OpenHands Agent (Apache-2.0)
/**
 * Verification Integration Tests
 * 
 * Tests the verification engine against real data sources (ledger + target).
 * Validates that the verification gate correctly identifies issues and passes when complete.
 * 
 * See docs/architecture/solution-architecture.md §20 (verification & rollback)
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createPgDb } from '@openmig/ledger';
import { PgLedger } from '@openmig/ledger';
import { runVerification, createRealVerificationDeps } from '@openmig/core';
import { createLedgerVerificationReader } from '@openmig/ledger';
import type { TargetReindexer, TargetEntry } from '@openmig/shared';
import { asTenantId, asMappingId } from '@openmig/shared';

// Connection string from Testcontainers
const PG_CONNECTION_STRING = process.env.TEST_DATABASE_URL;
if (!PG_CONNECTION_STRING) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Integration tests require Testcontainers to be running. ' +
    'Run: pnpm test:integration'
  );
}

// Fixed UUIDs for testing
const TEST_TENANT_ID = asTenantId('5d1b0000-e29b-41d4-a716-446655440101' as never);
const TEST_MAPPING_ID = asMappingId('5d1b0000-e29b-41d4-a716-446655440102' as never);

/** Mock target reindexer for testing */
class MockTargetReindexer implements TargetReindexer {
  private entries: TargetEntry[];

  constructor(entries: TargetEntry[] = []) {
    this.entries = entries;
  }

  async *listEntries(): AsyncIterable<TargetEntry> {
    for (const entry of this.entries) {
      yield entry;
    }
  }

  addEntry(entry: TargetEntry) {
    this.entries.push(entry);
  }

  clear() {
    this.entries = [];
  }
}

describe('Verification Engine (integration)', () => {
  let db: ReturnType<typeof createPgDb>;
  let ledger: PgLedger;
  let targetReindexer: MockTargetReindexer;

  beforeAll(async () => {
    db = createPgDb(PG_CONNECTION_STRING);
    ledger = new PgLedger(db);

    // Setup test tenant and mapping
    await db.execute(sql`
      INSERT INTO tenant (id, name, status)
      VALUES (${TEST_TENANT_ID}, 'Test Tenant', 'active')
      ON CONFLICT (id) DO NOTHING
    `);

    await db.execute(sql`
      INSERT INTO connection (id, tenant_id, role, kind, display_name, config, status)
      VALUES (
        '5d1b0000-e29b-41d4-a716-446655440101',
        ${TEST_TENANT_ID},
        'source',
        'o365',
        'O365 Source',
        '{}',
        'connected'
      )
      ON CONFLICT (id) DO NOTHING
    `);

    await db.execute(sql`
      INSERT INTO connection (id, tenant_id, role, kind, display_name, config, status)
      VALUES (
        '5d1b0000-e29b-41d4-a716-446655440102',
        ${TEST_TENANT_ID},
        'target',
        'selfhosted_mail',
        'Stalwart Target',
        '{}',
        'connected'
      )
      ON CONFLICT (id) DO NOTHING
    `);

    await db.execute(sql`
      INSERT INTO mailbox (id, tenant_id, connection_id, external_id, kind, display_name, status)
      VALUES (
        '5d1b0000-e29b-41d4-a716-446655440101',
        ${TEST_TENANT_ID},
        '5d1b0000-e29b-41d4-a716-446655440101',
        'inbox-source',
        'user',
        'Inbox',
        'active'
      )
      ON CONFLICT (id) DO NOTHING
    `);

    await db.execute(sql`
      INSERT INTO mailbox (id, tenant_id, connection_id, external_id, kind, display_name, status)
      VALUES (
        '5d1b0000-e29b-41d4-a716-446655440102',
        ${TEST_TENANT_ID},
        '5d1b0000-e29b-41d4-a716-446655440102',
        'inbox-target',
        'user',
        'Inbox',
        'active'
      )
      ON CONFLICT (id) DO NOTHING
    `);

    await db.execute(sql`
      INSERT INTO mailbox_mapping (id, tenant_id, source_mailbox_id, target_mailbox_id, status, mode)
      VALUES (
        ${TEST_MAPPING_ID},
        ${TEST_TENANT_ID},
        '5d1b0000-e29b-41d4-a716-446655440101',
        '5d1b0000-e29b-41d4-a716-446655440102',
        'active',
        'mirror'
      )
      ON CONFLICT (id) DO NOTHING
    `);
  });

  beforeEach(async () => {
    // Clean up test data
    await db.execute(sql`
      DELETE FROM item
      WHERE tenant_id = ${TEST_TENANT_ID} AND mapping_id = ${TEST_MAPPING_ID}
    `);

    targetReindexer = new MockTargetReindexer();
  });

  /**
   * T1: Full sync → verify passes
   */
  it('should pass verification when source and target are in sync', async () => {
    // Seed ledger with 3 messages
    const items = [
      {
        tenantId: TEST_TENANT_ID,
        mappingId: TEST_MAPPING_ID,
        itemType: 'email' as const,
        naturalKeyHash: 'hash1',
        contentHash: 'content1',
        targetId: 'target1',
        createdAt: new Date().toISOString(),
      },
      {
        tenantId: TEST_TENANT_ID,
        mappingId: TEST_MAPPING_ID,
        itemType: 'email' as const,
        naturalKeyHash: 'hash2',
        contentHash: 'content2',
        targetId: 'target2',
        createdAt: new Date().toISOString(),
      },
      {
        tenantId: TEST_TENANT_ID,
        mappingId: TEST_MAPPING_ID,
        itemType: 'email' as const,
        naturalKeyHash: 'hash3',
        contentHash: 'content3',
        targetId: 'target3',
        createdAt: new Date().toISOString(),
      },
    ];

    for (const item of items) {
      await ledger.recordIfAbsent(item);
    }

    // Mock target with same 3 messages
    targetReindexer.addEntry({ naturalKey: 'hash1', targetId: 'target1', mailboxId: 'inbox', contentHash: 'content1' });
    targetReindexer.addEntry({ naturalKey: 'hash2', targetId: 'target2', mailboxId: 'inbox', contentHash: 'content2' });
    targetReindexer.addEntry({ naturalKey: 'hash3', targetId: 'target3', mailboxId: 'inbox', contentHash: 'content3' });

    // Run verification
    const deps = createRealVerificationDeps({
      tenantId: TEST_TENANT_ID,
      mappingId: TEST_MAPPING_ID,
      config: {
        checksumSamplePercentage: 5,
        minSampleSize: 1,
        maxSampleSize: 100,
        requiredMatchPercentage: 0.99,
        maxDiscrepancyPercentage: 0.01,
        verifyMail: true,
        verifyCalendar: true,
        verifyContacts: true,
        verifyFiles: true,
      },
      ledger,
      targetReindexer,
      verificationReader: createLedgerVerificationReader({ connectionString: PG_CONNECTION_STRING }),
    });

    const result = await runVerification(deps);

    expect(result.overallStatus).toBe('PASS');
    expect(result.canProceedToCutover).toBe(true);
    expect(result.mail.status).toBe('PASS');
    expect(result.mail.sourceCount).toBe(3);
    expect(result.mail.targetCount).toBe(3);
    expect(result.mail.missingOnTarget).toBe(0);
  });

  /**
   * T2: Delete one message directly on target → verify FAILS
   */
  it('should fail verification when message is deleted from target', async () => {
    // Seed ledger with 3 messages
    const items = [
      {
        tenantId: TEST_TENANT_ID,
        mappingId: TEST_MAPPING_ID,
        itemType: 'email' as const,
        naturalKeyHash: 'hash1',
        contentHash: 'content1',
        targetId: 'target1',
        createdAt: new Date().toISOString(),
      },
      {
        tenantId: TEST_TENANT_ID,
        mappingId: TEST_MAPPING_ID,
        itemType: 'email' as const,
        naturalKeyHash: 'hash2',
        contentHash: 'content2',
        targetId: 'target2',
        createdAt: new Date().toISOString(),
      },
      {
        tenantId: TEST_TENANT_ID,
        mappingId: TEST_MAPPING_ID,
        itemType: 'email' as const,
        naturalKeyHash: 'hash3',
        contentHash: 'content3',
        targetId: 'target3',
        createdAt: new Date().toISOString(),
      },
    ];

    for (const item of items) {
      await ledger.recordIfAbsent(item);
    }

    // Mock target with only 2 messages (one deleted)
    targetReindexer.addEntry({ naturalKey: 'hash1', targetId: 'target1', mailboxId: 'inbox', contentHash: 'content1' });
    targetReindexer.addEntry({ naturalKey: 'hash2', targetId: 'target2', mailboxId: 'inbox', contentHash: 'content2' });
    // hash3 is missing

    const deps = createRealVerificationDeps({
      tenantId: TEST_TENANT_ID,
      mappingId: TEST_MAPPING_ID,
      config: {
        checksumSamplePercentage: 5,
        minSampleSize: 1,
        maxSampleSize: 100,
        requiredMatchPercentage: 0.99,
        maxDiscrepancyPercentage: 0.01,
        verifyMail: true,
        verifyCalendar: true,
        verifyContacts: true,
        verifyFiles: true,
      },
      ledger,
      targetReindexer,
      verificationReader: createLedgerVerificationReader({ connectionString: PG_CONNECTION_STRING }),
    });

    const result = await runVerification(deps);

    expect(result.overallStatus).toBe('FAIL');
    expect(result.canProceedToCutover).toBe(false);
    expect(result.mail.status).toBe('FAIL');
    expect(result.mail.missingOnTarget).toBe(1);
    expect(result.mail.sourceCount).toBe(3);
    expect(result.mail.targetCount).toBe(2);

    // Verify the error message identifies the missing item
    const missingIssue = result.mail.issues.find(i => i.id === 'MISSING_mail');
    expect(missingIssue).toBeDefined();
    expect(missingIssue?.message).toContain('1 mail item(s) missing on target');
  });

  /**
   * T3: Tolerance edges - add 1 extra message on target → WARN
   */
  it('should warn when extra items exist on target within tolerance', async () => {
    // Seed ledger with 3 messages
    const items = [
      {
        tenantId: TEST_TENANT_ID,
        mappingId: TEST_MAPPING_ID,
        itemType: 'email' as const,
        naturalKeyHash: 'hash1',
        contentHash: 'content1',
        targetId: 'target1',
        createdAt: new Date().toISOString(),
      },
      {
        tenantId: TEST_TENANT_ID,
        mappingId: TEST_MAPPING_ID,
        itemType: 'email' as const,
        naturalKeyHash: 'hash2',
        contentHash: 'content2',
        targetId: 'target2',
        createdAt: new Date().toISOString(),
      },
      {
        tenantId: TEST_TENANT_ID,
        mappingId: TEST_MAPPING_ID,
        itemType: 'email' as const,
        naturalKeyHash: 'hash3',
        contentHash: 'content3',
        targetId: 'target3',
        createdAt: new Date().toISOString(),
      },
    ];

    for (const item of items) {
      await ledger.recordIfAbsent(item);
    }

    // Mock target with 4 messages (one extra)
    targetReindexer.addEntry({ naturalKey: 'hash1', targetId: 'target1', mailboxId: 'inbox', contentHash: 'content1' });
    targetReindexer.addEntry({ naturalKey: 'hash2', targetId: 'target2', mailboxId: 'inbox', contentHash: 'content2' });
    targetReindexer.addEntry({ naturalKey: 'hash3', targetId: 'target3', mailboxId: 'inbox', contentHash: 'content3' });
    targetReindexer.addEntry({ naturalKey: 'hash4', targetId: 'target4', mailboxId: 'inbox', contentHash: 'content4' });

    const deps = createRealVerificationDeps({
      tenantId: TEST_TENANT_ID,
      mappingId: TEST_MAPPING_ID,
      config: {
        checksumSamplePercentage: 5,
        minSampleSize: 1,
        maxSampleSize: 100,
        requiredMatchPercentage: 0.99,
        maxDiscrepancyPercentage: 0.5, // High tolerance for this test
        verifyMail: true,
        verifyCalendar: true,
        verifyContacts: true,
        verifyFiles: true,
      },
      ledger,
      targetReindexer,
      verificationReader: createLedgerVerificationReader({ connectionString: PG_CONNECTION_STRING }),
    });

    const result = await runVerification(deps);

    // Should warn (not fail) because extra item is within tolerance
    expect(result.overallStatus).toBe('WARN');
    expect(result.mail.extraOnTarget).toBe(1);
  });

  /**
   * T4: Missing domain → SKIPPED status
   */
  it('should handle missing domains gracefully', async () => {
    // Only seed mail items, no calendar items
    await ledger.recordIfAbsent({
      tenantId: TEST_TENANT_ID,
      mappingId: TEST_MAPPING_ID,
      itemType: 'email' as const,
      naturalKeyHash: 'hash1',
      contentHash: 'content1',
      targetId: 'target1',
      createdAt: new Date().toISOString(),
    });

    // Add matching entry to target reindexer
    targetReindexer.addEntry({ naturalKey: 'hash1', targetId: 'target1', mailboxId: 'inbox', contentHash: 'content1' });

    const deps = createRealVerificationDeps({
      tenantId: TEST_TENANT_ID,
      mappingId: TEST_MAPPING_ID,
      config: {
        checksumSamplePercentage: 5,
        minSampleSize: 1,
        maxSampleSize: 100,
        requiredMatchPercentage: 0.99,
        maxDiscrepancyPercentage: 0.01,
        verifyMail: true,
        verifyCalendar: true,
        verifyContacts: true,
        verifyFiles: true,
      },
      ledger,
      targetReindexer,
      verificationReader: createLedgerVerificationReader({ connectionString: PG_CONNECTION_STRING }),
    });

    const result = await runVerification(deps);

    // Mail should pass (has data and matches target)
    expect(result.mail.status).toBe('PASS');
    
    // Calendar should be handled gracefully (no data - returns 0 count)
    expect(result.calendar.sourceCount).toBe(0);
    // Empty domain should PASS (nothing to verify)
    expect(result.calendar.status).toBe('PASS');
  });

  /**
   * T5: Checksum mismatch → FAIL with specific details
   */
  it('should fail verification when content checksums do not match', async () => {
    // Seed ledger with 2 messages
    await ledger.recordIfAbsent({
      tenantId: TEST_TENANT_ID,
      mappingId: TEST_MAPPING_ID,
      itemType: 'email' as const,
      naturalKeyHash: 'hash1',
      contentHash: 'content1-original',
      targetId: 'target1',
      createdAt: new Date().toISOString(),
    });

    await ledger.recordIfAbsent({
      tenantId: TEST_TENANT_ID,
      mappingId: TEST_MAPPING_ID,
      itemType: 'email' as const,
      naturalKeyHash: 'hash2',
      contentHash: 'content2-original',
      targetId: 'target2',
      createdAt: new Date().toISOString(),
    });

    // Mock target with modified content
    targetReindexer.addEntry({ naturalKey: 'hash1', targetId: 'target1', mailboxId: 'inbox', contentHash: 'content1-modified' });
    targetReindexer.addEntry({ naturalKey: 'hash2', targetId: 'target2', mailboxId: 'inbox', contentHash: 'content2-modified' });

    const deps = createRealVerificationDeps({
      tenantId: TEST_TENANT_ID,
      mappingId: TEST_MAPPING_ID,
      config: {
        checksumSamplePercentage: 100, // Sample all items
        minSampleSize: 1,
        maxSampleSize: 100,
        requiredMatchPercentage: 0.99,
        maxDiscrepancyPercentage: 0.01,
        verifyMail: true,
        verifyCalendar: true,
        verifyContacts: true,
        verifyFiles: true,
      },
      ledger,
      targetReindexer,
      verificationReader: createLedgerVerificationReader({ connectionString: PG_CONNECTION_STRING }),
    });

    const result = await runVerification(deps);

    // Should fail due to checksum mismatches
    expect(result.overallStatus).toBe('FAIL');
    expect(result.mail.checksumMismatches).toBeGreaterThan(0);

    // Verify error message includes checksum issue
    const checksumIssue = result.mail.issues.find(i => i.id === 'CHECKSUM_mail');
    expect(checksumIssue).toBeDefined();
    expect(checksumIssue?.severity).toBe('ERROR');
  });
});
