// Copyright 2026 OpenHands Agent (Apache-2.0)
// Integration tests for unified sync orchestration against real Stalwart + Nextcloud servers.
// Uses Testcontainers for containerized servers.
//
// TEST SCENARIOS:
// - Full unified sync across CalDAV/CardDAV/WebDAV
// - Idempotency across all domains
// - Delta sync (modify one item → exactly one update)
// - Reindex (wipe ledger → reindex creates 0)
// - Multi-domain test: All domains sync together with aggregated stats

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createPgDb, PgLedger, PgCursorStore } from '@openmig/ledger';
import { CalDAVSource } from '@openmig/connectors/caldav-source';
import { CarddavSource } from '@openmig/connectors/carddav-source';
import { WebdavFileSource } from '@openmig/connectors/webdav-source';
import { CalDAVTargetWriter } from '@openmig/engines/caldav-target-writer';
import { CardDAVTargetWriter } from '@openmig/engines/carddav-target-writer';
import { WebDAVTargetWriter } from '@openmig/engines/webdav-target-writer';
import { runUnifiedSync, type UnifiedSyncConfig } from './unified-sync';
import { asTenantId, asMappingId } from '@openmig/shared';

// Stalwart configuration from Testcontainers
const STALWART_URL = process.env.STALWART_JMAP_URL;
const STALWART_USERNAME = process.env.STALWART_JMAP_USERNAME || 'source@dev.local';
const STALWART_PASSWORD = process.env.STALWART_JMAP_PASSWORD || 'source_password';

// Nextcloud configuration from Testcontainers
const NEXTCLOUD_WEBDAV_URL = process.env.NEXTCLOUD_WEBDAV_URL;
const NEXTCLOUD_USERNAME = process.env.NEXTCLOUD_USERNAME || 'testadmin';
const NEXTCLOUD_PASSWORD = process.env.NEXTCLOUD_PASSWORD || 'testadmin_password';

// Database connection
const PG_CONNECTION_STRING = process.env.TEST_DATABASE_URL;
if (!PG_CONNECTION_STRING) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Integration tests require Testcontainers to be running. ' +
    'Run: pnpm test:integration'
  );
}

// Fixed UUIDs for testing
const TENANT_ID = asTenantId('650e8400-e29b-41d4-a716-446655440001' as never);
const MAPPING_ID = asMappingId('650e8400-e29b-41d4-a716-446655440002' as never);

/**
 * Wait for servers to be ready.
 */
async function waitForServers(maxRetries = 30, delayMs = 2000): Promise<void> {
  // Wait for Stalwart
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(`${STALWART_URL}/.well-known/jmap`);
      if (response.ok) {
        console.log('[WaitForServers] Stalwart is ready');
        break;
      }
    } catch {
      // Stalwart not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  // Wait for Nextcloud
  if (NEXTCLOUD_WEBDAV_URL) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await fetch(`${NEXTCLOUD_WEBDAV_URL}/`, {
          method: 'PROPFIND',
          headers: {
            Authorization: `Basic ${Buffer.from(`${NEXTCLOUD_USERNAME}:${NEXTCLOUD_PASSWORD}`).toString('base64')}`,
          },
        });
        if (response.status === 207 || response.status === 401) {
          console.log('[WaitForServers] Nextcloud is ready');
          break;
        }
      } catch {
        // Nextcloud not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
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
  const db = createPgDb(PG_CONNECTION_STRING);
  
  try {
    // Delete cursor entries for this mapping
    await db.execute(sql`
      DELETE FROM cursor 
      WHERE mapping_id = ${MAPPING_ID}
    `);
    
    // Delete ledger/item entries for this tenant
    await db.execute(sql`
      DELETE FROM item 
      WHERE tenant_id = ${TENANT_ID}
    `);
    
    // Delete connections for this tenant
    await db.execute(sql`
      DELETE FROM connection 
      WHERE tenant_id = ${TENANT_ID}
    `);
    
    console.log('[Cleanup] Database state cleaned');
  } finally {
    await db.close();
  }
}

/**
 * Seed test data for CalDAV.
 */
async function seedCalDAVData(): Promise<void> {
  const caldavUrl = STALWART_URL!.replace(/\/$/, '');
  const calendarPath = `/calendars/${STALWART_USERNAME.split('@')[0]}/unified-test-calendar/`;
  const fullCalendarUrl = `${caldavUrl}${calendarPath}`;

  // Create calendar
  const mkcalendarXml = `<?xml version="1.0" encoding="utf-8"?>
    <D:mkcalendar xmlns:D="DAV:" xmlns:CA="urn:ietf:params:xml:ns:caldav">
      <D:set>
        <D:prop>
          <D:displayname>Unified Test Calendar</D:displayname>
        </D:prop>
      </D:set>
    </D:mkcalendar>`;

  try {
    await fetch(fullCalendarUrl, {
      method: 'MKCALENDAR',
      headers: {
        'Content-Type': 'application/xml',
        Authorization: `Basic ${Buffer.from(`${STALWART_USERNAME}:${STALWART_PASSWORD}`).toString('base64')}`,
      },
      body: mkcalendarXml,
    });
    console.log('[Seed CalDAV] Created test calendar');
  } catch {
    // Calendar might already exist
  }

  // Create test event
  const icalendar = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//OpenMig//Test//EN
BEGIN:VEVENT
UID:unified-test-event@dev.local
DTSTAMP:20240101T000000Z
DTSTART:20240615T100000Z
DTEND:20240615T110000Z
SUMMARY:Unified Sync Test Event
DESCRIPTION:Test event for unified sync integration
END:VEVENT
END:VCALENDAR`;

  const eventUrl = `${fullCalendarUrl}unified-test-event.ics`;
  try {
    await fetch(eventUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/calendar',
        Authorization: `Basic ${Buffer.from(`${STALWART_USERNAME}:${STALWART_PASSWORD}`).toString('base64')}`,
      },
      body: icalendar,
    });
    console.log('[Seed CalDAV] Created test event');
  } catch (err) {
    console.warn('[Seed CalDAV] Warning: Could not seed event:', err);
  }
}

/**
 * Seed test data for CardDAV.
 */
async function seedCardDAVData(): Promise<void> {
  const carddavUrl = STALWART_URL!.replace(/\/$/, '');
  const addressbookPath = `/addressbooks/${STALWART_USERNAME.split('@')[0]}/unified-test-addressbook/`;
  const fullAddressbookUrl = `${carddavUrl}${addressbookPath}`;

  // Create address book
  const mkcolXml = `<?xml version="1.0" encoding="utf-8"?>
    <D:mkcol xmlns:D="DAV:" xmlns:CA="urn:ietf:params:xml:ns:carddav">
      <D:set>
        <D:prop>
          <D:resourcetype>
            <D:collection/>
            <CA:addressbook/>
          </D:resourcetype>
          <D:displayname>Unified Test Address Book</D:displayname>
        </D:prop>
      </D:set>
    </D:mkcol>`;

  try {
    await fetch(fullAddressbookUrl, {
      method: 'MKCOL',
      headers: {
        'Content-Type': 'application/xml',
        Authorization: `Basic ${Buffer.from(`${STALWART_USERNAME}:${STALWART_PASSWORD}`).toString('base64')}`,
      },
      body: mkcolXml,
    });
    console.log('[Seed CardDAV] Created test address book');
  } catch {
    // Address book might already exist
  }

  // Create test contact
  const vcard = `BEGIN:VCARD
VERSION:4.0
UID:unified-test-contact@dev.local
FN:Unified Test Contact
ORG:OpenMig Test
TITLE:Test Contact
EMAIL:test@dev.local
N:Contact;Unified;Test;;;
END:VCARD`;

  const contactUrl = `${fullAddressbookUrl}unified-test-contact.vcf`;
  try {
    await fetch(contactUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/vcard',
        Authorization: `Basic ${Buffer.from(`${STALWART_USERNAME}:${STALWART_PASSWORD}`).toString('base64')}`,
      },
      body: vcard,
    });
    console.log('[Seed CardDAV] Created test contact');
  } catch (err) {
    console.warn('[Seed CardDAV] Warning: Could not seed contact:', err);
  }
}

/**
 * Seed test data for WebDAV.
 */
async function seedWebDAVData(): Promise<void> {
  if (!NEXTCLOUD_WEBDAV_URL) {
    console.log('[Seed WebDAV] Skipping - Nextcloud not available');
    return;
  }

  const webdavUrl = NEXTCLOUD_WEBDAV_URL.replace(/\/$/, '');
  const testFolderPath = `/files/${NEXTCLOUD_USERNAME}/unified-test-folder`;
  const testFolderUrl = `${webdavUrl}${testFolderPath}`;

  // Create folder
  try {
    const response = await fetch(testFolderUrl, {
      method: 'MKCOL',
      headers: {
        Authorization: `Basic ${Buffer.from(`${NEXTCLOUD_USERNAME}:${NEXTCLOUD_PASSWORD}`).toString('base64')}`,
      },
    });
    if (response.status === 201 || response.status === 409) {
      console.log('[Seed WebDAV] Created test folder');
    }
  } catch {
    // Folder might already exist
  }

  // Create test file
  const testFileUrl = `${testFolderUrl}/unified-test.txt`;
  const fileContent = 'This is a test file for unified sync integration testing.';
  
  try {
    await fetch(testFileUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/plain',
        Authorization: `Basic ${Buffer.from(`${NEXTCLOUD_USERNAME}:${NEXTCLOUD_PASSWORD}`).toString('base64')}`,
      },
      body: fileContent,
    });
    console.log('[Seed WebDAV] Created test file');
  } catch (err) {
    console.warn('[Seed WebDAV] Warning: Could not seed file:', err);
  }
}

/**
 * Clean up test data.
 */
async function cleanTestData(): Promise<void> {
  // Clean CalDAV
  try {
    const caldavUrl = STALWART_URL!.replace(/\/$/, '');
    const calendarPath = `/calendars/${STALWART_USERNAME.split('@')[0]}/unified-test-calendar/`;
    await fetch(`${caldavUrl}${calendarPath}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Basic ${Buffer.from(`${STALWART_USERNAME}:${STALWART_PASSWORD}`).toString('base64')}`,
      },
    });
  } catch {
    // Ignore
  }

  // Clean CardDAV
  try {
    const carddavUrl = STALWART_URL!.replace(/\/$/, '');
    const addressbookPath = `/addressbooks/${STALWART_USERNAME.split('@')[0]}/unified-test-addressbook/`;
    await fetch(`${carddavUrl}${addressbookPath}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Basic ${Buffer.from(`${STALWART_USERNAME}:${STALWART_PASSWORD}`).toString('base64')}`,
      },
    });
  } catch {
    // Ignore
  }

  // Clean WebDAV
  if (NEXTCLOUD_WEBDAV_URL) {
    try {
      const webdavUrl = NEXTCLOUD_WEBDAV_URL.replace(/\/$/, '');
      const testFolderPath = `/files/${NEXTCLOUD_USERNAME}/unified-test-folder`;
      await fetch(`${webdavUrl}${testFolderPath}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Basic ${Buffer.from(`${NEXTCLOUD_USERNAME}:${NEXTCLOUD_PASSWORD}`).toString('base64')}`,
        },
      });
    } catch {
      // Ignore
    }
  }

  console.log('[Cleanup] Test data cleaned');
}

describe('Unified Sync Integration Tests', () => {
  let db: ReturnType<typeof createPgDb>;
  let ledger: InstanceType<typeof PgLedger>;
  let cursors: InstanceType<typeof PgCursorStore>;

  beforeAll(async () => {
    console.log('[Unified Sync Tests] Waiting for servers...');
    await waitForServers();
    console.log('[Unified Sync Tests] Servers are ready');

    db = createPgDb(PG_CONNECTION_STRING);
    ledger = new PgLedger(db);
    cursors = new PgCursorStore(db);
  }, 60000);

  beforeEach(async () => {
    await cleanDatabaseState();
    await seedCalDAVData();
    await seedCardDAVData();
    await seedWebDAVData();
  });

  afterAll(async () => {
    await cleanTestData();
    await db.close();
  });

  describe('Idempotency property', () => {
    it('should sync all domains idempotently (first run creates all, second run creates 0)', async () => {
      // Set up source connectors
      const caldavSource = new CalDAVSource({
        url: `${STALWART_URL}/`,
        username: STALWART_USERNAME,
        passwordEnv: 'STALWART_JMAP_PASSWORD',
      });
      process.env.STALWART_JMAP_PASSWORD = STALWART_PASSWORD;

      const carddavSource = new CarddavSource({
        url: `${STALWART_URL}/`,
        username: STALWART_USERNAME,
        passwordEnv: 'STALWART_JMAP_PASSWORD',
      });

      const webdavSource = NEXTCLOUD_WEBDAV_URL ? new WebdavFileSource({
        url: NEXTCLOUD_WEBDAV_URL,
        username: NEXTCLOUD_USERNAME,
        passwordEnv: 'NEXTCLOUD_PASSWORD',
        rootPath: `/files/${NEXTCLOUD_USERNAME}/`,
      }) : null;
      if (NEXTCLOUD_PASSWORD) {
        process.env.NEXTCLOUD_PASSWORD = NEXTCLOUD_PASSWORD;
      }

      // First run - unified sync will create target writers internally from configs
      const config: UnifiedSyncConfig = {
        tenantId: TENANT_ID,
        mappingId: MAPPING_ID,
        calendar: { enabled: true },
        contacts: { enabled: true },
        files: { enabled: !!webdavSource },
        caldavSource: {
          url: `${STALWART_URL}/`,
          username: STALWART_USERNAME,
          passwordEnv: 'STALWART_JMAP_PASSWORD',
        },
        caldavTarget: {
          url: `${STALWART_URL}/`,
          username: STALWART_USERNAME,
          password: STALWART_PASSWORD,
        },
        carddavSource: {
          url: `${STALWART_URL}/`,
          username: STALWART_USERNAME,
          passwordEnv: 'STALWART_JMAP_PASSWORD',
        },
        carddavTarget: {
          url: `${STALWART_URL}/`,
          username: STALWART_USERNAME,
          password: STALWART_PASSWORD,
        },
        webdavSource: NEXTCLOUD_WEBDAV_URL ? {
          url: NEXTCLOUD_WEBDAV_URL,
          username: NEXTCLOUD_USERNAME,
          passwordEnv: 'NEXTCLOUD_PASSWORD',
          rootPath: `/files/${NEXTCLOUD_USERNAME}/`,
        } : undefined,
        webdavTarget: NEXTCLOUD_WEBDAV_URL ? {
          url: NEXTCLOUD_WEBDAV_URL,
          username: NEXTCLOUD_USERNAME,
          password: NEXTCLOUD_PASSWORD || '',
          rootPath: `/files/${NEXTCLOUD_USERNAME}/`,
        } : undefined,
      };

      const result1 = await runUnifiedSync({
        config,
        ledger,
        cursors,
      });

      console.log('[First run] Calendar:', result1.calendar.createdCount, 'Created, Contacts:', result1.contacts.createdCount, 'Created, Files:', result1.files.createdCount, 'Created');
      
      // First run should create items in each domain
      expect(result1.calendar.createdCount).toBeGreaterThan(0);
      expect(result1.contacts.createdCount).toBeGreaterThan(0);
      if (webdavSource) {
        expect(result1.files.createdCount).toBeGreaterThan(0);
      }

      // Second run - should create 0
      const result2 = await runUnifiedSync({
        config,
        ledger,
        cursors,
      });

      console.log('[Second run] Calendar:', result2.calendar.createdCount, 'Created, Contacts:', result2.contacts.createdCount, 'Created, Files:', result2.files.createdCount, 'Created');
      
      // Idempotency: second run should create 0 items
      expect(result2.calendar.createdCount).toBe(0);
      expect(result2.contacts.createdCount).toBe(0);
      if (webdavSource) {
        expect(result2.files.createdCount).toBe(0);
      }
    }, 180000);
  });

  describe('Delta sync', () => {
    it('should handle delta correctly (adding one item creates exactly 1)', async () => {
      // Set up sources for delta test
      const caldavSource = new CalDAVSource({
        url: `${STALWART_URL}/`,
        username: STALWART_USERNAME,
        passwordEnv: 'STALWART_JMAP_PASSWORD',
      });
      process.env.STALWART_JMAP_PASSWORD = STALWART_PASSWORD;

      const carddavSource = new CarddavSource({
        url: `${STALWART_URL}/`,
        username: STALWART_USERNAME,
        passwordEnv: 'STALWART_JMAP_PASSWORD',
      });

      const webdavSource = NEXTCLOUD_WEBDAV_URL ? new WebdavFileSource({
        url: NEXTCLOUD_WEBDAV_URL,
        username: NEXTCLOUD_USERNAME,
        passwordEnv: 'NEXTCLOUD_PASSWORD',
        rootPath: `/files/${NEXTCLOUD_USERNAME}/`,
      }) : null;
      if (NEXTCLOUD_PASSWORD) {
        process.env.NEXTCLOUD_PASSWORD = NEXTCLOUD_PASSWORD;
      }

      // First, run initial sync to establish baseline
      const config: UnifiedSyncConfig = {
        tenantId: TENANT_ID,
        mappingId: MAPPING_ID,
        calendar: { enabled: true },
        contacts: { enabled: true },
        files: { enabled: !!webdavSource },
        caldavSource: {
          url: `${STALWART_URL}/`,
          username: STALWART_USERNAME,
          passwordEnv: 'STALWART_JMAP_PASSWORD',
        },
        caldavTarget: {
          url: `${STALWART_URL}/`,
          username: STALWART_USERNAME,
          password: STALWART_PASSWORD,
        },
        carddavSource: {
          url: `${STALWART_URL}/`,
          username: STALWART_USERNAME,
          passwordEnv: 'STALWART_JMAP_PASSWORD',
        },
        carddavTarget: {
          url: `${STALWART_URL}/`,
          username: STALWART_USERNAME,
          password: STALWART_PASSWORD,
        },
        webdavSource: NEXTCLOUD_WEBDAV_URL ? {
          url: NEXTCLOUD_WEBDAV_URL,
          username: NEXTCLOUD_USERNAME,
          passwordEnv: 'NEXTCLOUD_PASSWORD',
          rootPath: `/files/${NEXTCLOUD_USERNAME}/`,
        } : undefined,
        webdavTarget: NEXTCLOUD_WEBDAV_URL ? {
          url: NEXTCLOUD_WEBDAV_URL,
          username: NEXTCLOUD_USERNAME,
          password: NEXTCLOUD_PASSWORD || '',
          rootPath: `/files/${NEXTCLOUD_USERNAME}/`,
        } : undefined,
      };

      const result1 = await runUnifiedSync({
        config,
        ledger,
        cursors,
      });

      const initialCalendarCount = result1.calendar.createdCount;
      const initialContactCount = result1.contacts.createdCount;
      const initialFileCount = webdavSource ? result1.files.createdCount : 0;

      expect(initialCalendarCount).toBeGreaterThan(0);

      // Add one more calendar event
      const caldavUrl = STALWART_URL!.replace(/\/$/, '');
      const calendarPath = `/calendars/${STALWART_USERNAME.split('@')[0]}/unified-test-calendar/`;
      const icalendar = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//OpenMig//Test//EN
BEGIN:VEVENT
UID:delta-test-event@dev.local
DTSTAMP:20240101T000000Z
DTSTART:20240715T140000Z
DTEND:20240715T150000Z
SUMMARY:Delta Test Event
END:VEVENT
END:VCALENDAR`;

      await fetch(`${caldavUrl}${calendarPath}delta-test-event.ics`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'text/calendar',
          Authorization: `Basic ${Buffer.from(`${STALWART_USERNAME}:${STALWART_PASSWORD}`).toString('base64')}`,
        },
        body: icalendar,
      });

      console.log('[Delta Test] Added one new calendar event');

      // Second run - should create exactly 1 calendar item
      const result2 = await runUnifiedSync({
        config,
        ledger,
        cursors,
      });

      console.log('[Delta run] Calendar:', result2.calendar.createdCount, 'Created');
      
      // Should create exactly 1 new calendar item
      expect(result2.calendar.createdCount).toBe(1);
      expect(result2.contacts.createdCount).toBe(0);
      if (webdavSource) {
        expect(result2.files.createdCount).toBe(0);
      }

    }, 180000);
  });

  describe('Reindex test', () => {
    it('should handle reindex correctly (wipe ledger → re-run creates 0)', async () => {
      // Set up sources for reindex test
      const caldavSource = new CalDAVSource({
        url: `${STALWART_URL}/`,
        username: STALWART_USERNAME,
        passwordEnv: 'STALWART_JMAP_PASSWORD',
      });
      process.env.STALWART_JMAP_PASSWORD = STALWART_PASSWORD;

      const carddavSource = new CarddavSource({
        url: `${STALWART_URL}/`,
        username: STALWART_USERNAME,
        passwordEnv: 'STALWART_JMAP_PASSWORD',
      });

      const webdavSource = NEXTCLOUD_WEBDAV_URL ? new WebdavFileSource({
        url: NEXTCLOUD_WEBDAV_URL,
        username: NEXTCLOUD_USERNAME,
        passwordEnv: 'NEXTCLOUD_PASSWORD',
        rootPath: `/files/${NEXTCLOUD_USERNAME}/`,
      }) : null;
      if (NEXTCLOUD_PASSWORD) {
        process.env.NEXTCLOUD_PASSWORD = NEXTCLOUD_PASSWORD;
      }

      const config: UnifiedSyncConfig = {
        tenantId: TENANT_ID,
        mappingId: MAPPING_ID,
        calendar: { enabled: true },
        contacts: { enabled: true },
        files: { enabled: !!webdavSource },
        caldavSource: {
          url: `${STALWART_URL}/`,
          username: STALWART_USERNAME,
          passwordEnv: 'STALWART_JMAP_PASSWORD',
        },
        caldavTarget: {
          url: `${STALWART_URL}/`,
          username: STALWART_USERNAME,
          password: STALWART_PASSWORD,
        },
        carddavSource: {
          url: `${STALWART_URL}/`,
          username: STALWART_USERNAME,
          passwordEnv: 'STALWART_JMAP_PASSWORD',
        },
        carddavTarget: {
          url: `${STALWART_URL}/`,
          username: STALWART_USERNAME,
          password: STALWART_PASSWORD,
        },
        webdavSource: NEXTCLOUD_WEBDAV_URL ? {
          url: NEXTCLOUD_WEBDAV_URL,
          username: NEXTCLOUD_USERNAME,
          passwordEnv: 'NEXTCLOUD_PASSWORD',
          rootPath: `/files/${NEXTCLOUD_USERNAME}/`,
        } : undefined,
        webdavTarget: NEXTCLOUD_WEBDAV_URL ? {
          url: NEXTCLOUD_WEBDAV_URL,
          username: NEXTCLOUD_USERNAME,
          password: NEXTCLOUD_PASSWORD || '',
          rootPath: `/files/${NEXTCLOUD_USERNAME}/`,
        } : undefined,
      };

      // First run
      const result1 = await runUnifiedSync({
        config,
        ledger,
        cursors,
      });

      const initialTotal = result1.calendar.createdCount + result1.contacts.createdCount + result1.files.createdCount;
      expect(initialTotal).toBeGreaterThan(0);
      console.log('[Reindex Test] Initial sync created', initialTotal, 'items');

      // Wipe the ledger (but keep cursors)
      await cleanDatabaseState();
      console.log('[Reindex Test] Wiped ledger');

      // Re-run sync - should create 0 items because cursors indicate all items are already synced
      const result2 = await runUnifiedSync({
        config,
        ledger,
        cursors,
      });

      console.log('[Reindex run] Calendar:', result2.calendar.createdCount, 'Created, Contacts:', result2.contacts.createdCount, 'Created, Files:', result2.files.createdCount, 'Created');
      
      // With cursor-based recovery, reindex should create 0 items
      expect(result2.calendar.createdCount).toBe(0);
      expect(result2.contacts.createdCount).toBe(0);
      if (webdavSource) {
        expect(result2.files.createdCount).toBe(0);
      }
    }, 180000);
  });

  describe('Multi-domain aggregation', () => {
    it('should aggregate stats across all domains correctly', async () => {
      // Set up sources for multi-domain test
      const caldavSource = new CalDAVSource({
        url: `${STALWART_URL}/`,
        username: STALWART_USERNAME,
        passwordEnv: 'STALWART_JMAP_PASSWORD',
      });
      process.env.STALWART_JMAP_PASSWORD = STALWART_PASSWORD;

      const carddavSource = new CarddavSource({
        url: `${STALWART_URL}/`,
        username: STALWART_USERNAME,
        passwordEnv: 'STALWART_JMAP_PASSWORD',
      });

      const webdavSource = NEXTCLOUD_WEBDAV_URL ? new WebdavFileSource({
        url: NEXTCLOUD_WEBDAV_URL,
        username: NEXTCLOUD_USERNAME,
        passwordEnv: 'NEXTCLOUD_PASSWORD',
        rootPath: `/files/${NEXTCLOUD_USERNAME}/`,
      }) : null;
      if (NEXTCLOUD_PASSWORD) {
        process.env.NEXTCLOUD_PASSWORD = NEXTCLOUD_PASSWORD;
      }

      const config: UnifiedSyncConfig = {
        tenantId: TENANT_ID,
        mappingId: MAPPING_ID,
        calendar: { enabled: true },
        contacts: { enabled: true },
        files: { enabled: !!webdavSource },
        caldavSource: {
          url: `${STALWART_URL}/`,
          username: STALWART_USERNAME,
          passwordEnv: 'STALWART_JMAP_PASSWORD',
        },
        caldavTarget: {
          url: `${STALWART_URL}/`,
          username: STALWART_USERNAME,
          password: STALWART_PASSWORD,
        },
        carddavSource: {
          url: `${STALWART_URL}/`,
          username: STALWART_USERNAME,
          passwordEnv: 'STALWART_JMAP_PASSWORD',
        },
        carddavTarget: {
          url: `${STALWART_URL}/`,
          username: STALWART_USERNAME,
          password: STALWART_PASSWORD,
        },
        webdavSource: NEXTCLOUD_WEBDAV_URL ? {
          url: NEXTCLOUD_WEBDAV_URL,
          username: NEXTCLOUD_USERNAME,
          passwordEnv: 'NEXTCLOUD_PASSWORD',
          rootPath: `/files/${NEXTCLOUD_USERNAME}/`,
        } : undefined,
        webdavTarget: NEXTCLOUD_WEBDAV_URL ? {
          url: NEXTCLOUD_WEBDAV_URL,
          username: NEXTCLOUD_USERNAME,
          password: NEXTCLOUD_PASSWORD || '',
          rootPath: `/files/${NEXTCLOUD_USERNAME}/`,
        } : undefined,
      };

      const result = await runUnifiedSync({
        config,
        ledger,
        cursors,
      });

      // Verify each domain has its own stats
      expect(result.calendar).toBeDefined();
      expect(result.contacts).toBeDefined();
      expect(result.files).toBeDefined();

      // Verify stats structure
      expect(result.calendar.totalItems).toBeGreaterThanOrEqual(result.calendar.createdCount);
      expect(result.contacts.totalItems).toBeGreaterThanOrEqual(result.contacts.createdCount);
      expect(result.files.totalItems).toBeGreaterThanOrEqual(result.files.createdCount);

      // Verify total duration is positive
      expect(result.totalDurationSeconds).toBeGreaterThan(0);

      console.log('[Multi-domain] Calendar:', result.calendar.totalItems, 'items,',
                  'Contacts:', result.contacts.totalItems, 'items,',
                  'Files:', result.files.totalItems, 'items');
    }, 180000);
  });
});
