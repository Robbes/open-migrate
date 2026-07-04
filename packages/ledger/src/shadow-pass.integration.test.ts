// Copyright 2026 OpenHands Agent (Apache-2.0)
// Integration tests for the shadow pass (T4) against real IMAP source + JMAP target + SQL ledger.
// Tests idempotency: running twice creates 0 duplicates; delta: adding one message creates exactly 1.

import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImapSimpleOptions } from 'imap-simple';
import { createPgDb } from './db.js';
import { PgLedger } from './ledger.js';
import { PgCursorStore } from './cursor-store.js';
import { ImapSource } from '../../connectors/src/imap-source.js';
import { JmapTargetWriter } from '../../connectors/src/jmap-target.js';
import { runShadowPass } from '../../core/src/reconcile.js';
import { asTenantId, asMappingId } from '@openmig/shared';

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

// Get the directory name
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Test configuration - matches dev stack
// Note: When running tests from the host, use localhost with mapped ports.
// When running from within Docker, use Docker service names.
const isRunningInDocker = !!process.env.RUNNING_IN_DOCKER;
const host = isRunningInDocker ? 'stalwart' : 'localhost';

const PG_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  `postgres://openmig:openmig@${isRunningInDocker ? 'postgres' : 'localhost'}:5432/openmig`;

const STALWART_IMAP_HOST = host;
const STALWART_IMAP_PORT = 143;
const STALWART_JMAP_URL = `http://${host}:8080`; // Use internal port 8080
const STALWART_JMAP_USERNAME = 'target@dev.local';
const STALWART_JMAP_PASSWORD = 'change-me-immediately';

// Test accounts
const SOURCE_ACCOUNT = 'source@dev.local';
const SOURCE_PASSWORD = 'change-me-immediately';

// Fixed UUIDs for testing
const TEST_TENANT_ID = asTenantId('550e8400-e29b-41d4-a716-446655440001' as never);
const TEST_MAPPING_ID = asMappingId('550e8400-e29b-41d4-a716-446655440002' as never);

/**
 * Database type for migration execution.
 * Using a more flexible type that matches the actual drizzle database object.
 */
type DbClient = ReturnType<typeof createPgDb>;

/**
 * Execute a multi-statement SQL migration.
 */
async function executeMigration(db: DbClient, sqlContent: string): Promise<void> {
  // Remove single-line comments
  const cleaned = sqlContent.replace(/--[^\n]*/g, '');
  
  // Split by semicolons outside of strings
  const statements: string[] = [];
  let current = '';
  let inString = false;
  let stringChar = '';
  
  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    const nextChar = cleaned[i + 1];
    
    if (!inString && (char === "'" || char === '"')) {
      inString = true;
      stringChar = char;
      current += char;
    } else if (inString && char === stringChar && nextChar === stringChar) {
      current += char + nextChar;
      i++;
    } else if (inString && char === stringChar) {
      inString = false;
      stringChar = '';
      current += char;
    } else if (!inString && char === ';') {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        statements.push(trimmed);
      }
      current = '';
    } else {
      current += char;
    }
  }
  
  const trimmed = current.trim();
  if (trimmed.length > 0) {
    statements.push(trimmed);
  }

  for (const stmt of statements) {
    await db.execute(sql.raw(stmt));
  }
}

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

describe('Shadow Pass Integration (T4)', () => {
  let db: DbClient;
  let ledger: PgLedger;
  let cursorStore: PgCursorStore;
  let source: ImapSource;
  let target: JmapTargetWriter;

  beforeAll(async () => {
    // Setup database
    db = createPgDb(PG_CONNECTION_STRING);
    
    // Run migrations
    const migrationSql = readFileSync(
      path.join(__dirname, '../migrations/0001_init.sql'),
      'utf-8',
    );
    await executeMigration(db, migrationSql);
    
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
    
    // Seed source messages
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
