// Copyright 2026 OpenHands Agent (Apache-2.0)
/**
 * DAV domain sync wrappers - thin wrappers around runDomainSync for CalDAV, CardDAV, and WebDAV.
 * 
 * Each wrapper operates on REAL domain-typed sources/targets, not generic types.
 * The abstraction is at the function level, parameterizing the loop with domain-specific injections.
 */

import {
  type Ledger,
  type CursorStore,
  type CalendarSource,
  type CalendarTargetWriter,
  type CalendarFolder,
  type RawCalendarEvent,
  type ContactSource,
  type ContactTargetWriter,
  type ContactFolder,
  type RawContact,
  type FileSource,
  type FileTargetWriter,
  type FileFolder,
  type RawFileItem,
  type TenantId,
  type MappingId,
  calendarNaturalKeyHash,
  calendarContentHash,
  contactNaturalKeyHash,
  contactContentHash,
  fileNaturalKeyHash,
  fileContentHash,
} from '@openmig/shared';
import { runDomainSync, type DomainSyncResult } from './domain-sync';

/**
 * Dependencies for calendar (CalDAV) sync.
 */
export interface CalendarSyncDeps {
  readonly tenantId: TenantId;
  readonly mappingId: MappingId;
  readonly source: CalendarSource;
  readonly target: CalendarTargetWriter;
  readonly ledger: Ledger;
  readonly cursors?: CursorStore;
  readonly concurrency?: number;
}

/**
 * Run CalDAV sync using the generalized domain sync loop.
 * 
 * Idempotent: running twice creates 0 items on the second run.
 * Non-destructive: never deletes or overwrites on the target.
 */
export async function runCalendarSync(deps: CalendarSyncDeps): Promise<DomainSyncResult> {
  const { tenantId, mappingId, source, target, ledger, cursors, concurrency } = deps;

  return runDomainSync<CalendarSource, CalendarTargetWriter, RawCalendarEvent, CalendarFolder>({
    tenantId,
    mappingId,
    domain: 'calendar',
    source,
    target,
    ledger,
    cursors,
    concurrency,
    listFolders: () => source.listFolders(),
    listSince: (folder, cursor) => source.listSince(folder, cursor),
    fetchRaw: async (item) => {
      const raw = item.icalendar;
      return { 
        raw: { item: item.item, icalendar: raw } as RawCalendarEvent,
        sizeBytes: Buffer.from(item.icalendar, 'utf8').length 
      };
    },
    upsert: async (calendarId, raw, _item) => 
      target.upsertCalendarEvent(calendarId, raw as RawCalendarEvent),
    naturalKey: (item) => calendarNaturalKeyHash(item.item.uid),
    contentHash: (raw) => calendarContentHash((raw as RawCalendarEvent).icalendar),
    ensureCollection: (folder) => target.ensureCalendar(folder),
  });
}

/**
 * Dependencies for contact (CardDAV) sync.
 */
export interface ContactSyncDeps {
  readonly tenantId: TenantId;
  readonly mappingId: MappingId;
  readonly source: ContactSource;
  readonly target: ContactTargetWriter;
  readonly ledger: Ledger;
  readonly cursors?: CursorStore;
  readonly concurrency?: number;
}

/**
 * Run CardDAV sync using the generalized domain sync loop.
 * 
 * Idempotent: running twice creates 0 items on the second run.
 * Non-destructive: never deletes or overwrites on the target.
 */
export async function runContactSync(deps: ContactSyncDeps): Promise<DomainSyncResult> {
  const { tenantId, mappingId, source, target, ledger, cursors, concurrency } = deps;

  return runDomainSync<ContactSource, ContactTargetWriter, RawContact, ContactFolder>({
    tenantId,
    mappingId,
    domain: 'contact',
    source,
    target,
    ledger,
    cursors,
    concurrency,
    listFolders: () => source.listFolders(),
    listSince: (folder, cursor) => source.listSince(folder, cursor),
    fetchRaw: async (item) => {
      const raw = item.vcard;
      return { 
        raw: { item: item.item, vcard: raw } as RawContact,
        sizeBytes: Buffer.from(raw, 'utf8').length 
      };
    },
    upsert: async (folderId, raw, _item) => 
      target.upsertContact(folderId, raw as RawContact),
    naturalKey: (item) => contactNaturalKeyHash(item.item.uid),
    contentHash: (raw) => contactContentHash((raw as RawContact).vcard),
    ensureCollection: (folder) => target.ensureContactFolder(folder),
  });
}

/**
 * Dependencies for file (WebDAV) sync.
 */
export interface FileSyncDeps {
  readonly tenantId: TenantId;
  readonly mappingId: MappingId;
  readonly source: FileSource;
  readonly target: FileTargetWriter;
  readonly ledger: Ledger;
  readonly cursors?: CursorStore;
  readonly concurrency?: number;
}

/**
 * Run WebDAV sync using the generalized domain sync loop.
 * 
 * Idempotent: running twice creates 0 items on the second run.
 * Non-destructive: never deletes or overwrites on the target.
 */
export async function runFileSync(deps: FileSyncDeps): Promise<DomainSyncResult> {
  const { tenantId, mappingId, source, target, ledger, cursors, concurrency } = deps;

  return runDomainSync<FileSource, FileTargetWriter, RawFileItem, FileFolder>({
    tenantId,
    mappingId,
    domain: 'file',
    source,
    target,
    ledger,
    cursors,
    concurrency,
    listFolders: () => source.listFolders(),
    listSince: (folder, cursor) => source.listSince(folder, cursor),
    fetchRaw: async (item) => {
      const content = item.content ?? new Uint8Array(0);
      return { 
        raw: { item: item.item, content } as RawFileItem,
        sizeBytes: item.item?.size ?? content.length 
      };
    },
    upsert: async (parentId, raw, _item) => 
      target.upsertFile(parentId, raw as RawFileItem),
    naturalKey: (item) => fileNaturalKeyHash(item.item.path),
    contentHash: (raw) => fileContentHash((raw as RawFileItem).content ?? new Uint8Array(0)),
    ensureCollection: (folder) => target.ensureDirectory(folder),
  });
}
