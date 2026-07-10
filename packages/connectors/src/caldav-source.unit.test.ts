/**
 * CalDAV Source Unit Tests
 * 
 * Tests for CalDAVSource implementation covering:
 * - PROPFIND parsing
 * - sync-collection REPORT parsing
 * - UID extraction from iCalendar
 * - Case-insensitive UID handling
 */

import { describe, it, expect, vi } from 'vitest';
import { CalDAVSource } from './caldav-source';
import type { CalDAVSourceConfig, CalDAVSyncToken } from './caldav-source.types';
import type { HttpClient, HttpResponse } from './dav-http.types';

// Mock HTTP client for testing
function createMockHttpClient(response: HttpResponse): HttpClient {
  return {
    request: vi.fn().mockResolvedValue(response),
  };
}

describe('CalDAVSource', () => {
  describe('PROPFIND parsing', () => {
    it('should parse calendar home set from PROPFIND response', async () => {
      const propfindResponse: HttpResponse = {
        status: 207,
        body: `<?xml version="1.0" encoding="utf-8"?>
          <D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
            <D:response>
              <D:href>/dav/user/test/</D:href>
              <D:propstat>
                <D:prop>
                  <C:calendar-home-set>/dav/calendars/user/test/</C:calendar-home-set>
                </D:prop>
                <D:status>HTTP/1.1 200 OK</D:status>
              </D:propstat>
            </D:response>
          </D:multistatus>`,
        headers: {},
      };

      const mockClient = createMockHttpClient(propfindResponse);
      const config: CalDAVSourceConfig = {
        url: 'https://caldav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      };

      // Mock the listCollections to avoid actual HTTP call
      const source = new CalDAVSource(config, { httpClient: mockClient });

      // Access private method via type casting for testing
      const homeSet = (source as any).parseCalendarHomeSetResponse(propfindResponse.body);
      expect(homeSet).toBe('/dav/calendars/user/test/');
    });

    it('should parse calendar collections from PROPFIND response', async () => {
      const propfindResponse: HttpResponse = {
        status: 207,
        body: `<?xml version="1.0" encoding="utf-8"?>
          <D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CR="urn:ietf:params:xml:ns:carddav">
            <D:response>
              <D:href>/dav/calendars/user/test/calendar/</D:href>
              <D:propstat>
                <D:prop>
                  <D:displayname>Personal</D:displayname>
                  <D:resourcetype><D:collection/><C:calendar-collection/></D:resourcetype>
                  <C:calendar-description>Personal calendar</C:calendar-description>
                  <C:calendar-timezone>Europe/Berlin</C:calendar-timezone>
                  <CR:color>#1f8aff</CR:color>
                </D:prop>
                <D:status>HTTP/1.1 200 OK</D:status>
              </D:propstat>
            </D:response>
            <D:response>
              <D:href>/dav/calendars/user/test/work/</D:href>
              <D:propstat>
                <D:prop>
                  <D:displayname>Work</D:displayname>
                  <D:resourcetype><D:collection/><C:calendar-collection/></D:resourcetype>
                  <C:calendar-description>Work calendar</C:calendar-description>
                </D:prop>
                <D:status>HTTP/1.1 200 OK</D:status>
              </D:propstat>
            </D:response>
          </D:multistatus>`,
        headers: {},
      };

      const source = new CalDAVSource({
        url: 'https://caldav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const collections = (source as any).parseCollectionsResponse(propfindResponse.body, '/dav/calendars/user/test/');
      
      expect(collections).toHaveLength(2);
      expect(collections[0]).toMatchObject({
        path: '/dav/calendars/user/test/calendar/',
        name: 'Personal',
        description: 'Personal calendar',
        timezone: 'Europe/Berlin',
        color: '#1f8aff',
      });
      expect(collections[1]).toMatchObject({
        path: '/dav/calendars/user/test/work/',
        name: 'Work',
        description: 'Work calendar',
      });
    });

    it('should handle empty PROPFIND response', async () => {
      const propfindResponse: HttpResponse = {
        status: 207,
        body: `<?xml version="1.0" encoding="utf-8"?>
          <D:multistatus xmlns:D="DAV:">
          </D:multistatus>`,
        headers: {},
      };

      const source = new CalDAVSource({
        url: 'https://caldav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const collections = (source as any).parseCollectionsResponse(propfindResponse.body, '/home/');
      expect(collections).toHaveLength(0);
    });
  });

  describe('sync-collection REPORT parsing', () => {
    it('should parse sync-collection REPORT with sync-token', async () => {
      const reportResponse: HttpResponse = {
        status: 207,
        body: `<?xml version="1.0" encoding="utf-8"?>
          <D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
            <D:sync-token>https://caldav.example.com/token/abc123</D:sync-token>
            <D:response>
              <D:href>/dav/calendars/user/test/calendar/event1.ics</D:href>
              <D:propstat>
                <D:prop>
                  <D:resourcetype/>
                  <C:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:event1@example.com
DTSTART:20240101T100000Z
DTEND:20240101T110000Z
SUMMARY:Test Event
END:VEVENT
END:VCALENDAR
</C:calendar-data>
                </D:prop>
                <D:status>HTTP/1.1 200 OK</D:status>
              </D:propstat>
            </D:response>
          </D:multistatus>`,
        headers: {},
      };

      const source = new CalDAVSource({
        url: 'https://caldav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const result = (source as any).parseSyncCollectionResponse(reportResponse.body);
      
      expect(result.syncToken).toBe('https://caldav.example.com/token/abc123');
      expect(result.objects).toHaveLength(1);
      expect(result.objects[0].href).toBe('/dav/calendars/user/test/calendar/event1.ics');
      expect(result.objects[0].icalendar).toContain('BEGIN:VCALENDAR');
      expect(result.objects[0].icalendar).toContain('UID:event1@example.com');
    });

    it('should parse sync-collection REPORT with multiple events', async () => {
      const reportResponse: HttpResponse = {
        status: 207,
        body: `<?xml version="1.0" encoding="utf-8"?>
          <D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
            <D:sync-token>https://caldav.example.com/token/xyz789</D:sync-token>
            <D:response>
              <D:href>/dav/calendars/user/test/calendar/event1.ics</D:href>
              <D:propstat>
                <D:prop>
                  <C:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:event1@example.com
SUMMARY:Event 1
END:VEVENT
END:VCALENDAR
</C:calendar-data>
                </D:prop>
              </D:propstat>
            </D:response>
            <D:response>
              <D:href>/dav/calendars/user/test/calendar/event2.ics</D:href>
              <D:propstat>
                <D:prop>
                  <C:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:event2@example.com
SUMMARY:Event 2
END:VEVENT
END:VCALENDAR
</C:calendar-data>
                </D:prop>
              </D:propstat>
            </D:response>
          </D:multistatus>`,
        headers: {},
      };

      const source = new CalDAVSource({
        url: 'https://caldav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const result = (source as any).parseSyncCollectionResponse(reportResponse.body);
      
      expect(result.syncToken).toBe('https://caldav.example.com/token/xyz789');
      expect(result.objects).toHaveLength(2);
      expect(result.objects[0].icalendar).toContain('UID:event1@example.com');
      expect(result.objects[1].icalendar).toContain('UID:event2@example.com');
    });

    it('should handle sync-collection REPORT without sync-token (full sync)', async () => {
      const reportResponse: HttpResponse = {
        status: 207,
        body: `<?xml version="1.0" encoding="utf-8"?>
          <D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
            <D:response>
              <D:href>/dav/calendars/user/test/calendar/event1.ics</D:href>
              <D:propstat>
                <D:prop>
                  <C:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:event1@example.com
SUMMARY:Test
END:VEVENT
END:VCALENDAR
</C:calendar-data>
                </D:prop>
              </D:propstat>
            </D:response>
          </D:multistatus>`,
        headers: {},
      };

      const source = new CalDAVSource({
        url: 'https://caldav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const result = (source as any).parseSyncCollectionResponse(reportResponse.body);
      
      expect(result.syncToken).toBeUndefined();
      expect(result.objects).toHaveLength(1);
    });
  });

  describe('UID extraction from iCalendar', () => {
    it('should extract UID from simple iCalendar', () => {
      const icalendar = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:test-event-123@example.com
DTSTART:20240101T100000Z
SUMMARY:Test Event
END:VEVENT
END:VCALENDAR`;

      const source = new CalDAVSource({
        url: 'https://caldav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const uid = (source as any).extractUidFromIcalendar(icalendar);
      expect(uid).toBe('test-event-123@example.com');
    });

    it('should extract UID with different formatting', () => {
      const icalendar = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:  spaced-uid@example.com
SUMMARY:Test
END:VEVENT
END:VCALENDAR`;

      const source = new CalDAVSource({
        url: 'https://caldav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const uid = (source as any).extractUidFromIcalendar(icalendar);
      expect(uid).toBe('spaced-uid@example.com');
    });

    it('should extract UID with colon separator', () => {
      const icalendar = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:colon-sep@example.com
DTSTART:20240101T100000Z
END:VEVENT
END:VCALENDAR`;

      const source = new CalDAVSource({
        url: 'https://caldav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const uid = (source as any).extractUidFromIcalendar(icalendar);
      expect(uid).toBe('colon-sep@example.com');
    });

    it('should return null for iCalendar without UID', () => {
      const icalendar = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
DTSTART:20240101T100000Z
SUMMARY:No UID Event
END:VEVENT
END:VCALENDAR`;

      const source = new CalDAVSource({
        url: 'https://caldav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const uid = (source as any).extractUidFromIcalendar(icalendar);
      expect(uid).toBeNull();
    });

    it('should handle UID with special characters', () => {
      const icalendar = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:complex-uid_with.special+chars@example.com
SUMMARY:Test
END:VEVENT
END:VCALENDAR`;

      const source = new CalDAVSource({
        url: 'https://caldav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const uid = (source as any).extractUidFromIcalendar(icalendar);
      expect(uid).toBe('complex-uid_with.special+chars@example.com');
    });
  });

  describe('Case-insensitive UID handling', () => {
    it('should normalize UID to lowercase', () => {
      const source = new CalDAVSource({
        url: 'https://caldav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      expect((source as any).normalizeUid('UPPERCASE@EXAMPLE.COM')).toBe('uppercase@example.com');
      expect((source as any).normalizeUid('MiXeDcAsE@Example.Com')).toBe('mixedcase@example.com');
      expect((source as any).normalizeUid('lowercase@example.com')).toBe('lowercase@example.com');
    });

    it('should treat UIDs as case-insensitive for comparison', () => {
      const source = new CalDAVSource({
        url: 'https://caldav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const uid1 = (source as any).normalizeUid('EVENT@EXAMPLE.COM');
      const uid2 = (source as any).normalizeUid('event@example.com');
      const uid3 = (source as any).normalizeUid('Event@Example.Com');

      expect(uid1).toBe(uid2);
      expect(uid2).toBe(uid3);
      expect(uid1).toBe(uid3);
    });

    it('should handle UID in calendar object parsing with case normalization', () => {
      const icalendar = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:MIXEDCASE@EXAMPLE.COM
SUMMARY:Test Event
END:VEVENT
END:VCALENDAR`;

      const source = new CalDAVSource({
        url: 'https://caldav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const event = (source as any).parseCalendarObject({
        href: '/calendar/event.ics',
        icalendar,
      });

      expect(event.item.uid).toBe('mixedcase@example.com');
    });
  });

  describe('Cursor encoding and decoding', () => {
    it('should encode and decode sync-token cursor', () => {
      const source = new CalDAVSource({
        url: 'https://caldav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const token = 'https://caldav.example.com/token/abc123';
      const encoded = (source as any).encodeSyncToken(token);
      const decoded: CalDAVSyncToken = (source as any).decodeSyncToken({ value: encoded });

      expect(decoded.token).toBe(token);
      expect(decoded.isSyncToken).toBe(true);
    });

    it('should encode and decode CTag cursor', () => {
      const source = new CalDAVSource({
        url: 'https://caldav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const collectionPath = '/dav/calendars/user/test/calendar/';
      const ctag = '"1234567890"';
      const encoded = (source as any).encodeCTag(ctag, collectionPath);
      const decoded: CalDAVSyncToken = (source as any).decodeSyncToken({ value: encoded });

      expect(decoded.token).toBe(ctag);
      expect(decoded.isSyncToken).toBe(false);
      expect(decoded.collectionPath).toBe(collectionPath);
    });

    it('should throw error for invalid cursor format', () => {
      const source = new CalDAVSource({
        url: 'https://caldav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      expect(() => (source as any).decodeSyncToken({ value: 'invalid-format' })).toThrow();
    });
  });

  describe('XML escaping', () => {
    it('should escape XML special characters', () => {
      const source = new CalDAVSource({
        url: 'https://caldav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const input = 'Test & <script> "quotes" \'apostrophe\'';
      const escaped = (source as any).escapeXml(input);

      expect(escaped).toBe('Test &amp; &lt;script&gt; &quot;quotes&quot; &apos;apostrophe&apos;');
    });
  });

  describe('XML entity decoding', () => {
    it('should decode XML entities in calendar data', () => {
      const source = new CalDAVSource({
        url: 'https://caldav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const encoded = 'Test &lt;description&gt; &amp; more';
      const decoded = (source as any).decodeXmlEntities(encoded);

      expect(decoded).toBe('Test <description> & more');
    });
  });

  describe('Line unfolding', () => {
    it('should unfold iCalendar lines', () => {
      const source = new CalDAVSource({
        url: 'https://caldav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      // iCalendar lines can be folded with leading whitespace
      const folded = `BEGIN:VCALENDAR
DESCRIPTION:This is a long description that was
 folded to multiple lines
SUMMARY:Test
END:VCALENDAR`;

      const unfolded = (source as any).unfoldLines(folded);

      expect(unfolded).toBe('BEGIN:VCALENDAR\nDESCRIPTION:This is a long description that wasfolded to multiple lines\nSUMMARY:Test\nEND:VCALENDAR');

      expect((source as any).convertIcalDateToIso('20240101T120000Z')).toBe('2024-01-01T12:00:00Z');
      expect((source as any).convertIcalDateToIso('20240101T120000')).toBe('2024-01-01T12:00:00');
    });

    it('should convert iCalendar date (all-day) to ISO 8601', () => {
      const source = new CalDAVSource({
        url: 'https://caldav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      expect((source as any).convertIcalDateToIso('20240101')).toBe('2024-01-01T00:00:00Z');
    });
  });

  describe('Path normalization', () => {
    it('should normalize paths consistently', () => {
      const source = new CalDAVSource({
        url: 'https://caldav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      expect((source as any).normalizePath('/path/to/calendar')).toBe('/path/to/calendar/');
      expect((source as any).normalizePath('path/to/calendar/')).toBe('/path/to/calendar/');
      expect((source as any).normalizePath('path/to/calendar')).toBe('/path/to/calendar/');
    });

    it('should build URLs correctly', () => {
      const source = new CalDAVSource({
        url: 'https://caldav.example.com',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      expect((source as any).buildUrl('/calendar/')).toBe('https://caldav.example.com/calendar/');
      expect((source as any).buildUrl('calendar')).toBe('https://caldav.example.com/calendar/');
    });
  });

  describe('Calendar object parsing', () => {
    it('should parse complete calendar event', () => {
      const icalendar = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:test-event@example.com
DTSTART:20240101T100000Z
DTEND:20240101T110000Z
SUMMARY:Test Event
DESCRIPTION:Event description
LOCATION:Conference Room A
END:VEVENT
END:VCALENDAR`;

      const source = new CalDAVSource({
        url: 'https://caldav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const event = (source as any).parseCalendarObject({
        href: '/dav/calendars/user/test/calendar/event.ics',
        icalendar,
      });

      expect(event).toMatchObject({
        item: {
          uid: 'test-event@example.com',
          type: 'event',
          summary: 'Test Event',
          start: '2024-01-01T10:00:00Z',
          end: '2024-01-01T11:00:00Z',
          description: 'Event description',
          location: 'Conference Room A',
        },
      });
    });

    it('should handle all-day events', () => {
      const icalendar = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:allday-event@example.com
DTSTART;VALUE=DATE:20240101
SUMMARY:All Day Event
END:VEVENT
END:VCALENDAR`;

      const source = new CalDAVSource({
        url: 'https://caldav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const event = (source as any).parseCalendarObject({
        href: '/dav/calendars/user/test/calendar/allday.ics',
        icalendar,
      });

      expect(event.item.uid).toBe('allday-event@example.com');
      expect(event.item.summary).toBe('All Day Event');
    });
  });

  describe('Authorization header', () => {
    it('should build correct authorization header', () => {
      process.env.TEST_CALENDAR_PASSWORD = 'secret123';
      
      const source = new CalDAVSource({
        url: 'https://caldav.example.com/',
        username: 'testuser',
        passwordEnv: 'TEST_CALENDAR_PASSWORD',
      });

      const authHeader = (source as any).getAuthorizationHeader();
      const expected = `Basic ${Buffer.from('testuser:secret123').toString('base64')}`;
      
      expect(authHeader).toBe(expected);
    });

    it('should throw error when password env var not set', () => {
      const source = new CalDAVSource({
        url: 'https://caldav.example.com/',
        username: 'testuser',
        passwordEnv: 'NONEXISTENT_PASSWORD_VAR',
      });

      expect(() => (source as any).getAuthorizationHeader()).toThrow();
    });
  });
});
