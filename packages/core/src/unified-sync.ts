/**
 * Unified Sync Engine - Multi-Domain Sync Implementation
 * 
 * Orchestrates sync across multiple domains (calendar, contacts, files)
 * using the appropriate source connectors and target writers.
 * 
 * Features:
 * - Domain-specific source connectors (CalDAV, CardDAV, WebDAV)
 * - Domain-specific target writers (CalDAV, CardDAV, WebDAV)
 * - Generic sync engine for all domains
 * - Aggregated statistics and error handling
 * - Fail-fast on domain errors
 * 
 * Architecture: Connectors are injected via UnifiedSyncDeps following ports & adapters.
 * This keeps the core stack-independent - no direct dependency on @openmig/connectors.
 */

import type { TenantId, MappingId, Ledger, CursorStore } from '@openmig/shared';
import { runGenericSync, type GenericSyncResult, type GenericSource, type GenericTargetWriter, type GenericFolder, type GenericItem, type GenericRawItem } from './generic-sync';

// Type-only imports for config interfaces (used in UnifiedSyncConfig)
import type { CalDAVSourceConfig } from '@openmig/connectors';
import type { RawCalendarEvent } from '@openmig/shared';
import type { CalDAVTargetConfig } from '@openmig/engines';
import type { CardDAVSourceConfig } from '@openmig/connectors';
import type { RawContact } from '@openmig/shared';
import type { CardDAVTargetConfig } from '@openmig/engines';
import type { WebDAVSourceConfig } from '@openmig/connectors';
import type { RawFileItem } from '@openmig/shared';
import type { WebDAVTargetConfig } from '@openmig/engines';

export interface UnifiedSyncConfig {
  tenantId: TenantId;
  mappingId: MappingId;
  mail?: { enabled: boolean };
  calendar?: { enabled: boolean };
  contacts?: { enabled: boolean };
  files?: { enabled: boolean };
  concurrency?: number;
  dryRun?: boolean;
  // Domain-specific configurations - separate source and target configs
  caldavSource?: CalDAVSourceConfig;
  caldavTarget?: CalDAVTargetConfig;
  carddavSource?: CardDAVSourceConfig;
  carddavTarget?: CardDAVTargetConfig;
  webdavSource?: WebDAVSourceConfig;
  webdavTarget?: WebDAVTargetConfig;
}

export interface TypeSyncStats {
  totalItems: number;
  createdCount: number;
  skippedCount: number;
  failureCount: number;
  bytesTransferred: number;
  durationSeconds: number;
  failures: Array<{ id: string; error: string }>;
}

export interface UnifiedSyncResult {
  mail: TypeSyncStats;
  calendar: TypeSyncStats;
  contacts: TypeSyncStats;
  files: TypeSyncStats;
  totalDurationSeconds: number;
}

export interface UnifiedSyncDeps {
  config: UnifiedSyncConfig;
  ledger: Ledger;
  cursors?: CursorStore;
  // Injected connector instances (ports & adapters pattern)
  // Core doesn't construct connectors - they're provided by the caller
  caldavSource?: GenericSource<CalDAVFolder, CalDAVItem>;
  caldavWriter?: GenericTargetWriter<CalDAVFolder, CalDAVItem>;
  carddavSource?: GenericSource<CardDAVFolder, CardDAVItem>;
  carddavWriter?: GenericTargetWriter<CardDAVFolder, CardDAVItem>;
  webdavSource?: GenericSource<WebDAVFolder, WebDAVItem>;
  webdavWriter?: GenericTargetWriter<WebDAVFolder, WebDAVItem>;
}

/**
 * CalDAV Folder type implementing GenericFolder
 */
export interface CalDAVFolder extends GenericFolder {
  readonly path: string;
  readonly name: string;
  readonly color?: string;
  readonly description?: string;
}

/**
 * CalDAV Item type implementing GenericItem
 */
export interface CalDAVItem extends GenericItem {
  readonly uid: string;
  readonly type: string;
  readonly summary: string;
  readonly sourcePath: string;
}

/**
 * CardDAV Folder type implementing GenericFolder
 */
export interface CardDAVFolder extends GenericFolder {
  readonly path: string;
  readonly name: string;
  readonly description?: string;
  readonly supportedVersions?: ReadonlyArray<import('@openmig/shared').VCardVersion>;
}

/**
 * CardDAV Item type implementing GenericItem
 */
export interface CardDAVItem extends GenericItem {
  readonly uid: string;
  readonly type: string;
  readonly name: string;
  readonly sourcePath: string;
}

/**
 * WebDAV Folder type implementing GenericFolder
 */
export interface WebDAVFolder extends GenericFolder {
  readonly path: string;
  readonly name: string;
  readonly description?: string;
  readonly quota?: {
    readonly used: number;
    readonly available?: number;
  };
}

/**
 * WebDAV Item type implementing GenericItem
 */
export interface WebDAVItem extends GenericItem {
  readonly path: string;
  readonly isDirectory: boolean;
  readonly size: number;
}

/**
 * Adapter to wrap CalDAVTargetWriter for GenericTargetWriter interface
 */
class CalDAVTargetWriterAdapter implements GenericTargetWriter<CalDAVFolder> {
  private readonly writer: CalDAVTargetWriter;

  constructor(config: CalDAVTargetConfig, deps: { ledger: Ledger; tenantId: TenantId; mappingId: MappingId }) {
    this.writer = new CalDAVTargetWriter(config, deps);
  }

  async ensureFolder(folder: CalDAVFolder): Promise<string> {
    return this.writer.ensureCalendar(folder);
  }

  async upsertItem(folderId: string, naturalKey: string, raw: GenericRawItem): Promise<{ targetId: string; created: boolean }> {
    // Convert GenericRawItem to RawCalendarEvent
    const rawCalendarEvent: RawCalendarEvent = {
      item: {
        uid: naturalKey,
        type: 'event',
        summary: raw.metadata?.summary || 'Untitled Event',
        start: '2024-01-01T00:00:00Z',
        sourcePath: raw.metadata?.sourcePath || '',
        icalendar: raw.content as string,
      },
      icalendar: raw.content as string,
    };

    const result = await this.writer.upsertCalendarEvent(folderId, rawCalendarEvent);
    return {
      targetId: result.targetId,
      created: result.created,
    };
  }

  async findByNaturalKey(folderId: string, naturalKey: string): Promise<string | undefined> {
    return this.writer.findCalendarByNaturalKey(folderId, naturalKey);
  }
}

/**
 * Adapter to wrap CardDAVTargetWriter for GenericTargetWriter interface
 */
class CardDAVTargetWriterAdapter implements GenericTargetWriter<CardDAVFolder> {
  private readonly writer: CardDAVTargetWriter;

  constructor(config: CardDAVTargetConfig, deps: { ledger: Ledger; tenantId: TenantId; mappingId: MappingId }) {
    this.writer = new CardDAVTargetWriter(config, deps);
  }

  async ensureFolder(folder: CardDAVFolder): Promise<string> {
    return this.writer.ensureContactFolder(folder);
  }

  async upsertItem(folderId: string, naturalKey: string, raw: GenericRawItem): Promise<{ targetId: string; created: boolean }> {
    // Convert GenericRawItem to RawContact
    const rawContact: RawContact = {
      item: {
        uid: naturalKey,
        type: 'person',
        name: raw.metadata?.name || 'Unknown Contact',
        sourcePath: raw.metadata?.sourcePath || '',
        vcard: raw.content as string,
        version: '4.0',
      },
      vcard: raw.content as string,
    };

    const result = await this.writer.upsertContact(folderId, rawContact);
    return {
      targetId: result.targetId,
      created: result.created,
    };
  }

  async findByNaturalKey(folderId: string, naturalKey: string): Promise<string | undefined> {
    return this.writer.findContactByNaturalKey(folderId, naturalKey);
  }
}

/**
 * Adapter to wrap WebDAVTargetWriter for GenericTargetWriter interface
 */
class WebDAVTargetWriterAdapter implements GenericTargetWriter<WebDAVFolder> {
  private readonly writer: WebDAVTargetWriter;

  constructor(config: WebDAVTargetConfig, deps: { ledger: Ledger; tenantId: TenantId; mappingId: MappingId }) {
    this.writer = new WebDAVTargetWriter(config, deps);
  }

  async ensureFolder(folder: WebDAVFolder): Promise<string> {
    return this.writer.ensureDirectory(folder);
  }

  async upsertItem(folderId: string, naturalKey: string, raw: GenericRawItem): Promise<{ targetId: string; created: boolean }> {
    // Convert GenericRawItem to RawFileItem
    // Handle both string and ArrayBuffer content
    let content: Uint8Array | undefined;
    if (raw.content instanceof ArrayBuffer) {
      content = new Uint8Array(raw.content);
    } else if (typeof raw.content === 'string') {
      // Convert string to Uint8Array
      const encoder = new TextEncoder();
      content = encoder.encode(raw.content);
    }
    
    const rawFileItem: RawFileItem = {
      item: {
        path: naturalKey,
        isDirectory: raw.metadata?.type === 'directory',
        size: parseInt(raw.metadata?.size || '0', 10),
        modifiedAt: new Date().toISOString(),
        sourceRef: naturalKey,
      },
      content,
    };

    const result = await this.writer.upsertFile(folderId, rawFileItem);
    return {
      targetId: result.targetId,
      created: result.created,
    };
  }

  async findByNaturalKey(folderId: string, naturalKey: string): Promise<string | undefined> {
    return this.writer.findFileByNaturalKey(folderId, naturalKey);
  }
}

/**
 * Convert GenericSyncResult to TypeSyncStats
 */
function convertToTypeSyncStats(result: GenericSyncResult, durationSeconds: number): TypeSyncStats {
  return {
    totalItems: result.scanned,
    createdCount: result.created,
    skippedCount: result.skipped,
    failureCount: result.failed,
    bytesTransferred: result.bytesTransferred,
    durationSeconds,
    failures: result.errors,
  };
}

/**
 * Run unified sync across all enabled domains.
 * 
 * For each enabled domain:
 * 1. Use the injected source connector (or create from config if not injected)
 * 2. Use the injected target writer (or create from config if not injected)
 * 3. Call runGenericSync with the source, writer, ledger, and cursors
 * 4. Aggregate results into UnifiedSyncResult
 * 
 * Fail loud: if a domain errors, surface the error (don't return zeros)
 */
export async function runUnifiedSync(
  deps: UnifiedSyncDeps
): Promise<UnifiedSyncResult> {
  const { config, ledger, cursors } = deps;
  const startTime = Date.now();

  // Initialize result with empty stats
  const result: UnifiedSyncResult = {
    mail: { totalItems: 0, createdCount: 0, skippedCount: 0, failureCount: 0, bytesTransferred: 0, durationSeconds: 0, failures: [] },
    calendar: { totalItems: 0, createdCount: 0, skippedCount: 0, failureCount: 0, bytesTransferred: 0, durationSeconds: 0, failures: [] },
    contacts: { totalItems: 0, createdCount: 0, skippedCount: 0, failureCount: 0, bytesTransferred: 0, durationSeconds: 0, failures: [] },
    files: { totalItems: 0, createdCount: 0, skippedCount: 0, failureCount: 0, bytesTransferred: 0, durationSeconds: 0, failures: [] },
    totalDurationSeconds: 0,
  };

  const concurrency = config.concurrency ?? 4;

  // Process each enabled domain
  const domainPromises: Promise<void>[] = [];

  // Calendar domain
  if (config.calendar?.enabled) {
    const caldavSource = deps.caldavSource;
    const caldavTarget = config.caldavTarget;
    if (!caldavSource || !caldavTarget) {
      throw new Error('CalDAV source and target configuration required for calendar sync');
    }

    domainPromises.push(
      (async () => {
        const domainStart = Date.now();
        try {
          const writer = new CalDAVTargetWriterAdapter(caldavTarget, {
            ledger,
            tenantId: config.tenantId,
            mappingId: config.mappingId,
          });

          const syncResult = await runGenericSync({
            tenantId: config.tenantId,
            mappingId: config.mappingId,
            source: caldavSource,
            target: writer,
            ledger,
            cursors,
            concurrency,
            itemType: 'calendar',
          });

          const durationSeconds = (Date.now() - domainStart) / 1000;
          result.calendar = convertToTypeSyncStats(syncResult, durationSeconds);
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error(`[UnifiedSync] Calendar domain failed: ${errMsg}`);
          result.calendar.failureCount = 1;
          result.calendar.failures.push({ id: 'calendar', error: errMsg });
          throw new Error(`Calendar sync failed: ${errMsg}`, { cause: error });
        }
      })()
    );
  }

  // Contacts domain
  if (config.contacts?.enabled) {
    const carddavSource = deps.carddavSource;
    const carddavTarget = config.carddavTarget;
    if (!carddavSource || !carddavTarget) {
      throw new Error('CardDAV source and target configuration required for contacts sync');
    }

    domainPromises.push(
      (async () => {
        const domainStart = Date.now();
        try {
          const writer = new CardDAVTargetWriterAdapter(carddavTarget, {
            ledger,
            tenantId: config.tenantId,
            mappingId: config.mappingId,
          });

          const syncResult = await runGenericSync({
            tenantId: config.tenantId,
            mappingId: config.mappingId,
            source: carddavSource,
            target: writer,
            ledger,
            cursors,
            concurrency,
            itemType: 'contact',
          });

          const durationSeconds = (Date.now() - domainStart) / 1000;
          result.contacts = convertToTypeSyncStats(syncResult, durationSeconds);
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error(`[UnifiedSync] Contacts domain failed: ${errMsg}`);
          result.contacts.failureCount = 1;
          result.contacts.failures.push({ id: 'contacts', error: errMsg });
          throw new Error(`Contacts sync failed: ${errMsg}`, { cause: error });
        }
      })()
    );
  }

  // Files domain
  if (config.files?.enabled) {
    const webdavSource = deps.webdavSource;
    const webdavTarget = config.webdavTarget;
    if (!webdavSource || !webdavTarget) {
      throw new Error('WebDAV source and target configuration required for files sync');
    }

    domainPromises.push(
      (async () => {
        const domainStart = Date.now();
        try {
          const writer = new WebDAVTargetWriterAdapter(webdavTarget, {
            ledger,
            tenantId: config.tenantId,
            mappingId: config.mappingId,
          });

          const syncResult = await runGenericSync({
            tenantId: config.tenantId,
            mappingId: config.mappingId,
            source: webdavSource,
            target: writer,
            ledger,
            cursors,
            concurrency,
            itemType: 'file',
          });

          const durationSeconds = (Date.now() - domainStart) / 1000;
          result.files = convertToTypeSyncStats(syncResult, durationSeconds);
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error(`[UnifiedSync] Files domain failed: ${errMsg}`);
          result.files.failureCount = 1;
          result.files.failures.push({ id: 'files', error: errMsg });
          throw new Error(`Files sync failed: ${errMsg}`, { cause: error });
        }
      })()
    );
  }

  // Wait for all domains to complete
  if (domainPromises.length > 0) {
    await Promise.all(domainPromises);
  }

  // Calculate total duration
  const totalDuration = (Date.now() - startTime) / 1000;
  result.totalDurationSeconds = totalDuration;

  return result;
}
