/**
 * CardDAV Target Writer Implementation
 * 
 * Implements ContactTargetWriter interface for CardDAV contact synchronization.
 * Uses vdirsyncer for bulk operations and direct CardDAV API calls for individual operations.
 * Follows the idempotency pattern with ledger fast-path and target-side existence checks.
 */

import type {
  ContactTargetWriter,
  ContactFolder,
  RawContact,
  UpsertResult,
  Ledger,
  TenantId,
  MappingId,
} from '@openmig/shared';
import { contactNaturalKeyHash, contactContentHash } from '@openmig/shared';

/**
 * Configuration for CardDAV target writer
 */
export interface CardDAVTargetConfig {
  /** CardDAV endpoint URL */
  url: string;
  /** Authentication username */
  username: string;
  /** Authentication password or token */
  password: string;
  /** Address book home set path */
  homeSet?: string;
  /** Default address book description */
  description?: string;
}

/**
 * CardDAV target writer implementation
 */
export class CardDAVTargetWriter implements ContactTargetWriter {
  private readonly config: CardDAVTargetConfig;
  private readonly ledger: Ledger;
  private readonly tenantId: TenantId;
  private readonly mappingId: MappingId;
  private readonly httpClient: HttpClient;

  constructor(
    config: CardDAVTargetConfig,
    deps: {
      ledger: Ledger;
      tenantId: TenantId;
      mappingId: MappingId;
      httpClient?: HttpClient;
    },
  ) {
    this.config = config;
    this.ledger = deps.ledger;
    this.tenantId = deps.tenantId;
    this.mappingId = deps.mappingId;
    this.httpClient = deps.httpClient ?? createDefaultHttpClient();
  }

  /**
   * Ensure an address book exists with the given folder metadata.
   * Returns the address book ID (href) for use in subsequent operations.
   */
  async ensureContactFolder(folder: ContactFolder): Promise<string> {
    const addressBookPath = this.normalizeAddressBookPath(folder.path ?? folder.name ?? 'addressbook');
    
    // Check if address book already exists via PROPFIND
    const exists = await this.addressBookExists(addressBookPath);
    if (exists) {
      return addressBookPath;
    }

    // Create new address book using MKCOL
    await this.createAddressBook(addressBookPath, folder);
    return addressBookPath;
  }

  /**
   * Idempotently write a contact to the target.
   * Uses ledger fast-path and target-side UID check to ensure idempotency.
   */
  async upsertContact(
    folderId: string,
    raw: RawContact,
  ): Promise<UpsertResult> {
    // Extract UID from vCard data
    const uid = this.extractUidFromVcard(raw.vcard);
    const naturalKey = uid;
    const naturalKeyHash = contactNaturalKeyHash(naturalKey);

    // LEDGER FAST-PATH: Check if already migrated
    const known = await this.ledger.find(this.tenantId, this.mappingId, naturalKeyHash);
    if (known) {
      return { targetId: known.targetId, created: false };
    }

    // Compute content hash for change detection
    const contentHashValue = contactContentHash(raw.vcard);

    // Check if contact already exists on target (by UID)
    const existingId = await this.findContactByNaturalKey(folderId, naturalKey);
    if (existingId) {
      // Record in ledger if not present (adopt existing)
      await this.ledger.recordIfAbsent({
        tenantId: this.tenantId,
        mappingId: this.mappingId,
        naturalKeyHash,
        contentHash: contentHashValue,
        targetId: existingId,
        createdAt: new Date().toISOString(),
      });
      return { targetId: existingId, created: false };
    }

    // Upload the contact to the address book
    const contactId = await this.uploadContact(folderId, raw, uid);

    // RECORD IN LEDGER
    await this.ledger.recordIfAbsent({
      tenantId: this.tenantId,
      mappingId: this.mappingId,
      naturalKeyHash,
      contentHash: contentHashValue,
      targetId: contactId,
      createdAt: new Date().toISOString(),
    });

    return { targetId: contactId, created: true };
  }

  /**
   * Find a contact by its natural key (UID).
   * Returns the contact ID if found, undefined otherwise.
   */
  async findContactByNaturalKey(
    folderId: string,
    naturalKey: string,
  ): Promise<string | undefined> {
    // Use CardDAV REPORT to search for contacts by UID
    const query = `<?xml version="1.0" encoding="utf-8"?>
      <C:addressbook-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
        <D:prop>
          <D:resourcetype/>
          <C:address-data/>
        </D:prop>
        <C:filter>
          <C:comp-filter name="VADDRESSBOOK">
            <C:comp-filter name="VCARD">
              <C:prop-filter name="UID">
                <C:text-match>${this.escapeXml(naturalKey)}</C:text-match>
              </C:prop-filter>
            </C:comp-filter>
          </C:comp-filter>
        </C:filter>
      </C:addressbook-query>`;

    const response = await this.httpClient.request({
      method: 'REPORT',
      url: this.buildUrl(folderId),
      body: query,
      headers: {
        'Content-Type': 'application/xml',
        Authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64')}`,
      },
    });

    if (response.status === 207) {
      // Multi-status response - parse for matching resources
      const href = this.parseMultiStatusResponse(response.body, naturalKey);
      return href || undefined;
    }

    return undefined;
  }

  // Private helper methods

  private normalizeAddressBookPath(path: string): string {
    // Normalize path to ensure consistent format
    let normalized = path.replace(/\\/g, '/');
    if (!normalized.startsWith('/')) {
      normalized = '/' + normalized;
    }
    if (!normalized.endsWith('/')) {
      normalized += '/';
    }
    // Ensure .vcf extension for individual contacts, no extension for address books
    if (normalized.endsWith('.vcf/')) {
      normalized = normalized.slice(0, -4);
    }
    return normalized;
  }

  private async addressBookExists(path: string): Promise<boolean> {
    try {
      const response = await this.httpClient.request({
        method: 'PROPFIND',
        url: this.buildUrl(path),
        headers: {
          Depth: '0',
          Authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64')}`,
        },
      });
      return response.status === 207 || response.status === 200;
    } catch {
      return false;
    }
  }

  private async createAddressBook(path: string, folder: ContactFolder): Promise<void> {
    const mkcol = `<?xml version="1.0" encoding="utf-8"?>
      <D:mkcol xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
        <D:set>
          <D:prop>
            <D:displayname>${this.escapeXml(folder.name || folder.path)}</D:displayname>
            ${folder.description ? `<C:addressbook-description>${this.escapeXml(folder.description)}</C:addressbook-description>` : ''}
          </D:prop>
        </D:set>
      </D:mkcol>`;

    await this.httpClient.request({
      method: 'MKCOL',
      url: this.buildUrl(path),
      body: mkcol,
      headers: {
        'Content-Type': 'application/xml',
        Authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64')}`,
      },
    });
  }

  private extractUidFromVcard(vcard: string): string {
    const uidMatch = vcard.match(/UID:[^\r\n]+/i);
    if (!uidMatch) {
      throw new Error('Invalid vCard data: missing UID');
    }
    const parts = uidMatch[0].split(':');
    return parts[1]?.trim() ?? '';
  }

  private async uploadContact(
    folderId: string,
    raw: RawContact,
    uid: string,
  ): Promise<string> {
    // Generate contact filename from UID
    const filename = `${uid}.vcf`;
    const contactPath = `${folderId}${filename}`;

    await this.httpClient.request({
      method: 'PUT',
      url: this.buildUrl(contactPath),
      body: raw.vcard,
      headers: {
        'Content-Type': 'text/vcard',
        Authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64')}`,
      },
    });

    return contactPath;
  }

  private parseMultiStatusResponse(
    response: string,
    searchUid: string,
  ): string | null {
    // Parse XML response to find matching href
    const hrefMatches = response.matchAll(/<D:href>([^<]+)<\/D:href>/g);
    for (const match of hrefMatches) {
      const href = match[1];
      if (!href) continue;
      // Check if this resource contains the matching UID
      if (href.includes(searchUid)) {
        return href;
      }
    }
    return null;
  }

  private escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private buildUrl(path: string): string {
    const baseUrl = this.config.url.replace(/\/$/, '');
    const normalizedPath = path.replace(/^\/+/, '');
    return `${baseUrl}/${normalizedPath}`;
  }
}

/**
 * HTTP client interface for CardDAV requests
 */
export interface HttpClient {
  request(options: HttpRequestOptions): Promise<HttpResponse>;
}

export interface HttpRequestOptions {
  method: string;
  url: string;
  body?: string | Buffer;
  headers?: Record<string, string>;
}

export interface HttpResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

/**
 * Create a default HTTP client using Node.js fetch
 */
function createDefaultHttpClient(): HttpClient {
  return {
    async request(options: HttpRequestOptions): Promise<HttpResponse> {
      const response = await fetch(options.url, {
        method: options.method,
        headers: options.headers,
        body: typeof options.body === 'string' ? options.body : undefined,
      });

      const body = await response.text();
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      return {
        status: response.status,
        body,
        headers,
      };
    },
  };
}
