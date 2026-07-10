/**
 * Test fixtures and fakes for unified-sync tests.
 * 
 * Provides fake implementations of connectors and writers that can be
 * injected into runUnifiedSync via UnifiedSyncDeps.
 */

import type { GenericSource, GenericTargetWriter, SyncCursor } from '@openmig/shared';
import type { CalDAVFolder, CalDAVItem } from './unified-sync';
import type { CardDAVFolder, CardDAVItem } from './unified-sync';
import type { WebDAVFolder, WebDAVItem } from './unified-sync';

/**
 * Fake CalDAV source for testing
 */
export function createFakeCalDAVSource() {
  const listFolders = vi.fn().mockResolvedValue([]);
  const listSince = vi.fn().mockResolvedValue({ items: [], nextCursor: { value: '' } as SyncCursor });
  const fetch = vi.fn().mockResolvedValue({ content: '', metadata: {} });

  return {
    listFolders,
    listSince,
    fetch,
  } as unknown as GenericSource<CalDAVFolder, CalDAVItem>;
}

/**
 * Fake CardDAV source for testing
 */
export function createFakeCardDAVSource() {
  const listFolders = vi.fn().mockResolvedValue([]);
  const listSince = vi.fn().mockResolvedValue({ items: [], nextCursor: { value: '' } as SyncCursor });
  const fetch = vi.fn().mockResolvedValue({ content: '', metadata: {} });

  return {
    listFolders,
    listSince,
    fetch,
  } as unknown as GenericSource<CardDAVFolder, CardDAVItem>;
}

/**
 * Fake WebDAV source for testing
 */
export function createFakeWebDAVSource() {
  const listFolders = vi.fn().mockResolvedValue([]);
  const listSince = vi.fn().mockResolvedValue({ items: [], nextCursor: { value: '' } as SyncCursor });
  const fetch = vi.fn().mockResolvedValue({ content: '', metadata: {} });

  return {
    listFolders,
    listSince,
    fetch,
  } as unknown as GenericSource<WebDAVFolder, WebDAVItem>;
}

/**
 * Fake CalDAV target writer for testing
 */
export function createFakeCalDAVTargetWriter() {
  const ensureFolder = vi.fn().mockResolvedValue('calendar/');
  const upsertItem = vi.fn().mockResolvedValue({ targetId: 'calendar/event.ics', created: true });
  const findByNaturalKey = vi.fn().mockResolvedValue(undefined);

  return {
    ensureFolder,
    upsertItem,
    findByNaturalKey,
  } as unknown as GenericTargetWriter<CalDAVFolder, CalDAVItem>;
}

/**
 * Fake CardDAV target writer for testing
 */
export function createFakeCardDAVTargetWriter() {
  const ensureFolder = vi.fn().mockResolvedValue('contacts/');
  const upsertItem = vi.fn().mockResolvedValue({ targetId: 'contacts/contact.vcf', created: true });
  const findByNaturalKey = vi.fn().mockResolvedValue(undefined);

  return {
    ensureFolder,
    upsertItem,
    findByNaturalKey,
  } as unknown as GenericTargetWriter<CardDAVFolder, CardDAVItem>;
}

/**
 * Fake WebDAV target writer for testing
 */
export function createFakeWebDAVTargetWriter() {
  const ensureFolder = vi.fn().mockResolvedValue('files/');
  const upsertItem = vi.fn().mockResolvedValue({ targetId: 'files/file.txt', created: true });
  const findByNaturalKey = vi.fn().mockResolvedValue(undefined);

  return {
    ensureFolder,
    upsertItem,
    findByNaturalKey,
  } as unknown as GenericTargetWriter<WebDAVFolder, WebDAVItem>;
}
