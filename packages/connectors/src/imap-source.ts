// Copyright 2026 OpenHands Agent (Apache-2.0)
// IMAP source connector for O365 (XOAUTH2) and generic IMAP (LOGIN).
// Supports RFC 6154 special-use folder detection and incremental listing via UIDVALIDITY/UIDNEXT.
// T2 from workplan 0001-first-slice-jmap-mail.

import imap, { ImapSimple } from "imap-simple";
import type { SourceConnector, SyncCursor, TokenProvider } from "@openmig/shared";
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
 * Extended configuration for IMAP connection with TokenProvider support.
 */
export interface ImapSourceConfigWithTokenProvider extends ImapSourceConfig {
  tokenProvider?: TokenProvider;
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
  private readonly config: ImapSourceConfigWithTokenProvider;
  private readonly tokenProvider?: TokenProvider;

  constructor(config: ImapSourceConfigWithTokenProvider) {
    this.config = config;
    this.tokenProvider = config.tokenProvider;
  }

  /**
   * Connect to the IMAP server and return a connection.
   */
  async connect(): Promise<ImapSimple> {
    // Get access token from TokenProvider if available
    let accessToken: string | undefined = this.config.auth.accessToken;
    
    if (this.tokenProvider && this.config.authType === "XOAUTH2") {
      const token = await this.tokenProvider.getToken();
      accessToken = token.accessToken;
    }

    const connectionConfig: imap.ImapSimpleOptions = {
      imap: {
        user: this.config.auth.user,
        password: this.config.auth.password ?? "",
        xoauth2:
          this.config.authType === "XOAUTH2"
            ? accessToken
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
        conn.imap.getBoxes as () => Promise<Record<string, MailboxInfo>>
      )();

      // Handle case where getBoxes returns undefined - this can happen with some IMAP servers
      // that don't include INBOX in the LIST response or use a different response format.
      // In this case, we'll try to open INBOX directly and include it in the folder list.
      if (!list) {
        
        try {
          await conn.openBox('INBOX');
          
          // Return INBOX as the only folder
          return [{
            path: 'INBOX',
            name: 'INBOX',
            specialUse: 'inbox' as SpecialUse,
          }];
        } catch (openErr) {
          throw new Error(
            'IMAP getBoxes() returned undefined and INBOX cannot be opened. ' +
            'This indicates a server-side issue or missing account configuration.',
            { cause: openErr }
          );
        }
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
    } catch (error) {
      // Check if this is an authentication error and we have a token provider
      if (this.isAuthError(error) && this.tokenProvider) {
        // Force refresh the token and retry once
        await this.tokenProvider.refresh();
        const conn = await this.connect();
        try {
          type MailboxInfo = { attributes?: string[] };
          const list = await (
            conn.imap.getBoxes as () => Promise<Record<string, MailboxInfo>>
          )();

          if (!list) {
            throw new Error(
              'IMAP getBoxes() returned undefined after token refresh. ' +
              'This indicates a server-side issue or missing account configuration.',
              { cause: error }
            );
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
      throw error;
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
      return await this.listSinceInternal(conn, folder, cursor);
    } catch (error) {
      // Check if this is an authentication error and we have a token provider
      if (this.isAuthError(error) && this.tokenProvider) {
        // Force refresh the token and retry once
        await this.tokenProvider.refresh();
        const conn = await this.connect();
        try {
          return await this.listSinceInternal(conn, folder, cursor);
        } finally {
          conn.end();
        }
      }
      throw error;
    } finally {
      conn.end();
    }
  }

  /**
   * Internal method to list messages (without reconnection logic).
   */
  private async listSinceInternal(
    conn: ImapSimple,
    folder: MailFolder,
    cursor?: SyncCursor,
  ): Promise<{ items: ReadonlyArray<MailItem>; nextCursor: SyncCursor }> {
    await conn.openBox(folder.path);

      // Get UIDVALIDITY from the opened box
      // Note: node-imap uses _box (with underscore) internally
      type ImapBox = { 
        name: string;
        uidvalidity: number; 
        uidnext?: number;
        messages?: number; // Total number of messages in the mailbox
        flags: string[];
        readOnly: boolean;
      };
      const box = (conn.imap as unknown as { _box?: ImapBox })._box;
      if (!box) {
        throw new Error("No mailbox opened");
      }
      const uidValidity = box.uidvalidity;

      // Determine search criteria
      let searchCriteria: string[] = ["ALL"];
      let uidNext = box.uidnext || 1;

      if (cursor) {
        try {
          const decoded = decodeImapCursor(cursor);
          if (decoded.uidValidity === uidValidity) {
            // Only fetch messages with UID >= UIDNEXT from the cursor
            // Fetch ALL messages and filter by UID manually (more reliable than range search)
            searchCriteria = ['ALL'];
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

      // Filter results by UID if we're using a cursor
      let filteredResults = results || [];
      if (cursor) {
        try {
          const decoded = decodeImapCursor(cursor);
          if (decoded.uidValidity === uidValidity) {
            filteredResults = filteredResults.filter(msg => {
              const uid = msg.attributes?.uid;
              // Include all messages with UID >= cursor.uidNext
              return uid >= decoded.uidNext;
            });
          }
        } catch {
          // Invalid cursor, use all results
        }
      }

      const items: MailItem[] = [];
      let maxUidNext = uidNext;

      for (const msg of filteredResults) {
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
  }

  /**
   * Fetch the full RFC822 bytes for an item.
   */
  async fetch(item: MailItem): Promise<RawMessage> {
    const conn = await this.connect();
    try {
      return await this.fetchInternal(conn, item);
    } catch (error) {
      // Check if this is an authentication error and we have a token provider
      if (this.isAuthError(error) && this.tokenProvider) {
        // Force refresh the token and retry once
        await this.tokenProvider.refresh();
        const conn = await this.connect();
        try {
          return await this.fetchInternal(conn, item);
        } finally {
          conn.end();
        }
      }
      throw error;
    } finally {
      conn.end();
    }
  }

  /**
   * Internal method to fetch a message (without reconnection logic).
   */
  private async fetchInternal(
    conn: ImapSimple,
    item: MailItem,
  ): Promise<RawMessage> {
    await conn.openBox(item.folder.path);

      const uid = this.extractUidFromSourceRef(item.sourceRef);
      
      // Fetch the raw RFC822 message using the UID
      // Retry up to 3 times to handle potential race conditions where the message
      // hasn't been fully committed to the IMAP server yet
      let results: Array<{ attributes: { uid: number }; parts: Array<{ body: unknown }> }> = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        // Search for the specific UID using the correct node-imap criteria format
        // node-imap expects an array of criteria, where each criterion is either a string or an array
        // For UID search, we need to nest it: [['UID', String(uid)]]
        results = await conn.search([['UID', String(uid)]] as unknown as string[], {
          bodies: '',  // Fetch entire message body
          markSeen: false,
        });
        if (results.length > 0) {
          break;
        }
        // Small delay between retries to allow IMAP server to commit the message
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      if (results.length === 0) {
        throw new Error(`Message not found: ${item.sourceRef}`);
      }

      const msg = results[0]!;
      
      // The raw message should be in msg.parts[0].body
      if (!msg.parts || msg.parts.length === 0) {
        throw new Error(`No parts found for message: ${item.sourceRef}`);
      }
      
      const rfc822Data = msg.parts[0]?.body;
      if (!rfc822Data) {
        throw new Error(`No body found for message: ${item.sourceRef}`);
      }
      
      // Ensure we have a Buffer
      const rfc822Buffer = Buffer.isBuffer(rfc822Data)
        ? rfc822Data
        : Buffer.from(rfc822Data as string);

      return {
        item,
        rfc822: rfc822Buffer,
      };
  }

  /**
   * Extract Message-ID from parsed headers.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractMessageId(msg: any): string | null {
    // The search result structure is: { attributes: { envelope: { messageId: ... } }, parts: [...] }
    // Try to get from envelope first (fetched with envelope: true)
    const envelope = msg.attributes?.envelope || msg.envelope;
    if (envelope?.messageId) {
      const messageId = envelope.messageId;
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

  /**
   * Check if an error is an authentication error.
   * IMAP authentication errors typically contain specific error messages.
   */
  private isAuthError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    const message = error.message.toLowerCase();
    // Common IMAP authentication error patterns
    return (
      message.includes("authentication failed") ||
      message.includes("unauthorized") ||
      message.includes("xoauth2") ||
      message.includes("invalid token") ||
      message.includes("token expired") ||
      message.includes("401")
    );
  }
}
