// Copyright 2026 OpenHands Agent (Apache-2.0)
// Integration tests for JMAP target reindex functionality.
// Tests the listEntries method and reindexFromTarget function with Stalwart.
//
// TEST ISOLATION STRATEGY:
// - Uses shared Stalwart accounts (source@dev.local, target@dev.local)
// - Cleans ALL target mailboxes before each test to prevent data leakage
// - Cleans database state (cursors, ledger entries) for the test tenant
// This is simpler and more efficient than unique accounts per test.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import type { ImapSimpleOptions } from 'imap-simple';
import { sql } from 'drizzle-orm';
import { createPgDb } from '../../../packages/ledger/src/db';
import { PgLedger } from '../../../packages/ledger/src/ledger';
import { ImapSource } from '../../../packages/connectors/src/imap-source';
import { JmapTargetWriter } from '../../../packages/connectors/src/jmap-target';
import { runShadowPass } from '../../../packages/core/src/reconcile';
import { reindexFromTarget } from '../../../packages/core/src/reindex';
import { asTenantId, asMappingId, type MailItem } from '@openmig/shared';
import imap from 'imap-simple';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Connection string from Testcontainers
const PG_CONNECTION_STRING = process.env.TEST_DATABASE_URL;
if (!PG_CONNECTION_STRING) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Integration tests require Testcontainers to be running. ' +
    'Run: pnpm test:integration'
  );
}

// Stalwart configuration from Testcontainers (shared instance)
const STALWART_IMAP_HOST = process.env.STALWART_IMAP_HOST;
const STALWART_IMAP_PORT = parseInt(process.env.STALWART_IMAP_PORT || '993', 10);
const STALWART_JMAP_URL = process.env.STALWART_JMAP_URL;
const STALWART_JMAP_USERNAME = process.env.STALWART_JMAP_USERNAME || 'target@dev.local';
const STALWART_JMAP_PASSWORD = process.env.STALWART_JMAP_PASSWORD || 'target_password';

// Skip tests if Stalwart is not available (for faster iteration without full stack)
if (!STALWART_IMAP_HOST || !STALWART_JMAP_URL) {
  console.warn('[jmap-reindex] Skipping tests: Stalwart not available. Set STALWART_IMAP_HOST and STALWART_JMAP_URL to enable.');
  describe.skip('JMAP Reindex Integration', () => {
    it('skipped - Stalwart not configured', () => {
      expect(true).toBe(true);
    });
  });
} else {

// Test accounts (shared, but cleaned between tests)
const SOURCE_ACCOUNT = 'source@dev.local';
const SOURCE_PASSWORD = 'source_password';
const TARGET_ACCOUNT = 'target@dev.local';
const TARGET_PASSWORD = 'target_password';

// Retry configuration for IMAP connection
const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 2000;

// Fixed UUIDs for reindex testing (consistent across runs for reproducibility)
const REINDEX_TENANT_ID = asTenantId('5e0b0000-e29b-41d4-a716-446655440001' as never);
const REINDEX_MAPPING_ID = asMappingId('5e0b0000-e29b-41d4-a716-446655440002' as never);

/**
 * Wait for schema to be ready by checking if a table exists.
 */
async function waitForSchema(maxRetries = 30, delayMs = 1000): Promise<void> {
  if (!PG_CONNECTION_STRING) {
    throw new Error('TEST_DATABASE_URL is not set');
  }
  const client = createPgDb(PG_CONNECTION_STRING);
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      const result = await client.execute<{ exists: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables 
          WHERE table_schema = 'public' AND table_name = 'mailbox'
        ) as exists
      `);
      if (result.rows[0]?.exists) {
        return;
      }
    } catch {
      // Ignore connection errors during startup
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  
  throw new Error('Schema not ready after max retries');
}

/**
 * Clean all messages from target account mailboxes.
 * This ensures test isolation by removing any data from previous test runs.
 */
async function cleanTargetMailboxes(): Promise<void> {
  if (!STALWART_IMAP_HOST) {
    console.warn('[Cleanup] STALWART_IMAP_HOST not set, skipping cleanup');
    return;
  }

  const config: ImapSimpleOptions = {
    imap: {
      user: TARGET_ACCOUNT,
      password: TARGET_PASSWORD,
      host: STALWART_IMAP_HOST,
      port: STALWART_IMAP_PORT,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      authTimeout: 3000,
    },
  };

  let conn: unknown = null;
  
  try {
    conn = await imap.connect(config);
    
    // Get all mailboxes
    const mailboxes: Record<string, { name: string }> = await (conn as { getMailboxes: () => Promise<Record<string, { name: string }>> }).getMailboxes();
    
    // Delete all messages from each mailbox
    for (const mailbox of Object.values(mailboxes)) {
      try {
        const mb = mailbox;
        await (conn as { openBox: (name: string) => Promise<void> }).openBox(mb.name);
        
        // Fetch all messages
        const searchCriteria = ['ALL'];
        const fetchResults: Array<{ attributes: { uid: number } }> = await (conn as { search: (criteria: string[], opts: unknown) => Promise<Array<{ attributes: { uid: number } }>> }).search(searchCriteria, {
          fields: ['ENVELOPE', 'RFC822.SIZE'],
        });
        
        if (fetchResults.length > 0) {
          // Get message UIDs for deletion
          const uids = fetchResults.map((r) => r.attributes.uid);
          
          // Mark all messages as deleted
          await (conn as { addFlags: (uids: number[], flags: string) => Promise<void> }).addFlags(uids, '\\Deleted');
          
          // Expunge to actually remove them
          await (conn as { expunge: () => Promise<void> }).expunge();
          
          console.log(`[Cleanup] Deleted ${fetchResults.length} messages from ${mb.name}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const mbName = (mailbox as { name: string })?.name || 'unknown';
        console.warn(`[Cleanup] Warning: Could not clean mailbox ${mbName}: ${msg}`);
      }
    }
    
    console.log('[Cleanup] Target mailboxes cleaned');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Cleanup] Warning: Could not clean mailboxes: ${msg}`);
    // Don't fail the test if cleanup fails - just warn
  } finally {
    if (conn) {
      (conn as { end: () => void }).end();
    }
  }
}

/**
 * Clean database state for the test tenant.
 */
async function cleanDatabaseState(): Promise<void> {
  if (!PG_CONNECTION_STRING) {
    throw new Error('TEST_DATABASE_URL is not set');
  }
  const client = createPgDb(PG_CONNECTION_STRING);
  
  try {
    // Delete cursor entries for this mapping
    await client.execute(sql`
      DELETE FROM cursor 
      WHERE mapping_id = ${REINDEX_MAPPING_ID}
    `);
    
    // Delete ledger/item entries for this tenant
    await client.execute(sql`
      DELETE FROM item 
      WHERE tenant_id = ${REINDEX_TENANT_ID}
    `);
    
    // Delete mailbox mappings for this tenant
    await client.execute(sql`
      DELETE FROM mailbox_mapping 
      WHERE tenant_id = ${REINDEX_TENANT_ID}
    `);
    
    // Delete mailboxes for this tenant
    await client.execute(sql`
      DELETE FROM mailbox 
      WHERE tenant_id = ${REINDEX_TENANT_ID}
    `);
    
    // Delete connections for this tenant
    await client.execute(sql`
      DELETE FROM connection 
      WHERE tenant_id = ${REINDEX_TENANT_ID}
    `);
    
    // Create tenant if it doesn't exist
    await client.execute(sql`
      INSERT INTO tenant (id, name, status)
      VALUES (${REINDEX_TENANT_ID}, 'Test Tenant', 'active')
      ON CONFLICT (id) DO NOTHING
    `);
    
    // Create source connection
    const sourceConnId = '5e0b0000-e29b-41d4-a716-446655440003';
    await client.execute(sql`
      INSERT INTO connection (id, tenant_id, role, kind, display_name, config, status)
      VALUES (${sourceConnId}, ${REINDEX_TENANT_ID}, 'source', 'imap', 'Test Source', '{}', 'connected')
      ON CONFLICT (id) DO NOTHING
    `);
    
    // Create target connection
    const targetConnId = '5e0b0000-e29b-41d4-a716-446655440004';
    await client.execute(sql`
      INSERT INTO connection (id, tenant_id, role, kind, display_name, config, status)
      VALUES (${targetConnId}, ${REINDEX_TENANT_ID}, 'target', 'selfhosted_mail', 'Test Target', '{}', 'connected')
      ON CONFLICT (id) DO NOTHING
    `);
    
    // Create source mailbox
    const sourceMailboxId = '5e0b0000-e29b-41d4-a716-446655440005';
    await client.execute(sql`
      INSERT INTO mailbox (id, tenant_id, connection_id, kind, display_name, status)
      VALUES (${sourceMailboxId}, ${REINDEX_TENANT_ID}, ${sourceConnId}, 'user', 'INBOX', 'active')
      ON CONFLICT (id) DO NOTHING
    `);
    
    // Create target mailbox
    const targetMailboxId = '5e0b0000-e29b-41d4-a716-446655440006';
    await client.execute(sql`
      INSERT INTO mailbox (id, tenant_id, connection_id, kind, display_name, status)
      VALUES (${targetMailboxId}, ${REINDEX_TENANT_ID}, ${targetConnId}, 'user', 'INBOX', 'active')
      ON CONFLICT (id) DO NOTHING
    `);
    
    // Create mailbox mapping
    await client.execute(sql`
      INSERT INTO mailbox_mapping (id, tenant_id, source_mailbox_id, target_mailbox_id, mode, status)
      VALUES (${REINDEX_MAPPING_ID}, ${REINDEX_TENANT_ID}, ${sourceMailboxId}, ${targetMailboxId}, 'mirror', 'active')
      ON CONFLICT (id) DO NOTHING
    `);
    
    console.log('[Cleanup] Database state cleaned for tenant', REINDEX_TENANT_ID);
  } finally {
    // Note: createPgDb returns a client that doesn't have an end() method
    // The connection is managed by the pool
  }
}

/**
 * Wait for IMAP server to be available with retry logic.
 */
async function waitForImap(host: string, port: number): Promise<void> {
  const net = await import('node:net');
  
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const client = new net.Socket();
        const timeout = setTimeout(() => {
          client.destroy();
          reject(new Error('Connection timeout'));
        }, 5000);
        
        client.connect(port, host, () => {
          clearTimeout(timeout);
          client.destroy();
          resolve();
        });
        
        client.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
      return;
    } catch (err) {
      if (i < MAX_RETRIES - 1) {
        console.log(`[IMAP] Connection attempt ${i + 1}/${MAX_RETRIES} failed, retrying in ${RETRY_DELAY_MS}ms...`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      } else {
        throw err;
      }
    }
  }
}

/**
 * Append options for IMAP append operation.
 */
interface AppendOptions {
  mailbox?: string;
  flags?: string | string[];
  date?: Date;
}

/**
 * Seed test messages to source account (IMAP).
 */
async function seedReindex(): Promise<void> {
  const config: ImapSimpleOptions = {
    imap: {
      user: SOURCE_ACCOUNT,
      password: SOURCE_PASSWORD,
      host: STALWART_IMAP_HOST,
      port: STALWART_IMAP_PORT,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      authTimeout: 3000,
    },
  };

  const conn = await imap.connect(config);

  try {
    const messages = [
      {
        messageId: '<reindex-message-1@dev.local>',
        subject: 'Reindex Message 1',
        body: 'This is the first reindex test message.',
      },
      {
        messageId: '<reindex-message-2@dev.local>',
        subject: 'Reindex Message 2',
        body: 'This is the second reindex test message.',
      },
      {
        messageId: '<reindex-message-3@dev.local>',
        subject: 'Reindex Message 3',
        body: 'This is the third reindex test message.',
      },
    ];

    for (const msg of messages) {
      const rfc822 = `From: ${SOURCE_ACCOUNT}
To: ${TARGET_ACCOUNT}
Subject: ${msg.subject}
Message-ID: ${msg.messageId}
Date: ${new Date().toUTCString()}
Content-Type: text/plain; charset=utf-8

${msg.body}
`;

      await conn.append(rfc822, {
        mailbox: 'INBOX',
      } as AppendOptions);
    }

    console.log('[seedReindex] Seeded', messages.length, 'test messages to source');
  } finally {
    conn.end();
  }
}

describe('JMAP Reindex Integration Tests', () => {
  let db: ReturnType<typeof createPgDb>;
  let ledger: InstanceType<typeof PgLedger>;
  let source: InstanceType<typeof ImapSource>;
  let target: InstanceType<typeof JmapTargetWriter>;

  beforeAll(async () => {
    console.log('[JMAP Reindex] Waiting for IMAP server...');
    await waitForImap(STALWART_IMAP_HOST, STALWART_IMAP_PORT);
    console.log('[JMAP Reindex] IMAP server is ready');
    
    // Wait for schema to be ready
    console.log('[JMAP Reindex] Waiting for database schema...');
    await waitForSchema();
    console.log('[JMAP Reindex] Database schema is ready');
    
    // Initialize database and ledger
    db = createPgDb(PG_CONNECTION_STRING);
    ledger = new PgLedger(db);
    
    // Initialize source and target
    source = new ImapSource({
      host: STALWART_IMAP_HOST,
      port: STALWART_IMAP_PORT,
      tls: true,
      auth: {
        user: SOURCE_ACCOUNT,
        password: SOURCE_PASSWORD,
      },
    });
    
    target = new JmapTargetWriter({
      baseUrl: STALWART_JMAP_URL,
      username: STALWART_JMAP_USERNAME,
      password: STALWART_JMAP_PASSWORD,
    });
    
    console.log('[JMAP Reindex] Test setup complete');
  }, 30000);

  beforeEach(async () => {
    // Clean target mailboxes before each test
    console.log('[JMAP Reindex] Cleaning target mailboxes...');
    await cleanTargetMailboxes();
    
    // Clean database state
    console.log('[JMAP Reindex] Cleaning database state...');
    await cleanDatabaseState();

    // NOTE: intentionally do NOT call target.connect() here. The production sync path
    // (runShadowPass/runDomainSync) never calls it — the TargetWriter interface has no
    // connect() — so the writer must self-connect lazily on first use. Exercising that path
    // here is what actually covers the "Not connected to JMAP server" bug (an explicit
    // connect() masked it, so the test passed while the real path was broken).

    // Seed fresh test data
    console.log('[JMAP Reindex] Seeding test data...');
    await seedReindex();
    
    console.log('[JMAP Reindex] Test environment ready');
  });

  afterAll(async () => {
    // Final cleanup
    console.log('[JMAP Reindex] Final cleanup...');
    await cleanTargetMailboxes();
    await cleanDatabaseState();
    
    // Note: db connection is managed by the pool and doesn't need explicit closing
    console.log('[JMAP Reindex] Cleanup complete');
  }, 30000);

  describe('listEntries', () => {
    it('should return entries from target with natural keys', async () => {
      // Run shadow pass to sync messages from source to target
      await runShadowPass({
        source,
        target,
        mappingId: REINDEX_MAPPING_ID,
        tenantId: REINDEX_TENANT_ID,
        ledger,
      });

      const entries = [];
      for await (const entry of target.listEntries()) {
        entries.push(entry);
      }
      
      console.log('[listEntries] Found', entries.length, 'entries');
      
      // Should have at least 3 entries (we seeded 3 messages)
      expect(entries.length).toBeGreaterThanOrEqual(3);
      
      // Each entry should have a naturalKey (Message-ID)
      for (const entry of entries) {
        expect(entry.naturalKey).toBeDefined();
        expect(entry.naturalKey).toMatch(/^<.*@.*>$/);
      }
    });

    it('should return empty results after reindex with no new messages', async () => {
      // Run mirror to sync messages
      await runShadowPass({
        source,
        target,
        mappingId: REINDEX_MAPPING_ID,
        tenantId: REINDEX_TENANT_ID,
        ledger,
      });
      
      // Run reindex - should find no new messages since we just synced
      const result = await reindexFromTarget({
        tenantId: REINDEX_TENANT_ID,
        mappingId: REINDEX_MAPPING_ID,
        reindexer: target,
        ledger,
      });
      
      // Should have processed entries but no new items to add
      expect(result.adopted).toBe(0);
    });

    it('should handle reindex after new messages are added', async () => {
      // First sync existing messages
      await runShadowPass({
        source,
        target,
        mappingId: REINDEX_MAPPING_ID,
        tenantId: REINDEX_TENANT_ID,
        ledger,
      });

      // Get the target mailbox ID (INBOX)
      const targetMailboxId = await target.ensureMailbox({
        path: 'INBOX',
        name: 'INBOX',
        specialUse: 'inbox',
      });

      // Add a new message directly to the target (simulating a message added outside the migration)
      const newMessage = `From: ${TARGET_ACCOUNT}
To: ${SOURCE_ACCOUNT}
Subject: New Message After Sync
Message-ID: <new-message-after-sync@dev.local>
Date: ${new Date().toUTCString()}
Content-Type: text/plain; charset=utf-8

This message was added directly to the target after the initial sync.
`;

      const newMessageItem: MailItem = {
        messageId: '<new-message-after-sync@dev.local>',
        folder: {
          path: 'INBOX',
          name: 'INBOX',
          specialUse: 'inbox',
        },
        keywords: [],
        receivedAt: new Date().toISOString(),
        sourceRef: 'INBOX:1',
      };

      await target.upsertEmail(targetMailboxId, {
        item: newMessageItem,
        rfc822: new Uint8Array(Buffer.from(newMessage)),
      }, []);

      // Verify the message was added by checking listEntries
      let foundNewMessage = false;
      for await (const entry of target.listEntries()) {
        if (entry.naturalKey === '<new-message-after-sync@dev.local>') {
          foundNewMessage = true;
          break;
        }
      }
      expect(foundNewMessage).toBe(true);

      // Run reindex - should find the new message in the target
      const result = await reindexFromTarget({
        tenantId: REINDEX_TENANT_ID,
        mappingId: REINDEX_MAPPING_ID,
        reindexer: target,
        ledger,
      });

      // Should have added at least 1 new item
      expect(result.adopted).toBeGreaterThanOrEqual(1);
    });

    it('should be idempotent - re-running reindex should not add duplicates', async () => {
      // Setup: sync messages from source to target
      await runShadowPass({
        source,
        target,
        mappingId: REINDEX_MAPPING_ID,
        tenantId: REINDEX_TENANT_ID,
        ledger,
      });

      // Run reindex twice
      const result1 = await reindexFromTarget({
        tenantId: REINDEX_TENANT_ID,
        mappingId: REINDEX_MAPPING_ID,
        reindexer: target,
        ledger,
      });

      const result2 = await reindexFromTarget({
        tenantId: REINDEX_TENANT_ID,
        mappingId: REINDEX_MAPPING_ID,
        reindexer: target,
        ledger,
      });

      // First run should adopt items
      expect(result1.adopted).toBeGreaterThan(0);

      // Second run should adopt nothing (already synced)
      expect(result2.adopted).toBe(0);
    });
  });
});
}
