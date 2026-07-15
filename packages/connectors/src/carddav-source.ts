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
import type { CardDAVSourceConfig, CardDAVSyncToken, CardDAVContactObject, CardDAVHomeSet as _CardDAVHomeSet, CardDAVCollection as _CardDAVCollection } from './carddav-source.types';
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
   * Discover the address book home set using RFC 6764 well-known URIs.
   * First tries /.well-known/carddav, then falls back to PROPFIND on base URL.
   * RFC 6764 Section 4.2
   */
  private async discoverAddressBookHomeSet(): Promise<void> {
    // Step 1: Try RFC 6764 well-known URI discovery
    try {
      const wellKnownUrl = this.buildUrl('.well-known/carddav');
      const response = await this.httpClient.request({
        method: 'GET',
        url: wellKnownUrl,
        headers: {
          Authorization: this.getAuthorizationHeader(),
        },
      });

      // Follow redirect to get principal URL
      if (response.status === 301 || response.status === 302 || response.status === 307 || response.status === 308) {
        // Extract redirect location
        const location = response.headers['location'] || response.headers['Location'];
        if (location) {
          const principalUrl = this.normalizePath(location);
          // Step 2: PROPFIND the principal to get addressbook-home-set
          const homeSet = await this.discoverHomeSetFromPrincipal(principalUrl);
          if (homeSet) {
            this.addressBookHomeSet = homeSet;
            return;
          }
        }
      } else if (response.status === 200 || response.status === 204) {
        // Well-known URI exists but may not redirect - try PROPFIND on it
        const homeSet = await this.discoverHomeSetFromPrincipal(wellKnownUrl);
        if (homeSet) {
          this.addressBookHomeSet = homeSet;
          return;
        }
      }
      // Well-known URI not available or didn't help, fall through to PROPFIND on base URL
    } catch {
      // Well-known discovery failed, fall through to PROPFIND on base URL
    }

    // Fallback: PROPFIND on base URL (original behavior)
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

    if (response.status === 207) {
      const homeSet = this.parseAddressBookHomeSetResponse(response.body);
      if (homeSet) {
        this.addressBookHomeSet = homeSet;
      } else {
        // Final fallback: construct address book home set from username
        // Nextcloud typically serves address books at /remote.php/dav/addressbooks/users/{username}/
        const baseUrl = this.config.url.replace(/\/$/, '');
        this.addressBookHomeSet = `${baseUrl}/addressbooks/users/${this.config.username}/`;
      }
    } else if (response.status === 404) {
      // PROPFIND failed with 404, use fallback constructed URL
      const baseUrl = this.config.url.replace(/\/$/, '');
      this.addressBookHomeSet = `${baseUrl}/addressbooks/users/${this.config.username}/`;
    } else {
      throw new Error(`PROPFIND failed with status ${response.status}: ${response.body}`);
    }
  }

  /**
   * Discover addressbook-home-set by PROPFINDing a principal URL.
   * Used after following RFC 6764 well-known redirect.
   */
  private async discoverHomeSetFromPrincipal(principalUrl: string): Promise<string | null> {
    const propfind = `<?xml version="1.0" encoding="utf-8"?>
      <D:propfind xmlns:D="DAV:">
        <D:prop>
          <A:addressbook-home-set xmlns:A="urn:ietf:params:xml:ns:carddav"/>
        </D:prop>
      </D:propfind>`;

    const response = await this.httpClient.request({
      method: 'PROPFIND',
      url: principalUrl,
      body: propfind,
      headers: {
        'Content-Type': 'application/xml',
        Depth: '0',
        Authorization: this.getAuthorizationHeader(),
      },
    });

    if (response.status !== 207) {
      return null;
    }

    return this.parseAddressBookHomeSetResponse(response.body);
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
      url: this.resolveHref(homeSet),
      body: propfind,
      headers: {
        'Content-Type': 'application/xml',
        Depth: '1',
        Authorization: this.getAuthorizationHeader(),
      },
    });

    // Handle 404 - collection doesn't exist yet, return empty list
    if (response.status === 404) {
      return [];
    }

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
      url: this.resolveHref(collectionPath),
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
    // Nextcloud requires sync-token element even for full syncs
    // Use empty element for full sync, actual token for incremental sync
    const syncTokenElement = syncToken
      ? `<D:sync-token>${this.escapeXml(syncToken)}</D:sync-token>`
      : '<D:sync-token/>';

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
    // Look for addressbook-home-set in the response - namespace-agnostic
    const match = body.match(/<[A-Za-z]+:addressbook-home-set[^>]*>([^<]+)<\/[A-Za-z]+:addressbook-home-set>/i);
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
    
    // Find all response elements - namespace-agnostic
    const responseRegex = /<[A-Za-z]+:response[^>]*>([\s\S]*?)<\/[A-Za-z]+:response>/gi;
    let match: RegExpExecArray | null;

    while ((match = responseRegex.exec(body)) !== null) {
      const responseContent = match[1];
      if (!responseContent) continue;
      
      // Extract href - namespace-agnostic
      const hrefMatch = responseContent.match(/<[A-Za-z]+:href>([^<]+)<\/[A-Za-z]+:href>/i);
      if (!hrefMatch || !hrefMatch[1]) continue;
      
      const path = this.normalizePath(hrefMatch[1].trim());
      
      // Skip if this is the home set itself
      if (path === this.normalizePath(homeSet)) continue;

      // Extract display name - namespace-agnostic
      const displayNameMatch = responseContent.match(/<[A-Za-z]+:displayname[^>]*>([^<]*)<\/[A-Za-z]+:displayname>/i);
      const displayName = displayNameMatch && displayNameMatch[1] ? displayNameMatch[1].trim() : undefined;

      // Extract description - namespace-agnostic
      const descriptionMatch = responseContent.match(/<[A-Za-z]+:addressbook-description[^>]*>([^<]*)<\/[A-Za-z]+:addressbook-description>/i);
      const description = descriptionMatch && descriptionMatch[1] ? this.decodeXmlEntities(descriptionMatch[1].trim()) : undefined;

      // Extract color - namespace-agnostic
      const colorMatch = responseContent.match(/<[A-Za-z]+:color[^>]*>([^<]+)<\/[A-Za-z]+:color>/i);
      const _color = colorMatch && colorMatch[1] ? colorMatch[1].trim() : undefined;

      // Skip Nextcloud internal address books
      const name = displayName || this.extractNameFromPath(path);
      if (this.isInternalCollection(name)) continue;

      folders.push({
        path,
        name,
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

    // Extract sync-token if present - namespace-agnostic
    const syncTokenMatch = body.match(/<[A-Za-z]+:sync-token[^>]*>([^<]+)<\/[A-Za-z]+:sync-token>/i);
    if (syncTokenMatch && syncTokenMatch[1]) {
      syncToken = syncTokenMatch[1].trim();
    }

    // Extract CTag from ETag if present - namespace-agnostic
    const ctagMatch = body.match(/<[A-Za-z]+:getetag[^>]*>([^<]+)<\/[A-Za-z]+:getetag>/i);
    if (ctagMatch && ctagMatch[1]) {
      ctag = ctagMatch[1].trim();
    }

    // Find all response elements - namespace-agnostic
    const responseRegex = /<[A-Za-z]+:response[^>]*>([\s\S]*?)<\/[A-Za-z]+:response>/gi;
    let match: RegExpExecArray | null;

    while ((match = responseRegex.exec(body)) !== null) {
      const responseContent = match[1];
      if (!responseContent) continue;
      
      // Extract href - namespace-agnostic
      const hrefMatch = responseContent.match(/<[A-Za-z]+:href>([^<]+)<\/[A-Za-z]+:href>/i);
      if (!hrefMatch || !hrefMatch[1]) continue;
      
      const href = hrefMatch[1].trim();

      // Extract vCard data - namespace-agnostic
      const vcardMatch = responseContent.match(/<[A-Za-z]+:address-data[^>]*>([\s\S]*?)<\/[A-Za-z]+:address-data>/i);
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
    const match = vcard.match(/^N[:\s]([^\r\n]+)/im);
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
    const match = vcard.match(/^N[:\s]([^\r\n]+)/im);
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
        
        // Extract type (HOME, WORK, MOBILE/CELL, etc.)
        let type: 'home' | 'work' | 'mobile' | 'other' = 'other';
        if (/;HOME/i.test(fullLine)) type = 'home';
        else if (/;WORK/i.test(fullLine)) type = 'work';
        else if (/;MOBILE/i.test(fullLine) || /;CELL/i.test(fullLine)) type = 'mobile';
        
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
      
      // ADR format: ADR;TYPE=work:;;street;city;region;postal;country
      // The regex needs 7 capture groups: prefix, type, street, city, region, postal, country
      const adrMatch = fullLine.match(/[:\s]([^;]*);([^;]*);([^;]*);([^;]*);([^;]*);([^;]*);([^;\r\n]*)/);
      if (adrMatch && adrMatch[3] && adrMatch[4] && adrMatch[5] && adrMatch[6] && adrMatch[7]) {
        addresses.push({
          type,
          street: this.unfoldAndDecode(adrMatch[3].trim()) || undefined,
          city: this.unfoldAndDecode(adrMatch[4].trim()) || undefined,
          region: this.unfoldAndDecode(adrMatch[5].trim()) || undefined,
          postalCode: this.unfoldAndDecode(adrMatch[6].trim()) || undefined,
          country: this.unfoldAndDecode(adrMatch[7].trim()) || undefined,
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
    // Extract VERSION from vCard data
    const versionMatch = vcard.match(/^VERSION[:\s](\d+\.\d+)/im);
    if (versionMatch && versionMatch[1]) {
      const version = versionMatch[1];
      // Normalize to either 3.0 or 4.0
      if (version.startsWith('3')) return '3.0';
      if (version.startsWith('4')) return '4.0';
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
   * Used for config-derived paths (e.g., .well-known/carddav).
   * Rule B: APPEND the path to the base, preserving any subpath prefix.
   * For CardDAV collections, always add trailing slash (RFC 4918).
   */
  private buildUrl(path: string): string {
    // Handle empty path case
    if (path === '') {
      return this.config.url.replace(/\/$/, '');
    }
    
    const baseUrl = this.config.url.endsWith('/') 
      ? this.config.url.slice(0, -1)
      : this.config.url;
    
    // Remove leading slash from relative path to avoid double slash
    const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
    
    // Remove trailing slash from path for now - we'll add it back for collections
    const pathWithoutTrailingSlash = normalizedPath.replace(/\/$/, '');
    
    const result = baseUrl + '/' + pathWithoutTrailingSlash;
    
    // For CardDAV collections (non-.well-known paths), add trailing slash
    // .well-known paths should NOT have trailing slash
    if (!pathWithoutTrailingSlash.includes('.well-known')) {
      return result + '/';
    }
    
    return result;
  }

  /**
   * Resolve a server-returned href against the base URL's origin.
   * Used for hrefs returned by the server in PROPFIND multistatus responses.
   * Rule A: REPLACE the base path with the server-returned path.
   */
  private resolveHref(href: string): string {
    // If href is already a full URL, return it as-is
    if (href.startsWith('http://') || href.startsWith('https://')) {
      return href;
    }
    
    const origin = new URL(this.config.url).origin;
    // Normalize href to ensure it starts with /
    const normalizedHref = href.startsWith('/') ? href : '/' + href;
    return new URL(normalizedHref, origin).toString();
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
   * Check if a collection name indicates it's an internal Nextcloud collection.
   * These are auto-created by Nextcloud and should be filtered out.
   */
  private isInternalCollection(name: string): boolean {
    // Nextcloud internal address book collections
    const internalPatterns = [
      /^z-server-generated--system$/,
      /^z-app-generated--contactsinteraction--recent$/,
      /^contact_birthdays$/,
    ];
    return internalPatterns.some(pattern => pattern.test(name));
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
