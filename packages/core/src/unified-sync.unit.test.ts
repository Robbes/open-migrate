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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Ledger, CursorStore } from '@openmig/shared';
import { asTenantId, asMappingId } from '@openmig/shared';
import { runUnifiedSync, type UnifiedSyncConfig } from './unified-sync';
import { createFakeCalDAVSource, createFakeCardDAVSource, createFakeWebDAVSource, createFakeCalDAVTargetWriter, createFakeCardDAVTargetWriter, createFakeWebDAVTargetWriter } from './unified-sync.test-fakes';

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
      tenantId: asTenantId('tenant-1'),
      mappingId: asMappingId('mapping-1'),
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
      tenantId: asTenantId('tenant-1'),
      mappingId: asMappingId('mapping-1'),
      calendar: { enabled: true },
      caldavTarget: {
        url: 'https://caldav.example.com',
        username: 'user',
        password: 'pass',
        homeSet: 'https://caldav.example.com/',
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
      tenantId: asTenantId('tenant-1'),
      mappingId: asMappingId('mapping-1'),
      contacts: { enabled: true },
      carddavTarget: {
        url: 'https://carddav.example.com',
        username: 'user',
        password: 'pass',
        homeSet: 'https://carddav.example.com/',
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
        { path: '/files/file1.txt', isDirectory: false, size: 1024, naturalKey: 'file1', type: 'file', sourcePath: '/files/file1.txt' }
      ],
      nextCursor: { value: 'cursor1' }
    });
    webdavSource.fetch.mockResolvedValue({
      content: 'file content',
      metadata: { path: '/files/file1.txt', isDirectory: 'false', size: '1024' }
    });

    const config: UnifiedSyncConfig = {
      tenantId: asTenantId('tenant-1'),
      mappingId: asMappingId('mapping-1'),
      files: { enabled: true },
      webdavTarget: {
        url: 'https://webdav.example.com',
        username: 'user',
        password: 'pass',
        rootPath: '/files',
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
    webdavSource.listSince.mockResolvedValue({ items: [{ path: '/files/file1.txt', isDirectory: false, size: 1024, naturalKey: 'file1', type: 'file', sourcePath: '/files/file1.txt' }], nextCursor: { value: 'cursor1' } });
    webdavSource.fetch.mockResolvedValue({ content: 'content', metadata: {} });

    const config: UnifiedSyncConfig = {
      tenantId: asTenantId('tenant-1'),
      mappingId: asMappingId('mapping-1'),
      calendar: { enabled: true },
      contacts: { enabled: true },
      files: { enabled: true },
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
    
    caldavSource.listFolders.mockResolvedValue([{ id: 'cal1', name: 'Calendar', path: '/calendar/', color: '#FF0000' }]);
    caldavSource.listSince.mockRejectedValue(new Error('Calendar sync failed'));

    const config: UnifiedSyncConfig = {
      tenantId: asTenantId('tenant-1'),
      mappingId: asMappingId('mapping-1'),
      calendar: { enabled: true },
      caldavTarget: {
        url: 'https://caldav.example.com',
        username: 'user',
        password: 'pass',
        homeSet: 'https://caldav.example.com/',
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
    
    carddavSource.listFolders.mockResolvedValue([{ id: 'addr1', name: 'Address Book', path: '/addressbook/' }]);
    carddavSource.listSince.mockRejectedValue(new Error('Contacts sync failed'));

    const config: UnifiedSyncConfig = {
      tenantId: asTenantId('tenant-1'),
      mappingId: asMappingId('mapping-1'),
      contacts: { enabled: true },
      carddavTarget: {
        url: 'https://carddav.example.com',
        username: 'user',
        password: 'pass',
        homeSet: 'https://carddav.example.com/',
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
    
    webdavSource.listFolders.mockResolvedValue([{ id: 'files1', name: 'Files', path: '/files/' }]);
    webdavSource.listSince.mockRejectedValue(new Error('Files sync failed'));

    const config: UnifiedSyncConfig = {
      tenantId: asTenantId('tenant-1'),
      mappingId: asMappingId('mapping-1'),
      files: { enabled: true },
      webdavTarget: {
        url: 'https://webdav.example.com',
        username: 'user',
        password: 'pass',
        rootPath: '/files',
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
      tenantId: asTenantId('tenant-1'),
      mappingId: asMappingId('mapping-1'),
      calendar: { enabled: true },
    };

    await expect(runUnifiedSync({
      config,
      ledger: mockLedger,
      cursors: mockCursors,
    })).rejects.toThrow('CalDAV source and writer required for calendar sync (inject via UnifiedSyncDeps)');
  });

  it('should throw error when contacts config is missing', async () => {
    const config: UnifiedSyncConfig = {
      tenantId: asTenantId('tenant-1'),
      mappingId: asMappingId('mapping-1'),
      contacts: { enabled: true },
    };

    await expect(runUnifiedSync({
      config,
      ledger: mockLedger,
      cursors: mockCursors,
    })).rejects.toThrow('CardDAV source and writer required for contacts sync (inject via UnifiedSyncDeps)');
  });

  it('should throw error when files config is missing', async () => {
    const config: UnifiedSyncConfig = {
      tenantId: asTenantId('tenant-1'),
      mappingId: asMappingId('mapping-1'),
      files: { enabled: true },
    };

    await expect(runUnifiedSync({
      config,
      ledger: mockLedger,
      cursors: mockCursors,
    })).rejects.toThrow('WebDAV source and writer required for files sync (inject via UnifiedSyncDeps)');
  });
});
