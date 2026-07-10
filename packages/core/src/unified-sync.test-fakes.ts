/**
 * Test fixtures and fakes for unified-sync tests.
 * 
 * Provides fake implementations of connectors and writers that can be
 * injected into runUnifiedSync via UnifiedSyncDeps.
 */

import { vi } from 'vitest';
import type { SyncCursor } from '@openmig/shared';
import type { GenericRawItem } from './generic-sync';
import type { CalDAVFolder, CalDAVItem } from './unified-sync';
import type { CardDAVFolder, CardDAVItem } from './unified-sync';
import type { WebDAVFolder, WebDAVItem } from './unified-sync';

/**
 * Fake CalDAV source for testing
 */
export function createFakeCalDAVSource() {
  const listFolders = vi.fn<() => Promise<readonly CalDAVFolder[]>>().mockResolvedValue([]);
  const listSince = vi.fn<(folder: CalDAVFolder, cursor?: SyncCursor) => Promise<{ items: readonly CalDAVItem[]; nextCursor: SyncCursor }>>().mockResolvedValue({ items: [], nextCursor: { value: '' } as SyncCursor });
  const fetch = vi.fn<(item: CalDAVItem) => Promise<GenericRawItem>>().mockResolvedValue({ content: '', metadata: {} });

  return {
    listFolders,
    listSince,
    fetch,
  };
}

/**
 * Fake CardDAV source for testing
 */
export function createFakeCardDAVSource() {
  const listFolders = vi.fn<() => Promise<readonly CardDAVFolder[]>>().mockResolvedValue([]);
  const listSince = vi.fn<(folder: CardDAVFolder, cursor?: SyncCursor) => Promise<{ items: readonly CardDAVItem[]; nextCursor: SyncCursor }>>().mockResolvedValue({ items: [], nextCursor: { value: '' } as SyncCursor });
  const fetch = vi.fn<(item: CardDAVItem) => Promise<GenericRawItem>>().mockResolvedValue({ content: '', metadata: {} });

  return {
    listFolders,
    listSince,
    fetch,
  };
}

/**
 * Fake WebDAV source for testing
 */
export function createFakeWebDAVSource() {
  const listFolders = vi.fn<() => Promise<readonly WebDAVFolder[]>>().mockResolvedValue([]);
  const listSince = vi.fn<(folder: WebDAVFolder, cursor?: SyncCursor) => Promise<{ items: readonly WebDAVItem[]; nextCursor: SyncCursor }>>().mockResolvedValue({ items: [], nextCursor: { value: '' } as SyncCursor });
  const fetch = vi.fn<(item: WebDAVItem) => Promise<GenericRawItem>>().mockResolvedValue({ content: '', metadata: {} });

  return {
    listFolders,
    listSince,
    fetch,
  };
}

/**
 * Fake CalDAV target writer for testing
 */
export function createFakeCalDAVTargetWriter() {
  const ensureFolder = vi.fn<(folder: CalDAVFolder) => Promise<string>>().mockResolvedValue('calendar/');
  const upsertItem = vi.fn<(folderId: string, naturalKey: string, raw: GenericRawItem) => Promise<{ targetId: string; created: boolean }>>().mockResolvedValue({ targetId: 'calendar/event.ics', created: true });
  const findByNaturalKey = vi.fn<(folderId: string, naturalKey: string) => Promise<string | undefined>>().mockResolvedValue(undefined);

  return {
    ensureFolder,
    upsertItem,
    findByNaturalKey,
  };
}

/**
 * Fake CardDAV target writer for testing
 */
export function createFakeCardDAVTargetWriter() {
  const ensureFolder = vi.fn<(folder: CardDAVFolder) => Promise<string>>().mockResolvedValue('contacts/');
  const upsertItem = vi.fn<(folderId: string, naturalKey: string, raw: GenericRawItem) => Promise<{ targetId: string; created: boolean }>>().mockResolvedValue({ targetId: 'contacts/contact.vcf', created: true });
  const findByNaturalKey = vi.fn<(folderId: string, naturalKey: string) => Promise<string | undefined>>().mockResolvedValue(undefined);

  return {
    ensureFolder,
    upsertItem,
    findByNaturalKey,
  };
}

/**
 * Fake WebDAV target writer for testing
 */
export function createFakeWebDAVTargetWriter() {
  const ensureFolder = vi.fn<(folder: WebDAVFolder) => Promise<string>>().mockResolvedValue('files/');
  const upsertItem = vi.fn<(folderId: string, naturalKey: string, raw: GenericRawItem) => Promise<{ targetId: string; created: boolean }>>().mockResolvedValue({ targetId: 'files/file.txt', created: true });
  const findByNaturalKey = vi.fn<(folderId: string, naturalKey: string) => Promise<string | undefined>>().mockResolvedValue(undefined);

  return {
    ensureFolder,
    upsertItem,
    findByNaturalKey,
  };
}
