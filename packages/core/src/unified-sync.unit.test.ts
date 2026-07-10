/**
 * Unit tests for unified-sync module
 *
 * Tests cover:
 * - Each domain being enabled/disabled
 * - Failing domain surfacing errors
 * - Aggregated statistics
 * 
 * Architecture: Connectors are injected via UnifiedSyncDeps (ports & adapters).
 * No vi.mock needed - we inject fake implementations directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Ledger, CursorStore, SyncCursor, GenericSource, GenericTargetWriter } from '@openmig/shared';
import { runUnifiedSync, type UnifiedSyncConfig, type UnifiedSyncDeps, type CalDAVFolder, type CalDAVItem, type CardDAVFolder, type CardDAVItem, type WebDAVFolder, type WebDAVItem } from './unified-sync';

// Fake implementations for testing
function createFakeCalDAVSource() {
  const listFolders = vi.fn().mockResolvedValue([]);
  const listSince = vi.fn().mockResolvedValue({ items: [], nextCursor: { value: '' } as SyncCursor });
  const fetch = vi.fn().mockResolvedValue({ content: '', metadata: {} });

  return {
    listFolders,
    listSince,
    fetch,
  } as unknown as GenericSource<CalDAVFolder, CalDAVItem>;
}

function createFakeCardDAVSource() {
  const listFolders = vi.fn().mockResolvedValue([]);
  const listSince = vi.fn().mockResolvedValue({ items: [], nextCursor: { value: '' } as SyncCursor });
  const fetch = vi.fn().mockResolvedValue({ content: '', metadata: {} });

  return {
    listFolders,
    listSince,
    fetch,
  } as unknown as GenericSource<CardDAVFolder, CardDAVItem>;
}

function createFakeWebDAVSource() {
  const listFolders = vi.fn().mockResolvedValue([]);
  const listSince = vi.fn().mockResolvedValue({ items: [], nextCursor: { value: '' } as SyncCursor });
  const fetch = vi.fn().mockResolvedValue({ content: '', metadata: {} });

  return {
    listFolders,
    listSince,
    fetch,
  } as unknown as GenericSource<WebDAVFolder, WebDAVItem>;
}

function createFakeCalDAVTargetWriter() {
  const ensureFolder = vi.fn().mockResolvedValue('calendar/');
  const upsertItem = vi.fn().mockResolvedValue({ targetId: 'calendar/event.ics', created: true });
  const findByNaturalKey = vi.fn().mockResolvedValue(undefined);

  return {
    ensureFolder,
    upsertItem,
    findByNaturalKey,
  } as unknown as GenericTargetWriter<CalDAVFolder, CalDAVItem>;
}

function createFakeCardDAVTargetWriter() {
  const ensureFolder = vi.fn().mockResolvedValue('contacts/');
  const upsertItem = vi.fn().mockResolvedValue({ targetId: 'contacts/contact.vcf', created: true });
  const findByNaturalKey = vi.fn().mockResolvedValue(undefined);

  return {
    ensureFolder,
    upsertItem,
    findByNaturalKey,
  } as unknown as GenericTargetWriter<CardDAVFolder, CardDAVItem>;
}

function createFakeWebDAVTargetWriter() {
  const ensureFolder = vi.fn().mockResolvedValue('files/');
  const upsertItem = vi.fn().mockResolvedValue({ targetId: 'files/file.txt', created: true });
  const findByNaturalKey = vi.fn().mockResolvedValue(undefined);

  return {
    ensureFolder,
    upsertItem,
    findByNaturalKey,
  } as unknown as GenericTargetWriter<WebDAVFolder, WebDAVItem>;
}

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

  it('should return empty stats when no domains are enabled', async () => {
    const config: UnifiedSyncConfig = {
      tenantId: 'tenant-1',
      mappingId: 'mapping-1',
    };

    const result = await runUnifiedSync({
      config,
      ledger: mockLedger,
      cursors: mockCursors,
    });

    expect(result).toEqual({
      mail: { totalItems: 0, createdCount: 0, skippedCount: 0, failureCount: 0, bytesTransferred: 0, durationSeconds: 0, failures: [] },
      calendar: { totalItems: 0, createdCount: 0, skippedCount: 0, failureCount: 0, bytesTransferred: 0, durationSeconds: 0, failures: [] },
      contacts: { totalItems: 0, createdCount: 0, skippedCount: 0, failureCount: 0, bytesTransferred: 0, durationSeconds: 0, failures: [] },
      files: { totalItems: 0, createdCount: 0, skippedCount: 0, failureCount: 0, bytesTransferred: 0, durationSeconds: 0, failures: [] },
      totalDurationSeconds: expect.any(Number),
    });
  });

  it('should sync calendar domain when enabled', async () => {
    const caldavSource = createFakeCalDAVSource();
    const caldavWriter = createFakeCalDAVTargetWriter();
    
    // Setup mock data
    caldavSource.listFolders.mockResolvedValue([
      { id: 'cal1', name: 'Calendar', path: '/calendar/', color: '#FF0000' }
    ]);
    caldavSource.listSince.mockResolvedValue({
      items: [
        { naturalKey: 'event1', uid: 'event1', type: 'VEVENT', summary: 'Test Event', sourcePath: '/calendar/event1.ics' }
      ],
      nextCursor: { value: 'cursor1' }
    });
    caldavSource.fetch.mockResolvedValue({
      content: 'BEGIN:VCALENDAR...END:VCALENDAR',
      metadata: { uid: 'event1', type: 'VEVENT', summary: 'Test Event' }
    });

    const config: UnifiedSyncConfig = {
      tenantId: 'tenant-1',
      mappingId: 'mapping-1',
      calendar: { enabled: true },
      caldavTarget: {
        calendarHomeSet: 'https://caldav.example.com/',
        httpClient: { request: vi.fn() },
      },
    };

    const result = await runUnifiedSync({
      config,
      ledger: mockLedger,
      cursors: mockCursors,
      caldavSource,
      caldavWriter,
    });

    expect(result.calendar.totalItems).toBe(1);
    expect(result.calendar.failureCount).toBe(0);
  });

  it('should sync contacts domain when enabled', async () => {
    const carddavSource = createFakeCardDAVSource();
    const carddavWriter = createFakeCardDAVTargetWriter();
    
    // Setup mock data
    carddavSource.listFolders.mockResolvedValue([
      { id: 'addrbook1', name: 'Address Book', path: '/addressbook/' }
    ]);
    carddavSource.listSince.mockResolvedValue({
      items: [
        { naturalKey: 'contact1', uid: 'contact1', type: 'VCARD', name: 'John Doe', sourcePath: '/addressbook/contact1.vcf' }
      ],
      nextCursor: { value: 'cursor1' }
    });
    carddavSource.fetch.mockResolvedValue({
      content: 'BEGIN:VCARD...END:VCARD',
      metadata: { uid: 'contact1', type: 'VCARD', name: 'John Doe' }
    });

    const config: UnifiedSyncConfig = {
      tenantId: 'tenant-1',
      mappingId: 'mapping-1',
      contacts: { enabled: true },
      carddavTarget: {
        addressBookHomeSet: 'https://carddav.example.com/',
        httpClient: { request: vi.fn() },
      },
    };

    const result = await runUnifiedSync({
      config,
      ledger: mockLedger,
      cursors: mockCursors,
      carddavSource,
      carddavWriter,
    });

    expect(result.contacts.totalItems).toBe(1);
    expect(result.contacts.failureCount).toBe(0);
  });

  it('should sync files domain when enabled', async () => {
    const webdavSource = createFakeWebDAVSource();
    const webdavWriter = createFakeWebDAVTargetWriter();
    
    // Setup mock data
    webdavSource.listFolders.mockResolvedValue([
      { id: 'files1', name: 'Files', path: '/files/' }
    ]);
    webdavSource.listSince.mockResolvedValue({
      items: [
        { path: '/files/file1.txt', isDirectory: false, size: 1024, naturalKey: 'file1', uid: 'file1', type: 'file', sourcePath: '/files/file1.txt' }
      ],
      nextCursor: { value: 'cursor1' }
    });
    webdavSource.fetch.mockResolvedValue({
      content: 'file content',
      metadata: { path: '/files/file1.txt', isDirectory: false, size: 1024 }
    });

    const config: UnifiedSyncConfig = {
      tenantId: 'tenant-1',
      mappingId: 'mapping-1',
      files: { enabled: true },
      webdavTarget: {
        rootPath: '/files',
        httpClient: { request: vi.fn() },
      },
    };

    const result = await runUnifiedSync({
      config,
      ledger: mockLedger,
      cursors: mockCursors,
      webdavSource,
      webdavWriter,
    });

    expect(result.files.totalItems).toBe(1);
    expect(result.files.failureCount).toBe(0);
  });

  it('should sync all enabled domains', async () => {
    const caldavSource = createFakeCalDAVSource();
    const caldavWriter = createFakeCalDAVTargetWriter();
    const carddavSource = createFakeCardDAVSource();
    const carddavWriter = createFakeCardDAVTargetWriter();
    const webdavSource = createFakeWebDAVSource();
    const webdavWriter = createFakeWebDAVTargetWriter();
    
    // Setup mock data for all domains
    caldavSource.listFolders.mockResolvedValue([{ id: 'cal1', name: 'Calendar', path: '/calendar/' }]);
    caldavSource.listSince.mockResolvedValue({ items: [{ naturalKey: 'event1', uid: 'event1', type: 'VEVENT', summary: 'Test', sourcePath: '/calendar/event1.ics' }], nextCursor: { value: 'cursor1' } });
    caldavSource.fetch.mockResolvedValue({ content: 'ical', metadata: {} });

    carddavSource.listFolders.mockResolvedValue([{ id: 'addr1', name: 'Address Book', path: '/addressbook/' }]);
    carddavSource.listSince.mockResolvedValue({ items: [{ naturalKey: 'contact1', uid: 'contact1', type: 'VCARD', name: 'John', sourcePath: '/addressbook/contact1.vcf' }], nextCursor: { value: 'cursor1' } });
    carddavSource.fetch.mockResolvedValue({ content: 'vcard', metadata: {} });

    webdavSource.listFolders.mockResolvedValue([{ id: 'files1', name: 'Files', path: '/files/' }]);
    webdavSource.listSince.mockResolvedValue({ items: [{ path: '/files/file1.txt', isDirectory: false, size: 1024, naturalKey: 'file1', uid: 'file1', type: 'file', sourcePath: '/files/file1.txt' }], nextCursor: { value: 'cursor1' } });
    webdavSource.fetch.mockResolvedValue({ content: 'content', metadata: {} });

    const config: UnifiedSyncConfig = {
      tenantId: 'tenant-1',
      mappingId: 'mapping-1',
      calendar: { enabled: true },
      contacts: { enabled: true },
      files: { enabled: true },
      caldavTarget: { calendarHomeSet: 'https://caldav.example.com/', httpClient: { request: vi.fn() } },
      carddavTarget: { addressBookHomeSet: 'https://carddav.example.com/', httpClient: { request: vi.fn() } },
      webdavTarget: { rootPath: '/files', httpClient: { request: vi.fn() } },
    };

    const result = await runUnifiedSync({
      config,
      ledger: mockLedger,
      cursors: mockCursors,
      caldavSource,
      caldavWriter,
      carddavSource,
      carddavWriter,
      webdavSource,
      webdavWriter,
    });

    expect(result.calendar.totalItems).toBe(1);
    expect(result.contacts.totalItems).toBe(1);
    expect(result.files.totalItems).toBe(1);
    expect(result.calendar.failureCount).toBe(0);
    expect(result.contacts.failureCount).toBe(0);
    expect(result.files.failureCount).toBe(0);
  });

  it('should fail when calendar domain errors', async () => {
    const caldavSource = createFakeCalDAVSource();
    const caldavWriter = createFakeCalDAVTargetWriter();
    
    caldavSource.listSince.mockRejectedValue(new Error('Calendar sync failed'));

    const config: UnifiedSyncConfig = {
      tenantId: 'tenant-1',
      mappingId: 'mapping-1',
      calendar: { enabled: true },
      caldavTarget: {
        calendarHomeSet: 'https://caldav.example.com/',
        httpClient: { request: vi.fn() },
      },
    };

    await expect(runUnifiedSync({
      config,
      ledger: mockLedger,
      cursors: mockCursors,
      caldavSource,
      caldavWriter,
    })).rejects.toThrow('Calendar sync failed');
  });

  it('should fail when contacts domain errors', async () => {
    const carddavSource = createFakeCardDAVSource();
    const carddavWriter = createFakeCardDAVTargetWriter();
    
    carddavSource.listSince.mockRejectedValue(new Error('Contacts sync failed'));

    const config: UnifiedSyncConfig = {
      tenantId: 'tenant-1',
      mappingId: 'mapping-1',
      contacts: { enabled: true },
      carddavTarget: {
        addressBookHomeSet: 'https://carddav.example.com/',
        httpClient: { request: vi.fn() },
      },
    };

    await expect(runUnifiedSync({
      config,
      ledger: mockLedger,
      cursors: mockCursors,
      carddavSource,
      carddavWriter,
    })).rejects.toThrow('Contacts sync failed');
  });

  it('should fail when files domain errors', async () => {
    const webdavSource = createFakeWebDAVSource();
    const webdavWriter = createFakeWebDAVTargetWriter();
    
    webdavSource.listSince.mockRejectedValue(new Error('Files sync failed'));

    const config: UnifiedSyncConfig = {
      tenantId: 'tenant-1',
      mappingId: 'mapping-1',
      files: { enabled: true },
      webdavTarget: {
        rootPath: '/files',
        httpClient: { request: vi.fn() },
      },
    };

    await expect(runUnifiedSync({
      config,
      ledger: mockLedger,
      cursors: mockCursors,
      webdavSource,
      webdavWriter,
    })).rejects.toThrow('Files sync failed');
  });

  it('should throw error when calendar config is missing', async () => {
    const config: UnifiedSyncConfig = {
      tenantId: 'tenant-1',
      mappingId: 'mapping-1',
      calendar: { enabled: true },
    };

    await expect(runUnifiedSync({
      config,
      ledger: mockLedger,
      cursors: mockCursors,
    })).rejects.toThrow('CalDAV source and target configuration required for calendar sync');
  });

  it('should throw error when contacts config is missing', async () => {
    const config: UnifiedSyncConfig = {
      tenantId: 'tenant-1',
      mappingId: 'mapping-1',
      contacts: { enabled: true },
    };

    await expect(runUnifiedSync({
      config,
      ledger: mockLedger,
      cursors: mockCursors,
    })).rejects.toThrow('CardDAV source and target configuration required for contacts sync');
  });

  it('should throw error when files config is missing', async () => {
    const config: UnifiedSyncConfig = {
      tenantId: 'tenant-1',
      mappingId: 'mapping-1',
      files: { enabled: true },
    };

    await expect(runUnifiedSync({
      config,
      ledger: mockLedger,
      cursors: mockCursors,
    })).rejects.toThrow('WebDAV source and target configuration required for files sync');
  });
});
