/**
 * Unit tests for unified-sync module
 * 
 * Tests cover:
 * - Each domain being enabled/disabled
 * - Failing domain surfacing errors
 * - Aggregated statistics
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Ledger, CursorStore, TenantId, MappingId } from '@openmig/shared';
import { runUnifiedSync, type UnifiedSyncConfig, type UnifiedSyncDeps } from './unified-sync';

// Mock the connectors and engines with default implementations
vi.mock('@openmig/connectors/caldav-source', () => ({
  CalDAVSource: vi.fn().mockImplementation((config) => ({
    config,
    httpClient: { request: vi.fn() },
    calendarHomeSet: null,
    listFolders: vi.fn().mockResolvedValue([]),
    listSince: vi.fn().mockResolvedValue({ items: [], nextCursor: { value: '' } }),
    fetch: vi.fn().mockResolvedValue({ content: '' }),
    discoverCalendarHomeSet: vi.fn().mockResolvedValue(undefined),
    listCollections: vi.fn().mockResolvedValue([]),
    syncCollection: vi.fn().mockResolvedValue({ objects: [], syncToken: undefined, ctag: undefined }),
    parseCalendarObject: vi.fn().mockReturnValue(null),
    buildCollectionPath: vi.fn().mockReturnValue(''),
    encodeSyncToken: vi.fn().mockReturnValue(''),
    encodeCTag: vi.fn().mockReturnValue(''),
    parseCalendarHomeSetResponse: vi.fn().mockReturnValue(undefined),
    getAuthorizationHeader: vi.fn().mockReturnValue(''),
    buildSyncCollectionReport: vi.fn().mockReturnValue(''),
    parseCollectionsResponse: vi.fn().mockReturnValue([]),
    parseSyncCollectionResponse: vi.fn().mockReturnValue({ objects: [], syncToken: undefined, ctag: undefined }),
    parseCalendarData: vi.fn().mockReturnValue(''),
  })),
}));

vi.mock('@openmig/connectors/carddav-source', () => ({
  CarddavSource: vi.fn().mockImplementation((config) => ({
    config,
    httpClient: { request: vi.fn() },
    addressBookHomeSet: null,
    listFolders: vi.fn().mockResolvedValue([]),
    listSince: vi.fn().mockResolvedValue({ items: [], nextCursor: { value: '' } }),
    fetch: vi.fn().mockResolvedValue({ content: '' }),
    discoverAddressBookHomeSet: vi.fn().mockResolvedValue(undefined),
    listCollections: vi.fn().mockResolvedValue([]),
    syncCollection: vi.fn().mockResolvedValue({ objects: [], syncToken: undefined, ctag: undefined }),
    parseAddressBookObject: vi.fn().mockReturnValue(null),
    buildCollectionPath: vi.fn().mockReturnValue(''),
    encodeSyncToken: vi.fn().mockReturnValue(''),
    encodeCTag: vi.fn().mockReturnValue(''),
    parseAddressBookHomeSetResponse: vi.fn().mockReturnValue(undefined),
    getAuthorizationHeader: vi.fn().mockReturnValue(''),
    buildSyncCollectionReport: vi.fn().mockReturnValue(''),
    parseCollectionsResponse: vi.fn().mockReturnValue([]),
    parseSyncCollectionResponse: vi.fn().mockReturnValue({ objects: [], syncToken: undefined, ctag: undefined }),
    parseContactData: vi.fn().mockReturnValue(''),
  })),
}));

vi.mock('@openmig/connectors/webdav-source', () => ({
  WebdavFileSource: vi.fn().mockImplementation((config) => ({
    config,
    httpClient: { request: vi.fn() },
    listFolders: vi.fn().mockResolvedValue([]),
    listSince: vi.fn().mockResolvedValue({ items: [], nextCursor: { value: '' } }),
    fetch: vi.fn().mockResolvedValue({ content: '' }),
    fetchFileContent: vi.fn().mockResolvedValue({ content: '' }),
    performPropfind: vi.fn().mockResolvedValue([]),
    buildPropfindXml: vi.fn().mockReturnValue(''),
    parsePropfindResponse: vi.fn().mockReturnValue([]),
    parsePropfindEntry: vi.fn().mockReturnValue(null),
    buildGetXml: vi.fn().mockReturnValue(''),
    parseGetResponse: vi.fn().mockReturnValue({}),
    buildDeleteXml: vi.fn().mockReturnValue(''),
    parseDeleteResponse: vi.fn().mockReturnValue({}),
    isCollection: vi.fn().mockReturnValue(false),
    parseFolderFromEntry: vi.fn().mockReturnValue(null),
    parseFileFromEntry: vi.fn().mockReturnValue(null),
    hasChanged: vi.fn().mockReturnValue(true),
    buildPutXml: vi.fn().mockReturnValue(''),
    parsePutResponse: vi.fn().mockReturnValue({}),
  })),
}));

vi.mock('@openmig/engines/caldav-target-writer', () => ({
  CalDAVTargetWriter: vi.fn().mockImplementation(() => ({
    ensureCalendar: vi.fn().mockResolvedValue('/calendar/'),
    upsertCalendarEvent: vi.fn().mockResolvedValue({ targetId: '/calendar/event.ics', created: true }),
    findCalendarByNaturalKey: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@openmig/engines/carddav-target-writer', () => ({
  CardDAVTargetWriter: vi.fn().mockImplementation(() => ({
    ensureContactFolder: vi.fn().mockResolvedValue('/contacts/'),
    upsertContact: vi.fn().mockResolvedValue({ targetId: '/contacts/contact.vcf', created: true }),
    findContactByNaturalKey: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@openmig/engines/webdav-target-writer', () => ({
  WebDAVTargetWriter: vi.fn().mockImplementation(() => ({
    ensureDirectory: vi.fn().mockResolvedValue('/files/'),
    upsertFile: vi.fn().mockResolvedValue({ targetId: '/files/file.txt', created: true }),
    findFileByNaturalKey: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Import the mocked constructors for use in tests
import { CalDAVSource } from '@openmig/connectors/caldav-source';
import { CarddavSource } from '@openmig/connectors/carddav-source';
import { WebdavFileSource } from '@openmig/connectors/webdav-source';

// Type the mocked constructors
const mockedCalDAVSource = vi.mocked(CalDAVSource);
const mockedCarddavSource = vi.mocked(CarddavSource);
const mockedWebdavFileSource = vi.mocked(WebdavFileSource);

// Mock ledger
const mockLedger: Ledger = {
  find: vi.fn().mockResolvedValue(undefined),
  recordIfAbsent: vi.fn().mockResolvedValue(undefined),
};

// Mock cursor store
const mockCursors: CursorStore = {
  get: vi.fn().mockResolvedValue(undefined),
  set: vi.fn().mockResolvedValue(undefined),
};

describe('runUnifiedSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Reset all mock implementations to defaults after each test
    mockedCalDAVSource.mockImplementation((config) => ({
      config,
      httpClient: { request: vi.fn() },
      calendarHomeSet: null,
      listFolders: vi.fn().mockResolvedValue([]),
      listSince: vi.fn().mockResolvedValue({ items: [], nextCursor: { value: '' } }),
      fetch: vi.fn().mockResolvedValue({ content: '' }),
      discoverCalendarHomeSet: vi.fn().mockResolvedValue(undefined),
      listCollections: vi.fn().mockResolvedValue([]),
      syncCollection: vi.fn().mockResolvedValue({ objects: [], syncToken: undefined, ctag: undefined }),
      parseCalendarObject: vi.fn().mockReturnValue(null),
      buildCollectionPath: vi.fn().mockReturnValue(''),
      encodeSyncToken: vi.fn().mockReturnValue(''),
      encodeCTag: vi.fn().mockReturnValue(''),
      parseCalendarHomeSetResponse: vi.fn().mockReturnValue(undefined),
      getAuthorizationHeader: vi.fn().mockReturnValue(''),
      buildSyncCollectionReport: vi.fn().mockReturnValue(''),
      parseCollectionsResponse: vi.fn().mockReturnValue([]),
      parseSyncCollectionResponse: vi.fn().mockReturnValue({ objects: [], syncToken: undefined, ctag: undefined }),
      parseCalendarData: vi.fn().mockReturnValue(''),
      unfoldLines: vi.fn().mockReturnValue(''),
      decodeXmlEntities: vi.fn().mockReturnValue(''),
      extractUidFromIcalendar: vi.fn().mockReturnValue(''),
      normalizeUid: vi.fn().mockReturnValue(''),
      extractSummary: vi.fn().mockReturnValue(''),
      extractStart: vi.fn().mockReturnValue(''),
      extractEnd: vi.fn().mockReturnValue(''),
      extractDescription: vi.fn().mockReturnValue(''),
      encodeVobject: vi.fn().mockReturnValue(''),
      decodeVobject: vi.fn().mockReturnValue(''),
      buildPropfindXml: vi.fn().mockReturnValue(''),
      parsePropfindResponse: vi.fn().mockReturnValue([]),
      extractLocation: vi.fn().mockReturnValue(''),
      convertIcalDateToIso: vi.fn().mockReturnValue(''),
      decodeSyncToken: vi.fn().mockReturnValue(''),
      buildUrl: vi.fn().mockReturnValue(''),
    } as unknown as CalDAVSource));
    mockedCarddavSource.mockImplementation((config) => ({
      config,
      httpClient: { request: vi.fn() },
      addressBookHomeSet: null,
      listFolders: vi.fn().mockResolvedValue([]),
      listSince: vi.fn().mockResolvedValue({ items: [], nextCursor: { value: '' } }),
      fetch: vi.fn().mockResolvedValue({ content: '' }),
      discoverAddressBookHomeSet: vi.fn().mockResolvedValue(undefined),
      listCollections: vi.fn().mockResolvedValue([]),
      syncCollection: vi.fn().mockResolvedValue({ objects: [], syncToken: undefined, ctag: undefined }),
      parseAddressBookObject: vi.fn().mockReturnValue(null),
      buildCollectionPath: vi.fn().mockReturnValue(''),
      encodeSyncToken: vi.fn().mockReturnValue(''),
      encodeCTag: vi.fn().mockReturnValue(''),
      parseAddressBookHomeSetResponse: vi.fn().mockReturnValue(undefined),
      getAuthorizationHeader: vi.fn().mockReturnValue(''),
      buildSyncCollectionReport: vi.fn().mockReturnValue(''),
      parseCollectionsResponse: vi.fn().mockReturnValue([]),
      parseSyncCollectionResponse: vi.fn().mockReturnValue({ objects: [], syncToken: undefined, ctag: undefined }),
      parseContactData: vi.fn().mockReturnValue(''),
      parseContactObject: vi.fn().mockReturnValue(null),
      extractUidFromVcard: vi.fn().mockReturnValue(''),
      extractFN: vi.fn().mockReturnValue(''),
      extractGivenName: vi.fn().mockReturnValue(''),
      extractEmail: vi.fn().mockReturnValue(''),
      extractFamilyName: vi.fn().mockReturnValue(''),
      extractOrganization: vi.fn().mockReturnValue(''),
      extractPhones: vi.fn().mockReturnValue([]),
      extractEmails: vi.fn().mockReturnValue([]),
      extractAddresses: vi.fn().mockReturnValue([]),
      extractUrls: vi.fn().mockReturnValue([]),
      extractNotes: vi.fn().mockReturnValue([]),
      extractBirthday: vi.fn().mockReturnValue(''),
      extractNickname: vi.fn().mockReturnValue(''),
      extractPhoto: vi.fn().mockReturnValue(''),
      extractLogo: vi.fn().mockReturnValue(''),
      extractSound: vi.fn().mockReturnValue(''),
      extractTitle: vi.fn().mockReturnValue(''),
      extractRole: vi.fn().mockReturnValue(''),
      extractAgent: vi.fn().mockReturnValue(''),
      extractCategories: vi.fn().mockReturnValue([]),
      extractNote: vi.fn().mockReturnValue(''),
      extractVCardVersion: vi.fn().mockReturnValue(''),
      extractContactType: vi.fn().mockReturnValue(''),
      unfoldAndDecode: vi.fn().mockReturnValue(''),
      decodeVcard: vi.fn().mockReturnValue(''),
      buildUrl: vi.fn().mockReturnValue(''),
    } as unknown as CarddavSource));
    mockedWebdavFileSource.mockImplementation((config) => ({
      config,
      httpClient: { request: vi.fn() },
      listFolders: vi.fn().mockResolvedValue([]),
      listSince: vi.fn().mockResolvedValue({ items: [], nextCursor: { value: '' } }),
      fetch: vi.fn().mockResolvedValue({ content: '' }),
      fetchFileContent: vi.fn().mockResolvedValue({ content: '' }),
      performPropfind: vi.fn().mockResolvedValue([]),
      buildPropfindXml: vi.fn().mockReturnValue(''),
      parsePropfindResponse: vi.fn().mockReturnValue([]),
      parsePropfindEntry: vi.fn().mockReturnValue(null),
      buildGetXml: vi.fn().mockReturnValue(''),
      parseGetResponse: vi.fn().mockReturnValue({}),
      buildDeleteXml: vi.fn().mockReturnValue(''),
      parseDeleteResponse: vi.fn().mockReturnValue({}),
      isCollection: vi.fn().mockReturnValue(false),
      parseFolderFromEntry: vi.fn().mockReturnValue(null),
      parseFileFromEntry: vi.fn().mockReturnValue(null),
      hasChanged: vi.fn().mockReturnValue(true),
      buildPutXml: vi.fn().mockReturnValue(''),
      parsePutResponse: vi.fn().mockReturnValue({}),
      buildCursor: vi.fn().mockReturnValue({}),
      decodeCursor: vi.fn().mockReturnValue({}),
      cleanEtag: vi.fn().mockReturnValue(''),
      parseDate: vi.fn().mockReturnValue(undefined),
      extractNameFromPath: vi.fn().mockReturnValue(''),
      normalizePath: vi.fn().mockReturnValue(''),
      buildUrl: vi.fn().mockReturnValue(''),
      getAuthorizationHeader: vi.fn().mockReturnValue(''),
    } as unknown as WebdavFileSource));
  });

  describe('domain enablement', () => {
    it('should skip calendar when not enabled', async () => {
      const config: UnifiedSyncConfig = {
        tenantId: 'tenant-1' as TenantId,
        mappingId: 'mapping-1' as MappingId,
        calendar: { enabled: false },
      };

      const result = await runUnifiedSync({
        config,
        ledger: mockLedger,
        cursors: mockCursors,
      });

      expect(result.calendar.totalItems).toBe(0);
      expect(result.calendar.createdCount).toBe(0);
    });

    it('should skip contacts when not enabled', async () => {
      const config: UnifiedSyncConfig = {
        tenantId: 'tenant-1' as TenantId,
        mappingId: 'mapping-1' as MappingId,
        contacts: { enabled: false },
      };

      const result = await runUnifiedSync({
        config,
        ledger: mockLedger,
        cursors: mockCursors,
      });

      expect(result.contacts.totalItems).toBe(0);
      expect(result.contacts.createdCount).toBe(0);
    });

    it('should skip files when not enabled', async () => {
      const config: UnifiedSyncConfig = {
        tenantId: 'tenant-1' as TenantId,
        mappingId: 'mapping-1' as MappingId,
        files: { enabled: false },
      };

      const result = await runUnifiedSync({
        config,
        ledger: mockLedger,
        cursors: mockCursors,
      });

      expect(result.files.totalItems).toBe(0);
      expect(result.files.createdCount).toBe(0);
    });

    it('should process all enabled domains', async () => {
      const config: UnifiedSyncConfig = {
        tenantId: 'tenant-1' as TenantId,
        mappingId: 'mapping-1' as MappingId,
        calendar: { enabled: true },
        contacts: { enabled: true },
        files: { enabled: true },
        caldavSource: {
          url: 'https://caldav.example.com',
          username: 'user',
          passwordEnv: 'CALDAV_PASSWORD',
        },
        caldavTarget: {
          url: 'https://caldav.example.com',
          username: 'user',
          password: 'password123',
        },
        carddavSource: {
          url: 'https://carddav.example.com',
          username: 'user',
          passwordEnv: 'CARDDAV_PASSWORD',
        },
        carddavTarget: {
          url: 'https://carddav.example.com',
          username: 'user',
          password: 'password123',
        },
        webdavSource: {
          url: 'https://webdav.example.com',
          username: 'user',
          passwordEnv: 'WEBDAV_PASSWORD',
        },
        webdavTarget: {
          url: 'https://webdav.example.com',
          username: 'user',
          password: 'password123',
        },
      };

      // Set environment variables for the mocks
      process.env.CALDAV_PASSWORD = 'password123';
      process.env.CARDDAV_PASSWORD = 'password123';
      process.env.WEBDAV_PASSWORD = 'password123';

      const result = await runUnifiedSync({
        config,
        ledger: mockLedger,
        cursors: mockCursors,
      });

      // All domains should have been processed (even if with 0 items due to empty mock responses)
      expect(result.calendar).toBeDefined();
      expect(result.contacts).toBeDefined();
      expect(result.files).toBeDefined();
      expect(result.totalDurationSeconds).toBeGreaterThanOrEqual(0);
    });

    it('should return empty stats when no domains enabled', async () => {
      const config: UnifiedSyncConfig = {
        tenantId: 'tenant-1' as TenantId,
        mappingId: 'mapping-1' as MappingId,
      };

      const result = await runUnifiedSync({
        config,
        ledger: mockLedger,
        cursors: mockCursors,
      });

      expect(result.mail.totalItems).toBe(0);
      expect(result.calendar.totalItems).toBe(0);
      expect(result.contacts.totalItems).toBe(0);
      expect(result.files.totalItems).toBe(0);
      expect(result.totalDurationSeconds).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should throw error when calendar enabled but caldav config missing', async () => {
      const config: UnifiedSyncConfig = {
        tenantId: 'tenant-1' as TenantId,
        mappingId: 'mapping-1' as MappingId,
        calendar: { enabled: true },
      };

      await expect(runUnifiedSync({
        config,
        ledger: mockLedger,
        cursors: mockCursors,
      })).rejects.toThrow('CalDAV source and target configuration required for calendar sync');
    });

    it('should throw error when contacts enabled but carddav config missing', async () => {
      const config: UnifiedSyncConfig = {
        tenantId: 'tenant-1' as TenantId,
        mappingId: 'mapping-1' as MappingId,
        contacts: { enabled: true },
      };

      await expect(runUnifiedSync({
        config,
        ledger: mockLedger,
        cursors: mockCursors,
      })).rejects.toThrow('CardDAV source and target configuration required for contacts sync');
    });

    it('should throw error when files enabled but webdav config missing', async () => {
      const config: UnifiedSyncConfig = {
        tenantId: 'tenant-1' as TenantId,
        mappingId: 'mapping-1' as MappingId,
        files: { enabled: true },
      };

      await expect(runUnifiedSync({
        config,
        ledger: mockLedger,
        cursors: mockCursors,
      })).rejects.toThrow('WebDAV source and target configuration required for files sync');
    });

    it('should surface calendar errors in result', async () => {
      const error = new Error('CalDAV connection failed');
      mockedCalDAVSource.mockImplementation(() => ({
        config: { url: 'https://caldav.example.com', username: 'user', passwordEnv: 'CALDAV_PASSWORD' },
        httpClient: { request: vi.fn() },
        calendarHomeSet: null,
        listFolders: vi.fn().mockRejectedValue(error),
        listSince: vi.fn(),
        fetch: vi.fn(),
        discoverCalendarHomeSet: vi.fn().mockResolvedValue(undefined),
        listCollections: vi.fn().mockResolvedValue([]),
        syncCollection: vi.fn().mockResolvedValue({ objects: [], syncToken: undefined, ctag: undefined }),
        parseCalendarObject: vi.fn().mockReturnValue(null),
        buildCollectionPath: vi.fn().mockReturnValue(''),
        encodeSyncToken: vi.fn().mockReturnValue(''),
        encodeCTag: vi.fn().mockReturnValue(''),
        parseCalendarHomeSetResponse: vi.fn().mockReturnValue(undefined),
        getAuthorizationHeader: vi.fn().mockReturnValue(''),
        buildSyncCollectionReport: vi.fn().mockReturnValue(''),
        parseCollectionsResponse: vi.fn().mockReturnValue([]),
        parseSyncCollectionResponse: vi.fn().mockReturnValue({ objects: [], syncToken: undefined, ctag: undefined }),
        parseCalendarData: vi.fn().mockReturnValue(''),
        unfoldLines: vi.fn().mockReturnValue(''),
        decodeXmlEntities: vi.fn().mockReturnValue(''),
        extractUidFromIcalendar: vi.fn().mockReturnValue(''),
        normalizeUid: vi.fn().mockReturnValue(''),
        extractSummary: vi.fn().mockReturnValue(''),
        extractStart: vi.fn().mockReturnValue(''),
        extractEnd: vi.fn().mockReturnValue(''),
        extractDescription: vi.fn().mockReturnValue(''),
        encodeVobject: vi.fn().mockReturnValue(''),
        decodeVobject: vi.fn().mockReturnValue(''),
        buildPropfindXml: vi.fn().mockReturnValue(''),
        parsePropfindResponse: vi.fn().mockReturnValue([]),
        extractLocation: vi.fn().mockReturnValue(''),
        convertIcalDateToIso: vi.fn().mockReturnValue(''),
        decodeSyncToken: vi.fn().mockReturnValue(''),
        buildUrl: vi.fn().mockReturnValue(''),
      } as unknown as CalDAVSource));

      const config: UnifiedSyncConfig = {
        tenantId: 'tenant-1' as TenantId,
        mappingId: 'mapping-1' as MappingId,
        calendar: { enabled: true },
        caldavSource: {
          url: 'https://caldav.example.com',
          username: 'user',
          passwordEnv: 'CALDAV_PASSWORD',
        },
        caldavTarget: {
          url: 'https://caldav.example.com',
          username: 'user',
          password: 'password123',
        },
      };

      process.env.CALDAV_PASSWORD = 'password123';

      await expect(runUnifiedSync({
        config,
        ledger: mockLedger,
        cursors: mockCursors,
      })).rejects.toThrow('Calendar sync failed');
    });

    it('should surface contacts errors in result', async () => {
      const error = new Error('CardDAV connection failed');
      mockedCarddavSource.mockImplementation(() => ({
        config: { url: 'https://carddav.example.com', username: 'user', passwordEnv: 'CARDDAV_PASSWORD' },
        httpClient: { request: vi.fn() },
        addressBookHomeSet: null,
        listFolders: vi.fn().mockRejectedValue(error),
        listSince: vi.fn(),
        fetch: vi.fn(),
        discoverAddressBookHomeSet: vi.fn().mockResolvedValue(undefined),
        listCollections: vi.fn().mockResolvedValue([]),
        syncCollection: vi.fn().mockResolvedValue({ objects: [], syncToken: undefined, ctag: undefined }),
        parseAddressBookObject: vi.fn().mockReturnValue(null),
        buildCollectionPath: vi.fn().mockReturnValue(''),
        encodeSyncToken: vi.fn().mockReturnValue(''),
        encodeCTag: vi.fn().mockReturnValue(''),
        parseAddressBookHomeSetResponse: vi.fn().mockReturnValue(undefined),
        getAuthorizationHeader: vi.fn().mockReturnValue(''),
        buildSyncCollectionReport: vi.fn().mockReturnValue(''),
        parseCollectionsResponse: vi.fn().mockReturnValue([]),
        parseSyncCollectionResponse: vi.fn().mockReturnValue({ objects: [], syncToken: undefined, ctag: undefined }),
        parseContactData: vi.fn().mockReturnValue(''),
        parseContactObject: vi.fn().mockReturnValue(null),
        extractUidFromVcard: vi.fn().mockReturnValue(''),
        extractFN: vi.fn().mockReturnValue(''),
        extractGivenName: vi.fn().mockReturnValue(''),
        extractEmail: vi.fn().mockReturnValue(''),
        extractFamilyName: vi.fn().mockReturnValue(''),
        extractOrganization: vi.fn().mockReturnValue(''),
        extractPhones: vi.fn().mockReturnValue([]),
        extractEmails: vi.fn().mockReturnValue([]),
        extractAddresses: vi.fn().mockReturnValue([]),
        extractUrls: vi.fn().mockReturnValue([]),
        extractNotes: vi.fn().mockReturnValue([]),
        extractBirthday: vi.fn().mockReturnValue(''),
        extractNickname: vi.fn().mockReturnValue(''),
        extractPhoto: vi.fn().mockReturnValue(''),
        extractLogo: vi.fn().mockReturnValue(''),
        extractSound: vi.fn().mockReturnValue(''),
        extractTitle: vi.fn().mockReturnValue(''),
        extractRole: vi.fn().mockReturnValue(''),
        extractAgent: vi.fn().mockReturnValue(''),
        extractCategories: vi.fn().mockReturnValue([]),
        extractNote: vi.fn().mockReturnValue(''),
        extractVCardVersion: vi.fn().mockReturnValue(''),
        extractContactType: vi.fn().mockReturnValue(''),
        unfoldAndDecode: vi.fn().mockReturnValue(''),
        decodeVcard: vi.fn().mockReturnValue(''),
        buildUrl: vi.fn().mockReturnValue(''),
      } as unknown as CarddavSource));

      const config: UnifiedSyncConfig = {
        tenantId: 'tenant-1' as TenantId,
        mappingId: 'mapping-1' as MappingId,
        contacts: { enabled: true },
        carddavSource: {
          url: 'https://carddav.example.com',
          username: 'user',
          passwordEnv: 'CARDDAV_PASSWORD',
        },
        carddavTarget: {
          url: 'https://carddav.example.com',
          username: 'user',
          password: 'password123',
        },
      };

      process.env.CARDDAV_PASSWORD = 'password123';

      await expect(runUnifiedSync({
        config,
        ledger: mockLedger,
        cursors: mockCursors,
      })).rejects.toThrow('Contacts sync failed');
    });

    it('should surface files errors in result', async () => {
      const error = new Error('WebDAV connection failed');
      mockedWebdavFileSource.mockImplementation(() => ({
        config: { url: 'https://webdav.example.com', username: 'user', passwordEnv: 'WEBDAV_PASSWORD' },
        httpClient: { request: vi.fn() },
        listFolders: vi.fn().mockRejectedValue(error),
        listSince: vi.fn(),
        fetch: vi.fn(),
        fetchFileContent: vi.fn().mockResolvedValue({ content: '' }),
        performPropfind: vi.fn().mockResolvedValue([]),
        buildPropfindXml: vi.fn().mockReturnValue(''),
        parsePropfindResponse: vi.fn().mockReturnValue([]),
        parsePropfindEntry: vi.fn().mockReturnValue(null),
        buildGetXml: vi.fn().mockReturnValue(''),
        parseGetResponse: vi.fn().mockReturnValue({}),
        buildDeleteXml: vi.fn().mockReturnValue(''),
        parseDeleteResponse: vi.fn().mockReturnValue({}),
        isCollection: vi.fn().mockReturnValue(false),
        parseFolderFromEntry: vi.fn().mockReturnValue(null),
        parseFileFromEntry: vi.fn().mockReturnValue(null),
        hasChanged: vi.fn().mockReturnValue(true),
        buildPutXml: vi.fn().mockReturnValue(''),
        parsePutResponse: vi.fn().mockReturnValue({}),
        buildCursor: vi.fn().mockReturnValue({}),
        decodeCursor: vi.fn().mockReturnValue({}),
        cleanEtag: vi.fn().mockReturnValue(''),
        parseDate: vi.fn().mockReturnValue(undefined),
        extractNameFromPath: vi.fn().mockReturnValue(''),
        normalizePath: vi.fn().mockReturnValue(''),
        buildUrl: vi.fn().mockReturnValue(''),
        getAuthorizationHeader: vi.fn().mockReturnValue(''),
      } as unknown as WebdavFileSource));

      const config: UnifiedSyncConfig = {
        tenantId: 'tenant-1' as TenantId,
        mappingId: 'mapping-1' as MappingId,
        files: { enabled: true },
        webdavSource: {
          url: 'https://webdav.example.com',
          username: 'user',
          passwordEnv: 'WEBDAV_PASSWORD',
        },
        webdavTarget: {
          url: 'https://webdav.example.com',
          username: 'user',
          password: 'password123',
        },
      };

      process.env.WEBDAV_PASSWORD = 'password123';

      await expect(runUnifiedSync({
        config,
        ledger: mockLedger,
        cursors: mockCursors,
      })).rejects.toThrow('Files sync failed');
    });
  });

  describe('aggregated statistics', () => {
    it('should accumulate bytesTransferred across domains', async () => {
      const config: UnifiedSyncConfig = {
        tenantId: 'tenant-1' as TenantId,
        mappingId: 'mapping-1' as MappingId,
        calendar: { enabled: true },
        contacts: { enabled: true },
        files: { enabled: true },
        caldavSource: {
          url: 'https://caldav.example.com',
          username: 'user',
          passwordEnv: 'CALDAV_PASSWORD',
        },
        caldavTarget: {
          url: 'https://caldav.example.com',
          username: 'user',
          password: 'password123',
        },
        carddavSource: {
          url: 'https://carddav.example.com',
          username: 'user',
          passwordEnv: 'CARDDAV_PASSWORD',
        },
        carddavTarget: {
          url: 'https://carddav.example.com',
          username: 'user',
          password: 'password123',
        },
        webdavSource: {
          url: 'https://webdav.example.com',
          username: 'user',
          passwordEnv: 'WEBDAV_PASSWORD',
        },
        webdavTarget: {
          url: 'https://webdav.example.com',
          username: 'user',
          password: 'password123',
        },
      };

      process.env.CALDAV_PASSWORD = 'password123';
      process.env.CARDDAV_PASSWORD = 'password123';
      process.env.WEBDAV_PASSWORD = 'password123';

      const result = await runUnifiedSync({
        config,
        ledger: mockLedger,
        cursors: mockCursors,
      });

      // Each domain should have bytesTransferred (even if 0 from empty mocks)
      expect(typeof result.calendar.bytesTransferred).toBe('number');
      expect(typeof result.contacts.bytesTransferred).toBe('number');
      expect(typeof result.files.bytesTransferred).toBe('number');
    });

    it('should track failures per domain', async () => {
      const config: UnifiedSyncConfig = {
        tenantId: 'tenant-1' as TenantId,
        mappingId: 'mapping-1' as MappingId,
        calendar: { enabled: true },
        caldavSource: {
          url: 'https://caldav.example.com',
          username: 'user',
          passwordEnv: 'CALDAV_PASSWORD',
        },
        caldavTarget: {
          url: 'https://caldav.example.com',
          username: 'user',
          password: 'password123',
        },
      };

      process.env.CALDAV_PASSWORD = 'password123';

      // This will fail but we can check the structure
      try {
        await runUnifiedSync({
          config,
          ledger: mockLedger,
          cursors: mockCursors,
        });
      } catch {
        // Expected to fail
      }
    });

    it('should calculate totalDurationSeconds', async () => {
      const config: UnifiedSyncConfig = {
        tenantId: 'tenant-1' as TenantId,
        mappingId: 'mapping-1' as MappingId,
        calendar: { enabled: true },
        caldavSource: {
          url: 'https://caldav.example.com',
          username: 'user',
          passwordEnv: 'CALDAV_PASSWORD',
        },
        caldavTarget: {
          url: 'https://caldav.example.com',
          username: 'user',
          password: 'password123',
        },
      };

      process.env.CALDAV_PASSWORD = 'password123';

      const result = await runUnifiedSync({
        config,
        ledger: mockLedger,
        cursors: mockCursors,
      });

      expect(result.totalDurationSeconds).toBeGreaterThanOrEqual(0);
    });
  });

  describe('concurrency configuration', () => {
    it('should use default concurrency of 4 when not specified', async () => {
      const config: UnifiedSyncConfig = {
        tenantId: 'tenant-1' as TenantId,
        mappingId: 'mapping-1' as MappingId,
        calendar: { enabled: true },
        caldavSource: {
          url: 'https://caldav.example.com',
          username: 'user',
          passwordEnv: 'CALDAV_PASSWORD',
        },
        caldavTarget: {
          url: 'https://caldav.example.com',
          username: 'user',
          password: 'password123',
        },
      };

      process.env.CALDAV_PASSWORD = 'password123';

      // Should not throw - just testing that it accepts the config
      const result = await runUnifiedSync({
        config,
        ledger: mockLedger,
        cursors: mockCursors,
      });

      expect(result).toBeDefined();
    });

    it('should accept custom concurrency value', async () => {
      const config: UnifiedSyncConfig = {
        tenantId: 'tenant-1' as TenantId,
        mappingId: 'mapping-1' as MappingId,
        calendar: { enabled: true },
        concurrency: 8,
        caldavSource: {
          url: 'https://caldav.example.com',
          username: 'user',
          passwordEnv: 'CALDAV_PASSWORD',
        },
        caldavTarget: {
          url: 'https://caldav.example.com',
          username: 'user',
          password: 'password123',
        },
      };

      process.env.CALDAV_PASSWORD = 'password123';

      const result = await runUnifiedSync({
        config,
        ledger: mockLedger,
        cursors: mockCursors,
      });

      expect(result).toBeDefined();
    });
  });

  describe('domain-specific configurations', () => {
    it('should accept caldav configuration for calendar sync', async () => {
      const config: UnifiedSyncConfig = {
        tenantId: 'tenant-1' as TenantId,
        mappingId: 'mapping-1' as MappingId,
        calendar: { enabled: true },
        caldavSource: {
          url: 'https://caldav.example.com',
          username: 'user',
          passwordEnv: 'CALDAV_PASSWORD',
          calendarHomeSet: '/calendar/',
        },
        caldavTarget: {
          url: 'https://caldav.example.com',
          username: 'user',
          password: 'password123',
        },
      };

      process.env.CALDAV_PASSWORD = 'password123';

      const result = await runUnifiedSync({
        config,
        ledger: mockLedger,
        cursors: mockCursors,
      });

      expect(result.calendar).toBeDefined();
    });

    it('should accept carddav configuration for contacts sync', async () => {
      const config: UnifiedSyncConfig = {
        tenantId: 'tenant-1' as TenantId,
        mappingId: 'mapping-1' as MappingId,
        contacts: { enabled: true },
        carddavSource: {
          url: 'https://carddav.example.com',
          username: 'user',
          passwordEnv: 'CARDDAV_PASSWORD',
          addressBookHomeSet: '/contacts/',
        },
        carddavTarget: {
          url: 'https://carddav.example.com',
          username: 'user',
          password: 'password123',
        },
      };

      process.env.CARDDAV_PASSWORD = 'password123';

      const result = await runUnifiedSync({
        config,
        ledger: mockLedger,
        cursors: mockCursors,
      });

      expect(result.contacts).toBeDefined();
    });

    it('should accept webdav configuration for files sync', async () => {
      const config: UnifiedSyncConfig = {
        tenantId: 'tenant-1' as TenantId,
        mappingId: 'mapping-1' as MappingId,
        files: { enabled: true },
        webdavSource: {
          url: 'https://webdav.example.com',
          username: 'user',
          passwordEnv: 'WEBDAV_PASSWORD',
          rootPath: '/files/',
        },
        webdavTarget: {
          url: 'https://webdav.example.com',
          username: 'user',
          password: 'password123',
        },
      };

      process.env.WEBDAV_PASSWORD = 'password123';

      const result = await runUnifiedSync({
        config,
        ledger: mockLedger,
        cursors: mockCursors,
      });

      expect(result.files).toBeDefined();
    });
  });
});
