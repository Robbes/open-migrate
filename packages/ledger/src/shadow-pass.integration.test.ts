// Copyright 2026 OpenHands Agent (Apache-2.0)
// Integration tests for the shadow pass (T4) against real IMAP source + JMAP target + SQL ledger.
// Tests idempotency: running twice creates 0 duplicates; delta: adding one message creates exactly 1.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ImapSimpleOptions } from 'imap-simple';
import { createPgDb } from './db.js';
import { PgLedger } from './ledger.js';
import { PgCursorStore } from './cursor-store.js';
import { ImapSource } from '../../connectors/src/imap-source.js';
import { JmapTargetWriter } from '../../connectors/src/jmap-target.js';
import { runShadowPass } from '../../core/src/reconcile.js';
import { asTenantId, asMappingId } from '@openmig/shared';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_DIR = join(__dirname, '..', 'test-data');

/**
 * Append options for IMAP append operation.
 * Defined locally to avoid direct dependency on @types/imap.
 */
interface AppendOptions {
  /** The name of the mailbox to append the message to. Default: the currently open mailbox */
  mailbox?: string;
  /** A single flag (e.g. 'Seen') or an array of flags (e.g. ['Seen', 'Flagged']) to append to the message. Default: (no flags) */
  flags?: string | string[];
  /** What to use for message arrival date/time. Default: (current date/time) */
  date?: Date;
}

// Connection string from Testcontainers (set by vitest.global-setup.ts)
// Fails loudly if TEST_DATABASE_URL is not set, rather than silently using wrong defaults.
const PG_CONNECTION_STRING = process.env.TEST_DATABASE_URL;
if (!PG_CONNECTION_STRING) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Integration tests require Testcontainers to be running. ' +
    'Run: pnpm test:integration'
  );
}

// Stalwart configuration from Testcontainers (set by vitest.global-setup.ts)
// Stalwart is a REQUIRED dependency for shadow pass tests
const STALWART_IMAP_HOST = process.env.STALWART_IMAP_HOST;
const STALWART_IMAP_PORT = parseInt(process.env.STALWART_IMAP_PORT || '143', 10);
const STALWART_JMAP_URL = process.env.STALWART_JMAP_URL;
const STALWART_JMAP_USERNAME = process.env.STALWART_JMAP_USERNAME || 'target@dev.local';
const STALWART_JMAP_PASSWORD = process.env.STALWART_JMAP_PASSWORD || 'target_password';

if (!STALWART_IMAP_HOST || !STALWART_JMAP_URL) {
  throw new Error(
    'Stalwart is a required dependency for shadow pass tests. ' +
    'Set STALWART_IMAP_HOST and STALWART_JMAP_URL environment variables. ' +
    'Run: pnpm test:integration'
  );
}

// Test accounts - must match the accounts provisioned in testcontainers-setup.ts
const SOURCE_ACCOUNT = 'source';
const SOURCE_PASSWORD = 'source_password';

// Target account
const TARGET_ACCOUNT = 'target';
const TARGET_PASSWORD = 'target_password';

// Admin account for provisioning (not used in tests)
const ADMIN_ACCOUNT = 'admin';

// Retry configuration for IMAP connection
const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 2000;

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
      // Success - IMAP is available
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

// Fixed UUIDs for testing
const TEST_TENANT_ID = asTenantId('550e8400-e29b-41d4-a716-446655440001' as never);
const TEST_MAPPING_ID = asMappingId('550e8400-e29b-41d4-a716-446655440002' as never);

/**
 * Database type for drizzle.
 */
type DbClient = ReturnType<typeof createPgDb>;

/**
 * Seed test messages into the source IMAP account.
 */
async function seedSourceMessages(): Promise<void> {
  const imap = await import('imap-simple');

  const config: ImapSimpleOptions = {
    imap: {
      user: SOURCE_ACCOUNT,
      password: SOURCE_PASSWORD,
      host: STALWART_IMAP_HOST,
      port: STALWART_IMAP_PORT,
      tls: false,
      tlsOptions: { rejectUnauthorized: false },
    },
  };

  const conn = await imap.connect(config);

  try {
    // Open INBOX
    await conn.openBox('INBOX');

    // Seed test messages with known Message-IDs
    const testMessages = [
      {
        messageId: '<test-message-1@dev.local>',
        subject: 'Test Message 1',
        body: 'This is the first test message.',
      },
      {
        messageId: '<test-message-2@dev.local>',
        subject: 'Test Message 2',
        body: 'This is the second test message.',
      },
      {
        messageId: '<test-message-3@dev.local>',
        subject: 'Test Message 3',
        body: 'This is the third test message.',
      },
    ];

    for (const msg of testMessages) {
      const rfc822 = `From: source@dev.local
To: target@dev.local
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
  } finally {
    conn.end();
  }
}

// Shadow pass tests require Stalwart (JMAP/IMAP)
describe('Shadow Pass Integration (T4)', () => {
  let db: DbClient;
  let ledger: PgLedger;
  let cursorStore: PgCursorStore;
  let source: ImapSource;
  let target: JmapTargetWriter;

  beforeAll(async () => {
    // Wait for IMAP server to be available
    console.log('[ShadowPass] Waiting for IMAP server...');
    await waitForImap(STALWART_IMAP_HOST, STALWART_IMAP_PORT);
    console.log('[ShadowPass] IMAP server is ready');
    
    // Setup database
    db = createPgDb(PG_CONNECTION_STRING);
    
    ledger = new PgLedger(db);
    cursorStore = new PgCursorStore(db);
    
    // Setup connectors
    source = new ImapSource({
      host: STALWART_IMAP_HOST,
      port: STALWART_IMAP_PORT,
      tls: false,
      auth: {
        user: SOURCE_ACCOUNT,
        password: SOURCE_PASSWORD,
      },
      authType: 'LOGIN',
    });
    
    target = new JmapTargetWriter({
      baseUrl: STALWART_JMAP_URL,
      username: STALWART_JMAP_USERNAME,
      password: STALWART_JMAP_PASSWORD,
    });
    
    // Connect target
    await target.connect();
    
    // Seed source messages (accounts are already provisioned by testcontainers setup)
    await seedSourceMessages();
    
    // Create test data (tenant, connection, mailbox, mapping)
    await db.execute(sql`
      INSERT INTO tenant (id, name, status)
      VALUES (${TEST_TENANT_ID}, 'Test Tenant', 'active')
      ON CONFLICT (id) DO NOTHING
    `);

    const sourceConnId = '650e8400-e29b-41d4-a716-446655440001';
    const targetConnId = '650e8400-e29b-41d4-a716-446655440002';
    
    await db.execute(sql`
      INSERT INTO connection (id, tenant_id, role, kind, display_name, config, status)
      VALUES (${sourceConnId}, ${TEST_TENANT_ID}, 'source', 'imap', 'IMAP Source', '{}', 'connected')
      ON CONFLICT (id) DO NOTHING
    `);
    
    await db.execute(sql`
      INSERT INTO connection (id, tenant_id, role, kind, display_name, config, status)
      VALUES (${targetConnId}, ${TEST_TENANT_ID}, 'target', 'jmap', 'JMAP Target', '{}', 'connected')
      ON CONFLICT (id) DO NOTHING
    `);

    const sourceMailboxId = '750e8400-e29b-41d4-a716-446655440001';
    const targetMailboxId = '750e8400-e29b-41d4-a716-446655440002';
    
    await db.execute(sql`
      INSERT INTO mailbox (id, tenant_id, connection_id, external_id, kind, display_name, status)
      VALUES (${sourceMailboxId}, ${TEST_TENANT_ID}, ${sourceConnId}, 'INBOX', 'user', 'INBOX', 'active')
      ON CONFLICT (id) DO NOTHING
    `);
    
    await db.execute(sql`
      INSERT INTO mailbox (id, tenant_id, connection_id, external_id, kind, display_name, status)
      VALUES (${targetMailboxId}, ${TEST_TENANT_ID}, ${targetConnId}, 'INBOX', 'user', 'INBOX', 'active')
      ON CONFLICT (id) DO NOTHING
    `);

    await db.execute(sql`
      INSERT INTO mailbox_mapping (id, tenant_id, source_mailbox_id, target_mailbox_id, mode, status)
      VALUES (${TEST_MAPPING_ID}, ${TEST_TENANT_ID}, ${sourceMailboxId}, ${targetMailboxId}, 'mirror', 'active')
      ON CONFLICT (id) DO NOTHING
    `);
  }, 60000);

  afterAll(async () => {
    // Cleanup: delete test data
    if (db) {
      await db.execute(sql`DELETE FROM item WHERE tenant_id = ${TEST_TENANT_ID}`);
      await db.execute(sql`DELETE FROM cursor WHERE tenant_id = ${TEST_TENANT_ID}`);
      await db.execute(sql`DELETE FROM mailbox_mapping WHERE tenant_id = ${TEST_TENANT_ID}`);
      await db.execute(sql`DELETE FROM mailbox WHERE tenant_id = ${TEST_TENANT_ID}`);
      await db.execute(sql`DELETE FROM connection WHERE tenant_id = ${TEST_TENANT_ID}`);
      await db.execute(sql`DELETE FROM tenant WHERE id = ${TEST_TENANT_ID}`);
    }
    if (target) {
      await target.disconnect();
    }
  });

  it('should mirror messages idempotently (first run creates all, second run creates 0)', async () => {
    // First run
    const result1 = await runShadowPass({
      tenantId: TEST_TENANT_ID,
      mappingId: TEST_MAPPING_ID,
      source,
      target,
      ledger,
      cursors: cursorStore,
      concurrency: 2,
    });

    // First run should create all 3 messages
    expect(result1.scanned).toBe(3);
    expect(result1.created).toBe(3);
    expect(result1.skipped).toBe(0);

    // Second run should create 0 (idempotent)
    const result2 = await runShadowPass({
      tenantId: TEST_TENANT_ID,
      mappingId: TEST_MAPPING_ID,
      source,
      target,
      ledger,
      cursors: cursorStore,
      concurrency: 2,
    });

    expect(result2.scanned).toBe(3);
    expect(result2.created).toBe(0);
    expect(result2.skipped).toBe(3);
  }, 120000);

  it('should handle delta correctly (adding one message creates exactly 1)', async () => {
    // Seed one more message
    const imap = await import('imap-simple');

    const config: ImapSimpleOptions = {
      imap: {
        user: SOURCE_ACCOUNT,
        password: SOURCE_PASSWORD,
        host: STALWART_IMAP_HOST,
        port: STALWART_IMAP_PORT,
        tls: false,
        tlsOptions: { rejectUnauthorized: false },
      },
    };

    const conn = await imap.connect(config);

    try {
      const newMessage = `From: source@dev.local
To: target@dev.local
Subject: Test Message 4 (Delta Test)
Message-ID: <test-message-4-delta@dev.local>
Date: ${new Date().toUTCString()}
Content-Type: text/plain; charset=utf-8

This is the fourth test message for delta testing.
`;

      await conn.append(newMessage, {
        mailbox: 'INBOX',
      } as AppendOptions);
    } finally {
      conn.end();
    }

    // Run shadow pass again - should only create the new message
    const result = await runShadowPass({
      tenantId: TEST_TENANT_ID,
      mappingId: TEST_MAPPING_ID,
      source,
      target,
      ledger,
      cursors: cursorStore,
      concurrency: 2,
    });

    // Should scan 1 new message (due to cursor) and create 1
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(0);
  }, 120000);
});
