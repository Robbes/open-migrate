import type {
  CursorStore,
  Ledger,
  LedgerRecord,
  MailFolder,
  MailItem,
  MailKeyword,
  RawMessage,
  SourceConnector,
  SyncCursor,
  TargetEntry,
  TargetReindexer,
  TargetWriter,
  UpsertResult,
} from '@openmig/shared';

/** Seed shape for {@link MemorySource}. */
export interface SeedMessage {
  readonly folderPath: string;
  readonly messageId: string;
  readonly rfc822: string;
  readonly keywords?: ReadonlyArray<MailKeyword>;
}

let idCounter = 0;
const nextId = (prefix: string): string => `${prefix}-${(idCounter += 1)}`;

/** In-memory, read-only source connector. */
export class MemorySource implements SourceConnector {
  private readonly byFolder = new Map<string, MailItem[]>();
  private readonly raw = new Map<string, Uint8Array>();
  private readonly folders = new Map<string, MailFolder>();

  add(seed: SeedMessage): void {
    const specialUse: MailFolder['specialUse'] =
      seed.folderPath.toUpperCase() === 'INBOX'
        ? 'inbox'
        : seed.folderPath.toLowerCase() === 'sent'
          ? 'sent'
          : 'normal';
    const folder: MailFolder = this.folders.get(seed.folderPath) ?? {
      path: seed.folderPath,
      specialUse,
    };
    this.folders.set(seed.folderPath, folder);

    const sourceRef = `${seed.folderPath}:${seed.messageId}`;
    const item: MailItem = {
      messageId: seed.messageId,
      folder,
      keywords: seed.keywords ?? [],
      receivedAt: new Date(0).toISOString(),
      sourceRef,
    };
    const list = this.byFolder.get(seed.folderPath) ?? [];
    list.push(item);
    this.byFolder.set(seed.folderPath, list);
    this.raw.set(sourceRef, new TextEncoder().encode(seed.rfc822));
  }

  listFolders(): Promise<ReadonlyArray<MailFolder>> {
    return Promise.resolve([...this.folders.values()]);
  }

  listSince(
    folder: MailFolder,
    cursor?: SyncCursor,
  ): Promise<{ items: ReadonlyArray<MailItem>; nextCursor: SyncCursor }> {
    const all = this.byFolder.get(folder.path) ?? [];
    // Cursor = "items already seen" offset; malformed/absent -> full scan (non-authoritative, ADR-0020).
    const start = cursor ? Math.max(0, Number(cursor.value) || 0) : 0;
    return Promise.resolve({ items: all.slice(start), nextCursor: { value: String(all.length) } });
  }

  fetch(item: MailItem): Promise<RawMessage> {
    const bytes = this.raw.get(item.sourceRef);
    if (!bytes) throw new Error(`MemorySource: no bytes for ${item.sourceRef}`);
    return Promise.resolve({ item, rfc822: bytes });
  }
}

interface StoredEmail {
  readonly targetId: string;
  readonly mailboxId: string;
  readonly messageId: string;
  readonly keywords: ReadonlyArray<MailKeyword>;
}

/** In-memory create-if-absent target, keyed by (mailboxId, messageId). Also a reindexer. */
export class MemoryTarget implements TargetWriter, TargetReindexer {
  private readonly mailboxes = new Map<string, string>();
  private readonly store = new Map<string, StoredEmail>();

  private key(mailboxId: string, messageId: string): string {
    return `${mailboxId}\u0000${messageId}`;
  }

  ensureMailbox(folder: MailFolder): Promise<string> {
    const existing = this.mailboxes.get(folder.path);
    if (existing) return Promise.resolve(existing);
    const id = nextId('mbox');
    this.mailboxes.set(folder.path, id);
    return Promise.resolve(id);
  }

  upsertEmail(
    mailboxId: string,
    raw: RawMessage,
    keywords: ReadonlyArray<MailKeyword>,
  ): Promise<UpsertResult> {
    const k = this.key(mailboxId, raw.item.messageId);
    const existing = this.store.get(k);
    if (existing) return Promise.resolve({ targetId: existing.targetId, created: false });
    const targetId = nextId('email');
    this.store.set(k, { targetId, mailboxId, messageId: raw.item.messageId, keywords });
    return Promise.resolve({ targetId, created: true });
  }

  findByNaturalKey(mailboxId: string, naturalKey: string): Promise<string | undefined> {
    return Promise.resolve(this.store.get(this.key(mailboxId, naturalKey))?.targetId);
  }

  async *listEntries(_mailboxId?: string): AsyncIterable<TargetEntry> {
    for (const v of this.store.values()) {
      const entry: TargetEntry = { naturalKey: v.messageId, targetId: v.targetId, mailboxId: v.mailboxId };
      yield entry;
    }
  }

  /** Test helper: number of stored messages. */
  size(): number {
    return this.store.size;
  }
}

/** In-memory idempotency ledger. */
export class MemoryLedger implements Ledger {
  private readonly rows = new Map<string, LedgerRecord>();

  private key(r: Pick<LedgerRecord, 'tenantId' | 'mappingId' | 'naturalKeyHash'>): string {
    return `${r.tenantId}\u0000${r.mappingId}\u0000${r.naturalKeyHash}`;
  }

  find(
    tenantId: LedgerRecord['tenantId'],
    mappingId: LedgerRecord['mappingId'],
    naturalKeyHash: string,
  ): Promise<LedgerRecord | undefined> {
    return Promise.resolve(this.rows.get(this.key({ tenantId, mappingId, naturalKeyHash })));
  }

  recordIfAbsent(record: LedgerRecord): Promise<LedgerRecord> {
    const k = this.key(record);
    const existing = this.rows.get(k);
    if (existing) return Promise.resolve(existing);
    this.rows.set(k, record);
    return Promise.resolve(record);
  }

  /** Test helper: number of rows. */
  size(): number {
    return this.rows.size;
  }

  /** Test helper: wipe the ledger (simulate a fresh reinstall). */
  clear(): void {
    this.rows.clear();
  }
}

/** In-memory per-folder cursor store. */
export class MemoryCursorStore implements CursorStore {
  private readonly m = new Map<string, { readonly value: string }>();

  private key(tenantId: string, mappingId: string, folderPath: string): string {
    return `${tenantId}\u0000${mappingId}\u0000${folderPath}`;
  }

  get(
    tenantId: Parameters<CursorStore['get']>[0],
    mappingId: Parameters<CursorStore['get']>[1],
    folderPath: string,
  ): ReturnType<CursorStore['get']> {
    return Promise.resolve(this.m.get(this.key(tenantId, mappingId, folderPath)));
  }

  set(
    tenantId: Parameters<CursorStore['set']>[0],
    mappingId: Parameters<CursorStore['set']>[1],
    folderPath: string,
    cursor: { readonly value: string },
  ): Promise<void> {
    this.m.set(this.key(tenantId, mappingId, folderPath), cursor);
    return Promise.resolve();
  }

  /** Test helper: simulate a lost cursor store. */
  clear(): void {
    this.m.clear();
  }
}
