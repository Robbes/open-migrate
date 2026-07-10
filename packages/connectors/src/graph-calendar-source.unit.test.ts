/**
 * Graph Calendar Source Unit Tests
 * 
 * Tests for GraphCalendarSource implementation covering:
 * - Calendar enumeration via /me/calendars
 * - Delta query with @odata.deltaLink
 * - iCal extraction from Graph responses
 * - UID + RECURRENCE-ID extraction for natural keys
 * - Recurrence exception handling
 * - Cancelled occurrence tracking (drift log, not delete)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GraphCalendarSource } from './graph-calendar-source';
import type { GraphCalendarSourceConfig as _GraphCalendarSourceConfig } from './graph-calendar-source.types';
import type { HttpClient, HttpResponse } from './dav-http.types';
import type { TokenProvider, OAuth2Token } from '@openmig/shared';

// Mock token provider
function createMockTokenProvider(token: OAuth2Token = defaultToken): TokenProvider {
  return {
    getToken: vi.fn().mockResolvedValue(token),
    refresh: vi.fn().mockResolvedValue(token),
    isTokenValid: vi.fn().mockReturnValue(true),
    getTokenStatus: vi.fn().mockReturnValue({ isValid: true, timeUntilExpiry: 3600 }),
  };
}

const defaultToken: OAuth2Token = {
  accessToken: 'mock-access-token',
  tokenType: 'Bearer',
  expiresAt: Date.now() + 3600000,
};

// Mock HTTP client
function createMockHttpClient(responses: HttpResponse[]): HttpClient {
  let callCount = 0;
  return {
    request: vi.fn().mockImplementation(() => {
      const response = responses[callCount] || responses[responses.length - 1];
      callCount++;
      return Promise.resolve(response);
    }),
  };
}

describe('GraphCalendarSource', () => {
  describe('Calendar enumeration', () => {
    it('should list all calendars from /me/calendars endpoint', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'AQMkAGI2',
                name: 'Calendar',
                isDefaultCalendar: true,
                changeKey: 'changeKey1',
                hexColor: '#1f8aff',
              },
              {
                id: 'AQMkAGI3',
                name: 'Birthdays',
                isDefaultCalendar: false,
                changeKey: 'changeKey2',
                hexColor: '#a357ff',
              },
            ],
          }),
          headers: {},
        },
      ]);

      const source = new GraphCalendarSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folders = await source.listFolders();

      expect(folders).toHaveLength(2);
      expect(folders[0]).toMatchObject({
        path: '/calendars/AQMkAGI2',
        name: 'Calendar',
        color: '#1f8aff',
      });
      expect(folders[1]).toMatchObject({
        path: '/calendars/AQMkAGI3',
        name: 'Birthdays',
        color: '#a357ff',
      });
    });

    it('should handle pagination for calendar list', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'cal1',
                name: 'Calendar 1',
                isDefaultCalendar: true,
                changeKey: 'ck1',
              },
            ],
            '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendars?$skip=1',
          }),
          headers: {},
        },
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'cal2',
                name: 'Calendar 2',
                isDefaultCalendar: false,
                changeKey: 'ck2',
              },
            ],
          }),
          headers: {},
        },
      ]);

      const source = new GraphCalendarSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folders = await source.listFolders();

      expect(folders).toHaveLength(2);
      expect(mockClient.request).toHaveBeenCalledTimes(2);
    });

    it('should handle empty calendar list', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({ value: [] }),
          headers: {},
        },
      ]);

      const source = new GraphCalendarSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folders = await source.listFolders();

      expect(folders).toHaveLength(0);
    });
  });

  describe('Delta query', () => {
    it('should perform initial delta query without cursor', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'evt1',
                subject: 'Team Meeting',
                start: { dateTime: '2024-01-15T10:00:00', timeZone: 'UTC' },
                end: { dateTime: '2024-01-15T11:00:00', timeZone: 'UTC' },
                isAllDay: false,
                isCancelled: false,
                isRecurring: false,
              },
            ],
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/calendars/cal1/events/delta?$deltatoken=abc123',
          }),
          headers: {},
        },
      ]);

      const source = new GraphCalendarSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folder = { path: '/calendars/cal1', name: 'Calendar' };
      const result = await source.listSince(folder);

      expect(result.items).toHaveLength(0); // No iCal data in mock, so no items
      expect(result.nextCursor.value).toContain('graph-delta:');
      expect(result.nextCursor.value).toContain('abc123');
    });

    it('should perform incremental sync with deltaLink cursor', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'evt2',
                subject: 'Updated Meeting',
                start: { dateTime: '2024-01-16T14:00:00', timeZone: 'UTC' },
                end: { dateTime: '2024-01-16T15:00:00', timeZone: 'UTC' },
                isAllDay: false,
                isCancelled: false,
              },
            ],
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/calendars/cal1/events/delta?$deltatoken=xyz789',
          }),
          headers: {},
        },
      ]);

      const source = new GraphCalendarSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folder = { path: '/calendars/cal1', name: 'Calendar' };
      const cursor = {
        value: 'graph-delta:/calendars/cal1:https://graph.microsoft.com/v1.0/me/calendars/cal1/events/delta?$deltatoken=abc123',
      };

      const result = await source.listSince(folder, cursor);

      expect(result.items).toHaveLength(0); // No iCal data in mock
      expect(result.nextCursor.value).toContain('xyz789');
    });

    it('should handle pagination in delta query', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'evt1',
                subject: 'Event 1',
                start: { dateTime: '2024-01-15T10:00:00', timeZone: 'UTC' },
                isAllDay: false,
                isCancelled: false,
              },
            ],
            '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendars/cal1/events/delta?$skip=1',
          }),
          headers: {},
        },
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'evt2',
                subject: 'Event 2',
                start: { dateTime: '2024-01-16T10:00:00', timeZone: 'UTC' },
                isAllDay: false,
                isCancelled: false,
              },
            ],
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/calendars/cal1/events/delta?$deltatoken=final',
          }),
          headers: {},
        },
      ]);

      const source = new GraphCalendarSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folder = { path: '/calendars/cal1', name: 'Calendar' };
      await source.listSince(folder);

      // 2 requests for events pagination + 2 requests for iCal fetches (which fail)
      expect(mockClient.request).toHaveBeenCalledTimes(4);
    });
  });

  describe('iCal extraction from Graph responses', () => {
    it('should fetch event as iCal using /events/{id}/$value endpoint', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'evt1',
                subject: 'Test Event',
                start: { dateTime: '2024-01-15T10:00:00', timeZone: 'UTC' },
                isAllDay: false,
                isCancelled: false,
              },
            ],
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta',
          }),
          headers: {},
        },
        {
          status: 200,
          body: `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Microsoft//Office 365//EN
BEGIN:VEVENT
UID:test-event-123@office365.com
DTSTART:20240115T100000Z
DTEND:20240115T110000Z
SUMMARY:Test Event
DESCRIPTION:Event description
LOCATION:Conference Room A
END:VEVENT
END:VCALENDAR`,
          headers: { 'content-type': 'text/calendar' },
        },
      ]);

      const source = new GraphCalendarSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folder = { path: '/calendars/cal1', name: 'Calendar' };
      const result = await source.listSince(folder);

      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.icalendar).toContain('BEGIN:VCALENDAR');
      expect(result.items[0]?.item?.uid).toBe('test-event-123@office365.com');
      expect(result.items[0]?.item?.summary).toBe('Test Event');
    });

    it('should handle events with iCal parameters', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'evt1',
                subject: 'All Day Event',
                isAllDay: true,
                isCancelled: false,
              },
            ],
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta',
          }),
          headers: {},
        },
        {
          status: 200,
          body: `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Microsoft//Office 365//EN
BEGIN:VEVENT
UID:allday-event@office365.com
DTSTART;VALUE=DATE:20240115
DTEND;VALUE=DATE:20240116
SUMMARY:All Day Event
END:VEVENT
END:VCALENDAR`,
          headers: { 'content-type': 'text/calendar' },
        },
      ]);

      const source = new GraphCalendarSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folder = { path: '/calendars/cal1', name: 'Calendar' };
      const result = await source.listSince(folder);

      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.item?.start).toBe('2024-01-15T00:00:00Z');
    });
  });

  describe('UID + RECURRENCE-ID extraction', () => {
    it('should extract UID from iCal event', async () => {
      const source = new GraphCalendarSource(
        createMockTokenProvider(),
        'test-tenant-id',
      );

      const icalendar = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:unique-event-id@example.com
DTSTART:20240115T100000Z
SUMMARY:Test Event
END:VEVENT
END:VCALENDAR`;

      const parsed = (source as any).parseIcal(icalendar);
      const naturalKey = (source as any).extractNaturalKey(parsed);

      expect(naturalKey).toBe('unique-event-id@example.com');
    });

    it('should extract UID + RECURRENCE-ID for recurring event instances', async () => {
      const source = new GraphCalendarSource(
        createMockTokenProvider(),
        'test-tenant-id',
      );

      const icalendar = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:recurring-event@example.com
RECURRENCE-ID:20240115T100000Z
DTSTART:20240115T100000Z
SUMMARY:Recurring Event - Specific Instance
END:VEVENT
END:VCALENDAR`;

      const parsed = (source as any).parseIcal(icalendar);
      const naturalKey = (source as any).extractNaturalKey(parsed);

      expect(naturalKey).toBe('recurring-event@example.com|20240115T100000Z');
    });

    it('should handle multiple UID values (should take first)', async () => {
      const source = new GraphCalendarSource(
        createMockTokenProvider(),
        'test-tenant-id',
      );

      const icalendar = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:first-uid@example.com
UID:second-uid@example.com
DTSTART:20240115T100000Z
SUMMARY:Test
END:VEVENT
END:VCALENDAR`;

      const parsed = (source as any).parseIcal(icalendar);
      const uid = (source as any).extractUid(parsed);

      expect(uid).toBe('first-uid@example.com');
    });
  });

  describe('Recurrence exception handling', () => {
    it('should identify recurrence masters', async () => {
      const source = new GraphCalendarSource(
        createMockTokenProvider(),
        'test-tenant-id',
      );

      const icalendar = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:recurring-master@example.com
DTSTART:20240101T100000Z
RRULE:FREQ=WEEKLY;COUNT=10
SUMMARY:Recurring Master Event
END:VEVENT
END:VCALENDAR`;

      const parsed = (source as any).parseIcal(icalendar);
      const naturalKey = (source as any).extractNaturalKey(parsed);

      expect(naturalKey).toBe('recurring-master@example.com');
      expect(parsed.properties['RRULE']).toBeDefined();
    });

    it('should identify recurrence exceptions', async () => {
      const source = new GraphCalendarSource(
        createMockTokenProvider(),
        'test-tenant-id',
      );

      const icalendar = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:recurring-master@example.com
RECURRENCE-ID:20240115T100000Z
DTSTART:20240115T100000Z
SUMMARY:Modified Instance
END:VEVENT
END:VCALENDAR`;

      const parsed = (source as any).parseIcal(icalendar);
      const naturalKey = (source as any).extractNaturalKey(parsed);
      const recurrenceId = (source as any).extractRecurrenceId(parsed);

      expect(naturalKey).toBe('recurring-master@example.com|20240115T100000Z');
      expect(recurrenceId).toBe('20240115T100000Z');
    });

    it('should handle exceptions with different start times', async () => {
      const source = new GraphCalendarSource(
        createMockTokenProvider(),
        'test-tenant-id',
      );

      const icalendar = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:recurring-master@example.com
RECURRENCE-ID;TZID=America/New_York:20240115T100000
DTSTART;TZID=America/New_York:20240115T140000
SUMMARY:Rescheduled Instance
END:VEVENT
END:VCALENDAR`;

      const parsed = (source as any).parseIcal(icalendar);
      const naturalKey = (source as any).extractNaturalKey(parsed);

      expect(naturalKey).toContain('recurring-master@example.com');
      expect(naturalKey).toContain('20240115T100000');
    });
  });

  describe('Cancelled occurrences (drift log, not delete)', () => {
    it('should exclude cancelled events from results', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'evt-cancelled',
                subject: 'Cancelled Meeting',
                isAllDay: false,
                isCancelled: true,
              },
            ],
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta',
          }),
          headers: {},
        },
        {
          status: 200,
          body: `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:cancelled-event@example.com
STATUS:CANCELLED
DTSTART:20240115T100000Z
SUMMARY:Cancelled Meeting
END:VEVENT
END:VCALENDAR`,
          headers: { 'content-type': 'text/calendar' },
        },
      ]);

      const source = new GraphCalendarSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folder = { path: '/calendars/cal1', name: 'Calendar' };
      const result = await source.listSince(folder);

      // Cancelled events should be excluded (logged to drift, not returned)
      expect(result.items).toHaveLength(0);
    });

    it('should detect cancelled status from iCal STATUS property', async () => {
      const source = new GraphCalendarSource(
        createMockTokenProvider(),
        'test-tenant-id',
      );

      const cancelledIcal = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:cancelled@example.com
STATUS:CANCELLED
DTSTART:20240115T100000Z
SUMMARY:Cancelled Event
END:VEVENT
END:VCALENDAR`;

      const parsed = (source as any).parseIcal(cancelledIcal);
      const isCancelled = (source as any).checkIfCancelled(parsed);

      expect(isCancelled).toBe(true);
    });

    it('should handle cancelled with lowercase status', async () => {
      const source = new GraphCalendarSource(
        createMockTokenProvider(),
        'test-tenant-id',
      );

      const cancelledIcal = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:cancelled2@example.com
status:cancelled
DTSTART:20240115T100000Z
SUMMARY:Cancelled Event
END:VEVENT
END:VCALENDAR`;

      const parsed = (source as any).parseIcal(cancelledIcal);
      const isCancelled = (source as any).checkIfCancelled(parsed);

      expect(isCancelled).toBe(true);
    });

    it('should include non-cancelled events', async () => {
      const source = new GraphCalendarSource(
        createMockTokenProvider(),
        'test-tenant-id',
      );

      const activeIcal = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:active@example.com
STATUS:CONFIRMED
DTSTART:20240115T100000Z
SUMMARY:Active Event
END:VEVENT
END:VCALENDAR`;

      const parsed = (source as any).parseIcal(activeIcal);
      const isCancelled = (source as any).checkIfCancelled(parsed);

      expect(isCancelled).toBe(false);
    });

    it('should handle events without STATUS property (not cancelled)', async () => {
      const source = new GraphCalendarSource(
        createMockTokenProvider(),
        'test-tenant-id',
      );

      const ical = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:nostatus@example.com
DTSTART:20240115T100000Z
SUMMARY:No Status Event
END:VEVENT
END:VCALENDAR`;

      const parsed = (source as any).parseIcal(ical);
      const isCancelled = (source as any).checkIfCancelled(parsed);

      expect(isCancelled).toBe(false);
    });
  });

  describe('iCal parsing', () => {
    it('should parse iCal properties correctly', async () => {
      const source = new GraphCalendarSource(
        createMockTokenProvider(),
        'test-tenant-id',
      );

      const icalendar = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:test@example.com
DTSTART:20240115T100000Z
DTEND:20240115T110000Z
SUMMARY:Test Event
DESCRIPTION:Test Description
LOCATION:Test Location
END:VEVENT
END:VCALENDAR`;

      const parsed = (source as any).parseIcal(icalendar);

      expect(parsed.type).toBe('VCALENDAR');
      expect(parsed.properties['VERSION']).toBe('2.0');
      expect(parsed.properties['PRODID']).toBe('-//Test//Test//EN');
      expect(parsed.components.length).toBe(1);
      expect(parsed.components[0].type).toBe('VEVENT');
    });

    it('should handle line folding in iCal', async () => {
      const source = new GraphCalendarSource(
        createMockTokenProvider(),
        'test-tenant-id',
      );

      const icalendar = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:folding@example.com
DESCRIPTION:This is a long description that was
 folded to multiple lines according to
 iCalendar specification
SUMMARY:Test
END:VEVENT
END:VCALENDAR`;

      const parsed = (source as any).parseIcal(icalendar);
      const desc = (source as any).extractDescription(parsed);

      expect(desc).toContain('This is a long description');
      expect(desc).toContain('folded to multiple lines');
    });

    it('should extract summary from iCal', async () => {
      const source = new GraphCalendarSource(
        createMockTokenProvider(),
        'test-tenant-id',
      );

      const icalendar = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:test@example.com
SUMMARY:Meeting with Team
END:VEVENT
END:VCALENDAR`;

      const parsed = (source as any).parseIcal(icalendar);
      const summary = (source as any).extractSummary(parsed);

      expect(summary).toBe('Meeting with Team');
    });

    it('should extract location from iCal', async () => {
      const source = new GraphCalendarSource(
        createMockTokenProvider(),
        'test-tenant-id',
      );

      const icalendar = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:test@example.com
LOCATION:Conference Room A, Building 5
END:VEVENT
END:VCALENDAR`;

      const parsed = (source as any).parseIcal(icalendar);
      const location = (source as any).extractLocation(parsed);

      expect(location).toBe('Conference Room A, Building 5');
    });
  });

  describe('Date conversion', () => {
    it('should convert iCalendar date-time to ISO 8601', async () => {
      const source = new GraphCalendarSource(
        createMockTokenProvider(),
        'test-tenant-id',
      );

      expect((source as any).convertIcalDateToIso('20240115T100000Z')).toBe('2024-01-15T10:00:00Z');
      expect((source as any).convertIcalDateToIso('20240115T100000')).toBe('2024-01-15T10:00:00');
    });

    it('should convert iCalendar date (all-day) to ISO 8601', async () => {
      const source = new GraphCalendarSource(
        createMockTokenProvider(),
        'test-tenant-id',
      );

      expect((source as any).convertIcalDateToIso('20240115')).toBe('2024-01-15T00:00:00Z');
    });
  });

  describe('Cursor encoding and decoding', () => {
    it('should encode and decode Graph delta cursor', () => {
      const source = new GraphCalendarSource(
        createMockTokenProvider(),
        'test-tenant-id',
      );

      const cursor: any = {
        deltaLink: 'https://graph.microsoft.com/v1.0/me/calendars/cal1/events/delta?$deltatoken=abc123',
        folderPath: '/calendars/cal1',
      };

      const encoded = (source as any).encodeCursor(cursor);
      const decoded = (source as any).decodeCursor({ value: encoded });

      expect(decoded.deltaLink).toBe(cursor.deltaLink);
      expect(decoded.folderPath).toBe(cursor.folderPath);
    });

    it('should handle deltaLink with special characters', () => {
      const source = new GraphCalendarSource(
        createMockTokenProvider(),
        'test-tenant-id',
      );

      const cursor: any = {
        deltaLink: 'https://graph.microsoft.com/v1.0/me/calendars/cal1/events/delta?$deltatoken=abc123&$deltastate=xyz',
        folderPath: '/calendars/cal1',
      };

      const encoded = (source as any).encodeCursor(cursor);
      const decoded = (source as any).decodeCursor({ value: encoded });

      expect(decoded.deltaLink).toBe(cursor.deltaLink);
    });

    it('should throw error for invalid cursor format', () => {
      const source = new GraphCalendarSource(
        createMockTokenProvider(),
        'test-tenant-id',
      );

      expect(() => (source as any).decodeCursor({ value: 'invalid-format' })).toThrow();
    });
  });

  describe('Calendar ID extraction', () => {
    it('should extract calendar ID from folder path', async () => {
      const source = new GraphCalendarSource(
        createMockTokenProvider(),
        'test-tenant-id',
      );

      const folder = { path: '/calendars/AQMkAGI2', name: 'Calendar' };
      const calendarId = (source as any).extractCalendarIdFromFolder(folder);

      expect(calendarId).toBe('AQMkAGI2');
    });

    it('should fallback to folder name if path doesn\'t contain calendar ID', async () => {
      const source = new GraphCalendarSource(
        createMockTokenProvider(),
        'test-tenant-id',
      );

      const folder = { path: '/some/other/path', name: 'MyCalendar' };
      const calendarId = (source as any).extractCalendarIdFromFolder(folder);

      expect(calendarId).toBe('MyCalendar');
    });
  });

  describe('Error handling', () => {
    it('should throw error when calendar listing fails', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 500,
          body: 'Internal Server Error',
          headers: {},
        },
      ]);

      const source = new GraphCalendarSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      await expect(source.listFolders()).rejects.toThrow('Failed to list calendars');
    });

    it('should throw error when event listing fails', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 401,
          body: 'Unauthorized',
          headers: {},
        },
      ]);

      const source = new GraphCalendarSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folder = { path: '/calendars/cal1', name: 'Calendar' };
      await expect(source.listSince(folder)).rejects.toThrow('Failed to list events');
    });

    it('should skip events that fail to fetch iCal', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'evt1',
                subject: 'Event with Error',
                isAllDay: false,
                isCancelled: false,
              },
            ],
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta',
          }),
          headers: {},
        },
        {
          status: 500,
          body: 'Failed to fetch iCal',
          headers: {},
        },
      ]);

      const source = new GraphCalendarSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folder = { path: '/calendars/cal1', name: 'Calendar' };
      const result = await source.listSince(folder);

      // Event should be skipped due to iCal fetch failure
      expect(result.items).toHaveLength(0);
    });
  });

  describe('Custom base URL', () => {
    it('should use custom base URL when provided', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({ value: [] }),
          headers: {},
        },
      ]);

      const source = new GraphCalendarSource(
        tokenProvider,
        'test-tenant-id',
        { baseUrl: 'https://graph.contoso.com/v1.0' },
        { httpClient: mockClient },
      );

      await source.listFolders();

      const callArgs = (mockClient.request as any).mock.calls[0][0];
      expect(callArgs.url).toContain('https://graph.contoso.com/v1.0');
    });
  });
});
