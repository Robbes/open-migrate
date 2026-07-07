// Copyright 2026 OpenHands Agent (Apache-2.0)
// JMAP target writer for Stalwart and other JMAP servers.
// Implements TargetWriter interface for mail import with idempotency support.
// T3 from workplan 0001-first-slice-jmap-mail.

import JamClient from "jmap-jam";
import type {
  TargetWriter,
  MailFolder,
  RawMessage,
  MailKeyword,
  UpsertResult,
} from "@openmig/shared";

/**
 * JMAP Mailbox query response type.
 */
interface MailboxQueryResponse {
  type: string;
  accountId: string;
  list: Array<{
    id: string;
    name: string;
    path?: string;
    role?: string;
  }>;
  notFound?: string[];
}

/**
 * JMAP Mailbox object.
 */
interface Mailbox {
  id: string;
  name: string;
  path?: string;
  role?: string;
  type?: string;
}

/**
 * JMAP Mailbox set response type.
 */
interface MailboxSetResponse {
  type: string;
  accountId: string;
  created?: Record<string, { id: string }>;
  notCreated?: Record<string, { type: string; description: string }>;
}

/**
 * JMAP Mailbox get response type.
 */
interface MailboxGetResponse {
  type: string;
  accountId: string;
  list: Array<{
    id: string;
    name: string;
    path?: string;
    role?: string;
  }>;
  notFound?: string[];
}

/**
 * JMAP Email/import response type.
 */
interface EmailImportResponse {
  type: string;
  accountId: string;
  created?: Record<string, { id: string; blobId: string }>;
  notCreated?: Record<string, { type: string; description: string }>;
}

/**
 * JMAP Email/query response type.
 */
interface EmailQueryResponse {
  type: string;
  accountId: string;
  ids: string[];
  total: number;
  queryState?: string;
}

/**
 * Configuration for JMAP connection.
 */
export interface JmapTargetConfig {
  baseUrl: string;
  username: string;
  password: string;
  /** Optional well-known discovery path (default: /.well-known/jmap) */
  wellKnownPath?: string;
}

/**
 * Special-use role mapping from our internal type to JMAP roles.
 */
const SPECIAL_USE_ROLE_MAP: Record<
  string,
  "inbox" | "sent" | "drafts" | "archive" | "junk" | "trash" | undefined
> = {
  inbox: "inbox",
  sent: "sent",
  drafts: "drafts",
  archive: "archive",
  junk: "junk",
  trash: "trash",
  normal: undefined,
};

/**
 * JMAP target writer implementation.
 */
export class JmapTargetWriter implements TargetWriter {
  private readonly config: JmapTargetConfig;
  private client: JamClient | null = null;
  private accountId: string | null = null;
  private apiUrl: string | null = null;
  private authHeader: string | null = null;

  constructor(config: JmapTargetConfig) {
    this.config = config;
  }

  /**
   * Connect to the JMAP server and discover the session.
   */
  async connect(): Promise<void> {
    console.log('[DEBUG JMAP] Connecting to JMAP server:', this.config.baseUrl);
    // Use basic auth - JMAP typically uses bearer tokens
    this.authHeader = `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString("base64")}`;

    const sessionUrl = `${this.config.baseUrl}${this.config.wellKnownPath || "/.well-known/jmap"}`;
    console.log('[DEBUG JMAP] Session URL:', sessionUrl);

    // Load the session directly
    const session = await JamClient.loadSession(sessionUrl, this.authHeader);
    console.log('[DEBUG JMAP] Session primaryAccounts:', JSON.stringify(session.primaryAccounts));
    console.log('[DEBUG JMAP] Session apiUrl (may be incorrect):', session.apiUrl);
    
    // Use the base URL + /jmap as the API URL
    // Stalwart's JMAP API is typically at /jmap endpoint
    this.apiUrl = this.config.baseUrl.endsWith('/') 
      ? `${this.config.baseUrl}jmap` 
      : `${this.config.baseUrl}/jmap`;
    console.log('[DEBUG JMAP] Using API URL:', this.apiUrl);
    
    // Stalwart uses "b" as the account ID for the primary account
    this.accountId = session.primaryAccounts?.['urn:ietf:params:jmap:mail'] || 'b';
    console.log('[DEBUG JMAP] Using account ID:', this.accountId);
    
    // Create the client with the session
    this.client = new JamClient({
      bearerToken: this.authHeader,
      sessionUrl,
    });
  }

  /**
   * Make a JMAP API request using the stored apiUrl.
   */
  private async apiRequest<T>(method: string, args: Record<string, unknown>): Promise<T> {
    if (!this.apiUrl || !this.authHeader) {
      throw new Error("Not connected to JMAP server");
    }

    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': this.authHeader,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
        methodCalls: [[method, args, 'c1']],
      }),
    });

    if (!response.ok) {
      const error = await response.json() as { type?: string; description?: string };
      throw new Error(`JMAP API error: ${error.type ?? 'unknown'} - ${error.description ?? 'no description'}`);
    }

    const result = await response.json() as { methodResponses?: Array<unknown[]> };
    const firstResponse = result.methodResponses?.[0];
    if (!firstResponse || !Array.isArray(firstResponse) || firstResponse.length < 2) {
      throw new Error('Invalid JMAP response format');
    }
    return firstResponse[1] as T;
  }

  /**
   * Upload a blob (email message) to the JMAP server.
   */
  private async uploadBlob(accountId: string, blob: Blob): Promise<{ blobId: string }> {
    if (!this.apiUrl || !this.authHeader) {
      throw new Error("Not connected to JMAP server");
    }

    // Get the upload URL from the session
    const session = await JamClient.loadSession(
      `${this.config.baseUrl}${this.config.wellKnownPath || "/.well-known/jmap"}`,
      this.authHeader
    );
    
    console.log('[DEBUG JMAP] Session uploadUrl:', session.uploadUrl);
    
    // Stalwart often returns incorrect uploadUrl (e.g., https://localhost)
    // Use the base URL instead and construct the upload endpoint manually
    // The upload endpoint is typically at {baseUrl}/upload/{accountId}
    const uploadUrl = `${this.apiUrl}/upload/${accountId}`;
    console.log('[DEBUG JMAP] Using upload URL:', uploadUrl);

    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': this.authHeader,
        'Content-Type': 'message/rfc822',
      },
      body: blob,
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('[DEBUG JMAP] Blob upload failed:', error);
      throw new Error(`Blob upload failed: ${error}`);
    }

    const result = await response.json() as { blobId: string };
    console.log('[DEBUG JMAP] Blob upload response:', JSON.stringify(result));
    return result;
  }

  /**
   * Ensure a mailbox exists, creating it if necessary.
   * Returns the mailbox ID.
   */
  async ensureMailbox(folder: MailFolder): Promise<string> {
    if (!this.apiUrl || !this.authHeader || !this.accountId) {
      throw new Error("Not connected to JMAP server");
    }

    console.log('[DEBUG JMAP] ensureMailbox called with folder:', JSON.stringify(folder));
    
    // Query for existing mailboxes
    const queryResponse = await this.apiRequest<MailboxQueryResponse>('Mailbox/query', {
      accountId: this.accountId,
      filter: { name: folder.name || folder.path },
    });

    console.log('[DEBUG JMAP] Mailbox query response:', JSON.stringify(queryResponse));

    // JMAP Mailbox/query returns IDs, we need to get the actual objects
    const ids: string[] = (queryResponse as { ids?: string[] }).ids || [];
    
    if (ids.length === 0) {
      // No mailboxes found, create one
      return await this.createMailbox(folder);
    }

    // Get the mailbox details for the found IDs
    const getResponse = await this.apiRequest<MailboxGetResponse>('Mailbox/get', {
      accountId: this.accountId,
      ids: ids,
    });

    console.log('[DEBUG JMAP] Mailbox get response:', JSON.stringify(getResponse));

    // JMAP Mailbox/get returns a 'list' property containing the mailbox objects
    const mailboxes = (getResponse as { list?: Mailbox[] }).list || [];
    console.log('[DEBUG JMAP] Mailboxes found:', mailboxes.length);

    // Look for existing mailbox with matching path or role (case-insensitive for name)
    const folderName = folder.name?.toLowerCase() || folder.path?.toLowerCase();
    const folderPath = folder.path?.toLowerCase();
    
    const existing = mailboxes.find(
      (m: { name: string; path?: string }) => 
        m.name.toLowerCase() === folderName || 
        (m.path && m.path.toLowerCase() === folderPath),
    );
    console.log('[DEBUG JMAP] Existing mailbox:', existing);

    if (existing) {
      return existing.id;
    }

    // No matching mailbox found, create one
    return await this.createMailbox(folder);
  }

  /**
   * Create a new mailbox.
   */
  private async createMailbox(folder: MailFolder): Promise<string> {
    const role = SPECIAL_USE_ROLE_MAP[folder.specialUse];

    const mailboxSetResponse = await this.apiRequest<MailboxSetResponse>('Mailbox/set', {
      accountId: this.accountId!,
      create: {
        "0": {
          name: folder.name || folder.path,
          role,
          sortOrder: 0,
        },
      },
    });

    console.log('[DEBUG JMAP] Mailbox set response:', JSON.stringify(mailboxSetResponse));
    
    const mailboxResponse = mailboxSetResponse as {
      created?: Record<string, { id: string }>;
      notCreated?: Record<string, { type: string; description: string }>;
    };
    const created = mailboxResponse.created || {};
    const createdId = Object.keys(created)[0];
    
    if (!createdId) {
      // Check if it already exists
      const notCreated = mailboxResponse.notCreated || {};
      if (Object.keys(notCreated).length > 0) {
        const errors = Object.values(notCreated);
        if (errors.length > 0 && errors[0]?.type === 'alreadyExists') {
          // Extract existingId from the description - format: "existingId: \"a\""
          const match = errors[0].description.match(/existingId:\s*"([^"]+)"/);
          if (match && match[1]) {
            console.log('[DEBUG JMAP] Mailbox already exists with ID:', match[1]);
            return match[1];
          }
          // Fallback: try to find the ID in the description
          const altMatch = errors[0].description.match(/'([a-z0-9]+)'/i);
          if (altMatch && altMatch[1]) {
            console.log('[DEBUG JMAP] Mailbox already exists with ID (alt):', altMatch[1]);
            return altMatch[1];
          }
        }
      }
      console.error('[DEBUG JMAP] Mailbox not created, notCreated:', JSON.stringify(mailboxResponse.notCreated));
      throw new Error("Failed to create mailbox: " + JSON.stringify(mailboxResponse.notCreated));
    }

    return createdId;
  }

  /**
   * Check if an email with the given Message-ID already exists in the mailbox.
   */
  async findByNaturalKey(
    mailboxId: string,
    naturalKey: string,
  ): Promise<string | undefined> {
    if (!this.accountId) {
      throw new Error("Not connected to JMAP server");
    }

    try {
      // Query emails by Message-ID header
      // JMAP header filter format: [headerName, headerValue]
      console.log('[DEBUG JMAP] findByNaturalKey looking for Message-ID:', naturalKey);
      
      const response = await this.apiRequest<EmailQueryResponse>('Email/query', {
        accountId: this.accountId,
        filter: {
          header: ["Message-ID", naturalKey],
        },
        properties: ["id"],
      });

      console.log('[DEBUG JMAP] findByNaturalKey response:', JSON.stringify(response));
      
      const ids = (response as { ids?: string[] }).ids || [];
      const found = ids.length > 0 ? ids[0] : undefined;
      console.log('[DEBUG JMAP] findByNaturalKey found:', found);
      return found;
    } catch (err) {
      console.log('[DEBUG JMAP] findByNaturalKey error:', err);
      // Query might not be supported; return undefined
      return undefined;
    }
  }

  /**
   * Idempotently write a message into the target mailbox.
   * 
   * Uses the Email/import method (RFC 8621 §4.4.2) which is the recommended
   * approach for importing raw RFC822 messages into JMAP servers like Stalwart.
   * 
   * Process:
   * 1. Upload the raw RFC822 message as a blob
   * 2. Use Email/import to parse and create the email from the blob
   * 
   * This avoids the complexity of manually constructing EmailBodyPart objects
   * and ensures proper parsing of the raw message by the server.
   * 
   * @see https://www.rfc-editor.org/rfc/rfc8621.html#section-4.4.2
   */
  async upsertEmail(
    mailboxId: string,
    raw: RawMessage,
    keywords: ReadonlyArray<MailKeyword>,
  ): Promise<UpsertResult> {
    if (!this.client || !this.accountId) {
      throw new Error("Not connected to JMAP server");
    }

    // Extract Message-ID from raw RFC822
    const messageId = this.extractMessageIdFromRfc822(raw.rfc822);
    console.log('[DEBUG JMAP] upsertEmail messageId:', messageId);

    // Check if email already exists
    if (messageId) {
      const existingId = await this.findByNaturalKey(mailboxId, messageId);
      if (existingId) {
        // Email already exists - idempotent no-op
        return { targetId: existingId, created: false };
      }
    } else {
      console.log('[DEBUG JMAP] No Message-ID found, skipping lookup');
    }

    // Parse headers from raw message to get receivedAt date
    const headers = this.parseRfc822Headers(raw.rfc822);

    // Step 1: Upload the raw RFC822 message as a blob
    // The Blob/upload endpoint expects BodyInit (Blob, File, ArrayBuffer, string, etc.)
    // Note: blobFileName is computed but not used - uploadBlob doesn't require a filename
    
    // Convert Uint8Array to Blob for upload
    // Pass Uint8Array directly - it's a valid BlobPart
    const arrayBuffer = raw.rfc822.buffer.slice(
      raw.rfc822.byteOffset,
      raw.rfc822.byteOffset + raw.rfc822.byteLength
    ) as ArrayBuffer;
    const blob = new Blob([arrayBuffer], { type: 'message/rfc822' });
    
    const blobUploadResponse = await this.uploadBlob(
      this.accountId!,
      blob
    );

    if (!blobUploadResponse.blobId) {
      throw new Error("Failed to upload blob: no blobId returned");
    }

    const blobId = blobUploadResponse.blobId;

    console.log('[DEBUG JMAP] Importing email with mailboxId:', mailboxId);
    
    // Parse the date from headers and convert to ISO 8601 UTC format for JMAP
    let receivedAt: string;
    if (headers.date) {
      const parsedDate = new Date(headers.date);
      receivedAt = !isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : new Date().toISOString();
    } else {
      receivedAt = new Date().toISOString();
    }
    console.log('[DEBUG JMAP] receivedAt:', receivedAt);
    
    // Step 2: Import the email from the blob using Email/import
    const importResponse = await this.apiRequest<EmailImportResponse>('Email/import', {
      accountId: this.accountId,
      emails: {
        "0": {
          blobId,
          mailboxIds: { [mailboxId]: true },
          keywords: this.mapKeywords(keywords),
          receivedAt,
        },
      },
    });

    console.log('[DEBUG JMAP] Email import response:', JSON.stringify(importResponse));

    // Check if import was successful
    if (importResponse.notCreated && Object.keys(importResponse.notCreated).length > 0) {
      const error = importResponse.notCreated["0"];
      throw new Error(
        `Failed to import email: ${error?.type} - ${error?.description || 'Unknown error'}`
      );
    }

    if (!importResponse.created || Object.keys(importResponse.created).length === 0) {
      throw new Error("Failed to create email: no created ID in response");
    }

    const createdId = Object.keys(importResponse.created)[0]!;
    console.log('[DEBUG JMAP] upsertEmail returning created:', true, 'with targetId:', createdId);
    return { targetId: createdId, created: true };
  }

  /**
   * Map our keywords to JMAP keywords.
   */
  private mapKeywords(
    keywords: ReadonlyArray<MailKeyword>,
  ): Record<string, boolean> {
    const result: Record<string, boolean> = {};
    for (const keyword of keywords) {
      result[kindToJmapKeyword(keyword)] = true;
    }
    return result;
  }

  /**
   * Extract Message-ID from raw RFC822 message.
   */
  private extractMessageIdFromRfc822(rfc822: Uint8Array): string | null {
    console.log('[DEBUG JMAP] extractMessageIdFromRfc822 raw length:', rfc822.length);
    const headers = this.parseRfc822Headers(rfc822);
    console.log('[DEBUG JMAP] extractMessageIdFromRfc822 headers:', JSON.stringify(headers));
    const messageId = headers["message-id"] || null;
    console.log('[DEBUG JMAP] extractMessageIdFromRfc822 messageId:', messageId);
    return messageId;
  }

  /**
   * Parse RFC822 headers from raw message.
   */
  private parseRfc822Headers(rfc822: Uint8Array): Record<string, string> {
    const headers: Record<string, string> = {};
    const headerText = new TextDecoder().decode(rfc822);
    
    // Find the end of headers (blank line separates headers from body)
    // Handle both \r\n\r\n and \n\n line endings
    let headerEnd = headerText.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      headerEnd = headerText.indexOf("\n\n");
    }
    
    const headerSection = headerEnd > 0 ? headerText.slice(0, headerEnd) : headerText;

    // Split by either \r\n or \n
    const lines = headerSection.split(/\r?\n/);
    
    for (const line of lines) {
      const colonIndex = line.indexOf(":");
      if (colonIndex > 0) {
        const key = line.slice(0, colonIndex).toLowerCase().trim();
        const value = line.slice(colonIndex + 1).trim();
        headers[key] = value;
      }
    }

    return headers;
  }

  /**
   * Close the connection.
   */
  async disconnect(): Promise<void> {
    this.client = null;
    this.accountId = null;
  }
}

/**
 * Convert our MailKeyword format to JMAP keyword format.
 */
function kindToJmapKeyword(keyword: MailKeyword): string {
  // JMAP uses $seen, $flagged, etc. directly
  return keyword;
}
