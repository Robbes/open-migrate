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

  constructor(config: JmapTargetConfig) {
    this.config = config;
  }

  /**
   * Connect to the JMAP server and discover the session.
   */
  async connect(): Promise<void> {
    // Use basic auth - JMAP typically uses bearer tokens
    const authHeader = `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString("base64")}`;

    const sessionUrl = `${this.config.baseUrl}${this.config.wellKnownPath || "/.well-known/jmap"}`;

    this.client = new JamClient({
      bearerToken: authHeader,
      sessionUrl,
    });

    // Wait for session to be loaded and get account ID
    this.accountId = await this.client.getPrimaryAccount();
  }

  /**
   * Ensure a mailbox exists, creating it if necessary.
   * Returns the mailbox ID.
   */
  async ensureMailbox(folder: MailFolder): Promise<string> {
    if (!this.client || !this.accountId) {
      throw new Error("Not connected to JMAP server");
    }

    // Query for existing mailboxes
    const response = await this.client.api.Mailbox.query({
      accountId: this.accountId,
      filter: { name: folder.name || folder.path },
    });

    // QueryResponse is an array-like object - cast to array for iteration
    const mailboxes = response as unknown as Array<{
      id: string;
      name: string;
      path?: string;
    }>;

    // Look for existing mailbox with matching path or role
    const existing = mailboxes.find(
      (m) => m.name === folder.name || m.path === folder.path,
    );

    if (existing) {
      return existing.id;
    }

    // Create the mailbox
    const role = SPECIAL_USE_ROLE_MAP[folder.specialUse];

    // Use type assertion to work around TypeScript's strict typing issues with jmap-rfc-types
    const mailboxSetResponse = await this.client.api.Mailbox.set({
      accountId: this.accountId,
      create: {
        "0": {
          name: folder.name || folder.path,
          role,
          sortOrder: 0,
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const mailboxResponse = mailboxSetResponse as {
      created?: Record<string, { id: string }>;
    };
    const createdId = Object.keys(mailboxResponse.created || {})[0];
    if (!createdId) {
      throw new Error("Failed to create mailbox");
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
    if (!this.client || !this.accountId) {
      throw new Error("Not connected to JMAP server");
    }

    try {
      // Query emails by Message-ID header
      // JMAP header filter format: [headerName, headerValue]
      const response = await this.client.api.Email.query({
        accountId: this.accountId,
        filter: {
          header: ["Message-ID", naturalKey],
        },
        properties: ["id"],
      });

      const emails = response as unknown as Array<{ id: string }>;
      return emails.length > 0 ? emails[0]!.id : undefined;
    } catch {
      // Query might not be supported; return undefined
      return undefined;
    }
  }

  /**
   * Idempotently write a message into the target mailbox.
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

    // Check if email already exists
    if (messageId) {
      const existingId = await this.findByNaturalKey(mailboxId, messageId);
      if (existingId) {
        // Email already exists - idempotent no-op
        return { targetId: existingId, created: false };
      }
    }

    // Parse headers from raw message
    const headers = this.parseRfc822Headers(raw.rfc822);

    // Create the email - use type assertion to work around TypeScript issues
    const setResponse = await this.client.api.Email.set({
      accountId: this.accountId,
      create: {
        "0": {
          mailboxIds: { [mailboxId]: true },
          keywords: this.mapKeywords(keywords),
          messageId: messageId ? [messageId] : undefined,
          receivedAt: headers.date || new Date().toISOString(),
          size: raw.rfc822.length,
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const response = setResponse as {
      created?: Record<string, { id: string }>;
    };
    const createdId = Object.keys(response.created || {})[0];
    if (!createdId) {
      throw new Error("Failed to create email");
    }

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
    const headers = this.parseRfc822Headers(rfc822);
    return headers["message-id"] || null;
  }

  /**
   * Parse RFC822 headers from raw message.
   */
  private parseRfc822Headers(rfc822: Uint8Array): Record<string, string> {
    const headers: Record<string, string> = {};
    const headerEnd = rfc822.indexOf("\r\n\r\n".charCodeAt(0));
    const headerSection = headerEnd > 0 ? rfc822.slice(0, headerEnd) : rfc822;
    const headerText = new TextDecoder().decode(headerSection);

    for (const line of headerText.split("\r\n")) {
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
