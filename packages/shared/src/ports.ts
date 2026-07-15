import type { TenantId, MappingId } from './ids';
import type { MailFolder, MailItem, RawMessage, MailKeyword } from './mail';
import type { CalendarFolder, RawCalendarEvent } from './calendar';
import type { ContactFolder, RawContact } from './contact';
import type { FileFolder, RawFileItem } from './file';

/** Opaque, source-defined cursor for incremental listing (e.g. UIDVALIDITY+UIDNEXT). */
export interface SyncCursor {
  readonly value: string;
}

/**
 * Persists per-folder incremental cursors so steady-state passes list only changed items.
 * Cursors are NON-AUTHORITATIVE (ADR-0020): a lost or malformed cursor merely forces a full,
 * still-idempotent re-scan. Backed by the ledger DB (a `cursors` table) in the real impl.
 */
export interface CursorStore {
  get(tenantId: TenantId, mappingId: MappingId, folderPath: string): Promise<SyncCursor | undefined>;
  set(tenantId: TenantId, mappingId: MappingId, folderPath: string, cursor: SyncCursor): Promise<void>;
}

/** A source mailbox the engine reads from. READ-ONLY. */
export interface SourceConnector {
  /** Enumerate folders with special-use detection (RFC 6154). */
  listFolders(): Promise<ReadonlyArray<MailFolder>>;
  /**
   * List items in `folder` changed since `cursor` (or all if undefined),
   * returning the items plus the next cursor to persist.
   */
  listSince(
    folder: MailFolder,
    cursor?: SyncCursor,
  ): Promise<{ items: ReadonlyArray<MailItem>; nextCursor: SyncCursor }>;
  /** Fetch the full RFC822 bytes for an item. */
  fetch(item: MailItem): Promise<RawMessage>;
}

/**
 * Calendar source connector for CalDAV.
 */
export interface CalendarSource {
  /** List all calendar collections */
  listFolders(): Promise<ReadonlyArray<CalendarFolder>>;
  /**
   * List calendar items changed since cursor.
   */
  listSince(
    folder: CalendarFolder,
    cursor?: SyncCursor,
  ): Promise<{ items: ReadonlyArray<RawCalendarEvent>; nextCursor: SyncCursor }>;
}

/**
 * Contact source connector for CardDAV.
 */
export interface ContactSource {
  /** List all address book collections */
  listFolders(): Promise<ReadonlyArray<ContactFolder>>;
  /**
   * List contacts changed since cursor.
   */
  listSince(
    folder: ContactFolder,
    cursor?: SyncCursor,
  ): Promise<{ items: ReadonlyArray<RawContact>; nextCursor: SyncCursor }>;
}

/**
 * File source connector for WebDAV.
 */
export interface FileSource {
  /** List all file folders/directories */
  listFolders(): Promise<ReadonlyArray<FileFolder>>;
  /**
   * List files changed since cursor.
   */
  listSince(
    folder: FileFolder,
    cursor?: SyncCursor,
  ): Promise<{ items: ReadonlyArray<RawFileItem>; nextCursor: SyncCursor }>;
}

/**
 * Union type for all source connector types.
 * Used for factory functions that can return different source types.
 */
export type Source = SourceConnector | CalendarSource | ContactSource | FileSource;

/** Result of upserting one message into a target. */
export interface UpsertResult {
  /** Target-side id (e.g. a JMAP Email id). */
  readonly targetId: string;
  /** True if a new item was created; false if it already existed (idempotent skip). */
  readonly created: boolean;
}

/** A target mailbox store the engine writes to. NEVER deletes or overwrites (non-destructive). */
export interface TargetWriter {
  /** Ensure a mailbox exists for the given folder/role; return its target id. */
  ensureMailbox(folder: MailFolder): Promise<string>;
  /**
   * Idempotently write a message into the target mailbox: **create-if-absent keyed on the
   * natural key**. The implementation SHOULD verify existence on the target itself (JMAP
   * `Email/query` on header `Message-ID`; IMAP `SEARCH HEADER Message-ID`) in addition to the
   * ledger fast-path, so even an empty ledger never produces duplicates. Keywords and the
   * original receivedAt are preserved. See ADR-0020 (the ledger is a rebuildable cache).
   */
  upsertEmail(
    mailboxId: string,
    raw: RawMessage,
    keywords: ReadonlyArray<MailKeyword>,
  ): Promise<UpsertResult>;
  /**
   * Existence check for create-if-absent (ADR-0020): return the target id of an item already
   * present in `mailboxId` with this natural key (JMAP `Email/query` on header `Message-ID`;
   * IMAP `SEARCH HEADER Message-ID`), or `undefined`. `upsertEmail` relies on this so an empty
   * ledger never causes duplicates.
   */
  findByNaturalKey(mailboxId: string, naturalKey: string): Promise<string | undefined>;
}

/**
 * Calendar target writer for CalDAV sync.
 */
export interface CalendarTargetWriter {
  /** Ensure a calendar collection exists; return its target id. */
  ensureCalendar(folder: CalendarFolder): Promise<string>;
  /**
   * Idempotently write a calendar event.
   */
  upsertCalendarEvent(
    calendarId: string,
    raw: RawCalendarEvent,
  ): Promise<UpsertResult>;
  /**
   * Existence check for create-if-absent.
   */
  findCalendarByNaturalKey(calendarId: string, naturalKey: string): Promise<string | undefined>;
}

/**
 * Contact target writer for CardDAV sync.
 */
export interface ContactTargetWriter {
  /** Ensure an address book collection exists; return its target id. */
  ensureContactFolder(folder: ContactFolder): Promise<string>;
  /**
   * Idempotently write a contact.
   */
  upsertContact(
    folderId: string,
    raw: RawContact,
  ): Promise<UpsertResult>;
  /**
   * Existence check for create-if-absent.
   */
  findContactByNaturalKey(folderId: string, naturalKey: string): Promise<string | undefined>;
}

/**
 * File target writer for WebDAV sync.
 */
export interface FileTargetWriter {
  /** Ensure a directory exists; return its target id. */
  ensureDirectory(folder: FileFolder): Promise<string>;
  /**
   * Idempotently write a file.
   */
  upsertFile(
    parentId: string,
    raw: RawFileItem,
  ): Promise<UpsertResult>;
  /**
   * Existence check for create-if-absent.
   */
  findFileByNaturalKey(parentId: string, naturalKey: string): Promise<string | undefined>;
}


/** One existing item discovered on the target during reindex/adoption (ADR-0020). */
export interface TargetEntry {
  /** Natural key as stored on the target (e.g. Message-ID). */
  readonly naturalKey: string;
  /** Target-side id (e.g. a JMAP Email id). */
  readonly targetId: string;
  /** Mailbox/folder the item lives in on the target. */
  readonly mailboxId: string;
  /** Content hash, if cheaply available from the listing; used as a fallback key. */
  readonly contentHash?: string;
}

/**
 * Reads existing items off the target to rebuild idempotency state (ADR-0020, workplan T9).
 * Used when the ledger is empty but the target is non-empty (a fresh reinstall), and on demand.
 * Enumeration is header/metadata-only (Message-ID / UID / path) and may be large — implementations
 * SHOULD page; the async iterable lets callers stream without loading everything into memory.
 */
export interface TargetReindexer {
  /** Stream every existing item's natural key + target id (optionally scoped to one mailbox). */
  listEntries(mailboxId?: string): AsyncIterable<TargetEntry>;
}

/** One row of idempotency state. */
export interface LedgerRecord {
  readonly tenantId: TenantId;
  readonly mappingId: MappingId;
  readonly itemType: 'mail' | 'calendar' | 'contact' | 'file';
  readonly naturalKeyHash: string;
  readonly contentHash: string;
  readonly targetId: string;
  /** ISO 8601 timestamp the row was first recorded. */
  readonly createdAt: string;
}

/** Idempotency ledger. UNIQUE(tenantId, mappingId, itemType, naturalKeyHash). Non-destructive. */
export interface Ledger {
  /** Look up an existing record by natural key. */
  find(
    tenantId: TenantId,
    mappingId: MappingId,
    itemType: 'mail' | 'calendar' | 'contact' | 'file',
    naturalKeyHash: string,
  ): Promise<LedgerRecord | undefined>;
  /**
   * Record a mapping if absent. If a row with the same
   * (tenantId, mappingId, itemType, naturalKeyHash) exists, return it unchanged (no-op);
   * otherwise insert and return the new row.
   */
  recordIfAbsent(record: LedgerRecord): Promise<LedgerRecord>;
}

/** Handle to a scheduled job; calling stop() cancels future runs. */
export interface ScheduleHandle {
  stop(): void;
}

/**
 * Orchestration seam. The self-host edition implements this in-process (croner);
 * the managed edition swaps a Trigger.dev-backed impl. Implementations MUST be
 * single-flight per jobId (no overlapping runs — coalesce).
 */
export interface Scheduler {
  /** Run `task` on a cron expression; coalesce overlapping runs. */
  schedule(jobId: string, cron: string, task: () => Promise<void>): ScheduleHandle;
  /** Run `task` once, now. */
  runOnce(jobId: string, task: () => Promise<void>): Promise<void>;
}

/** Dependency bundle for one mapping's shadow pass (DI for the T4 reconcile loop). */
export interface ReconcileDeps {
  readonly tenantId: TenantId;
  readonly mappingId: MappingId;
  readonly source: SourceConnector;
  readonly target: TargetWriter;
  readonly ledger: Ledger;
  /**
   * Optional cursor persistence: when provided, each folder pass lists only items changed since
   * the stored cursor and persists the new cursor after the folder completes. Absent -> full scan
   * (always correct via the ledger, just more work).
   */
  readonly cursors?: CursorStore;
  /** Max messages processed in parallel per folder (default 4). Bounds throughput and peak memory. */
  readonly concurrency?: number;
}

/** Summary of a single shadow pass. */
export interface ReconcileResult {
  readonly scanned: number;
  readonly created: number;
  readonly skipped: number;
  /** Source items absent on a later pass (potential deletions) — logged, never propagated. */
  readonly drift: number;
}

/**
 * Signature of the one-way, non-destructive shadow pass (implemented in @openmig/core, T4).
 * Runs a mapping to convergence; a second run yields `created === 0`.
 */
export type RunShadowPass = (deps: ReconcileDeps) => Promise<ReconcileResult>;

/** Dependency bundle for a reindex/adopt pass (DI for the T9 routine). */
export interface ReindexDeps {
  readonly tenantId: TenantId;
  readonly mappingId: MappingId;
  readonly reindexer: TargetReindexer;
  readonly ledger: Ledger;
}

/** Summary of a reindex/adopt pass. */
export interface ReindexResult {
  readonly scanned: number;
  /** Rows newly written to the ledger (adopted from the target). */
  readonly adopted: number;
  /** Entries already present in the ledger. */
  readonly alreadyKnown: number;
}

/**
 * Signature of the reindex/adopt routine (implemented in @openmig/core, T9): rebuilds ledger state
 * from the target's existing items so a fresh install does not re-copy what is already there.
 */
export type RunReindex = (deps: ReindexDeps) => Promise<ReindexResult>;

/**
 * OAuth2 token response with expiry information.
 */
export interface OAuth2Token {
  /** Access token string. */
  readonly accessToken: string;
  /** Token type (typically "Bearer"). */
  readonly tokenType: string;
  /** Unix timestamp (seconds since epoch) when the token expires. */
  readonly expiresAt: number;
  /** Refresh token, if available (for delegated flows). */
  readonly refreshToken?: string;
  /** Space-separated list of granted scopes. */
  readonly scope?: string;
}

/**
 * Configuration for TokenProvider.
 */
export interface TokenProviderConfig {
  /** OAuth2 token endpoint URL. */
  readonly tokenEndpoint: string;
  /** OAuth2 client ID. */
  readonly clientId: string;
  /** OAuth2 client secret (for client-credentials flow). */
  readonly clientSecret?: string;
  /** Client certificate key (for certificate-based auth). */
  readonly clientCertificateKey?: string;
  /** Client certificate thumbprint (for certificate-based auth). */
  readonly clientCertificateThumbprint?: string;
  /** OAuth2 tenant ID (for Azure AD). */
  readonly tenantId?: string;
  /** Resource/scopes for the token request. */
  readonly scope: string;
  /** Refresh token (for refresh-token flow). */
  readonly refreshToken?: string;
  /** Username (for refresh-token flow). */
  readonly username?: string;
  /** Password (for refresh-token flow). */
  readonly password?: string;
}

/**
 * Token status information.
 */
export interface TokenStatus {
  /** Whether the token is currently valid. */
  readonly isValid: boolean;
  /** Time until expiry in seconds (negative if already expired). */
  readonly timeUntilExpiry: number;
  /** Token type. */
  readonly tokenType?: string;
  /** Scopes granted. */
  readonly scope?: string;
}

/**
 * Token provider interface for managing OAuth2 tokens.
 * Provides token caching, automatic refresh, and single-flight refresh for concurrent callers.
 */
export interface TokenProvider {
  /**
   * Get the current access token, refreshing if necessary.
   * Returns a token that is guaranteed to be valid (not expired) at the time of return.
   * Concurrent callers will share a single refresh request (single-flight).
   */
  getToken(): Promise<OAuth2Token>;

  /**
   * Force a token refresh, bypassing the cache.
   * Returns the newly refreshed token.
   */
  refresh(): Promise<OAuth2Token>;

  /**
   * Check if the current token is valid (not expired).
   * Does not trigger a refresh.
   */
  isTokenValid(): boolean;

  /**
   * Get detailed token status information.
   */
  getTokenStatus(): TokenStatus;
}

/**
 * Port for reading verification data from the ledger.
 * Used by the verification orchestrator to compare source vs target state.
 * All queries are Postgres-only (ADR-0016).
 */
export interface LedgerVerificationReader {
  /** Count items of a given type in the ledger for a mapping */
  countItems(tenantId: TenantId, mappingId: MappingId, domain: 'email' | 'calendar' | 'contact' | 'file'): Promise<number>;
  
  /** Get total bytes for items of a given type in the ledger */
  totalSizeBytes(tenantId: TenantId, mappingId: MappingId, domain: 'email' | 'calendar' | 'contact' | 'file'): Promise<number>;
  
  /** Get sample items for verification (ids + natural key hashes + content hashes) */
  getSamples(
    tenantId: TenantId,
    mappingId: MappingId,
    domain: 'email' | 'calendar' | 'contact' | 'file',
    count: number
  ): Promise<Array<{ id: string; naturalKeyHash: string; contentHash: string }>>;
  
  /** Get all natural key hashes for a given domain (used for discrepancy detection) */
  getAllNaturalKeyHashes(
    tenantId: TenantId,
    mappingId: MappingId,
    domain: 'email' | 'calendar' | 'contact' | 'file'
  ): Promise<string[]>;
}

/**
 * Migration status for a domain sync.
 */
export interface MigrationStatus {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly mappingId: MappingId;
  readonly domain: 'email' | 'calendar' | 'contact' | 'file';
  readonly state: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
  readonly itemsSynced: number;
  readonly itemsFailed: number;
  readonly bytesTransferred: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly lastError?: string;
}

/**
 * Port for tracking per-domain migration status.
 * State is maintained (pending/in_progress/completed/failed/skipped),
 * while item counts are DERIVED from the item ledger records.
 */
export interface MigrationStatusStore {
  /**
   * Initialize domain status as 'pending' (idempotent).
   * Creates a new row if it doesn't exist, otherwise no-op.
   */
  initDomainStatus(tenantId: TenantId, mappingId: MappingId, domain: 'email' | 'calendar' | 'contact' | 'file'): Promise<void>;

  /**
   * Mark a domain sync as in progress.
   */
  markInProgress(tenantId: TenantId, mappingId: MappingId, domain: 'email' | 'calendar' | 'contact' | 'file'): Promise<void>;

  /**
   * Mark a domain sync as completed successfully.
   */
  markCompleted(tenantId: TenantId, mappingId: MappingId, domain: 'email' | 'calendar' | 'contact' | 'file'): Promise<void>;

  /**
   * Mark a domain sync as failed with an error.
   */
  markFailed(tenantId: TenantId, mappingId: MappingId, domain: 'email' | 'calendar' | 'contact' | 'file', error: string): Promise<void>;

  /**
   * Mark a domain sync as skipped (e.g., disabled or no work).
   */
  markSkipped(tenantId: TenantId, mappingId: MappingId, domain: 'email' | 'calendar' | 'contact' | 'file'): Promise<void>;

  /**
   * Get the migration status for a mapping, including DERIVED counts from item records.
   * Returns status for all domains (email, calendar, contact, file).
   */
  getStatus(tenantId: TenantId, mappingId: MappingId): Promise<MigrationStatus[]>;
}
