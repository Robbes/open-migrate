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
 * Config interfaces are defined locally to avoid coupling to implementation packages.
 */

import type { TenantId, MappingId, Ledger, CursorStore } from '@openmig/shared';
import { runGenericSync, type GenericSyncResult, type GenericSource, type GenericTargetWriter, type GenericFolder, type GenericItem } from './generic-sync';

// Local config interfaces (ports & adapters - core doesn't depend on connectors/engines)
export interface CalDAVSourceConfig {
  url: string;
  username: string;
  passwordEnv: string;
  calendarHomeSet?: string;
}

export interface CalDAVTargetConfig {
  url: string;
  username: string;
  password: string;
  homeSet?: string;
  color?: string;
  description?: string;
}

export interface CardDAVSourceConfig {
  url: string;
  username: string;
  passwordEnv: string;
  addressBookHomeSet?: string;
}

export interface CardDAVTargetConfig {
  url: string;
  username: string;
  password: string;
  homeSet?: string;
}

export interface WebDAVSourceConfig {
  url: string;
  username: string;
  passwordEnv: string;
  rootPath?: string;
}

export interface WebDAVTargetConfig {
  url: string;
  username: string;
  password: string;
  rootPath?: string;
  httpClient?: unknown;
}

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
  caldavWriter?: GenericTargetWriter<CalDAVFolder>;
  carddavSource?: GenericSource<CardDAVFolder, CardDAVItem>;
  carddavWriter?: GenericTargetWriter<CardDAVFolder>;
  webdavSource?: GenericSource<WebDAVFolder, WebDAVItem>;
  webdavWriter?: GenericTargetWriter<WebDAVFolder>;
}

/**
 * CalDAV Folder type implementing GenericFolder
 */
export interface CalDAVFolder extends GenericFolder {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly color?: string;
  readonly description?: string;
}

/**
 * CalDAV Item type implementing GenericItem
 */
export interface CalDAVItem extends GenericItem {
  readonly naturalKey: string;
  readonly uid: string;
  readonly type: string;
  readonly summary: string;
  readonly sourcePath: string;
}

/**
 * CardDAV Folder type implementing GenericFolder
 */
export interface CardDAVFolder extends GenericFolder {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly description?: string;
  readonly supportedVersions?: ReadonlyArray<import('@openmig/shared').VCardVersion>;
}

/**
 * CardDAV Item type implementing GenericItem
 */
export interface CardDAVItem extends GenericItem {
  readonly naturalKey: string;
  readonly uid: string;
  readonly type: string;
  readonly name: string;
  readonly sourcePath: string;
}

/**
 * WebDAV Folder type implementing GenericFolder
 */
export interface WebDAVFolder extends GenericFolder {
  readonly id: string;
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
  readonly naturalKey: string;
  readonly path: string;
  readonly isDirectory: boolean;
  readonly size: number;
  readonly type: string;
  readonly sourcePath: string;
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
 * 1. Use the injected source connector and target writer (must be provided)
 * 2. Call runGenericSync with the source, writer, ledger, and cursors
 * 3. Aggregate results into UnifiedSyncResult
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
    const caldavWriter = deps.caldavWriter;
    if (!caldavSource || !caldavWriter) {
      throw new Error('CalDAV source and writer required for calendar sync (inject via UnifiedSyncDeps)');
    }

    domainPromises.push(
      (async () => {
        const domainStart = Date.now();
        try {
          const syncResult = await runGenericSync({
            tenantId: config.tenantId,
            mappingId: config.mappingId,
            source: caldavSource,
            target: caldavWriter,
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
    const carddavWriter = deps.carddavWriter;
    if (!carddavSource || !carddavWriter) {
      throw new Error('CardDAV source and writer required for contacts sync (inject via UnifiedSyncDeps)');
    }

    domainPromises.push(
      (async () => {
        const domainStart = Date.now();
        try {
          const syncResult = await runGenericSync({
            tenantId: config.tenantId,
            mappingId: config.mappingId,
            source: carddavSource,
            target: carddavWriter,
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
    const webdavWriter = deps.webdavWriter;
    if (!webdavSource || !webdavWriter) {
      throw new Error('WebDAV source and writer required for files sync (inject via UnifiedSyncDeps)');
    }

    domainPromises.push(
      (async () => {
        const domainStart = Date.now();
        try {
          const syncResult = await runGenericSync({
            tenantId: config.tenantId,
            mappingId: config.mappingId,
            source: webdavSource,
            target: webdavWriter,
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

// Re-export types for external usage
export type {
  GenericSyncResult,
  GenericSource,
  GenericTargetWriter,
  GenericFolder,
  GenericItem,
  GenericRawItem,
} from './generic-sync';
