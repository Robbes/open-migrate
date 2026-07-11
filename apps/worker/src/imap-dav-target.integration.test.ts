// Copyright 2026 OpenHands Agent (Apache-2.0)
// Integration tests for IMAP/DAV target writer (ImapDavMailTarget).
// Tests idempotency, delta, and reindex functionality against Stalwart's IMAP backend.
//
// TEST ISOLATION STRATEGY:
// - Uses shared Stalwart IMAP account (target@dev.local)
// - Cleans ALL target mailboxes before each test
// - Cleans database state for the test tenant
// This follows the same pattern as jmap-reindex.integration.test.ts

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import type { ImapSimpleOptions } from 'imap-simple';
import { sql } from 'drizzle-orm';
import { createPgDb } from '../../../packages/ledger/src/db';
import { PgLedger } from '../../../packages/ledger/src/ledger';
import { ImapSource } from '../../../packages/connectors/src/imap-source';
import { ImapDavMailTarget } from '../../../packages/connectors/src/imap-dav-target';
import { runShadowPass } from '../../../packages/core/src/reconcile';
import { asTenantId, asMappingId, type RawMessage } from '@openmig/shared';
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
const _STALWART_IMAP_USERNAME = process.env.STALWART_IMAP_USERNAME || 'target@dev.local';
const _STALWART_IMAP_PASSWORD = process.env.STALWART_IMAP_PASSWORD || 'target_password';

if (!STALWART_IMAP_HOST) {
  throw new Error(
    'Stalwart IMAP is required for IMAP target tests. ' +
    'Set STALWART_IMAP_HOST environment variable. ' +
    'Run: pnpm test:integration'
  );
}

// Test accounts (shared, but cleaned between tests)
const SOURCE_ACCOUNT = 'source@dev.local';
const SOURCE_PASSWORD = 'source_password';
const TARGET_ACCOUNT = 'target@dev.local';
const TARGET_PASSWORD = 'target_password';

// Fixed UUIDs for testing (consistent across runs for reproducibility)
const TENANT_ID = asTenantId('650e8400-e29b-41d4-a716-446655440001' as never);
const MAPPING_ID = asMappingId('650e8400-e29b-41d4-a716-446655440002' as never);

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
 * Wait for IMAP server to be ready.
 */
async function waitForImap(maxRetries = 30, delayMs = 1000): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const config: ImapSimpleOptions = {
        imap: {
          host: STALWART_IMAP_HOST!,
          port: STALWART_IMAP_PORT,
          user: TARGET_ACCOUNT,
          password: TARGET_PASSWORD,
          tls: true,
          tlsOptions: { rejectUnauthorized: false },
          authTimeout: 3000,
        },
      };
      const conn = await imap.connect(config);
      conn.end();
      return;
    } catch {
      // IMAP not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error('IMAP server not ready after max retries');
}

/**
 * Clean all messages from target account mailboxes.
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
    
    // Get all mailboxes using the underlying node-imap connection
    const mailboxes = await (conn as { imap: { getBoxes: () => Promise<Record<string, unknown>> } }).imap.getBoxes();
    
    // Handle case where getBoxes returns undefined
    const mailboxNames = mailboxes ? Object.keys(mailboxes) : ['INBOX'];
    
    // Delete all messages from each mailbox
    for (const boxName of mailboxNames) {
      try {
        await (conn as { openBox: (name: string) => Promise<void> }).openBox(boxName);
        
        const searchCriteria = ['ALL'];
        const fetchResults: Array<{ attributes: { uid: number } }> = await (conn as { search: (criteria: string[], opts: unknown) => Promise<Array<{ attributes: { uid: number } }>> }).search(searchCriteria, {
          fields: ['UID'],
        });
        
        if (fetchResults.length > 0) {
          const uids = fetchResults.map((r) => r.attributes.uid);
          await (conn as { addFlags: (uids: number[], flags: string) => Promise<void> }).addFlags(uids, '\\Deleted');
          // Use the underlying node-imap connection for expunge
          await new Promise<void>((resolve) => {
            (conn as { imap: { expunge: (callback: (err: Error | null) => void) => void } }).imap.expunge((err: Error | null) => {
              if (err) console.warn(`[Cleanup] Warning: expunge error in ${boxName}:`, err.message);
              resolve();
            });
          });
          
          console.log(`[Cleanup] Deleted ${fetchResults.length} messages from ${boxName}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Cleanup] Warning: Could not clean mailbox ${boxName}: ${msg}`);
      }
    }
    
    console.log('[Cleanup] Target mailboxes cleaned');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Cleanup] Warning: Could not clean mailboxes: ${msg}`);
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
      WHERE mapping_id = ${MAPPING_ID}
    `);
    
    // Delete ledger/item entries for this tenant
    await client.execute(sql`
      DELETE FROM item 
      WHERE tenant_id = ${TENANT_ID}
    `);
    
    // Delete mailbox mappings for this tenant
    await client.execute(sql`
      DELETE FROM mailbox_mapping 
      WHERE tenant_id = ${TENANT_ID}
    `);
    
    // Delete mailboxes for this tenant
    await client.execute(sql`
      DELETE FROM mailbox 
      WHERE tenant_id = ${TENANT_ID}
    `);
    
    // Delete connections for this tenant
    await client.execute(sql`
      DELETE FROM connection 
      WHERE tenant_id = ${TENANT_ID}
    `);
    
    // Create tenant if it doesn't exist
    await client.execute(sql`
      INSERT INTO tenant (id, name, status)
      VALUES (${TENANT_ID}, 'Test Tenant', 'active')
      ON CONFLICT (id) DO NOTHING
    `);
    
    // Create source connection
    const sourceConnId = '650e8400-e29b-41d4-a716-446655440003';
    await client.execute(sql`
      INSERT INTO connection (id, tenant_id, role, kind, display_name, config, status)
      VALUES (${sourceConnId}, ${TENANT_ID}, 'source', 'imap', 'Test Source', '{}', 'connected')
      ON CONFLICT (id) DO NOTHING
    `);
    
    // Create target connection
    const targetConnId = '650e8400-e29b-41d4-a716-446655440004';
    await client.execute(sql`
      INSERT INTO connection (id, tenant_id, role, kind, display_name, config, status)
      VALUES (${targetConnId}, ${TENANT_ID}, 'target', 'imap', 'Test Target', '{}', 'connected')
      ON CONFLICT (id) DO NOTHING
    `);
    
    // Create source mailbox
    const sourceMailboxId = '650e8400-e29b-41d4-a716-446655440005';
    await client.execute(sql`
      INSERT INTO mailbox (id, tenant_id, connection_id, kind, display_name, status)
      VALUES (${sourceMailboxId}, ${TENANT_ID}, ${sourceConnId}, 'user', 'INBOX', 'active')
      ON CONFLICT (id) DO NOTHING
    `);
    
    // Create target mailbox
    const targetMailboxId = '650e8400-e29b-41d4-a716-446655440006';
    await client.execute(sql`
      INSERT INTO mailbox (id, tenant_id, connection_id, kind, display_name, status)
      VALUES (${targetMailboxId}, ${TENANT_ID}, ${targetConnId}, 'user', 'INBOX', 'active')
      ON CONFLICT (id) DO NOTHING
    `);
    
    // Create mailbox mapping
    await client.execute(sql`
      INSERT INTO mailbox_mapping (id, tenant_id, source_mailbox_id, target_mailbox_id, mode, status)
      VALUES (${MAPPING_ID}, ${TENANT_ID}, ${sourceMailboxId}, ${targetMailboxId}, 'mirror', 'active')
      ON CONFLICT (id) DO NOTHING
    `);
    
    console.log('[Cleanup] Database state cleaned for tenant', TENANT_ID);
  } finally {
    // Note: createPgDb returns a client that doesn't have an end() method
    // The connection is managed by the pool
  }
}

/**
 * Seed test messages into source account.
 */
async function seedSourceMessages(): Promise<void> {
  if (!STALWART_IMAP_HOST) {
    throw new Error('STALWART_IMAP_HOST not set');
  }

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
    await conn.openBox('INBOX');
    
    // Clean existing messages first - search requires a second argument
    const searchResults = await conn.search(['ALL'], {});
    const typedSearchResults = searchResults as Array<{ attributes: { uid: number } }>;
    if (typedSearchResults && typedSearchResults.length > 0) {
      const uids = typedSearchResults.map(r => r.attributes.uid);
      await conn.addFlags(uids, '\\Deleted');
      // Use the underlying node-imap connection for expunge
      (conn as { imap: { expunge: (callback: (err: Error | null) => void) => void } }).imap.expunge((err: Error | null) => {
        if (err) console.warn('[Seed] Warning: expunge error:', err.message);
      });
      console.log('[Seed] Cleaned', uids.length, 'existing messages from source');
    }
    
    // Seed 3 test messages
    const messages = [
      {
        subject: 'IMAP Target Test Message 1',
        messageId: '<imap-target-test-1@dev.local>',
        body: 'This is test message 1 for IMAP target testing.',
      },
      {
        subject: 'IMAP Target Test Message 2',
        messageId: '<imap-target-test-2@dev.local>',
        body: 'This is test message 2 for IMAP target testing.',
      },
      {
        subject: 'IMAP Target Test Message 3',
        messageId: '<imap-target-test-3@dev.local>',
        body: 'This is test message 3 for IMAP target testing.',
      },
    ];

    for (const msg of messages) {
      const raw = `From: ${SOURCE_ACCOUNT}
To: ${TARGET_ACCOUNT}
Subject: ${msg.subject}
Message-ID: ${msg.messageId}
Date: ${new Date().toUTCString()}
Content-Type: text/plain; charset=utf-8

${msg.body}
`;
      
      await conn.append(raw, {
        mailbox: 'INBOX',
        flags: ['\\Seen'],
      });
    }

    console.log('[Seed] Seeded 3 test messages to source');
  } finally {
    conn.end();
  }
}

/**
 * Count messages in a mailbox.
 */
async function _countMessages(mailboxName: string): Promise<number> {
  if (!STALWART_IMAP_HOST) {
    throw new Error('STALWART_IMAP_HOST not set');
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

  const conn = await imap.connect(config);
  try {
    await conn.openBox(mailboxName);
    const results = await conn.search(['ALL'], {});
    const typedResults = results as Array<{ attributes: { uid: number } }>;
    return typedResults?.length || 0;
  } finally {
    conn.end();
  }
}

describe('IMAP/DAV Target Writer Integration', () => {
  beforeAll(async () => {
    console.log('[IMAP Target] Waiting for IMAP server...');
    await waitForImap();
    console.log('[IMAP Target] IMAP server is ready');
    console.log('[IMAP Target] Waiting for database schema...');
    await waitForSchema();
    console.log('[IMAP Target] Database schema is ready');
    console.log('[IMAP Target] Test setup complete');
  }, 60000);

  beforeEach(async () => {
    await cleanTargetMailboxes();
    await cleanDatabaseState();
    await seedSourceMessages();
  });

  describe('ImapDavMailTarget', () => {
    it('should connect and ensure mailbox exists', async () => {
      const target = new ImapDavMailTarget({
        host: STALWART_IMAP_HOST!,
        port: STALWART_IMAP_PORT,
        tls: true,
        username: TARGET_ACCOUNT,
        password: TARGET_PASSWORD,
        rejectUnauthorized: false,
      });

      await target.connect();
      
      const mailboxId = await target.ensureMailbox({
        path: 'INBOX',
        name: 'INBOX',
        specialUse: 'inbox',
      });
      
      expect(mailboxId).toBe('INBOX');
      
      await target.disconnect();
    });

    it('should upsert email idempotently (first run creates, second run skips)', async () => {
      const target = new ImapDavMailTarget({
        host: STALWART_IMAP_HOST!,
        port: STALWART_IMAP_PORT,
        tls: true,
        username: TARGET_ACCOUNT,
        password: TARGET_PASSWORD,
        rejectUnauthorized: false,
      });

      await target.connect();
      
      const mailboxId = await target.ensureMailbox({
        path: 'INBOX',
        name: 'INBOX',
        specialUse: 'inbox',
      });

      // Create a test message
      const raw = Buffer.from(`From: ${SOURCE_ACCOUNT}
To: ${TARGET_ACCOUNT}
Subject: Idempotency Test Message
Message-ID: <idempotency-test@dev.local>
Date: ${new Date().toUTCString()}
Content-Type: text/plain; charset=utf-8

This is an idempotency test message.
`);

      const rawMessage: RawMessage = {
        item: {
          messageId: '<idempotency-test@dev.local>',
          folder: {
            path: 'INBOX',
            name: 'INBOX',
            specialUse: 'inbox',
          },
          keywords: ['$seen'],
          receivedAt: new Date().toISOString(),
          sourceRef: 'INBOX:1',
        },
        rfc822: raw,
      };

      // First upsert - should create
      const result1 = await target.upsertEmail(mailboxId, rawMessage, ['$seen']);
      expect(result1.created).toBe(true);
      expect(result1.targetId).toBeDefined();

      // Second upsert with same Message-ID - should skip
      const result2 = await target.upsertEmail(mailboxId, rawMessage, ['$seen']);
      expect(result2.created).toBe(false);
      expect(result2.targetId).toBe(result1.targetId);

      await target.disconnect();
    });

    it('should find by natural key (Message-ID)', async () => {
      const target = new ImapDavMailTarget({
        host: STALWART_IMAP_HOST!,
        port: STALWART_IMAP_PORT,
        tls: true,
        username: TARGET_ACCOUNT,
        password: TARGET_PASSWORD,
        rejectUnauthorized: false,
      });

      await target.connect();
      
      const mailboxId = await target.ensureMailbox({
        path: 'INBOX',
        name: 'INBOX',
        specialUse: 'inbox',
      });

      const raw = Buffer.from(`From: ${SOURCE_ACCOUNT}
To: ${TARGET_ACCOUNT}
Subject: Natural Key Test
Message-ID: <natural-key-test@dev.local>
Date: ${new Date().toUTCString()}
Content-Type: text/plain; charset=utf-8

Test message for natural key lookup.
`);

      const rawMessage: RawMessage = {
        item: {
          messageId: '<natural-key-test@dev.local>',
          folder: {
            path: 'INBOX',
            name: 'INBOX',
            specialUse: 'inbox',
          },
          keywords: ['$seen'],
          receivedAt: new Date().toISOString(),
          sourceRef: 'INBOX:1',
        },
        rfc822: raw,
      };

      // First insert
      await target.upsertEmail(mailboxId, rawMessage, ['$seen']);

      // Find by Message-ID
      const foundUid = await target.findByNaturalKey(mailboxId, '<natural-key-test@dev.local>');
      expect(foundUid).toBeDefined();
      expect(typeof foundUid).toBe('string');

      await target.disconnect();
    });

    it('should list entries for reindex', async () => {
      const target = new ImapDavMailTarget({
        host: STALWART_IMAP_HOST!,
        port: STALWART_IMAP_PORT,
        tls: true,
        username: TARGET_ACCOUNT,
        password: TARGET_PASSWORD,
        rejectUnauthorized: false,
      });

      await target.connect();
      
      const mailboxId = await target.ensureMailbox({
        path: 'INBOX',
        name: 'INBOX',
        specialUse: 'inbox',
      });

      // Insert a message
      const raw = Buffer.from(`From: ${SOURCE_ACCOUNT}
To: ${TARGET_ACCOUNT}
Subject: Reindex Test
Message-ID: <reindex-test@dev.local>
Date: ${new Date().toUTCString()}
Content-Type: text/plain; charset=utf-8

Test message for reindex.
`);

      const rawMessage: RawMessage = {
        item: {
          messageId: '<reindex-test@dev.local>',
          folder: {
            path: 'INBOX',
            name: 'INBOX',
            specialUse: 'inbox',
          },
          keywords: ['$seen'],
          receivedAt: new Date().toISOString(),
          sourceRef: 'INBOX:1',
        },
        rfc822: raw,
      };

      await target.upsertEmail(mailboxId, rawMessage, ['$seen']);

      // List entries
      const entries: Array<{ naturalKey: string; targetId: string }> = [];
      for await (const entry of target.listEntries()) {
        entries.push({ naturalKey: entry.naturalKey, targetId: entry.targetId });
      }

      expect(entries.length).toBeGreaterThan(0);
      
      // Check that our test message is in the list
      const found = entries.find(e => e.naturalKey === 'reindex-test@dev.local');
      expect(found).toBeDefined();

      await target.disconnect();
    });
  });

  describe('Idempotency property', () => {
    let db: ReturnType<typeof createPgDb>;
    let ledger: InstanceType<typeof PgLedger>;

    beforeAll(async () => {
      db = createPgDb(PG_CONNECTION_STRING);
      ledger = new PgLedger(db);
    });

    beforeEach(async () => {
      await cleanTargetMailboxes();
      await cleanDatabaseState();
      await seedSourceMessages();
    });

    it('should mirror messages idempotently (first run creates all, second run creates 0)', async () => {
      const source = new ImapSource({
        host: STALWART_IMAP_HOST!,
        port: STALWART_IMAP_PORT,
        tls: true,
        auth: { user: SOURCE_ACCOUNT, password: SOURCE_PASSWORD },
        authType: 'LOGIN',
      });

      const target = new ImapDavMailTarget({
        host: STALWART_IMAP_HOST!,
        port: STALWART_IMAP_PORT,
        tls: true,
        username: TARGET_ACCOUNT,
        password: TARGET_PASSWORD,
        rejectUnauthorized: false,
      });

      await target.connect();
      
      // Ensure INBOX exists
      await target.ensureMailbox({ path: 'INBOX', name: 'INBOX', specialUse: 'inbox' });

      // First run
      const result1 = await runShadowPass({
        tenantId: TENANT_ID,
        mappingId: MAPPING_ID,
        source,
        target,
        ledger,
        concurrency: 4,
      });

      console.log('[First run] scanned:', result1.scanned, 'created:', result1.created, 'skipped:', result1.skipped);
      expect(result1.created).toBeGreaterThan(0);
      expect(result1.skipped).toBe(0);

      // Second run - should create 0
      const result2 = await runShadowPass({
        tenantId: TENANT_ID,
        mappingId: MAPPING_ID,
        source,
        target,
        ledger,
        concurrency: 4,
      });

      console.log('[Second run] scanned:', result2.scanned, 'created:', result2.created, 'skipped:', result2.skipped);
      expect(result2.created).toBe(0);
      expect(result2.skipped).toBeGreaterThan(0);

      await target.disconnect();
    });

    it('should handle delta correctly (adding one message creates exactly 1)', async () => {
      const source = new ImapSource({
        host: STALWART_IMAP_HOST!,
        port: STALWART_IMAP_PORT,
        tls: true,
        auth: { user: SOURCE_ACCOUNT, password: SOURCE_PASSWORD },
        authType: 'LOGIN',
      });

      const target = new ImapDavMailTarget({
        host: STALWART_IMAP_HOST!,
        port: STALWART_IMAP_PORT,
        tls: true,
        username: TARGET_ACCOUNT,
        password: TARGET_PASSWORD,
        rejectUnauthorized: false,
      });

      await target.connect();
      await target.ensureMailbox({ path: 'INBOX', name: 'INBOX', specialUse: 'inbox' });

      // First run - create initial messages
      const result1 = await runShadowPass({
        tenantId: TENANT_ID,
        mappingId: MAPPING_ID,
        source,
        target,
        ledger,
        concurrency: 4,
      });

      const initialCount = result1.created;
      expect(initialCount).toBeGreaterThan(0);

      // Add one more message to source
      const config: ImapSimpleOptions = {
        imap: {
          user: SOURCE_ACCOUNT,
          password: SOURCE_PASSWORD,
          host: STALWART_IMAP_HOST!,
          port: STALWART_IMAP_PORT,
          tls: true,
          tlsOptions: { rejectUnauthorized: false },
          authTimeout: 3000,
        },
      };
      const conn = await imap.connect(config);
      await conn.openBox('INBOX');
      
      const newMessage = `From: ${SOURCE_ACCOUNT}
To: ${TARGET_ACCOUNT}
Subject: Delta Test Message
Message-ID: <delta-test-message@dev.local>
Date: ${new Date().toUTCString()}
Content-Type: text/plain; charset=utf-8

This is a new message for delta testing.
`;
      
      await conn.append(newMessage, {
        mailbox: 'INBOX',
        flags: ['\\Seen'],
      });
      conn.end();

      // Second run - should create exactly 1
      const result2 = await runShadowPass({
        tenantId: TENANT_ID,
        mappingId: MAPPING_ID,
        source,
        target,
        ledger,
        concurrency: 4,
      });

      console.log('[Delta run] scanned:', result2.scanned, 'created:', result2.created, 'skipped:', result2.skipped);
      expect(result2.created).toBe(1);

      await target.disconnect();
    });
  });
});
