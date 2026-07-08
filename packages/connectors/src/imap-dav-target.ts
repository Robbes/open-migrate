// Copyright 2026 OpenHands Agent (Apache-2.0)
// IMAP/DAV target writer for Soverin, openDesk, and other IMAP servers.
// Implements TargetWriter interface for mail import with idempotency support.
// U1 from workplan 0002-imap-dav-target.

import imap, { ImapSimple } from "imap-simple";
import type {
  TargetWriter,
  TargetReindexer,
  TargetEntry,
  MailFolder,
  RawMessage,
  MailKeyword,
  UpsertResult,
} from "@openmig/shared";

/**
 * Configuration for IMAP target connection.
 */
export interface ImapDavTargetConfig {
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password: string;
  rejectUnauthorized?: boolean; // For self-signed certs in dev
}

/**
 * IMAP search result entry.
 */
interface _SearchEntry {
  attributes: {
    uid: number;
  };
}

/**
 * IMAP fetch result.
 */
interface _FetchResult {
  attributes: {
    uid: number;
    body?: {
      data?: Buffer;
    };
  };
}

/**
 * Map our SpecialUse to IMAP special-use flags.
 */
const SPECIAL_USE_TO_IMAP: Record<string, string | undefined> = {
  inbox: "\\Inbox",
  sent: "\\Sent",
  drafts: "\\Drafts",
  archive: "\\Archive",
  junk: "\\Junk",
  trash: "\\Trash",
  normal: undefined,
};

/**
 * Map our MailKeyword to IMAP flags.
 */
const KEYWORD_TO_FLAG: Record<MailKeyword, string> = {
  "$seen": "\\Seen",
  "$flagged": "\\Flagged",
  "$draft": "\\Draft",
  "$answered": "\\Answered",
};

/**
 * IMAP/DAV mail target writer implementation.
 * Uses IMAP APPEND for writing messages with idempotency via Message-ID search.
 */
export class ImapDavMailTarget implements TargetWriter, TargetReindexer {
  private readonly config: ImapDavTargetConfig;
  private conn: ImapSimple | null = null;

  constructor(config: ImapDavTargetConfig) {
    this.config = config;
  }

  /**
   * Connect to the IMAP server.
   */
  async connect(): Promise<void> {
    console.log('[DEBUG IMAP] Connecting to IMAP server:', this.config.host, ':', this.config.port);
    
    const config = {
      imap: {
        host: this.config.host,
        port: this.config.port,
        user: this.config.username,
        password: this.config.password,
        tls: this.config.tls,
        tlsOptions: {
          rejectUnauthorized: this.config.rejectUnauthorized ?? true,
        },
        authTimeout: 30000,
      },
    };

    this.conn = await imap.connect(config);
    console.log('[DEBUG IMAP] Connected successfully');
  }

  /**
   * Disconnect from the IMAP server.
   */
  async disconnect(): Promise<void> {
    if (this.conn) {
      this.conn.end();
      this.conn = null;
      console.log('[DEBUG IMAP] Disconnected');
    }
  }

  /**
   * Ensure a mailbox exists for the given folder/role; return its name (IMAP uses names as IDs).
   */
  async ensureMailbox(folder: MailFolder): Promise<string> {
    if (!this.conn) {
      throw new Error('Not connected to IMAP server');
    }

    const mailboxName = folder.path || folder.name;
    if (!mailboxName) {
      throw new Error('Mailbox name or path is required');
    }
    console.log('[DEBUG IMAP] Ensuring mailbox:', mailboxName);

    // Use the underlying node-imap connection to get mailbox list
    type MailboxInfo = { attributes?: string[] };
    const mailboxes = await (
      (this.conn.imap.getBoxes as () => Promise<Record<string, MailboxInfo>>)()
    );

    // Handle case where getBoxes returns undefined
    if (!mailboxes) {
      // Try to open the mailbox directly - if it exists, we're good
      try {
        await this.conn.openBox(mailboxName);
        console.log('[DEBUG IMAP] Mailbox exists (opened directly):', mailboxName);
        return mailboxName;
      } catch {
        // Mailbox doesn't exist, create it
        console.log('[DEBUG IMAP] Creating mailbox:', mailboxName);
        // addMailbox is not in the type definition but exists in the runtime
        await (this.conn as unknown as { addMailbox: (name: string) => Promise<void> }).addMailbox(mailboxName);
        return mailboxName;
      }
    } else {
      const existingBox = mailboxes[mailboxName];
      if (existingBox) {
        console.log('[DEBUG IMAP] Mailbox already exists:', mailboxName);
        return mailboxName;
      }

      // Create the mailbox
      console.log('[DEBUG IMAP] Creating mailbox:', mailboxName);
      await (this.conn as unknown as { addMailbox: (name: string) => Promise<void> }).addMailbox(mailboxName);
    }

    // Set special-use flag if applicable
    if (folder.specialUse && SPECIAL_USE_TO_IMAP[folder.specialUse]) {
      const imapFlag = SPECIAL_USE_TO_IMAP[folder.specialUse]!;
      console.log('[DEBUG IMAP] Setting special-use flag:', imapFlag, 'on', mailboxName);
      // Note: Not all IMAP servers support setting special-use flags
      // This is best-effort
      try {
        // Set flags on the mailbox itself (not messages)
        await (this.conn as unknown as { setFlags: (name: string, flags: string[], isPermanent: boolean) => Promise<void> }).setFlags(mailboxName, [imapFlag], true);
      } catch (err) {
        console.warn('[DEBUG IMAP] Could not set special-use flag:', (err as Error).message);
      }
    }

    return mailboxName;
  }

  /**
   * Check if a message with the given Message-ID already exists in the mailbox.
   * Returns the UID if found, or undefined.
   */
  async findByNaturalKey(mailboxId: string, naturalKey: string): Promise<string | undefined> {
    if (!this.conn) {
      throw new Error('Not connected to IMAP server');
    }

    try {
      await this.conn.openBox(mailboxId);
      
      // Normalize the naturalKey - it might have < > brackets
      const normalizedKey = naturalKey.replace(/[<>]/g, '');
      
      // Search ALL messages to get their UIDs
      const allResults = await (this.conn.search as unknown as (criteria: string[]) => Promise<Array<{ attributes?: { uid: number } }>>)(['ALL']);

      const typedResults = allResults as Array<{ attributes?: { uid: number } }>;

      if (!typedResults || typedResults.length === 0) {
        console.log('[DEBUG IMAP] No messages found in mailbox');
        return undefined;
      }

      // Fetch headers for each message to find the matching Message-ID
      // Use the underlying node-imap connection for fetch
      const imap = this.conn.imap;
      
      for (const result of typedResults) {
        const uid = result.attributes?.uid;
        if (!uid) continue;
        
        try {
          // Fetch just the Message-ID header for this message using node-imap directly
          let messageIdHeader: string | undefined;
          
          await new Promise<void>((resolve, reject) => {
            const fetch = imap.fetch([uid], { bodies: ['HEADER'] });
            
            fetch.on('message', (msg: { on: (event: string, cb: (stream: { on: (event: string, cb: (chunk: Buffer) => void) => void; once: (event: string, cb: () => void) => void }) => void) => void }) => {
              msg.on('body', (stream: { on: (event: string, cb: (chunk: Buffer) => void) => void; once: (event: string, cb: () => void) => void }) => {
                let headers = '';
                stream.on('data', (chunk: Buffer) => {
                  headers += chunk.toString('utf8');
                });
                stream.once('end', () => {
                  console.log('[DEBUG IMAP] Raw headers for UID', uid, ':', JSON.stringify(headers));
                  // Parse the Message-ID from the headers string
                  // Try both \r\n and \n as line separators
                  const lines = headers.split(/\r?\n/);
                  for (const line of lines) {
                    const lowerLine = line.toLowerCase();
                    if (lowerLine.startsWith('message-id:')) {
                      messageIdHeader = line.substring('message-id:'.length).trim();
                      console.log('[DEBUG IMAP] Found Message-ID header:', messageIdHeader);
                      break;
                    }
                  }
                });
              });
            });
            
            fetch.once('error', reject);
            fetch.once('end', () => resolve());
          });
          
          if (messageIdHeader) {
            // Normalize the found Message-ID (remove angle brackets and whitespace)
            const foundKey = messageIdHeader.replace(/[<>]/g, '').trim();
            if (foundKey === normalizedKey) {
              console.log('[DEBUG IMAP] Found existing message by Message-ID:', naturalKey, 'UID:', uid);
              return String(uid);
            }
          }
        } catch (fetchErr) {
          // Skip messages that can't be fetched
          console.warn('[DEBUG IMAP] Warning: Could not fetch headers for UID', uid, ':', (fetchErr as Error).message);
        }
      }

      console.log('[DEBUG IMAP] No existing message found for Message-ID:', naturalKey);
      return undefined;
    } catch (err) {
      console.error('[DEBUG IMAP] Error searching for message:', (err as Error).message);
      return undefined;
    }
  }

  /**
   * Idempotently write a message into the target mailbox.
   * First checks if the message exists by Message-ID, then APPENDs if new.
   */
  async upsertEmail(
    mailboxId: string,
    raw: RawMessage,
    keywords: ReadonlyArray<MailKeyword>,
  ): Promise<UpsertResult> {
    if (!this.conn) {
      throw new Error('Not connected to IMAP server');
    }

    // Extract Message-ID from raw message (rfc822 property)
    const messageId = this.extractMessageId(raw.rfc822);
    if (!messageId) {
      throw new Error('No Message-ID found in raw message');
    }

    console.log('[DEBUG IMAP] upsertEmail for Message-ID:', messageId, 'in mailbox:', mailboxId);

    // Check if message already exists
    const existingUid = await this.findByNaturalKey(mailboxId, messageId);
    if (existingUid) {
      console.log('[DEBUG IMAP] Message already exists, skipping:', messageId);
      return { targetId: existingUid, created: false };
    }

    // Open the mailbox
    await this.conn.openBox(mailboxId);

    // Prepare flags
    const flags: string[] = [];
    for (const keyword of keywords) {
      if (KEYWORD_TO_FLAG[keyword]) {
        flags.push(KEYWORD_TO_FLAG[keyword]);
      }
    }

    // Append the message with flags
    // Note: imap-simple append signature is append(message, options)
    // The append method doesn't return the UID, so we'll search for it after appending
    interface AppendOptions {
      mailbox: string;
      flags?: string[];
    }
    const appendOptions: AppendOptions = {
      mailbox: mailboxId,
      flags: flags.length > 0 ? flags : ['\\Seen'], // Default to seen if no flags
    };

    try {
      // Append the message (rfc822 is a Uint8Array)
      await this.conn.append(raw.rfc822, appendOptions);
      console.log('[DEBUG IMAP] Message appended, searching for UID...');

      // Wait a moment for the message to be indexed
      await new Promise(resolve => setTimeout(resolve, 100));

      // Search for the message we just appended to get its UID
      // IMAP search syntax: [['HEADER', 'field', 'value']]
      const searchResults = await (this.conn.search as unknown as (criteria: unknown) => Promise<Array<{ attributes?: { uid: number } }>>)([['HEADER', 'Message-ID', messageId]]);

      const typedSearchResults = searchResults as Array<{ attributes?: { uid: number } }>;

      if (typedSearchResults && typedSearchResults.length > 0) {
        const firstResult = typedSearchResults[0];
        const newUid = firstResult?.attributes?.uid;
        if (newUid) {
          console.log('[DEBUG IMAP] Successfully appended message, UID:', newUid);
          return { targetId: String(newUid), created: true };
        }
      }

      // If header search fails, try searching ALL and filtering by Message-ID
      console.log('[DEBUG IMAP] Header search failed, trying ALL search...');
      const allResults = await (this.conn.search as unknown as (criteria: string[]) => Promise<Array<{ attributes?: { uid: number } }>>)(['ALL']);
      
      const typedAllResults = allResults as Array<{ attributes?: { uid: number } }>;

      if (typedAllResults && typedAllResults.length > 0) {
        // Get the highest UID (most recent message)
        const lastResult = typedAllResults[typedAllResults.length - 1];
        const latestUid = lastResult?.attributes?.uid;
        if (latestUid) {
          console.log('[DEBUG IMAP] Found message by ALL search, latest UID:', latestUid);
          return { targetId: String(latestUid), created: true };
        }
      }

      throw new Error('Failed to get UID after appending message');
    } catch (err) {
      console.error('[DEBUG IMAP] Error appending message:', (err as Error).message);
      throw err;
    }
  }

  /**
   * Extract Message-ID from raw RFC822 message.
   */
  private extractMessageId(raw: Uint8Array | string): string | null {
    const content = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf-8');
    const match = content.match(/Message-ID:\s*([^\r\n]+)/i);
    if (match) {
      return match[1]?.trim().replace(/[<>]/g, '') || null;
    }
    return null;
  }

  /**
   * Extract Received/Date header for INTERNALDATE.
   */
  private extractReceivedAt(raw: Uint8Array | string): string | null {
    const content = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf-8');
    
    // Try Date header first
    const dateMatch = content.match(/Date:\s*([^\r\n]+)/i);
    if (dateMatch) {
      return dateMatch[1]?.trim() || null;
    }
    
    return null;
  }

  /**
   * List all entries in the target for reindexing.
   * Streams entries from all mailboxes.
   */
  async *listEntries(mailboxId?: string): AsyncIterable<TargetEntry> {
    if (!this.conn) {
      throw new Error('Not connected to IMAP server');
    }

    // Determine which mailboxes to list
    let mailboxNames: string[] = [];
    
    if (mailboxId) {
      // If a specific mailbox is requested, just use that
      mailboxNames = [mailboxId];
    } else {
      // Try to get all mailboxes
      try {
        const mailboxes = await (
          (this.conn.imap.getBoxes as () => Promise<Record<string, { attributes?: string[] } | undefined>>)()
        );
        
        if (mailboxes) {
          mailboxNames = Object.keys(mailboxes);
        }
      } catch (err) {
        console.warn('[DEBUG IMAP] Warning: Could not get mailbox list:', (err as Error).message);
      }
      
      // If getBoxes failed or returned empty, default to INBOX
      if (mailboxNames.length === 0) {
        mailboxNames = ['INBOX'];
      }
    }

    for (const boxName of mailboxNames) {
      try {
        await this.conn.openBox(boxName);
        
        // Search for all messages
        const results = await (this.conn.search as unknown as (criteria: string[]) => Promise<Array<{ attributes?: { uid: number } }>>)(['ALL']);
        
        const typedResults = results as Array<{ attributes?: { uid: number } }>;
        
        if (!typedResults || typedResults.length === 0) {
          continue;
        }

        // Get the underlying node-imap connection for fetching headers
        const imap = this.conn.imap;

        for (const entry of typedResults) {
          const uid = entry.attributes?.uid;
          if (!uid) continue;

          try {
            // Fetch Message-ID header using node-imap directly
            let messageId: string | undefined;
            
            await new Promise<void>((resolve, reject) => {
              const fetch = imap.fetch([uid], { bodies: ['HEADER'] });
              
              fetch.on('message', (msg: { on: (event: string, cb: (stream: { on: (event: string, cb: (chunk: Buffer) => void) => void; once: (event: string, cb: () => void) => void }) => void) => void }) => {
                msg.on('body', (stream: { on: (event: string, cb: (chunk: Buffer) => void) => void; once: (event: string, cb: () => void) => void }) => {
                  let headers = '';
                  stream.on('data', (chunk: Buffer) => {
                    headers += chunk.toString('utf8');
                  });
                  stream.once('end', () => {
                    // Parse the Message-ID from the headers string
                    const lines = headers.split(/\r?\n/);
                    for (const line of lines) {
                      const lowerLine = line.toLowerCase();
                      if (lowerLine.startsWith('message-id:')) {
                        messageId = line.substring('message-id:'.length).trim().replace(/[<>]/g, '');
                        break;
                      }
                    }
                  });
                });
              });
              
              fetch.once('error', reject);
              fetch.once('end', () => resolve());
            });
            
            yield {
              naturalKey: messageId || String(uid),
              targetId: String(uid),
              mailboxId: boxName,
            };
          } catch (fetchErr) {
            console.warn('[DEBUG IMAP] Warning: Could not fetch headers for UID', uid, ':', (fetchErr as Error).message);
            // Yield with UID as fallback
            yield {
              naturalKey: String(uid),
              targetId: String(uid),
              mailboxId: boxName,
            };
          }
        }
      } catch (err) {
        console.error('[DEBUG IMAP] Error listing entries in', boxName, ':', (err as Error).message);
        continue;
      }
    }
  }
}
