/** RFC 6154 special-use mailbox roles we care about (plus 'normal' for everything else). */
export type SpecialUse = 'inbox' | 'sent' | 'drafts' | 'archive' | 'junk' | 'trash' | 'normal';

/** JMAP keywords / IMAP system flags we map. Subset used by the first slice. */
export type MailKeyword = '$seen' | '$flagged' | '$draft' | '$answered';

export interface MailFolder {
  /** Stable source path/name, e.g. "INBOX" or "INBOX/Projects". */
  readonly path: string;
  /** Human label (usually the last path segment) if known. */
  readonly name?: string;
  /** Detected special-use role (RFC 6154); 'normal' if none. */
  readonly specialUse: SpecialUse;
}

export interface MailAddress {
  readonly email: string;
  readonly name?: string;
}

/**
 * Normalized mail item flowing through the engine.
 * `messageId` is the idempotency anchor (the natural key); the RFC822 bytes are
 * fetched lazily via `sourceRef` by the source connector.
 */
export interface MailItem {
  /** RFC 5322 Message-ID, including angle brackets as received. The natural key. */
  readonly messageId: string;
  /** Folder this item belongs to (source-side). */
  readonly folder: MailFolder;
  /** Keywords/flags set on the message. */
  readonly keywords: ReadonlyArray<MailKeyword>;
  /** Original delivery/receipt time (IMAP INTERNALDATE), ISO 8601. */
  readonly receivedAt: string;
  /** Size in bytes, if known. */
  readonly size?: number;
  /** Opaque source handle the connector uses to fetch raw bytes (e.g. "INBOX:42"). */
  readonly sourceRef: string;
}

/** RFC822 bytes plus the item they belong to. */
export interface RawMessage {
  readonly item: MailItem;
  readonly rfc822: Uint8Array;
}
