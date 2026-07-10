/**
 * CardDAV Source Connector Implementation
 * 
 * Implements ContactSource interface for CardDAV address book synchronization.
 * Follows RFC 4791 (WebDAV), RFC 6350 (vCard), and RFC 6578 (Collection Synchronization).
 * 
 * Features:
 * - Address book home set discovery via PROPFIND
 * - Incremental sync using sync-collection REPORT (RFC 6578)
 * - CTag fallback when sync-token not supported
 * - **Case-sensitive UID handling** (vCard UIDs are case-sensitive per RFC 6350)
 * 
 * IMPORTANT: Unlike CalDAV where UIDs are case-insensitive (RFC 5545),
 * vCard UIDs are case-sensitive per RFC 6350. This must be preserved exactly.
 */

import type { ContactSource, ContactFolder, RawContact, SyncCursor } from '@openmig/shared';
import type { CardDAVSourceConfig, CardDAVSyncToken, CardDAVContactObject, CardDAVHomeSet, CardDAVCollection } from './carddav-source.types';
import type { HttpClient, HttpRequestOptions, HttpResponse } from './dav-http.types';

/**
 * CardDAV source connector implementation.
 */
export class CarddavSource implements ContactSource {
  private readonly config: CardDAVSourceConfig;
  private readonly httpClient: HttpClient;
  private addressBookHomeSet: string | null = null;

  constructor(
    config: CardDAVSourceConfig,
    deps?: { httpClient?: HttpClient },
  ) {
    this.config = config;
    this.httpClient = deps?.httpClient ?? createDefaultHttpClient();
  }

  /**
   * Enumerate address book folders (collections) with discovery.
   * Discovers address book home set if not provided in config.
   */
  async listFolders(): Promise<ReadonlyArray<ContactFolder>> {
    // Discover address book home set if not configured
    if (!this.addressBookHomeSet) {
      await this.discoverAddressBookHomeSet();
    }

    if (!this.addressBookHomeSet) {
      throw new Error('Failed to discover address book home set');
    }

    // List all address book collections under the home set
    return await this.listCollections(this.addressBookHomeSet);
  }

  /**
   * List contacts changed since cursor (or all if undefined).
   * Uses sync-collection REPORT (RFC 6578) for incremental sync.
   * Falls back to CTag if sync-token not supported.
   */
  async listSince(
    folder: ContactFolder,
    cursor?: SyncCursor,
  ): Promise<{ items: ReadonlyArray<RawContact>; nextCursor: SyncCursor }> {
    if (!this.addressBookHomeSet) {
      await this.discoverAddressBookHomeSet();
    }

    if (!this.addressBookHomeSet) {
      throw new Error('Failed to discover address book home set');
    }

    // Build the collection path from folder
    const collectionPath = this.buildCollectionPath(folder, this.addressBookHomeSet);

    // Perform sync-collection REPORT
    const result = await this.syncCollection(collectionPath, cursor);

    // Parse the response and extract contacts
    const items: RawContact[] = [];
    for (const obj of result.objects) {
      const contact = this.parseContactObject(obj);
      if (contact) {
        items.push(contact);
      }
    }

    // Create next cursor from sync token
    const nextCursor: SyncCursor = {
      value: result.syncToken ? this.encodeSyncToken(result.syncToken) : (result.ctag ? this.encodeCTag(result.ctag, collectionPath) : ''),
    };

    return { items, nextCursor };
  }

  // Private helper methods

  /**
   * Discover the address book home set using PROPFIND.
   * RFC 4791 Section 5.2 (similar to calendar-home-set)
   */
  private async discoverAddressBookHomeSet(): Promise<void> {
    const propfind = `<?xml version="1.0" encoding="utf-8"?>
      <D:propfind xmlns:D="DAV:">
        <D:prop>
          <A:addressbook-home-set xmlns:A="urn:ietf:params:xml:ns:carddav"/>
        </D:prop>
      </D:propfind>`;

    const response = await this.httpClient.request({
      method: 'PROPFIND',
      url: this.config.url,
      body: propfind,
      headers: {
        'Content-Type': 'application/xml',
        Depth: '0',
        Authorization: this.getAuthorizationHeader(),
      },
    });

    if (response.status !== 207) {
      throw new Error(`PROPFIND failed with status ${response.status}: ${response.body}`);
    }

    const homeSet = this.parseAddressBookHomeSetResponse(response.body);
    if (homeSet) {
      this.addressBookHomeSet = homeSet;
    } else {
      // Fallback: use the configured URL as the home set
      this.addressBookHomeSet = this.config.addressBookHomeSet || this.normalizePath(this.config.url);
    }
  }

  /**
   * List all address book collections under a home set.
   * Uses PROPFIND with Depth: 1 to find addressbook collections.
   */
  private async listCollections(homeSet: string): Promise<ContactFolder[]> {
    const propfind = `<?xml version="1.0" encoding="utf-8"?>
      <D:propfind xmlns:D="DAV:" xmlns:A="urn:ietf:params:xml:ns:carddav">
        <D:prop>
          <D:displayname/>
          <D:resourcetype/>
          <A:addressbook-description/>
          <A:supported-address-data/>
          <CR:color xmlns:CR="urn:ietf:params:xml:ns:carddav"/>
        </D:prop>
      </D:propfind>`;

    const response = await this.httpClient.request({
      method: 'PROPFIND',
      url: this.buildUrl(homeSet),
      body: propfind,
      headers: {
        'Content-Type': 'application/xml',
        Depth: '1',
        Authorization: this.getAuthorizationHeader(),
      },
    });

    if (response.status !== 207) {
      throw new Error(`PROPFIND failed with status ${response.status}: ${response.body}`);
    }

    return this.parseCollectionsResponse(response.body, homeSet);
  }

  /**
   * Perform sync-collection REPORT for incremental synchronization.
   * RFC 6578 Section 3.1
   */
  private async syncCollection(
    collectionPath: string,
    cursor?: SyncCursor,
  ): Promise<{ objects: CardDAVContactObject[]; syncToken?: string; ctag?: string }> {
    // Build sync-collection REPORT
    let syncToken: string | undefined;
    let ctag: string | undefined;

    if (cursor) {
      try {
        const decoded = this.decodeSyncToken(cursor);
        if (decoded.isSyncToken) {
          syncToken = decoded.token;
        } else {
          ctag = decoded.token;
        }
      } catch {
        // Invalid cursor, do full sync
      }
    }

    const report = this.buildSyncCollectionReport(collectionPath, syncToken, ctag);

    const response = await this.httpClient.request({
      method: 'REPORT',
      url: this.buildUrl(collectionPath),
      body: report,
      headers: {
        'Content-Type': 'application/xml',
        Authorization: this.getAuthorizationHeader(),
      },
    });

    if (response.status !== 207) {
      throw new Error(`REPORT failed with status ${response.status}: ${response.body}`);
    }

    return this.parseSyncCollectionResponse(response.body);
  }

  /**
   * Build the sync-collection REPORT XML.
   */
  private buildSyncCollectionReport(
    collectionPath: string,
    syncToken?: string,
    ctag?: string,
  ): string {
    const syncTokenElement = syncToken
      ? `<D:sync-token>${this.escapeXml(syncToken)}</D:sync-token>`
      : '';

    const vcardVersionElement = ctag
      ? `<A:address-data xmlns:A="urn:ietf:params:xml:ns:carddav"><A:prop>FN</A:prop><A:prop>UID</A:prop></A:address-data>`
      : '';

    return `<?xml version="1.0" encoding="utf-8"?>
      <D:sync-collection xmlns:D="DAV:" xmlns:A="urn:ietf:params:xml:ns:carddav">
        <D:prop>
          <D:resourcetype/>
          <A:address-data>
            ${vcardVersionElement}
          </A:address-data>
        </D:prop>
        ${syncTokenElement}
      </D:sync-collection>`;
  }

  /**
   * Parse address book home set from PROPFIND response.
   */
  private parseAddressBookHomeSetResponse(body: string): string | null {
    // Look for addressbook-home-set in the response
    const match = body.match(/<A:addressbook-home-set[^>]*>([^<]+)<\/A:addressbook-home-set>/i);
    if (match && match[1]) {
      return this.normalizePath(match[1].trim());
    }
    return null;
  }

  /**
   * Parse address book collections from PROPFIND response.
   */
  private parseCollectionsResponse(body: string, homeSet: string): ContactFolder[] {
    const folders: ContactFolder[] = [];
    
    // Find all response elements
    const responseRegex = /<D:response[^>]*>([\s\S]*?)<\/D:response>/gi;
    let match: RegExpExecArray | null;

    while ((match = responseRegex.exec(body)) !== null) {
      const responseContent = match[1];
      if (!responseContent) continue;
      
      // Extract href
      const hrefMatch = responseContent.match(/<D:href[^>]*>([^<]+)<\/D:href>/i);
      if (!hrefMatch || !hrefMatch[1]) continue;
      
      const path = this.normalizePath(hrefMatch[1].trim());
      
      // Skip if this is the home set itself
      if (path === this.normalizePath(homeSet)) continue;

      // Extract display name
      const displayNameMatch = responseContent.match(/<D:displayname[^>]*>([^<]*)<\/D:displayname>/i);
      const displayName = displayNameMatch && displayNameMatch[1] ? displayNameMatch[1].trim() : undefined;

      // Extract description
      const descriptionMatch = responseContent.match(/<A:addressbook-description[^>]*>([^<]*)<\/A:addressbook-description>/i);
      const description = descriptionMatch && descriptionMatch[1] ? this.decodeXmlEntities(descriptionMatch[1].trim()) : undefined;

      // Extract color
      const colorMatch = responseContent.match(/<CR:color[^>]*>([^<]+)<\/CR:color>/i);
      const _color = colorMatch && colorMatch[1] ? colorMatch[1].trim() : undefined;

      folders.push({
        path,
        name: displayName || this.extractNameFromPath(path),
        description,
      });
    }

    return folders;
  }

  /**
   * Parse sync-collection REPORT response.
   */
  private parseSyncCollectionResponse(body: string): { objects: CardDAVContactObject[]; syncToken?: string; ctag?: string } {
    const objects: CardDAVContactObject[] = [];
    let syncToken: string | undefined;
    let ctag: string | undefined;

    // Extract sync-token if present
    const syncTokenMatch = body.match(/<D:sync-token[^>]*>([^<]+)<\/D:sync-token>/i);
    if (syncTokenMatch && syncTokenMatch[1]) {
      syncToken = syncTokenMatch[1].trim();
    }

    // Extract CTag from ETag if present
    const ctagMatch = body.match(/<D:getetag[^>]*>([^<]+)<\/D:getetag>/i);
    if (ctagMatch && ctagMatch[1]) {
      ctag = ctagMatch[1].trim();
    }

    // Find all response elements
    const responseRegex = /<D:response[^>]*>([\s\S]*?)<\/D:response>/gi;
    let match: RegExpExecArray | null;

    while ((match = responseRegex.exec(body)) !== null) {
      const responseContent = match[1];
      if (!responseContent) continue;
      
      // Extract href
      const hrefMatch = responseContent.match(/<D:href[^>]*>([^<]+)<\/D:href>/i);
      if (!hrefMatch || !hrefMatch[1]) continue;
      
      const href = hrefMatch[1].trim();

      // Extract vCard data
      const vcardMatch = responseContent.match(/<A:address-data[^>]*>([\s\S]*?)<\/A:address-data>/i);
      if (vcardMatch && vcardMatch[1]) {
        const vcardData = this.decodeXmlEntities(vcardMatch[1].trim());
        objects.push({
          href,
          vcard: vcardData,
          syncToken,
        });
      }
    }

    return { objects, syncToken, ctag };
  }

  /**
   * Parse a contact object and extract contact data.
   * IMPORTANT: UID is case-sensitive per RFC 6350 - do NOT normalize!
   */
  private parseContactObject(obj: CardDAVContactObject): RawContact | null {
    try {
      // Extract UID from vCard data (case-sensitive!)
      const uid = this.extractUidFromVcard(obj.vcard);
      if (!uid) {
        return null;
      }

      // Extract FN (full name)
      const name = this.extractFN(obj.vcard);

      // Create the contact
      const contact: RawContact = {
        item: {
          uid, // Keep case-sensitive as-is per RFC 6350
          type: this.extractContactType(obj.vcard),
          name,
          givenName: this.extractGivenName(obj.vcard),
          familyName: this.extractFamilyName(obj.vcard),
          organization: this.extractOrganization(obj.vcard),
          phones: this.extractPhones(obj.vcard),
          emails: this.extractEmails(obj.vcard),
          addresses: this.extractAddresses(obj.vcard),
          urls: this.extractUrls(obj.vcard),
          note: this.extractNote(obj.vcard),
          birthday: this.extractBirthday(obj.vcard),
          categories: this.extractCategories(obj.vcard),
          sourcePath: obj.href,
          vcard: obj.vcard,
          version: this.extractVCardVersion(obj.vcard),
        },
        vcard: obj.vcard,
      };

      return contact;
    } catch {
      return null;
    }
  }

  /**
   * Extract UID from vCard data.
   * **Case-sensitive** per RFC 6350 - returns exact value without normalization.
   */
  extractUidFromVcard(vcard: string): string | null {
    // Match UID property in vCard (case-insensitive property name, but preserve UID value case)
    // vCard 4.0: UID:urn:uuid:...
    // vCard 3.0: UID:urn:uuid:...
    const uidMatch = vcard.match(/^UID[:\s]([^\r\n]+)/im);
    if (!uidMatch || !uidMatch[1]) {
      return null;
    }
    // Return UID exactly as-is - case-sensitive per RFC 6350!
    return uidMatch[1].trim();
  }

  /**
   * Extract FN (full name) from vCard data.
   */
  private extractFN(vcard: string): string {
    const match = vcard.match(/^FN[:\s]([^\r\n]+)/im);
    return match && match[1] ? this.unfoldAndDecode(match[1].trim()) : 'Unknown';
  }

  /**
   * Extract given name from vCard data.
   */
  private extractGivenName(vcard: string): string | undefined {
    const match = vcard.match(/^N[:\s]([^;]+)/im);
    if (match && match[1]) {
      const parts = match[1].split(';');
      if (parts.length >= 2 && parts[1]) {
        return this.unfoldAndDecode(parts[1].trim());
      }
    }
    return undefined;
  }

  /**
   * Extract family name from vCard data.
   */
  private extractFamilyName(vcard: string): string | undefined {
    const match = vcard.match(/^N[:\s]([^;]+)/im);
    if (match && match[1]) {
      const parts = match[1].split(';');
      if (parts.length >= 1 && parts[0]) {
        return this.unfoldAndDecode(parts[0].trim());
      }
    }
    return undefined;
  }

  /**
   * Extract organization from vCard data.
   */
  private extractOrganization(vcard: string): { name: string; title?: string } | undefined {
    const orgMatch = vcard.match(/^ORG[:\s]([^;\r\n]+)/im);
    if (orgMatch && orgMatch[1]) {
      const orgParts = orgMatch[1].split(';');
      const name = orgParts[0]?.trim() ? this.unfoldAndDecode(orgParts[0].trim()) : '';
      
      // Try to extract title from TITLE property
      const titleMatch = vcard.match(/^TITLE[:\s]([^\r\n]+)/im);
      const title = titleMatch && titleMatch[1] ? this.unfoldAndDecode(titleMatch[1].trim()) : undefined;
      
      return { name, title };
    }
    return undefined;
  }

  /**
   * Extract phone numbers from vCard data.
   */
  private extractPhones(vcard: string): Array<{ value: string; type: 'home' | 'work' | 'mobile' | 'other'; label?: string }> {
    const phones: Array<{ value: string; type: 'home' | 'work' | 'mobile' | 'other'; label?: string }> = [];
    
    const phoneRegex = /^TEL(;[^:]*:[^\r\n]+|[:\s][^\r\n]+)/gim;
    let match: RegExpExecArray | null;
    
    while ((match = phoneRegex.exec(vcard)) !== null) {
      const fullLine = match[0];
      const valueMatch = fullLine.match(/[:\s]([^\r\n]+)/);
      
      if (valueMatch && valueMatch[1]) {
        const value = this.unfoldAndDecode(valueMatch[1].trim());
        
        // Extract type (HOME, WORK, MOBILE, etc.)
        let type: 'home' | 'work' | 'mobile' | 'other' = 'other';
        if (/;HOME/i.test(fullLine)) type = 'home';
        else if (/;WORK/i.test(fullLine)) type = 'work';
        else if (/;MOBILE/i.test(fullLine)) type = 'mobile';
        
        phones.push({ value, type });
      }
    }
    
    return phones;
  }

  /**
   * Extract email addresses from vCard data.
   */
  private extractEmails(vcard: string): Array<{ value: string; type: 'home' | 'work' | 'other'; label?: string }> {
    const emails: Array<{ value: string; type: 'home' | 'work' | 'other'; label?: string }> = [];
    
    const emailRegex = /^EMAIL(;[^:]*:[^\r\n]+|[:\s][^\r\n]+)/gim;
    let match: RegExpExecArray | null;
    
    while ((match = emailRegex.exec(vcard)) !== null) {
      const fullLine = match[0];
      const valueMatch = fullLine.match(/[:\s]([^\r\n]+)/);
      
      if (valueMatch && valueMatch[1]) {
        const value = this.unfoldAndDecode(valueMatch[1].trim());
        
        // Extract type (HOME, WORK, OTHER)
        let type: 'home' | 'work' | 'other' = 'other';
        if (/;HOME/i.test(fullLine)) type = 'home';
        else if (/;WORK/i.test(fullLine)) type = 'work';
        
        emails.push({ value, type });
      }
    }
    
    return emails;
  }

  /**
   * Extract addresses from vCard data.
   */
  private extractAddresses(vcard: string): Array<{ type: 'home' | 'work' | 'other'; street?: string; city?: string; region?: string; postalCode?: string; country?: string }> {
    const addresses: Array<{ type: 'home' | 'work' | 'other'; street?: string; city?: string; region?: string; postalCode?: string; country?: string }> = [];
    
    const addressRegex = /^ADR(;[^:]*:[^\r\n]+|[:\s][^\r\n]+)/gim;
    let match: RegExpExecArray | null;
    
    while ((match = addressRegex.exec(vcard)) !== null) {
      const fullLine = match[0];
      
      // Extract type
      let type: 'home' | 'work' | 'other' = 'other';
      if (/;HOME/i.test(fullLine)) type = 'home';
      else if (/;WORK/i.test(fullLine)) type = 'work';
      
      // ADR format: ADR;;street;city;region;postal;country
      const adrMatch = fullLine.match(/[:\s]([^;]*);([^;]*);([^;]*);([^;]*);([^;]*);([^;\r\n]*)/);
      if (adrMatch && adrMatch[1] && adrMatch[2] && adrMatch[3] && adrMatch[4] && adrMatch[5]) {
        addresses.push({
          type,
          street: this.unfoldAndDecode(adrMatch[1].trim()) || undefined,
          city: this.unfoldAndDecode(adrMatch[2].trim()) || undefined,
          region: this.unfoldAndDecode(adrMatch[3].trim()) || undefined,
          postalCode: this.unfoldAndDecode(adrMatch[4].trim()) || undefined,
          country: this.unfoldAndDecode(adrMatch[5].trim()) || undefined,
        });
      }
    }
    
    return addresses;
  }

  /**
   * Extract URLs from vCard data.
   */
  private extractUrls(vcard: string): Array<{ value: string; type: 'home' | 'work' | 'profile' | 'other'; label?: string }> {
    const urls: Array<{ value: string; type: 'home' | 'work' | 'profile' | 'other'; label?: string }> = [];
    
    const urlRegex = /^URL[:\s]([^\r\n]+)/gim;
    let match: RegExpExecArray | null;
    
    while ((match = urlRegex.exec(vcard)) !== null) {
      const value = match[1] ? this.unfoldAndDecode(match[1].trim()) : '';
      if (value) {
        urls.push({ value, type: 'other' });
      }
    }
    
    return urls;
  }

  /**
   * Extract note from vCard data.
   */
  private extractNote(vcard: string): string | undefined {
    const match = vcard.match(/^NOTE[:\s]([^\r\n]+)/im);
    return match && match[1] ? this.unfoldAndDecode(match[1].trim()) : undefined;
  }

  /**
   * Extract birthday from vCard data.
   */
  private extractBirthday(vcard: string): string | undefined {
    const match = vcard.match(/^BDAY[:\s]([^\r\n]+)/im);
    return match && match[1] ? match[1].trim() : undefined;
  }

  /**
   * Extract categories from vCard data.
   */
  private extractCategories(vcard: string): string[] | undefined {
    const match = vcard.match(/^CATEGORIES[:\s]([^\r\n]+)/im);
    if (match && match[1]) {
      return match[1].split(',').map(c => this.unfoldAndDecode(c.trim()));
    }
    return undefined;
  }

  /**
   * Extract vCard version.
   */
  private extractVCardVersion(vcard: string): '3.0' | '4.0' {
    const match = vcard.match(/^VERSION[:\s]([^\r\n]+)/im);
    if (match && match[1]) {
      const version = match[1].trim();
      if (version === '4.0' || version === '3.0') {
        return version as '3.0' | '4.0';
      }
    }
    return '4.0'; // Default to vCard 4.0
  }

  /**
   * Extract contact type from vCard data.
   */
  private extractContactType(vcard: string): 'person' | 'organization' | 'group' {
    // Check for KIND property (vCard 4.0)
    const kindMatch = vcard.match(/^KIND[:\s]([^\r\n]+)/im);
    if (kindMatch && kindMatch[1]) {
      const kind = kindMatch[1].trim().toLowerCase();
      if (kind === 'org' || kind === 'organization') return 'organization';
      if (kind === 'group') return 'group';
    }
    
    // Default to person if not specified
    return 'person';
  }

  /**
   * Unfold vCard lines and decode special characters.
   * vCard lines can be folded with leading whitespace (RFC 6350 Section 3.1).
   */
  private unfoldAndDecode(str: string): string {
    // First unfold any folded lines
    const unfolded = str.replace(/\r?\n\s+/g, '');
    // Then decode vCard special characters
    return unfolded
      .replace(/\\n/gi, '\n')
      .replace(/\\,/g, ',')
      .replace(/\\;/g, ';')
      .replace(/\\\\/g, '\\');
  }

  /**
   * Decode XML entities.
   */
  private decodeXmlEntities(str: string): string {
    return str
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'");
  }

  /**
   * Escape XML special characters.
   */
  private escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Encode sync token for cursor storage.
   */
  private encodeSyncToken(token: string): string {
    return `sync-token:${token}`;
  }

  /**
   * Encode CTag for cursor storage.
   */
  private encodeCTag(ctag: string, collectionPath: string): string {
    return `ctag:${collectionPath}:${ctag}`;
  }

  /**
   * Decode sync token from cursor.
   */
  private decodeSyncToken(cursor: SyncCursor): CardDAVSyncToken {
    const value = cursor.value;
    
    if (value.startsWith('sync-token:')) {
      return {
        token: value.slice('sync-token:'.length),
        isSyncToken: true,
        collectionPath: '',
      };
    }

    if (value.startsWith('ctag:')) {
      const parts = value.slice('ctag:'.length).split(':');
      if (parts.length >= 2) {
        const collectionPath = parts[0];
        const token = parts.slice(1).join(':');
        if (!collectionPath) {
          throw new Error(`Invalid cursor format: ${value}`);
        }
        return {
          token,
          isSyncToken: false,
          collectionPath,
        };
      }
    }

    throw new Error(`Invalid cursor format: ${value}`);
  }

  /**
   * Get authorization header value.
   * Password is read from environment variable.
   */
  private getAuthorizationHeader(): string {
    const password = process.env[this.config.passwordEnv];
    if (!password) {
      throw new Error(`Password environment variable ${this.config.passwordEnv} not set`);
    }
    const credentials = Buffer.from(`${this.config.username}:${password}`).toString('base64');
    return `Basic ${credentials}`;
  }

  /**
   * Build URL from path.
   */
  private buildUrl(path: string): string {
    const baseUrl = this.config.url.replace(/\/$/, '');
    const normalizedPath = path.replace(/^\/+/, '');
    return `${baseUrl}/${normalizedPath}`;
  }

  /**
   * Normalize path to ensure consistent format.
   */
  private normalizePath(path: string): string {
    let normalized = path.replace(/\\/g, '/');
    if (!normalized.startsWith('/')) {
      normalized = '/' + normalized;
    }
    if (!normalized.endsWith('/')) {
      normalized += '/';
    }
    return normalized;
  }

  /**
   * Extract name from path.
   */
  private extractNameFromPath(path: string): string {
    const parts = path.split('/').filter(p => p.length > 0);
    return parts[parts.length - 1] || 'Address Book';
  }

  /**
   * Build collection path from folder info.
   */
  private buildCollectionPath(folder: ContactFolder, homeSet: string): string {
    // Use the folder path if available, otherwise construct from home set
    if (folder.path) {
      return this.normalizePath(folder.path);
    }
    return this.normalizePath(`${homeSet}${folder.name}/`);
  }
}

/**
 * Create a default HTTP client using Node.js fetch.
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
