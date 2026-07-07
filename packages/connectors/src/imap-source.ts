// Copyright 2026 OpenHands Agent (Apache-2.0)
// IMAP source connector for O365 (XOAUTH2) and generic IMAP (LOGIN).
// Supports RFC 6154 special-use folder detection and incremental listing via UIDVALIDITY/UIDNEXT.
// T2 from workplan 0001-first-slice-jmap-mail.

import imap, { ImapSimple } from "imap-simple";
import type { SourceConnector, SyncCursor } from "@openmig/shared";
import type {
  MailFolder,
  MailItem,
  RawMessage,
  MailKeyword,
  SpecialUse,
} from "@openmig/shared";

// Type alias for IMAP FetchOptions - using 'any' due to type definition issues
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FetchOptions = any;

/**
 * Configuration for IMAP connection.
 */
export interface ImapSourceConfig {
  host: string;
  port: number;
  tls: boolean;
  auth: {
    user: string;
    password?: string;
    accessToken?: string; // For XOAUTH2
  };
  authType?: "LOGIN" | "XOAUTH2";
}

/**
 * Cursor encoding for IMAP: "UIDVALIDITY:UIDNEXT"
 */
export function encodeImapCursor(uidValidity: number, uidNext: number): string {
  return `${uidValidity}:${uidNext}`;
}

export function decodeImapCursor(cursor: SyncCursor): {
  uidValidity: number;
  uidNext: number;
} {
  const parts = cursor.value.split(":");
  if (parts.length !== 2) {
    throw new Error(`Invalid IMAP cursor format: ${cursor.value}`);
  }
  const uidValidity = parseInt(parts[0]!, 10);
  const uidNext = parseInt(parts[1]!, 10);
  if (isNaN(uidValidity) || isNaN(uidNext)) {
    throw new Error(`Invalid IMAP cursor format: ${cursor.value}`);
  }
  return { uidValidity, uidNext };
}

/**
 * Map IMAP system flags to our MailKeyword type.
 */
function mapImapFlagsToKeywords(flags: string[]): MailKeyword[] {
  const keywords: MailKeyword[] = [];
  for (const flag of flags) {
    const lower = flag.toLowerCase();
    if (lower === "\\seen") keywords.push("$seen");
    else if (lower === "\\flagged") keywords.push("$flagged");
    else if (lower === "\\draft") keywords.push("$draft");
    else if (lower === "\\answered") keywords.push("$answered");
  }
  return keywords;
}

/**
 * Map IMAP special-use attributes to our SpecialUse type.
 */
function mapImapSpecialUse(attributes: string[]): SpecialUse {
  for (const attr of attributes) {
    const lower = attr.toLowerCase();
    if (lower === "\\inbox") return "inbox";
    if (lower === "\\sent") return "sent";
    if (lower === "\\drafts") return "drafts";
    if (lower === "\\archive") return "archive";
    if (lower === "\\junk" || lower === "\\spam") return "junk";
    if (lower === "\\trash" || lower === "\\deleted") return "trash";
  }
  return "normal";
}

/**
 * IMAP source connector implementation.
 */
export class ImapSource implements SourceConnector {
  private readonly config: ImapSourceConfig;

  constructor(config: ImapSourceConfig) {
    this.config = config;
  }

  /**
   * Connect to the IMAP server and return a connection.
   */
  async connect(): Promise<ImapSimple> {
    const connectionConfig: imap.ImapSimpleOptions = {
      imap: {
        user: this.config.auth.user,
        password: this.config.auth.password ?? "",
        xoauth2:
          this.config.authType === "XOAUTH2"
            ? this.config.auth.accessToken
            : undefined,
        host: this.config.host,
        port: this.config.port,
        tls: this.config.tls,
        tlsOptions: { rejectUnauthorized: false }, // For self-signed certs in dev
        authTimeout: 30000,
      },
    };

    return imap.connect(connectionConfig);
  }

  /**
   * Enumerate folders with special-use detection (RFC 6154).
   */
  async listFolders(): Promise<ReadonlyArray<MailFolder>> {
    const conn = await this.connect();
    try {
      // Use the underlying node-imap connection to get mailbox list
      // Note: getBoxes is callback-based in the type definitions, but returns a Promise in practice
      type MailboxInfo = { attributes?: string[] };
      const list = await (
        conn.imap.getBoxes as () => Promise<Record<string, MailboxInfo> | undefined>
      )();
      
      // Handle case where getBoxes returns undefined (no folders or server doesn't support LIST)
      if (!list) {
        return [];
      }
      
      const folders: MailFolder[] = [];

      for (const [path, mailbox] of Object.entries(list)) {
        const specialUse = mapImapSpecialUse(mailbox.attributes || []);
        folders.push({
          path,
          name: path.split("/").pop(),
          specialUse,
        });
      }

      return folders;
    } finally {
      conn.end();
    }
  }

  /**
   * List messages in a folder, optionally since a cursor.
   * Returns items and the next cursor to persist.
   */
  async listSince(
    folder: MailFolder,
    cursor?: SyncCursor,
  ): Promise<{ items: ReadonlyArray<MailItem>; nextCursor: SyncCursor }> {
    const conn = await this.connect();
    try {
      await conn.openBox(folder.path);

      // Get UIDVALIDITY from the opened box
      type ImapBox = { uidValidity: number; uidNext?: number };
      const box = (conn.imap as unknown as { box?: ImapBox }).box;
      if (!box) {
        throw new Error("No mailbox opened");
      }
      const uidValidity = box.uidValidity;

      // Determine search criteria
      let searchCriteria: string[] = ["ALL"];
      let uidNext = box.uidNext || 1;

      if (cursor) {
        try {
          const decoded = decodeImapCursor(cursor);
          if (decoded.uidValidity === uidValidity) {
            // Only fetch messages with UID >= UIDNEXT from the cursor
            searchCriteria = [`UID ${decoded.uidNext}:*`];
            uidNext = decoded.uidNext;
          }
        } catch {
          // Invalid cursor, do a full scan
        }
      }

      const fetchCriteria: FetchOptions = {
        bodies: "", // Don't fetch body, just headers
        struct: true, // Fetch message structure
        envelope: true, // Fetch envelope (headers)
        markSeen: false,
      };

      const results = await conn.search(searchCriteria, fetchCriteria);

      const items: MailItem[] = [];
      let maxUidNext = uidNext;

      for (const msg of results) {
        const attrs = msg.attributes;

        // Extract Message-ID from envelope
        const messageId = this.extractMessageId(msg);
        if (!messageId) {
          // Skip messages without Message-ID - they can't be idempotently tracked
          continue;
        }

        // Extract internal date
        const receivedAt =
          attrs.date?.toISOString() || new Date().toISOString();

        // Extract flags
        const keywords = mapImapFlagsToKeywords(attrs.flags || []);

        // Create sourceRef for fetching the full message
        const sourceRef = `${folder.path}:${attrs.uid}`;

        items.push({
          messageId,
          folder,
          keywords,
          receivedAt,
          size: attrs.size,
          sourceRef,
        });

        // Track max UID for cursor
        if (attrs.uid > maxUidNext) {
          maxUidNext = attrs.uid + 1;
        }
      }

      const nextCursor: SyncCursor = {
        value: encodeImapCursor(uidValidity, maxUidNext),
      };
      return { items, nextCursor };
    } finally {
      conn.end();
    }
  }

  /**
   * Fetch the full RFC822 bytes for an item.
   */
  async fetch(item: MailItem): Promise<RawMessage> {
    const conn = await this.connect();
    try {
      await conn.openBox(item.folder.path);

      const uid = this.extractUidFromSourceRef(item.sourceRef);
      const searchCriteria = [`UID ${uid}`];
      const fetchCriteria: FetchOptions = {
        bodies: "",
        markSeen: false,
      };

      const results = await conn.search(searchCriteria, fetchCriteria);

      if (results.length === 0) {
        throw new Error(`Message not found: ${item.sourceRef}`);
      }

      const msg = results[0]!;

      // Get the raw message body using getPartData
      const rfc822 = await conn.getPartData(msg, { which: "TEXT", part: 0 });

      // Ensure we have a Buffer
      const rfc822Buffer = Buffer.isBuffer(rfc822)
        ? rfc822
        : Buffer.from(rfc822 as string);

      return {
        item,
        rfc822: rfc822Buffer,
      };
    } finally {
      conn.end();
    }
  }

  /**
   * Extract Message-ID from parsed headers.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractMessageId(msg: any): string | null {
    // Try to get from envelope first (fetched with envelope: true)
    if (msg.envelope?.messageId) {
      const messageId = msg.envelope.messageId;
      // Ensure it has angle brackets
      if (messageId.startsWith("<") && messageId.endsWith(">")) {
        return messageId;
      }
      // Add angle brackets if missing
      return `<${messageId}>`;
    }
    return null;
  }

  /**
   * Extract UID from sourceRef (format: "folder:uid").
   */
  private extractUidFromSourceRef(sourceRef: string): number {
    const parts = sourceRef.split(":");
    const uidStr = parts[parts.length - 1];
    const uid = parseInt(uidStr || "0", 10);
    return isNaN(uid) ? 0 : uid;
  }
}
