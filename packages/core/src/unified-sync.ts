/**
 * Unified Sync Engine
 * 
 * Orchestrates synchronization across all data types: mail, calendar, contacts, and files.
 * Coordinates source connectors, target writers, and the ledger for idempotent, non-destructive sync.
 * 
 * Design follows ADR-0020 (idempotency) and workplan 0003 (multi-domain sync).
 */

import type {
  TenantId,
  MappingId,
  Ledger,
  CursorStore,
  MailSource,
  MailTargetWriter,
  CalendarSource,
  CalendarTargetWriter,
  ContactSource,
  ContactTargetWriter,
  FileSource,
  FileTargetWriter,
} from '@open-migrate/shared';

/**
 * Configuration for unified sync
 */
export interface UnifiedSyncConfig {
  tenantId: TenantId;
  mappingId: MappingId;
  
  // Data type enablement
  mail: {
    enabled: boolean;
    source: MailSource;
    target: MailTargetWriter;
  };
  calendar: {
    enabled: boolean;
    source: CalendarSource;
    target: CalendarTargetWriter;
  };
  contacts: {
    enabled: boolean;
    source: ContactSource;
    target: ContactTargetWriter;
  };
  files: {
    enabled: boolean;
    source: FileSource;
    target: FileTargetWriter;
  };
  
  // Sync behavior
  concurrency: number;
  dryRun: boolean;
}

/**
 * Sync statistics for a single data type
 */
export interface TypeSyncStats {
  totalItems: number;
  createdCount: number;
  skippedCount: number;
  failureCount: number;
  bytesTransferred: number;
  durationSeconds: number;
  failures: Array<{ id: string; error: string }>;
}

/**
 * Overall unified sync result
 */
export interface UnifiedSyncResult {
  tenantId: TenantId;
  mappingId: MappingId;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;
  mail: TypeSyncStats;
  calendar: TypeSyncStats;
  contacts: TypeSyncStats;
  files: TypeSyncStats;
  completed: boolean;
}

/**
 * Dependencies for unified sync
 */
export interface UnifiedSyncDeps {
  config: UnifiedSyncConfig;
  ledger: Ledger;
  cursors?: CursorStore;
}

/**
 * Run unified sync across all enabled data types.
 * 
 * Each enabled data type is synced sequentially (mail → calendar → contacts → files).
 * Within each type, the sync follows the shadow pass pattern:
 * 1. List source items incrementally using cursors
 * 2. Check ledger for existing mappings (fast-path skip)
 * 3. Fetch raw content
 * 4. Check target for existing items (existence check)
 * 5. Write to target if absent
 * 6. Record in ledger
 * 
 * This ensures idempotency and non-destructive behavior.
 */
export async function runUnifiedSync(deps: UnifiedSyncDeps): Promise<UnifiedSyncResult> {
  const { config, ledger, cursors } = deps;
  const startedAt = new Date().toISOString();
  
  const results: {
    mail: TypeSyncStats;
    calendar: TypeSyncStats;
    contacts: TypeSyncStats;
    files: TypeSyncStats;
  } = {
    mail: {
      totalItems: 0,
      createdCount: 0,
      skippedCount: 0,
      failureCount: 0,
      bytesTransferred: 0,
      durationSeconds: 0,
      failures: [],
    },
    calendar: {
      totalItems: 0,
      createdCount: 0,
      skippedCount: 0,
      failureCount: 0,
      bytesTransferred: 0,
      durationSeconds: 0,
      failures: [],
    },
    contacts: {
      totalItems: 0,
      createdCount: 0,
      skippedCount: 0,
      failureCount: 0,
      bytesTransferred: 0,
      durationSeconds: 0,
      failures: [],
    },
    files: {
      totalItems: 0,
      createdCount: 0,
      skippedCount: 0,
      failureCount: 0,
      bytesTransferred: 0,
      durationSeconds: 0,
      failures: [],
    },
  };

  // Sync mail if enabled
  if (config.mail.enabled) {
    console.log(`[${config.tenantId}] Syncing mail...`);
    results.mail = await syncMail(config, ledger, cursors);
    console.log(`[${config.tenantId}] Mail sync complete: ${results.mail.createdCount} created, ${results.mail.skippedCount} skipped`);
  }

  // Sync calendar if enabled
  if (config.calendar.enabled) {
    console.log(`[${config.tenantId}] Syncing calendar...`);
    results.calendar = await syncCalendar(config, ledger, cursors);
    console.log(`[${config.tenantId}] Calendar sync complete: ${results.calendar.createdCount} created, ${results.calendar.skippedCount} skipped`);
  }

  // Sync contacts if enabled
  if (config.contacts.enabled) {
    console.log(`[${config.tenantId}] Syncing contacts...`);
    results.contacts = await syncContacts(config, ledger, cursors);
    console.log(`[${config.tenantId}] Contacts sync complete: ${results.contacts.createdCount} created, ${results.contacts.skippedCount} skipped`);
  }

  // Sync files if enabled
  if (config.files.enabled) {
    console.log(`[${config.tenantId}] Syncing files...`);
    results.files = await syncFiles(config, ledger, cursors);
    console.log(`[${config.tenantId}] Files sync complete: ${results.files.createdCount} created, ${results.files.skippedCount} skipped`);
  }

  const completedAt = new Date().toISOString();
  const durationSeconds = Math.round((new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000);

  // Determine overall completion
  const allCompleted =
    (!config.mail.enabled || results.mail.failureCount === 0) &&
    (!config.calendar.enabled || results.calendar.failureCount === 0) &&
    (!config.contacts.enabled || results.contacts.failureCount === 0) &&
    (!config.files.enabled || results.files.failureCount === 0);

  return {
    tenantId: config.tenantId,
    mappingId: config.mappingId,
    startedAt,
    completedAt,
    durationSeconds,
    ...results,
    completed: allCompleted,
  };
}

// ============================================================================
// Mail Sync (existing implementation)
// ============================================================================

async function syncMail(
  config: UnifiedSyncConfig,
  ledger: Ledger,
  cursors?: CursorStore,
): Promise<TypeSyncStats> {
  const startTime = Date.now();
  const stats: TypeSyncStats = {
    totalItems: 0,
    createdCount: 0,
    skippedCount: 0,
    failureCount: 0,
    bytesTransferred: 0,
    durationSeconds: 0,
    failures: [],
  };

  try {
    const { source, target } = config.mail;

    // List all folders
    const folders = await source.listFolders();
    
    for (const folder of folders) {
      const mailboxId = await target.ensureMailbox(folder);
      const prev = cursors ? await cursors.get(config.tenantId, config.mappingId, folder.path) : undefined;
      
      const { items, nextCursor } = await source.listSince(folder, prev);
      stats.totalItems += items.length;

      for (const item of items) {
        try {
          const naturalKeyHash = naturalKeyForMailItem(item);
          
          // LEDGER FAST-PATH
          const known = await ledger.find(config.tenantId, config.mappingId, naturalKeyHash);
          if (known) {
            stats.skippedCount++;
            continue;
          }

          // Fetch raw content
          const raw = await source.fetch(item);
          const contentHashValue = contentHashForMail(raw.rfc822);

          // Check target existence
          const existingId = await target.findByNaturalKey(mailboxId, naturalKeyHash);
          if (existingId) {
            await ledger.recordIfAbsent({
              tenantId: config.tenantId,
              mappingId: config.mappingId,
              naturalKeyHash,
              contentHash: contentHashValue,
              targetId: existingId,
              createdAt: new Date().toISOString(),
            });
            stats.skippedCount++;
            continue;
          }

          // Write to target
          const result = await target.upsertEmail(mailboxId, raw, item.keywords);

          // Record in ledger
          await ledger.recordIfAbsent({
            tenantId: config.tenantId,
            mappingId: config.mappingId,
            naturalKeyHash,
            contentHash: contentHashValue,
            targetId: result.targetId,
            createdAt: new Date().toISOString(),
          });

          if (result.created) {
            stats.createdCount++;
          } else {
            stats.skippedCount++;
          }
        } catch (error) {
          const err = error as Error;
          stats.failureCount++;
          stats.failures.push({ id: item.id, error: err.message });
        }
      }

      // Persist cursor
      if (cursors && nextCursor) {
        await cursors.set(config.tenantId, config.mappingId, folder.path, nextCursor);
      }
    }
  } catch (error) {
    const err = error as Error;
    stats.failureCount++;
    stats.failures.push({ id: 'mail-sync', error: err.message });
  }

  stats.durationSeconds = Math.round((Date.now() - startTime) / 1000);
  return stats;
}

// ============================================================================
// Calendar Sync
// ============================================================================

async function syncCalendar(
  config: UnifiedSyncConfig,
  ledger: Ledger,
  cursors?: CursorStore,
): Promise<TypeSyncStats> {
  const startTime = Date.now();
  const stats: TypeSyncStats = {
    totalItems: 0,
    createdCount: 0,
    skippedCount: 0,
    failureCount: 0,
    bytesTransferred: 0,
    durationSeconds: 0,
    failures: [],
  };

  try {
    const { source, target } = config.calendar;

    // List all calendars
    const calendars = await source.listCalendars();
    
    for (const calendar of calendars) {
      const calendarId = await target.ensureCalendar(calendar);
      const prev = cursors ? await cursors.get(config.tenantId, config.mappingId, `cal:${calendar.path}`) : undefined;
      
      const { items, nextCursor } = await source.listSince(calendar, prev);
      stats.totalItems += items.length;

      for (const item of items) {
        try {
          const naturalKey = extractUidFromIcalendar(item.icalendar);
          const naturalKeyHash = calendarNaturalKeyHash(naturalKey);
          const contentHashValue = calendarContentHash(item.icalendar);

          // LEDGER FAST-PATH
          const known = await ledger.find(config.tenantId, config.mappingId, naturalKeyHash);
          if (known) {
            stats.skippedCount++;
            continue;
          }

          // Check target existence
          const existingId = await target.findCalendarByNaturalKey(calendarId, naturalKey);
          if (existingId) {
            await ledger.recordIfAbsent({
              tenantId: config.tenantId,
              mappingId: config.mappingId,
              naturalKeyHash,
              contentHash: contentHashValue,
              targetId: existingId,
              createdAt: new Date().toISOString(),
            });
            stats.skippedCount++;
            continue;
          }

          // Write to target
          const result = await target.upsertCalendarEvent(calendarId, item);

          // Record in ledger
          await ledger.recordIfAbsent({
            tenantId: config.tenantId,
            mappingId: config.mappingId,
            naturalKeyHash,
            contentHash: contentHashValue,
            targetId: result.targetId,
            createdAt: new Date().toISOString(),
          });

          if (result.created) {
            stats.createdCount++;
          } else {
            stats.skippedCount++;
          }
        } catch (error) {
          const err = error as Error;
          stats.failureCount++;
          stats.failures.push({ id: item.uid || 'unknown', error: err.message });
        }
      }

      // Persist cursor
      if (cursors && nextCursor) {
        await cursors.set(config.tenantId, config.mappingId, `cal:${calendar.path}`, nextCursor);
      }
    }
  } catch (error) {
    const err = error as Error;
    stats.failureCount++;
    stats.failures.push({ id: 'calendar-sync', error: err.message });
  }

  stats.durationSeconds = Math.round((Date.now() - startTime) / 1000);
  return stats;
}

// ============================================================================
// Contacts Sync
// ============================================================================

async function syncContacts(
  config: UnifiedSyncConfig,
  ledger: Ledger,
  cursors?: CursorStore,
): Promise<TypeSyncStats> {
  const startTime = Date.now();
  const stats: TypeSyncStats = {
    totalItems: 0,
    createdCount: 0,
    skippedCount: 0,
    failureCount: 0,
    bytesTransferred: 0,
    durationSeconds: 0,
    failures: [],
  };

  try {
    const { source, target } = config.contacts;

    // List all address books
    const addressBooks = await source.listAddressBooks();
    
    for (const addressBook of addressBooks) {
      const folderId = await target.ensureContactFolder(addressBook);
      const prev = cursors ? await cursors.get(config.tenantId, config.mappingId, `card:${addressBook.path}`) : undefined;
      
      const { items, nextCursor } = await source.listSince(addressBook, prev);
      stats.totalItems += items.length;

      for (const item of items) {
        try {
          const naturalKey = extractUidFromVcard(item.vcard);
          const naturalKeyHash = contactNaturalKeyHash(naturalKey);
          const contentHashValue = contactContentHash(item.vcard);

          // LEDGER FAST-PATH
          const known = await ledger.find(config.tenantId, config.mappingId, naturalKeyHash);
          if (known) {
            stats.skippedCount++;
            continue;
          }

          // Check target existence
          const existingId = await target.findContactByNaturalKey(folderId, naturalKey);
          if (existingId) {
            await ledger.recordIfAbsent({
              tenantId: config.tenantId,
              mappingId: config.mappingId,
              naturalKeyHash,
              contentHash: contentHashValue,
              targetId: existingId,
              createdAt: new Date().toISOString(),
            });
            stats.skippedCount++;
            continue;
          }

          // Write to target
          const result = await target.upsertContact(folderId, item);

          // Record in ledger
          await ledger.recordIfAbsent({
            tenantId: config.tenantId,
            mappingId: config.mappingId,
            naturalKeyHash,
            contentHash: contentHashValue,
            targetId: result.targetId,
            createdAt: new Date().toISOString(),
          });

          if (result.created) {
            stats.createdCount++;
          } else {
            stats.skippedCount++;
          }
        } catch (error) {
          const err = error as Error;
          stats.failureCount++;
          stats.failures.push({ id: item.uid || 'unknown', error: err.message });
        }
      }

      // Persist cursor
      if (cursors && nextCursor) {
        await cursors.set(config.tenantId, config.mappingId, `card:${addressBook.path}`, nextCursor);
      }
    }
  } catch (error) {
    const err = error as Error;
    stats.failureCount++;
    stats.failures.push({ id: 'contacts-sync', error: err.message });
  }

  stats.durationSeconds = Math.round((Date.now() - startTime) / 1000);
  return stats;
}

// ============================================================================
// Files Sync
// ============================================================================

async function syncFiles(
  config: UnifiedSyncConfig,
  ledger: Ledger,
  cursors?: CursorStore,
): Promise<TypeSyncStats> {
  const startTime = Date.now();
  const stats: TypeSyncStats = {
    totalItems: 0,
    createdCount: 0,
    skippedCount: 0,
    failureCount: 0,
    bytesTransferred: 0,
    durationSeconds: 0,
    failures: [],
  };

  try {
    const { source, target } = config.files;

    // List all file folders
    const folders = await source.listFolders();
    
    for (const folder of folders) {
      const folderId = await target.ensureDirectory(folder);
      const prev = cursors ? await cursors.get(config.tenantId, config.mappingId, `file:${folder.path}`) : undefined;
      
      const { items, nextCursor } = await source.listSince(folder, prev);
      stats.totalItems += items.length;

      for (const item of items) {
        try {
          const naturalKey = item.path;
          const naturalKeyHash = fileNaturalKeyHash(naturalKey);
          const contentHashValue = fileContentHash(item.content);

          // LEDGER FAST-PATH
          const known = await ledger.find(config.tenantId, config.mappingId, naturalKeyHash);
          if (known) {
            stats.skippedCount++;
            continue;
          }

          // Check target existence
          const existingId = await target.findFileByNaturalKey(folderId, naturalKey);
          if (existingId) {
            await ledger.recordIfAbsent({
              tenantId: config.tenantId,
              mappingId: config.mappingId,
              naturalKeyHash,
              contentHash: contentHashValue,
              targetId: existingId,
              createdAt: new Date().toISOString(),
            });
            stats.skippedCount++;
            continue;
          }

          // Write to target
          const result = await target.upsertFile(folderId, item);

          // Record in ledger
          await ledger.recordIfAbsent({
            tenantId: config.tenantId,
            mappingId: config.mappingId,
            naturalKeyHash,
            contentHash: contentHashValue,
            targetId: result.targetId,
            createdAt: new Date().toISOString(),
          });

          if (result.created) {
            stats.createdCount++;
            stats.bytesTransferred += item.content.length;
          } else {
            stats.skippedCount++;
          }
        } catch (error) {
          const err = error as Error;
          stats.failureCount++;
          stats.failures.push({ id: item.path || 'unknown', error: err.message });
        }
      }

      // Persist cursor
      if (cursors && nextCursor) {
        await cursors.set(config.tenantId, config.mappingId, `file:${folder.path}`, nextCursor);
      }
    }
  } catch (error) {
    const err = error as Error;
    stats.failureCount++;
    stats.failures.push({ id: 'files-sync', error: err.message });
  }

  stats.durationSeconds = Math.round((Date.now() - startTime) / 1000);
  return stats;
}

// ============================================================================
// Helper Functions
// ============================================================================

function naturalKeyForMailItem(item: { messageId?: string; id?: string }): string {
  // Extract Message-ID from item
  return item.messageId || item.id || '';
}

function contentHashForMail(rfc822: string): string {
  // SHA-256 of raw email content
  return sha256Hex(rfc822);
}

function extractUidFromIcalendar(icalendar: string): string {
  const match = icalendar.match(/UID:[^\r\n]+/i);
  return match ? match[0].split(':')[1].trim() : '';
}

function extractUidFromVcard(vcard: string): string {
  const match = vcard.match(/UID:[^\r\n]+/i);
  return match ? match[0].split(':')[1].trim() : '';
}

function sha256Hex(data: string | Uint8Array): string {
  // Simple SHA-256 implementation placeholder
  // In production, use crypto.subtle or a proper crypto library
  if (typeof data === 'string') {
    const encoder = new TextEncoder();
    data = encoder.encode(data);
  }
  
  // This is a placeholder - actual implementation would use crypto API
  // For now, return a simple hash
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = typeof data === 'string' ? data.charCodeAt(i) : data[i];
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(64, '0');
}

function calendarNaturalKeyHash(uid: string): string {
  return sha256Hex(`cal:${uid.toLowerCase()}`);
}

function contactNaturalKeyHash(uid: string): string {
  return sha256Hex(`card:${uid}`);
}

function fileNaturalKeyHash(path: string): string {
  return sha256Hex(`file:${path}`);
}

function calendarContentHash(icalendar: string): string {
  return sha256Hex(icalendar);
}

function contactContentHash(vcard: string): string {
  return sha256Hex(vcard);
}

function fileContentHash(content: Uint8Array): string {
  return sha256Hex(content);
}
