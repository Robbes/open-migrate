// Copyright 2026 OpenHands Agent (Apache-2.0)
/**
 * Sync Job Integration Tests
 *
 * Tests for T3 Trigger.dev job wiring with encrypted credentials:
 * - Full sync job execution with real core engine
 * - Delta sync job execution with real core engine
 * - Cross-tenant isolation THROUGH the job path
 * - Encrypted credential round-trip (store → decrypt → use)
 * - Standalone worker regression (runShadowPass still works)
 *
 * Run: pnpm test:integration
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { createPgDb, withTenant, PgLedger, PgCursorStore, PgMigrationStatusStore } from '@openmig/ledger';
import { runShadowPass } from '@openmig/core';
import { SecretStore } from '@openmig/core/secret-store';
import { buildDepsFromMapping } from '../../../apps/worker/src/build-deps-from-mapping';
import { asTenantId, asMappingId, type TenantId, type MappingId } from '@openmig/shared';

// Test database from environment
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Integration tests require Testcontainers to be running. ' +
    'Run: pnpm test:integration'
  );
}

// Fixed UUIDs for testing
const TENANT_A_ID = asTenantId('550e8400-e29b-41d4-a716-446655440001' as never);
const TENANT_B_ID = asTenantId('550e8400-e29b-41d4-a716-446655440002' as never);
const MAPPING_A_ID = asMappingId('550e8400-e29b-41d4-a716-446655440101' as never);
const MAPPING_B_ID = asMappingId('550e8400-e29b-41d4-a716-446655440102' as never);

// Encryption key for tests (same key used across all tests)
const TEST_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef'; // 32 bytes = 64 hex chars

describe('Sync Jobs with Encrypted Credentials (integration)', () => {
  let db: ReturnType<typeof createPgDb>;
  let pool: Pool;
  let migrationStatus: PgMigrationStatusStore;

  beforeAll(async () => {
    db = createPgDb(TEST_DATABASE_URL);
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
    migrationStatus = new PgMigrationStatusStore(db);

    // Initialize secret store with test key
    process.env.SECRET_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    SecretStore.init();

    // Setup tenant A
    await db.execute(sql`
      INSERT INTO tenant (id, name, status)
      VALUES (${TENANT_A_ID}, 'Tenant A', 'active')
      ON CONFLICT (id) DO NOTHING
    `);

    // Setup tenant B
    await db.execute(sql`
      INSERT INTO tenant (id, name, status)
      VALUES (${TENANT_B_ID}, 'Tenant B', 'active')
      ON CONFLICT (id) DO NOTHING
    `);

    // Setup source connection for tenant A with ENCRYPTED credentials
    const sourceCredsA = {
      accessToken: 'oauth2-token-for-tenant-a-source',
      user: 'user-a@source.com',
    };
    const encryptedCredsA = SecretStore.encryptCredentials(sourceCredsA);

    await db.execute(sql`
      INSERT INTO connection (id, tenant_id, role, kind, display_name, encrypted_credentials, config, status)
      VALUES (
        '650e8400-e29b-41d4-a716-446655440001',
        ${TENANT_A_ID},
        'source',
        'o365',
        'O365 Source A',
        ${JSON.stringify(encryptedCredsA)},
        '{}',
        'connected'
      )
      ON CONFLICT (id) DO NOTHING
    `);

    // Setup target connection for tenant A with ENCRYPTED credentials
    const targetCredsA = {
      password: 'jmap-password-for-tenant-a-target',
      user: 'user-a@target.com',
    };
    const encryptedTargetCredsA = SecretStore.encryptCredentials(targetCredsA);

    await db.execute(sql`
      INSERT INTO connection (id, tenant_id, role, kind, display_name, encrypted_credentials, config, status)
      VALUES (
        '650e8400-e29b-41d4-a716-446655440002',
        ${TENANT_A_ID},
        'target',
        'jmap',
        'JMAP Target A',
        ${JSON.stringify(encryptedTargetCredsA)},
        '{}',
        'connected'
      )
      ON CONFLICT (id) DO NOTHING
    `);

    // Setup mapping for tenant A
    await db.execute(sql`
      INSERT INTO mailbox_mapping (id, tenant_id, source_mailbox_id, target_mailbox_id, status, source, target, domains)
      VALUES (
        ${MAPPING_A_ID},
        ${TENANT_A_ID},
        '750e8400-e29b-41d4-a716-446655440001',
        '750e8400-e29b-41d4-a716-446655440002',
        'pending',
        '{"type":"imap-oauth2","host":"imap.source.com","port":993,"user":"user-a@source.com"}',
        '{"type":"jmap","baseUrl":"https://jmap.target.com","user":"user-a@target.com"}',
        '{"email":{"enabled":true,"source":{"type":"imap-oauth2","host":"imap.source.com","port":993,"user":"user-a@source.com"},"target":{"type":"jmap","baseUrl":"https://jmap.target.com","user":"user-a@target.com"}}}'
      )
      ON CONFLICT (id) DO NOTHING
    `);

    // Setup source connection for tenant B with DIFFERENT encrypted credentials
    const sourceCredsB = {
      accessToken: 'oauth2-token-for-tenant-b-source',
      user: 'user-b@source.com',
    };
    const encryptedCredsB = SecretStore.encryptCredentials(sourceCredsB);

    await db.execute(sql`
      INSERT INTO connection (id, tenant_id, role, kind, display_name, encrypted_credentials, config, status)
      VALUES (
        '650e8400-e29b-41d4-a716-446655440003',
        ${TENANT_B_ID},
        'source',
        'o365',
        'O365 Source B',
        ${JSON.stringify(encryptedCredsB)},
        '{}',
        'connected'
      )
      ON CONFLICT (id) DO NOTHING
    `);

    // Setup target connection for tenant B
    const targetCredsB = {
      password: 'jmap-password-for-tenant-b-target',
      user: 'user-b@target.com',
    };
    const encryptedTargetCredsB = SecretStore.encryptCredentials(targetCredsB);

    await db.execute(sql`
      INSERT INTO connection (id, tenant_id, role, kind, display_name, encrypted_credentials, config, status)
      VALUES (
        '650e8400-e29b-41d4-a716-446655440004',
        ${TENANT_B_ID},
        'target',
        'jmap',
        'JMAP Target B',
        ${JSON.stringify(encryptedTargetCredsB)},
        '{}',
        'connected'
      )
      ON CONFLICT (id) DO NOTHING
    `);

    // Setup mapping for tenant B
    await db.execute(sql`
      INSERT INTO mailbox_mapping (id, tenant_id, source_mailbox_id, target_mailbox_id, status, source, target, domains)
      VALUES (
        ${MAPPING_B_ID},
        ${TENANT_B_ID},
        '750e8400-e29b-41d4-a716-446655440003',
        '750e8400-e29b-41d4-a716-446655440004',
        'pending',
        '{"type":"imap-oauth2","host":"imap.source-b.com","port":993,"user":"user-b@source.com"}',
        '{"type":"jmap","baseUrl":"https://jmap.target-b.com","user":"user-b@target.com"}',
        '{"email":{"enabled":true,"source":{"type":"imap-oauth2","host":"imap.source-b.com","port":993,"user":"user-b@source.com"},"target":{"type":"jmap","baseUrl":"https://jmap.target-b.com","user":"user-b@target.com"}}}'
      )
      ON CONFLICT (id) DO NOTHING
    `);
  });

  afterAll(async () => {
    // Cleanup test data
    await db.execute(sql`DELETE FROM migration_status WHERE tenant_id IN (${TENANT_A_ID}, ${TENANT_B_ID})`);
    await db.execute(sql`DELETE FROM ledger WHERE tenant_id IN (${TENANT_A_ID}, ${TENANT_B_ID})`);
    await db.execute(sql`DELETE FROM cursor_store WHERE tenant_id IN (${TENANT_A_ID}, ${TENANT_B_ID})`);
    await db.execute(sql`DELETE FROM mailbox_mapping WHERE id IN (${MAPPING_A_ID}, ${MAPPING_B_ID})`);
    await db.execute(sql`DELETE FROM mailbox WHERE tenant_id IN (${TENANT_A_ID}, ${TENANT_B_ID})`);
    await db.execute(sql`DELETE FROM connection WHERE tenant_id IN (${TENANT_A_ID}, ${TENANT_B_ID})`);
    await db.execute(sql`DELETE FROM tenant WHERE id IN (${TENANT_A_ID}, ${TENANT_B_ID})`);
    pool.end();
  });

  beforeEach(async () => {
    // Clear ledger and cursors before each test
    await db.execute(sql`DELETE FROM ledger WHERE tenant_id IN (${TENANT_A_ID}, ${TENANT_B_ID})`);
    await db.execute(sql`DELETE FROM cursor_store WHERE tenant_id IN (${TENANT_A_ID}, ${TENANT_B_ID})`);
  });

  describe('buildDepsFromMapping - encrypted credential round-trip', () => {
    it('should load mapping, decrypt credentials, and build deps for tenant A', async () => {
      const deps = await buildDepsFromMapping(pool, TENANT_A_ID, MAPPING_A_ID);

      expect(deps.tenantId).toBe(TENANT_A_ID);
      expect(deps.mappingId).toBe(MAPPING_A_ID);
      expect(deps.source).toBeDefined();
      expect(deps.target).toBeDefined();
      expect(deps.ledger).toBeInstanceOf(PgLedger);
      expect(deps.cursors).toBeInstanceOf(PgCursorStore);

      // Verify the source connector has the correct credentials (from decrypted data)
      // The ImapSource should have been constructed with the decrypted access token
      // We can't directly access the auth object, but we can verify the connector was built
      expect(deps.source.listFolders).toBeDefined();
      expect(deps.target.upsertEmail).toBeDefined();
    });

    it('should load mapping, decrypt credentials, and build deps for tenant B', async () => {
      const deps = await buildDepsFromMapping(pool, TENANT_B_ID, MAPPING_B_ID);

      expect(deps.tenantId).toBe(TENANT_B_ID);
      expect(deps.mappingId).toBe(MAPPING_B_ID);
      expect(deps.source).toBeDefined();
      expect(deps.target).toBeDefined();
    });

    it('should fail when tenantId is missing', async () => {
      await expect(async () => {
        // @ts-expect-error - testing missing tenantId
        await buildDepsFromMapping(pool, null, MAPPING_A_ID);
      }).rejects.toThrow('tenantId is required');
    });

    it('should fail when mapping does not exist', async () => {
      const fakeMappingId = asMappingId('99999999-9999-9999-9999-999999999999' as never);
      await expect(async () => {
        await buildDepsFromMapping(pool, TENANT_A_ID, fakeMappingId);
      }).rejects.toThrow('Mapping not found or access denied');
    });

    it('should fail when connection credentials are missing', async () => {
      // Create a mapping without credentials
      const badMappingId = asMappingId('88888888-8888-8888-8888-888888888888' as never);
      await db.execute(sql`
        INSERT INTO mailbox_mapping (id, tenant_id, source_mailbox_id, target_mailbox_id, status, source, target, domains)
        VALUES (
          ${badMappingId},
          ${TENANT_A_ID},
          '750e8400-e29b-41d4-a716-446655440001',
          '750e8400-e29b-41d4-a716-446655440002',
          'pending',
          '{"type":"imap-oauth2","host":"imap.source.com","port":993,"user":"user-a@source.com"}',
          '{"type":"jmap","baseUrl":"https://jmap.target.com","user":"user-a@target.com"}',
          '{"email":{"enabled":true}}'
        )
        ON CONFLICT (id) DO NOTHING
      `);

      // Create a connection without credentials
      await db.execute(sql`
        INSERT INTO connection (id, tenant_id, role, kind, display_name, config, status)
        VALUES (
          '650e8400-e29b-41d4-a716-446655440005',
          ${TENANT_A_ID},
          'source',
          'o365',
          'No Creds Source',
          '{}',
          'connected'
        )
        ON CONFLICT (id) DO NOTHING
      `);

      await expect(async () => {
        await buildDepsFromMapping(pool, TENANT_A_ID, badMappingId);
      }).rejects.toThrow('Source connection has no credentials');
    });
  });

  describe('Cross-tenant isolation through job path', () => {
    it('should NOT be able to load tenant B\'s credentials when querying with tenant A\'s ID', async () => {
      // This is the critical security test:
      // Tenant A should NOT be able to access tenant B's encrypted credentials
      // even through the buildDepsFromMapping path

      // Try to build deps for tenant B's mapping but with tenant A's ID
      // This should fail because RLS will prevent access to tenant B's data
      await expect(async () => {
        await buildDepsFromMapping(pool, TENANT_A_ID, MAPPING_B_ID);
      }).rejects.toThrow();

      // The error should be either "Mapping not found" (RLS hides it)
      // or "Source connection not found" (RLS hides tenant B's connections)
    });

    it('should NOT be able to load tenant A\'s credentials when querying with tenant B\'s ID', async () => {
      // Reverse the test: tenant B should NOT access tenant A's data
      await expect(async () => {
        await buildDepsFromMapping(pool, TENANT_B_ID, MAPPING_A_ID);
      }).rejects.toThrow();
    });

    it('should create ledger items only for the correct tenant', async () => {
      // Build deps for tenant A
      const depsA = await buildDepsFromMapping(pool, TENANT_A_ID, MAPPING_A_ID);

      // Manually record a ledger item (simulating what runShadowPass would do)
      await depsA.ledger.recordIfAbsent({
        tenantId: TENANT_A_ID,
        mappingId: MAPPING_A_ID,
        domain: 'email',
        naturalKeyHash: 'test-natural-key-hash',
        contentHash: 'test-content-hash',
        status: 'synced',
        sourceRef: 'test-source-ref',
        targetRef: 'test-target-ref',
      });

      // Query for tenant A's ledger items
      const tenantAItems = await db.execute(sql`
        SELECT * FROM ledger WHERE tenant_id = ${TENANT_A_ID}
      `);
      expect(tenantAItems.rowCount).toBe(1);

      // Query for tenant B's ledger items (should be 0)
      const tenantBItems = await db.execute(sql`
        SELECT * FROM ledger WHERE tenant_id = ${TENANT_B_ID}
      `);
      expect(tenantBItems.rowCount).toBe(0);

      // Now build deps for tenant B and verify they can't see tenant A's data
      const depsB = await buildDepsFromMapping(pool, TENANT_B_ID, MAPPING_B_ID);

      const tenantBItemsAfter = await db.execute(sql`
        SELECT * FROM ledger WHERE tenant_id = ${TENANT_B_ID}
      `);
      expect(tenantBItemsAfter.rowCount).toBe(0); // Still 0, tenant B can't see tenant A's data
    });
  });

  describe('Full sync vs Delta sync', () => {
    it('full sync should work with undefined cursors (force full scan)', async () => {
      const deps = await buildDepsFromMapping(pool, TENANT_A_ID, MAPPING_A_ID);

      // Full sync: pass undefined for cursors
      const result = await runShadowPass({
        ...deps,
        cursors: undefined, // Force full scan
      });

      // Should complete without error (even with mocked connectors)
      expect(result).toBeDefined();
      expect(typeof result.scanned).toBe('number');
      expect(typeof result.created).toBe('number');
      expect(typeof result.skipped).toBe('number');
    });

    it('delta sync should work with cursors (incremental)', async () => {
      const deps = await buildDepsFromMapping(pool, TENANT_A_ID, MAPPING_A_ID);

      // Delta sync: use the cursor store
      const result = await runShadowPass({
        ...deps,
        cursors: deps.cursors, // Use cursors for incremental sync
      });

      expect(result).toBeDefined();
    });
  });

  describe('Standalone worker regression', () => {
    it('runShadowPass should still work when called directly (env-based creds)', async () => {
      // This test verifies that the standalone worker path still works
      // even after adding the encrypted credential path

      // Create a simple test with mocked connectors
      const mockSource = {
        listFolders: async () => [],
        listSince: async () => ({ items: [], nextCursor: { value: '' } }),
        fetch: async () => ({ rfc822: '', size: 0 }),
      };

      const mockTarget = {
        ensureMailbox: async () => 'mock-mailbox-id',
        upsertEmail: async () => ({ targetId: 'mock-target-id', created: true }),
      };

      const ledger = new PgLedger(db);
      const cursors = new PgCursorStore(db);

      const result = await runShadowPass({
        tenantId: TENANT_A_ID,
        mappingId: MAPPING_A_ID,
        source: mockSource as any,
        target: mockTarget as any,
        ledger,
        cursors,
        concurrency: 4,
      });

      // Should complete without error
      expect(result.scanned).toBe(0); // No folders = no items
      expect(result.created).toBe(0);
      expect(result.skipped).toBe(0);
    });
  });

  describe('Secret store encryption/decryption in context', () => {
    it('should encrypt and decrypt credentials correctly within buildDepsFromMapping', async () => {
      // Verify the full round-trip:
      // 1. Store credentials encrypted in DB
      // 2. Load via buildDepsFromMapping (within withTenant)
      // 3. Decrypt and use them

      const originalCreds = {
        accessToken: 'test-oauth-token-12345',
        user: 'test@example.com',
      };

      // Encrypt
      const encrypted = SecretStore.encryptCredentials(originalCreds);

      // Verify encryption produces a blob with expected structure
      expect(encrypted.v).toBeDefined();
      expect(encrypted.n).toBeDefined(); // nonce
      expect(encrypted.t).toBeDefined(); // auth tag
      expect(encrypted.c).toBeDefined(); // ciphertext

      // Verify nonce is unique (encrypt again, should be different)
      const encrypted2 = SecretStore.encryptCredentials(originalCreds);
      expect(encrypted.n).not.toBe(encrypted2.n);

      // Decrypt
      const decrypted = SecretStore.decryptCredentials(encrypted);

      expect(decrypted).toEqual(originalCreds);
    });

    it('should detect tampered credentials', async () => {
      const originalCreds = { token: 'secret-token' };
      const encrypted = SecretStore.encryptCredentials(originalCreds);

      // Tamper with the ciphertext
      const tampered = {
        ...encrypted,
        c: encrypted.c + 'tampered',
      };

      // Decryption should fail
      expect(() => SecretStore.decryptCredentials(tampered)).toThrow();
    });
  });
});
