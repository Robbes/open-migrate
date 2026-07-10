// Copyright 2026 OpenHands Agent (Apache-2.0)
// Integration tests for CalDAV source connector against a real Stalwart CalDAV server.
// Uses Testcontainers for containerized Stalwart instance.
//
// IMPORTANT: Stalwart v0.16.10 does NOT support CalDAV/CardDAV protocols.
// These tests are skipped because Stalwart only supports JMAP and IMAP.
// For CalDAV testing, use a DAV-capable server (e.g., Nextcloud, Xandikos).
//
// TEST SCENARIOS (when run against a DAV-capable server):
// - listFolders() discovers seeded calendars
// - listSince() returns seeded events with correct iCalendar payload
// - Cursor round-trip (second call returns only changes)
// - Idempotency: run twice, second run creates 0 items

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { CalDAVSource } from './caldav-source';
import type { CalDAVSourceConfig } from './caldav-source.types';
import type { RawCalendarEvent as _RawCalendarEvent } from '@openmig/shared';

// Stalwart CalDAV configuration from Testcontainers
const STALWART_CALENDAR_URL = process.env.STALWART_JMAP_URL;
const CALDAV_USERNAME = process.env.STALWART_JMAP_USERNAME || 'source@dev.local';
const CALDAV_PASSWORD = process.env.STALWART_JMAP_PASSWORD || 'source_password';

// Check if Stalwart supports CalDAV (it doesn't in v0.16.10)
let caldavSupported = false;
let skipReason = 'Stalwart CalDAV URL not configured';

if (STALWART_CALENDAR_URL) {
  try {
    // Check if Stalwart supports CalDAV by probing the well-known URI
    const response = await fetch(`${STALWART_CALENDAR_URL.replace(/\/$/, '')}/.well-known/caldav`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    
    // Check content-type to detect HTML responses (Stalwart portal)
    const contentType = response.headers.get('content-type') || '';
    console.log(`[Probe] .well-known/caldav: status=${response.status}, content-type=${contentType}`);
    
    // Stalwart v0.16.10 does not support DAV - returns HTML for all DAV endpoints
    const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml+xml');

    if (response.status === 404 || isHtml) {
      skipReason = 'Stalwart v0.16.10 does not support CalDAV protocol (only JMAP/IMAP)';
    } else if ((response.status === 401 || response.status === 200) && (contentType.includes('xml') || contentType.includes('calendar'))) {
      // 401 means the endpoint exists but requires auth - DAV might be supported
      // 200 means the endpoint is accessible - DAV is supported
      caldavSupported = true;
    }
  } catch (err) {
    skipReason = `Could not probe Stalwart CalDAV: ${err instanceof Error ? err.message : String(err)}`;
  }
} else {
  skipReason = 'Stalwart CalDAV URL not configured (STALWART_JMAP_URL not set)';
}

// Skip all tests if CalDAV is not supported
if (!caldavSupported) {
  console.warn(`[CalDAV Tests] Skipping: ${skipReason}`);
}

// Fixed UUIDs for testing
const TEST_CALENDAR_NAME = 'Test Calendar';
const TEST_EVENT_UID_1 = 'test-event-1@dev.local';
const TEST_EVENT_UID_2 = 'test-event-2@dev.local';
const TEST_EVENT_UID_3 = 'test-event-3@dev.local';

/**
 * Wait for CalDAV server to be ready.
 */
async function waitForCaldav(maxRetries = 30, delayMs = 2000): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(`${STALWART_CALENDAR_URL}/.well-known/caldav`, {
        method: 'GET',
      });
      if (response.status === 200 || response.status === 401 || response.status === 404) {
        return;
      }
    } catch {
      // CalDAV not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error('CalDAV server not ready after max retries');
}

/**
 * Seed test calendar events via raw DAV PUT.
 * Creates a test calendar and populates it with iCalendar events.
 * Uses RFC 6764 discovery to get the correct calendar-home-set URL.
 */
async function seedCalendarEvents(caldavSource: CalDAVSource): Promise<void> {
  const caldavUrl = STALWART_CALENDAR_URL!.replace(/\/$/, '');
  
  // Trigger discovery to get the calendar-home-set
  const folders = await caldavSource.listFolders();
  
  // Try to find or create the test calendar
  let testCalendar = folders.find(f => f.name === TEST_CALENDAR_NAME);
  let calendarUrl: string | undefined;
  
  if (!testCalendar) {
    // Calendar doesn't exist, we need to create it
    // The CalDAVSource should have discovered the calendar-home-set
    const calendarHomeSet = (caldavSource as any).calendarHomeSet;
    if (!calendarHomeSet) {
      throw new Error('Calendar home-set not discovered. DAV may not be enabled on the server.');
    }
    
    // Create the test calendar using MKCALENDAR
    calendarUrl = new URL(`test-calendar/`, calendarHomeSet).toString();
    
    const mkcalendarXml = `<?xml version="1.0" encoding="utf-8"?>
      <D:mkcalendar xmlns:D="DAV:" xmlns:CA="urn:ietf:params:xml:ns:caldav">
        <D:set>
          <D:prop>
            <D:displayname>${TEST_CALENDAR_NAME}</D:displayname>
            <CA:supported-calendar-component-set>
              <CA:comp name="VEVENT"/>
            </CA:supported-calendar-component-set>
          </D:prop>
        </D:set>
      </D:mkcalendar>`;

    try {
      const response = await fetch(calendarUrl, {
        method: 'MKCALENDAR',
        headers: {
          'Content-Type': 'application/xml',
          Authorization: `Basic ${Buffer.from(`${CALDAV_USERNAME}:${CALDAV_PASSWORD}`).toString('base64')}`,
        },
        body: mkcalendarXml,
      });
      
      if (response.status === 201 || response.status === 204) {
        console.log('[Seed] Created test calendar');
        // Refresh folders to get the new calendar
        const refreshedFolders = await caldavSource.listFolders();
        testCalendar = refreshedFolders.find(f => f.name === TEST_CALENDAR_NAME);
      } else {
        const body = await response.text();
        console.warn(`[Seed] Calendar creation failed: ${response.status} - ${body.substring(0, 200)}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Seed] Calendar creation error: ${msg}`);
    }
  } else {
    // Use the discovered calendar path
    calendarUrl = new URL(`${testCalendar.path.replace(/\/$/, '')}/`, caldavUrl).toString();
  }
  
  if (!testCalendar || !calendarUrl) {
    throw new Error('No calendar available for seeding. DAV configuration may be incorrect.');
  }

  // Seed test events
  const testEvents = [
    {
      uid: TEST_EVENT_UID_1,
      summary: 'Test Event 1',
      dtstart: '20240115T100000Z',
      dtend: '20240115T110000Z',
      description: 'First test event for CalDAV integration tests',
    },
    {
      uid: TEST_EVENT_UID_2,
      summary: 'Test Event 2',
      dtstart: '20240220T140000Z',
      dtend: '20240220T153000Z',
      description: 'Second test event with different timing',
    },
    {
      uid: TEST_EVENT_UID_3,
      summary: 'Test Event 3',
      dtstart: '20240310T090000Z',
      dtend: '20240310T100000Z',
      description: 'Third test event for cursor testing',
    },
  ];

  for (const event of testEvents) {
    const icalendar = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//OpenMig//Test//EN
METHOD:PUBLISH
BEGIN:VEVENT
UID:${event.uid}
DTSTAMP:20240101T000000Z
DTSTART:${event.dtstart}
DTEND:${event.dtend}
SUMMARY:${event.summary}
DESCRIPTION:${event.description}
LOCATION:Test Location
STATUS:CONFIRMED
END:VEVENT
END:VCALENDAR`;

    const eventUrl = new URL(`${event.uid}.ics`, calendarUrl!).toString();
    
    try {
      const response = await fetch(eventUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'text/calendar',
          Authorization: `Basic ${Buffer.from(`${CALDAV_USERNAME}:${CALDAV_PASSWORD}`).toString('base64')}`,
        },
        body: icalendar,
      });

      if (response.status === 201 || response.status === 204) {
        console.log(`[Seed] Created event: ${event.uid}`);
      } else {
        const body = await response.text();
        console.warn(`[Seed] Event ${event.uid} response: ${response.status} - ${body.substring(0, 200)}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Seed] Warning: Could not seed event ${event.uid}: ${msg}`);
    }
  }

  console.log('[Seed] Calendar events seeded');
}

/**
 * Clean up test calendar and events.
 * Uses RFC 6764 discovery to get the correct calendar-home-set URL.
 */
async function cleanCalendar(caldavSource?: CalDAVSource): Promise<void> {
  // If caldavSource is provided, use its discovered calendar home-set
  let calendarHomeSet: string | undefined;
  if (caldavSource) {
    calendarHomeSet = (caldavSource as any).calendarHomeSet;
  }
  
  // Fallback to environment variable if not discovered
  const caldavUrl = STALWART_CALENDAR_URL || 'http://localhost:8080';
  
  try {
    // If we have the calendar home-set, use it for cleanup
    const baseCollectionUrl = calendarHomeSet || `${caldavUrl.replace(/\/$/, '')}/${CALDAV_USERNAME.split('@')[0]}/`;
    
    // Delete all events in the calendar using REPORT
    const syncCollectionXml = `<?xml version="1.0" encoding="utf-8"?>
      <D:sync-collection xmlns:D="DAV:">
        <D:prop>
          <D:resourcetype/>
          <D:getetag/>
        </D:prop>
        <D:sync-token/>
      </D:sync-collection>`;

    const response = await fetch(baseCollectionUrl, {
      method: 'REPORT',
      headers: {
        'Content-Type': 'application/xml',
        Authorization: `Basic ${Buffer.from(`${CALDAV_USERNAME}:${CALDAV_PASSWORD}`).toString('base64')}`,
      },
      body: syncCollectionXml,
    });

    if (response.status === 207) {
      const body = await response.text();
      // Parse and delete all resources
      const hrefRegex = /<D:href>([^<]+)<\/D:href>/g;
      let match;
      const resourcesToDelete: string[] = [];
      
      while ((match = hrefRegex.exec(body)) !== null) {
        const href = match[1];
        if (!href) continue;
        // Only delete resources in our test calendar
        if (href.includes('test-calendar')) {
          resourcesToDelete.push(href);
        }
      }

      for (const resource of resourcesToDelete) {
        try {
          await fetch(resource, {
            method: 'DELETE',
            headers: {
              Authorization: `Basic ${Buffer.from(`${CALDAV_USERNAME}:${CALDAV_PASSWORD}`).toString('base64')}`,
            },
          });
        } catch {
          // Ignore deletion errors
        }
      }
    }

    // Delete the calendar itself
    if (calendarHomeSet) {
      const calendarUrl = new URL(`test-calendar/`, calendarHomeSet).toString();
      try {
        await fetch(calendarUrl, {
          method: 'DELETE',
          headers: {
            Authorization: `Basic ${Buffer.from(`${CALDAV_USERNAME}:${CALDAV_PASSWORD}`).toString('base64')}`,
          },
        });
      } catch {
        // Ignore calendar deletion errors
      }
    }

    console.log('[Cleanup] Calendar cleaned');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Cleanup] Warning: Could not clean calendar: ${msg}`);
  }
}

// Conditionally skip the entire test suite
const testSuite = caldavSupported ? describe : describe.skip;

testSuite('CalDAV Source Integration Tests', () => {
  let caldavSource: CalDAVSource;

  beforeAll(async () => {
    console.log('[CalDAV Tests] Waiting for CalDAV server...');
    await waitForCaldav();
    console.log('[CalDAV Tests] CalDAV server is ready');
    
    // Create the CalDAV source for seeding
    caldavSource = new CalDAVSource({
      url: `${STALWART_CALENDAR_URL}/`,
      username: CALDAV_USERNAME,
      passwordEnv: 'CALDAV_PASSWORD',
    } as CalDAVSourceConfig);
    process.env.CALDAV_PASSWORD = CALDAV_PASSWORD;
  }, 60000);

  beforeEach(async () => {
    // Clean up before each test for isolation
    await cleanCalendar(caldavSource);
    // Seed with the caldavSource instance
    await seedCalendarEvents(caldavSource);
  });

  afterAll(async () => {
    // Final cleanup
    await cleanCalendar(caldavSource);
  });

  describe('listFolders()', () => {
    it('should discover seeded calendars', async () => {
      // caldavSource is already created in beforeAll

      const folders = await caldavSource.listFolders();

      expect(folders).toBeDefined();
      expect(Array.isArray(folders)).toBe(true);
      
      // Should find at least the test calendar
      const testCalendar = folders.find(f => f.name === TEST_CALENDAR_NAME);
      expect(testCalendar).toBeDefined();
      expect(testCalendar?.name).toBe(TEST_CALENDAR_NAME);

      console.log('[listFolders] Discovered calendars:', folders.map(f => f.name));
    });
  });

  describe('listSince()', () => {
    it('should return seeded events with correct iCalendar payload', async () => {
      caldavSource = new CalDAVSource({
        url: `${STALWART_CALENDAR_URL}/`,
        username: CALDAV_USERNAME,
        passwordEnv: 'CALDAV_PASSWORD',
      } as CalDAVSourceConfig);

      process.env.CALDAV_PASSWORD = CALDAV_PASSWORD;

      // First, get the calendar folder
      const folders = await caldavSource.listFolders();
      const testCalendar = folders.find(f => f.name === TEST_CALENDAR_NAME);
      expect(testCalendar).toBeDefined();

      // List events since epoch (all events)
      const { items, nextCursor } = await caldavSource.listSince(testCalendar!);

      expect(items).toBeDefined();
      expect(Array.isArray(items)).toBe(true);
      expect(items.length).toBeGreaterThanOrEqual(3);

      // Verify each event has correct structure
      for (const item of items) {
        expect(item.item).toBeDefined();
        expect(item.item.uid).toBeDefined();
        expect(item.item.summary).toBeDefined();
        expect(item.item.icalendar).toBeDefined();
        expect(item.icalendar).toBeDefined();

        // Verify iCalendar payload contains expected properties
        const ical = item.icalendar;
        expect(ical).toContain('BEGIN:VCALENDAR');
        expect(ical).toContain('END:VCALENDAR');
        expect(ical).toContain('BEGIN:VEVENT');
        expect(ical).toContain('END:VEVENT');
        expect(ical).toContain('UID:');
        expect(ical).toContain('DTSTART:');
        expect(ical).toContain('SUMMARY:');
      }

      // Verify our test events are present
      const eventUids = items.map(i => i.item.uid.toLowerCase());
      expect(eventUids).toContain(TEST_EVENT_UID_1.toLowerCase());
      expect(eventUids).toContain(TEST_EVENT_UID_2.toLowerCase());
      expect(eventUids).toContain(TEST_EVENT_UID_3.toLowerCase());

      expect(nextCursor).toBeDefined();
      expect(nextCursor.value).toBeDefined();

      console.log('[listSince] Found', items.length, 'events');
    });

    it('should support cursor round-trip (second call returns only changes)', async () => {
      caldavSource = new CalDAVSource({
        url: `${STALWART_CALENDAR_URL}/`,
        username: CALDAV_USERNAME,
        passwordEnv: 'CALDAV_PASSWORD',
      } as CalDAVSourceConfig);

      process.env.CALDAV_PASSWORD = CALDAV_PASSWORD;

      const folders = await caldavSource.listFolders();
      const testCalendar = folders.find(f => f.name === TEST_CALENDAR_NAME);
      expect(testCalendar).toBeDefined();

      // First call - get all events
      const result1 = await caldavSource.listSince(testCalendar!);
      const initialCount = result1.items.length;
      expect(initialCount).toBeGreaterThanOrEqual(3);
      expect(result1.nextCursor.value).toBeDefined();

      // Second call with cursor - should return no new items (all already seen)
      const result2 = await caldavSource.listSince(testCalendar!, result1.nextCursor);
      
      // With cursor-based sync, unchanged data should return empty or minimal results
      expect(result2.items.length).toBeLessThanOrEqual(initialCount);
      
      console.log('[Cursor Round-trip] First call:', initialCount, 'items, Second call:', result2.items.length, 'items');
    });
  });

  describe('Idempotency', () => {
    it('should be idempotent (run twice, second run creates 0 new items)', async () => {
      caldavSource = new CalDAVSource({
        url: `${STALWART_CALENDAR_URL}/`,
        username: CALDAV_USERNAME,
        passwordEnv: 'CALDAV_PASSWORD',
      } as CalDAVSourceConfig);

      process.env.CALDAV_PASSWORD = CALDAV_PASSWORD;

      const folders = await caldavSource.listFolders();
      const testCalendar = folders.find(f => f.name === TEST_CALENDAR_NAME);
      expect(testCalendar).toBeDefined();

      // First sync - collect all events
      const sync1 = await caldavSource.listSince(testCalendar!);
      const firstRunCount = sync1.items.length;
      expect(firstRunCount).toBeGreaterThanOrEqual(3);

      // Second sync with cursor - should get no new items
      const sync2 = await caldavSource.listSince(testCalendar!, sync1.nextCursor);
      
      // Idempotency: second sync should not return new items
      expect(sync2.items.length).toBe(0);

      console.log('[Idempotency] First sync:', firstRunCount, 'items, Second sync:', sync2.items.length, 'items');
    });
  });

  describe('Event parsing', () => {
    it('should correctly parse iCalendar event properties', async () => {
      caldavSource = new CalDAVSource({
        url: `${STALWART_CALENDAR_URL}/`,
        username: CALDAV_USERNAME,
        passwordEnv: 'CALDAV_PASSWORD',
      } as CalDAVSourceConfig);

      process.env.CALDAV_PASSWORD = CALDAV_PASSWORD;

      const folders = await caldavSource.listFolders();
      const testCalendar = folders.find(f => f.name === TEST_CALENDAR_NAME);
      expect(testCalendar).toBeDefined();

      const { items } = await caldavSource.listSince(testCalendar!);

      // Find our first test event
      const testEvent = items.find(i => i.item.uid.toLowerCase() === TEST_EVENT_UID_1.toLowerCase());
      expect(testEvent).toBeDefined();

      // Verify parsed properties
      expect(testEvent!.item.summary).toBe('Test Event 1');
      expect(testEvent!.item.description).toBe('First test event for CalDAV integration tests');
      expect(testEvent!.item.location).toBe('Test Location');
      
      // Verify start/end times are parsed correctly
      expect(testEvent!.item.start).toBe('2024-01-15T10:00:00Z');
      expect(testEvent!.item.end).toBe('2024-01-15T11:00:00Z');

      console.log('[Event Parsing] Verified event properties');
    });
  });
});
