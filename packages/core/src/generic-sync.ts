/**
 * Generic Sync Engine
 * 
 * A domain-neutral sync engine that works with any source/writer pair
 * that follows the standard sync pattern:
 * - Source: listFolders(), listSince(folder, cursor), fetch(item)
 * - Writer: ensureFolder(), upsertItem(), findByNaturalKey()
 * 
 * This engine provides:
 * - Ledger fast-path optimization
 * - Create-if-absent for lost ledger recovery
 * - Incremental cursors with bounded concurrency
 * - Non-destructive sync (no deletions propagated)
 * - Idempotency guarantees
 */

import type {
  TenantId,
  MappingId,
  Ledger,
  LedgerRecord,
  CursorStore,
  SyncCursor,
} from '@openmig/shared';
import { mapWithConcurrency } from '@openmig/shared';
import { createHash } from 'node:crypto';

/**
 * Generic folder interface - represents a collection in any domain
 */
export interface GenericFolder {
  id: string;
  name: string;
  path: string;
  /** Special use flag (e.g., 'inbox', 'sent', 'drafts') */
  specialUse?: string;
}

/**
 * Generic item interface - represents an item in any domain
 */
export interface GenericItem {
  /** Natural key (UID, Message-ID, normalized path, etc.) */
  naturalKey: string;
  /** Domain-specific type (e.g., 'event', 'vcard', 'file') */
  type: string;
  /** Brief summary for display/debugging */
  summary?: string;
  /** Source path/location */
  sourcePath: string;
}

/**
 * Generic raw item - the full raw data for an item
 */
export interface GenericRawItem {
  /** The raw content (RFC822, iCalendar, vCard, file bytes, etc.) */
  content: string | ArrayBuffer;
  /** Metadata */
  metadata?: Record<string, string>;
}

/**
 * Generic source connector interface
 */
export interface GenericSource<TFolder extends GenericFolder, TItem extends GenericItem> {
  /** List all folders/collections */
  listFolders(): Promise<ReadonlyArray<TFolder>>;
  /**
   * List items in folder changed since cursor.
   * Returns items plus next cursor to persist.
   */
  listSince(
    folder: TFolder,
    cursor?: SyncCursor,
  ): Promise<{ items: ReadonlyArray<TItem>; nextCursor: SyncCursor }>;
  /** Fetch full raw data for an item */
  fetch(item: TItem): Promise<GenericRawItem>;
}

/**
 * Generic target writer interface
 */
export interface GenericTargetWriter<TFolder extends GenericFolder> {
  /** Ensure folder exists; return its target ID */
  ensureFolder(folder: TFolder): Promise<string>;
  /** Idempotently write an item */
  upsertItem(
    folderId: string,
    naturalKey: string,
    raw: GenericRawItem,
  ): Promise<{ targetId: string; created: boolean }>;
  /** Check if item exists by natural key */
  findByNaturalKey(folderId: string, naturalKey: string): Promise<string | undefined>;
}

/**
 * Result of a single sync operation
 */
export interface GenericSyncResult {
  /** Total items scanned */
  scanned: number;
  /** Items newly created */
  created: number;
  /** Items skipped (already synced) */
  skipped: number;
  /** Items that failed to sync */
  failed: number;
  /** Bytes transferred */
  bytesTransferred: number;
  /** Errors */
  errors: Array<{ id: string; error: string }>;
}

/**
 * Dependencies for generic sync
 */
export interface GenericSyncDeps<
  TFolder extends GenericFolder,
  TItem extends GenericItem
> {
  readonly tenantId: TenantId;
  readonly mappingId: MappingId;
  readonly source: GenericSource<TFolder, TItem>;
  readonly target: GenericTargetWriter<TFolder>;
  readonly ledger: Ledger;
  /** Optional cursor persistence */
  readonly cursors?: CursorStore;
  /** Max items processed in parallel per folder (default 4) */
  readonly concurrency?: number;
  /** Domain type for ledger records */
  readonly itemType: 'mail' | 'calendar' | 'contact' | 'file';
}

/**
 * Hash a natural key for ledger storage
 */
function hashNaturalKey(naturalKey: string): string {
  return createHash('sha256').update(naturalKey).digest('hex');
}

/**
 * Hash raw content for integrity checking
 */
function hashContent(content: string | ArrayBuffer): string {
  const data = typeof content === 'string' ? content : Buffer.from(content);
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Run a generic sync across all folders in a source
 */
export async function runGenericSync<
  TFolder extends GenericFolder,
  TItem extends GenericItem
>(deps: GenericSyncDeps<TFolder, TItem>): Promise<GenericSyncResult> {
  const { source, target, ledger, cursors, concurrency = 4, itemType } = deps;
  
  const result: GenericSyncResult = {
    scanned: 0,
    created: 0,
    skipped: 0,
    failed: 0,
    bytesTransferred: 0,
    errors: [],
  };

  // List all folders
  const folders = await source.listFolders();
  
  // Process each folder sequentially
  for (const folder of folders) {
    console.log(`[${deps.tenantId}] Syncing folder: ${folder.name} (${folder.path})`);
    
    // Ensure folder exists on target
    const folderId = await target.ensureFolder(folder);
    
    // Get cursor for this folder
    const cursorKey = `${itemType}/${folder.path}`;
    let cursor: SyncCursor | undefined;
    if (cursors) {
      cursor = await cursors.get(deps.tenantId, deps.mappingId, cursorKey);
    }
    
    // List items changed since cursor
    const { items, nextCursor } = await source.listSince(folder, cursor);
    result.scanned += items.length;
    
    // Persist new cursor
    if (cursors && nextCursor.value) {
      await cursors.set(deps.tenantId, deps.mappingId, cursorKey, nextCursor);
    }
    
    // Process items with bounded concurrency
    await mapWithConcurrency(
      items,
      concurrency,
      async (item) => {
        try {
          // Fetch raw data
          const raw = await source.fetch(item);
          const contentSize = typeof raw.content === 'string' 
            ? Buffer.byteLength(raw.content, 'utf8')
            : (raw.content as ArrayBuffer).byteLength;
          result.bytesTransferred += contentSize;
          
          // Ledger fast-path: check if already synced
          const naturalKeyHash = hashNaturalKey(item.naturalKey);
          const contentHash = hashContent(raw.content);
          const existingRecord = await ledger.find(
            deps.tenantId,
            deps.mappingId,
            itemType,
            naturalKeyHash
          );
          
          if (existingRecord) {
            // Already synced - skip
            result.skipped++;
            return;
          }
          
          // Check target for existing item (ledger recovery)
          const existingTargetId = await target.findByNaturalKey(folderId, item.naturalKey);
          if (existingTargetId) {
            // Item exists on target but not in ledger - update ledger only
            const record: LedgerRecord = {
              tenantId: deps.tenantId,
              mappingId: deps.mappingId,
              itemType: itemType as never, // Type assertion needed
              naturalKeyHash,
              contentHash,
              targetId: existingTargetId,
              createdAt: new Date().toISOString(),
            };
            await ledger.recordIfAbsent(record);
            result.skipped++;
            return;
          }
          
          // Upsert to target
          const upsertResult = await target.upsertItem(folderId, item.naturalKey, raw);
          
          // Update ledger
          const record: LedgerRecord = {
            tenantId: deps.tenantId,
            mappingId: deps.mappingId,
            itemType: itemType as never, // Type assertion needed
            naturalKeyHash,
            contentHash,
            targetId: upsertResult.targetId,
            createdAt: new Date().toISOString(),
          };
          await ledger.recordIfAbsent(record);
          
          if (upsertResult.created) {
            result.created++;
          } else {
            result.skipped++;
          }
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          result.failed++;
          result.errors.push({ id: item.naturalKey, error: errMsg });
          console.error(`[${deps.tenantId}] Failed to sync ${item.naturalKey}: ${errMsg}`);
        }
      }
    );
  }
  
  return result;
}

