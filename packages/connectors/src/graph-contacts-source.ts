/**
 * Graph Contacts Source Connector Implementation
 * 
 * Implements ContactSource interface for Microsoft Graph Contacts synchronization.
 * Uses Microsoft Graph API v1.0 with delta query for incremental synchronization.
 * 
 * Features:
 * - Contact folder enumeration via /me/contactFolders endpoint
 * - Delta query for incremental contact synchronization
 * - vCard 4.0 format generation from Graph contacts
 * - Photo handling with BASE64 encoding
 * - UID mapping (Graph id used as fallback when vCard UID is absent)
 * - Multi-value field support (emails, phones, addresses)
 * - Rate limiting and throttling support
 * 
 * UID Mapping Note:
 * When a contact's vCard does not contain a UID property, the Graph contact's
 * `id` field is used as the UID. This ensures each contact has a unique identifier
 * for idempotency tracking.
 */

import type { ContactSource, ContactFolder, RawContact, SyncCursor, ContactPhone, ContactEmail, ContactAddress, ContactUrl, EmailType, UrlType, Contact } from '@openmig/shared';
import type { TokenProvider } from '@openmig/shared';
import type { GraphContactsSourceConfig, GraphContactFolder, GraphContact, GraphContactsDeltaCursor, VCardFieldMapping, GraphContactWithPhoto } from './graph-contacts-source.types';
import type { HttpClient, HttpRequestOptions, HttpResponse } from './dav-http.types';
import type { ThrottleLimiter } from '@openmig/shared';

/**
 * Graph contacts source connector implementation.
 */
export class GraphContactsSource implements ContactSource {
  private readonly config: GraphContactsSourceConfig;
  private readonly tokenProvider: TokenProvider;
  private readonly httpClient: HttpClient;
  private readonly baseUrl: string;
  private readonly throttleLimiter?: ThrottleLimiter;
  private readonly provider: string;

  constructor(
    tokenProvider: TokenProvider,
    tenantId: string,
    options?: { baseUrl?: string; throttleLimiter?: ThrottleLimiter },
    deps?: { httpClient?: HttpClient },
  ) {
    this.tokenProvider = tokenProvider;
    this.config = {
      baseUrl: options?.baseUrl,
      tenantId,
    };
    this.baseUrl = options?.baseUrl?.replace(/\/$/, '') ?? 'https://graph.microsoft.com/v1.0';
    this.httpClient = deps?.httpClient ?? createDefaultHttpClient();
    this.throttleLimiter = options?.throttleLimiter;
    this.provider = this.extractProviderFromBaseUrl(this.baseUrl);
  }

  /**
   * Enumerate all contact folders.
   * Uses /me/contactFolders endpoint to list all contact folders.
   */
  async listFolders(): Promise<ReadonlyArray<ContactFolder>> {
    const folders: GraphContactFolder[] = [];
    let nextLink: string | undefined;

    // Paginate through all contact folders
    do {
      const url = nextLink ?? `${this.baseUrl}/me/contactFolders`;
      const response = await this.makeRequest({
        url,
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });

      if (response.status !== 200) {
        throw new Error(`Failed to list contact folders: ${response.status} - ${response.body}`);
      }

      const data = JSON.parse(response.body) as { value: GraphContactFolder[]; '@odata.nextLink'?: string };
      folders.push(...data.value);
      nextLink = data['@odata.nextLink'];
    } while (nextLink);

    // Convert to ContactFolder format
    return folders.map(folder => ({
      path: `/contactFolders/${folder.id}`,
      name: folder.name,
      description: undefined,
      supportedVersions: ['4.0'], // We generate vCard 4.0
    }));
  }

  /**
   * List contacts changed since cursor (or all if undefined).
   * Uses delta query for incremental synchronization.
   * Generates vCard 4.0 format from Graph contacts.
   */
  async listSince(
    folder: ContactFolder,
    cursor?: SyncCursor,
  ): Promise<{ items: ReadonlyArray<RawContact>; nextCursor: SyncCursor }> {
    // Parse cursor to get delta link
    let deltaLink: string | undefined;
    
    if (cursor) {
      try {
        const graphCursor = this.decodeCursor(cursor);
        deltaLink = graphCursor.deltaLink;
      } catch {
        // Invalid cursor, do full sync
        deltaLink = undefined;
      }
    }

    // Extract folder ID from path
    const folderId = this.extractFolderIdFromFolder(folder);
    
    // Build the delta query URL
    const baseUrl = `${this.baseUrl}/me/contactFolders/${folderId}/contacts`;
    const url = deltaLink ?? `${baseUrl}/$delta`;

    const contacts: GraphContact[] = [];
    let nextLink: string | undefined;
    let lastDeltaLink: string | undefined;

    // Paginate through all contacts
    do {
      const response = await this.makeRequest({
        url,
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });

      if (response.status !== 200) {
        throw new Error(`Failed to list contacts: ${response.status} - ${response.body}`);
      }

      const data = JSON.parse(response.body) as { value: GraphContact[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string };
      contacts.push(...data.value);
      lastDeltaLink = data['@odata.deltaLink'];
      nextLink = data['@odata.nextLink'];
    } while (nextLink);

    // Generate vCard 4.0 for each contact (metadata-only, no photo fetch)
    const items: RawContact[] = [];
    for (const contact of contacts) {
      try {
        // Map to vCard 4.0 without photo (photo fetched lazily via fetch() method)
        const vcard = this.mapToVCard4(contact);
        
        const item: RawContact = {
          item: {
            uid: this.extractUidFromVCard(vcard),
            type: 'person',
            name: contact.displayName || contact.givenName || 'Unknown',
            givenName: contact.givenName,
            familyName: contact.surname,
            nickname: contact.nickname,
            organization: contact.companyName ? {
              name: contact.companyName,
              title: contact.jobTitle,
              department: contact.department,
            } : undefined,
            phones: this.mapPhones(contact),
            emails: this.mapEmails(contact),
            addresses: this.mapAddresses(contact),
            urls: this.mapUrls(contact),
            note: contact.personalNotes,
            birthday: contact.birthday,
            // Photo is NOT fetched here - use fetch() method instead
            photo: undefined,
            categories: contact.categories,
            sourcePath: `/contactFolders/${folderId}/contacts/${contact.id}`,
            vcard,
            version: '4.0',
          },
          vcard,
        };

        items.push(item);
      } catch (error) {
        // Skip contacts that fail to process
        console.warn(`Failed to process contact ${contact.id}:`, error);
      }
    }

    // Create next cursor from delta link
    const nextCursor: SyncCursor = {
      value: this.encodeCursor({
        deltaLink: lastDeltaLink ?? '',
        folderPath: folder.path,
      }),
    };

    return { items, nextCursor };
  }

  /**
   * Fetch full raw data for a contact including photo (implements ContactSource interface).
   */
  async fetch(item: Contact): Promise<RawContact> {
    // Extract contact ID from sourcePath
    const sourcePath = item.sourcePath;
    if (!sourcePath) {
      throw new Error(`Contact missing sourcePath: ${JSON.stringify(item)}`);
    }

    // Extract folder ID and contact ID from sourcePath (format: /contactFolders/{folderId}/contacts/{contactId})
    const match = sourcePath.match(/\/contactFolders\/([^/]+)\/contacts\/([^/]+)$/);
    if (!match) {
      throw new Error(`Invalid sourcePath format: ${sourcePath}`);
    }

    const folderId = match[1]!;
    const contactId = match[2]!;

    // Fetch photo
    const contactWithPhoto = await this.fetchContactWithPhoto({ id: contactId } as GraphContact, folderId);

    // Re-map vCard with photo
    const vcard = this.mapToVCard4(contactWithPhoto);

    return {
      item: {
        ...item,
        photo: contactWithPhoto.photoData ? {
          data: contactWithPhoto.photoData,
          mimeType: contactWithPhoto.photoMimeType || 'image/jpeg',
        } : item.photo,
        vcard,
      },
      vcard,
    };
  }

  // Private helper methods

  /**
   * Make an authenticated HTTP request to Graph API.
   */
  private async makeRequest(options: HttpRequestOptions): Promise<HttpResponse> {
    const token = await this.tokenProvider.getToken();

    // If throttling is enabled, use the throttle limiter
    if (this.throttleLimiter) {
      return this.throttleLimiter.executeWithThrottling(
        this.config.tenantId,
        this.provider,
        async () => {
          const response = await this.httpClient.request({
            ...options,
            headers: {
              'Authorization': `Bearer ${token.accessToken}`,
              ...options.headers,
            },
          });
          
          // Check for rate limited response
          if (response.status === 429 || response.status === 503) {
            const retryAfter = response.headers['retry-after'] as string | undefined;
            const waitTime = this.throttleLimiter!.handleRateLimited(response.status, retryAfter);
            return {
              status: response.status,
              headers: response.headers,
              body: response.body,
              _retryAfterMs: waitTime, // Internal property for tracking
            };
          }
          
          return response;
        }
      );
    }

    const response = await this.httpClient.request({
      ...options,
      headers: {
        'Authorization': `Bearer ${token.accessToken}`,
        ...options.headers,
      },
    });

    // Handle 429/503 responses with Retry-After (without throttle limiter)
    if ((response.status === 429 || response.status === 503)) {
      const retryAfter = response.headers['retry-after'] as string | undefined;
      const waitTime = retryAfter ? this.parseRetryAfterHeader(retryAfter) : 60000;
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return this.makeRequest(options); // Retry
    }

    return response;
  }

  /**
   * Parse Retry-After header value.
   */
  private parseRetryAfterHeader(headerValue: string): number {
    // Try to parse as seconds (integer)
    const seconds = parseInt(headerValue, 10);
    if (!isNaN(seconds)) {
      return seconds * 1000;
    }

    // Try to parse as HTTP-date
    try {
      const date = new Date(headerValue);
      if (!isNaN(date.getTime())) {
        const now = Date.now();
        const retryAt = date.getTime();
        return Math.max(0, retryAt - now);
      }
    } catch {
      // Ignore parsing errors
    }

    // Default to 60 seconds if parsing fails
    return 60000;
  }

  /**
   * Extract provider domain from base URL.
   */
  private extractProviderFromBaseUrl(baseUrl: string): string {
    try {
      const url = new URL(baseUrl);
      return url.hostname;
    } catch {
      return 'unknown';
    }
  }

  /**
   * Extract folder ID from folder path.
   */
  private extractFolderIdFromFolder(folder: ContactFolder): string {
    // Try to extract from path like /contactFolders/{id}
    const match = folder.path.match(/\/contactFolders\/([^/]+)/);
    if (match && match[1]) {
      return match[1];
    }
    // Fallback to folder name
    return folder.name || 'contacts';
  }

  /**
   * Fetch contact photo if available.
   */
  private async fetchContactWithPhoto(contact: GraphContact, folderId: string): Promise<GraphContact & { photoData?: string; photoMimeType?: string }> {
    const result: GraphContact & { photoData?: string; photoMimeType?: string } = { ...contact };

    // Try to get photo from the photo endpoint
    if (contact.photo?.id || contact.id) {
      try {
        const photoUrl = `${this.baseUrl}/me/contactFolders/${folderId}/contacts/${contact.id}/photo/$value`;
        const response = await this.makeRequest({
          url: photoUrl,
          method: 'GET',
          headers: {
            'Accept': 'image/*, application/json',
          },
        });

        if (response.status === 200) {
          // Get content type
          const contentType = response.headers['content-type'] || 'image/jpeg';
          
          // Convert binary data to base64
          let binaryData: string;
          if (typeof response.body === 'string') {
            binaryData = response.body;
          } else {
            // Handle ArrayBuffer or other binary formats
            binaryData = this.arrayBufferToBase64(response.body as ArrayBuffer);
          }

          result.photoData = binaryData;
          result.photoMimeType = contentType.startsWith('image/') ? contentType : 'image/jpeg';
        }
      } catch {
        // Photo fetch failed, continue without photo
        // This is expected for contacts without photos
      }
    }

    return result;
  }

  /**
   * Convert ArrayBuffer to base64 string.
   */
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(Number(bytes[i]));
    }
    return this.btoa(binary);
  }

  /**
   * Base64 encode a string.
   */
  private btoa(str: string): string {
    return Buffer.from(str, 'binary').toString('base64');
  }

  /**
   * Map Graph contact to vCard 4.0 format.
   */
  private mapToVCard4(contact: GraphContact & { photoData?: string; photoMimeType?: string }): string {
    const mapping = this.mapContactToVCardFields(contact);
    
    const lines: string[] = [];
    
    // vCard header
    lines.push('BEGIN:VCARD');
    lines.push('VERSION:4.0');
    
    // UID - use Graph id if vCard UID is absent (documented design choice)
    lines.push(`UID:${this.escapeVCardValue(mapping.uid)}`);
    
    // FN (Formatted Name) - required in vCard 4.0
    lines.push(`FN:${this.escapeVCardValue(mapping.fn)}`);
    
    // N (Name components)
    const n = mapping.n;
    lines.push(`N:${this.escapeVCardValue(n.family)};${this.escapeVCardValue(n.given)};${this.escapeVCardValue(n.additional.join(' '))};;`);
    
    // ORG (Organization)
    if (mapping.org) {
      const orgValue = `${this.escapeVCardValue(mapping.org.name)}${mapping.org.department ? `;${this.escapeVCardValue(mapping.org.department)}` : ''}`;
      lines.push(`ORG:${orgValue}`);
    }
    
    // TITLE
    if (mapping.title) {
      lines.push(`TITLE:${this.escapeVCardValue(mapping.title)}`);
    }
    
    // TEL (Phone numbers)
    if (mapping.tel) {
      for (const tel of mapping.tel) {
        const params = this.formatVCardParams(tel.params);
        lines.push(`TEL${params}:${this.escapeVCardValue(tel.value)}`);
      }
    }
    
    // EMAIL (Email addresses)
    if (mapping.email) {
      for (const email of mapping.email) {
        const params = this.formatVCardParams(email.params);
        lines.push(`EMAIL${params}:${this.escapeVCardValue(email.value)}`);
      }
    }
    
    // ADR (Addresses)
    if (mapping.adr) {
      for (const adr of mapping.adr) {
        const params = this.formatVCardParams(adr.params);
        const addr = adr.value;
        lines.push(`ADR${params}:;;${this.escapeVCardValue(addr.street)};${this.escapeVCardValue(addr.city)};${this.escapeVCardValue(addr.region)};${this.escapeVCardValue(addr.postal)};${this.escapeVCardValue(addr.country)}`);
      }
    }
    
    // URL
    if (mapping.url) {
      for (const url of mapping.url) {
        const params = this.formatVCardParams(url.params);
        lines.push(`URL${params}:${this.escapeVCardValue(url.value)}`);
      }
    }
    
    // NOTE
    if (mapping.note) {
      lines.push(`NOTE:${this.escapeVCardValue(mapping.note)}`);
    }
    
    // BDAY (Birthday)
    if (mapping.bday) {
      lines.push(`BDAY:${this.escapeVCardValue(mapping.bday)}`);
    }
    
    // PHOTO (Base64 encoded)
    if (mapping.photo) {
      const photoParams = `;ENCODING=base64;TYPE=${mapping.photo.mimeType}`;
      lines.push(`PHOTO${photoParams}:${mapping.photo.data}`);
    }
    
    // CATEGORIES
    if (mapping.categories && mapping.categories.length > 0) {
      const cats = mapping.categories.map(c => this.escapeVCardValue(c)).join(',');
      lines.push(`CATEGORIES:${cats}`);
    }
    
    // End vCard
    lines.push('END:VCARD');
    
    return lines.join('\r\n');
  }

  /**
   * Map Graph contact to vCard field mapping structure.
   */
  private mapContactToVCardFields(contact: GraphContactWithPhoto): VCardFieldMapping {
    // Extract name components
    const givenName = contact.givenName || '';
    const familyName = contact.surname || '';
    const additionalNames = contact.middleName ? [contact.middleName] : [];
    
    // Build formatted name (FN)
    const fn = this.buildFormattedName(contact.displayName, givenName, familyName);
    
    // UID: Use Graph id if vCard UID is absent (documented design choice)
    // This ensures each contact has a unique identifier
    const uid = contact.id;
    
    const mapping: VCardFieldMapping = {
      uid,
      fn,
      n: {
        family: familyName,
        given: givenName,
        additional: additionalNames,
        prefix: [],
        suffix: [],
      },
      title: contact.jobTitle,
      tel: this.mapPhonesToVCard(contact),
      email: this.mapEmailsToVCard(contact),
      adr: this.mapAddressesToVCard(contact),
      url: this.mapUrlsToVCard(contact),
      note: contact.personalNotes,
      bday: contact.birthday,
      categories: contact.categories,
    };
    
    // Add photo if available
    if (contact.photoData) {
      mapping.photo = {
        data: contact.photoData,
        mimeType: contact.photoMimeType || 'image/jpeg',
      };
    }
    
    // Add organization
    if (contact.companyName) {
      mapping.org = {
        name: contact.companyName,
        department: contact.department,
      };
    }
    
    return mapping;
  }

  /**
   * Build formatted name from components.
   */
  private buildFormattedName(displayName: string | undefined, givenName: string, familyName: string): string {
    if (displayName) {
      return displayName;
    }
    if (givenName && familyName) {
      return `${givenName} ${familyName}`;
    }
    if (givenName) {
      return givenName;
    }
    if (familyName) {
      return familyName;
    }
    return 'Unknown';
  }

  /**
   * Extract UID from vCard string.
   */
  private extractUidFromVCard(vcard: string): string {
    const uidMatch = vcard.match(/^UID:(.+)$/m);
    if (uidMatch && uidMatch[1]) {
      return uidMatch[1];
    }
    // Fallback (shouldn't happen as we always set UID)
    return '';
  }

  /**
   * Map Graph phones to vCard format.
   */
  private mapPhones(contact: GraphContact): ReadonlyArray<ContactPhone> {
    const phones: ContactPhone[] = [];
    
    // Business phones
    if (contact.businessPhones) {
      for (const phone of contact.businessPhones) {
        phones.push({ value: phone, type: 'work' });
      }
    }
    
    // Mobile phone
    if (contact.mobilePhone) {
      phones.push({ value: contact.mobilePhone, type: 'mobile' });
    }
    
    // Home phones
    if (contact.homePhones) {
      for (const phone of contact.homePhones) {
        phones.push({ value: phone, type: 'home' });
      }
    }
    
    // Other phones
    if (contact.otherPhones) {
      for (const phone of contact.otherPhones) {
        phones.push({ value: phone, type: 'other' });
      }
    }
    
    return phones;
  }

  /**
   * Map phones to vCard TEL entries.
   */
  private mapPhonesToVCard(contact: GraphContact): Array<{ value: string; params: Record<string, string | string[]> }> {
    const telEntries: Array<{ value: string; params: Record<string, string | string[]> }> = [];
    
    // Business phones
    if (contact.businessPhones) {
      for (const phone of contact.businessPhones) {
        telEntries.push({
          value: phone,
          params: { TYPE: 'work' },
        });
      }
    }
    
    // Mobile phone
    if (contact.mobilePhone) {
      telEntries.push({
        value: contact.mobilePhone,
        params: { TYPE: 'cell' },
      });
    }
    
    // Home phones
    if (contact.homePhones) {
      for (const phone of contact.homePhones) {
        telEntries.push({
          value: phone,
          params: { TYPE: 'home' },
        });
      }
    }
    
    // Other phones
    if (contact.otherPhones) {
      for (const phone of contact.otherPhones) {
        telEntries.push({
          value: phone,
          params: { TYPE: 'other' },
        });
      }
    }
    
    return telEntries;
  }

  /**
   * Map Graph emails to vCard format.
   */
  private mapEmails(contact: GraphContact): ReadonlyArray<ContactEmail> {
    const emails: ContactEmail[] = [];
    
    if (contact.emailAddresses) {
      for (const email of contact.emailAddresses) {
        const type = this.mapEmailType(email.type);
        emails.push({
          value: email.address,
          type,
          label: email.name,
        });
      }
    }
    
    return emails;
  }

  /**
   * Map emails to vCard EMAIL entries.
   */
  private mapEmailsToVCard(contact: GraphContact): Array<{ value: string; params: Record<string, string | string[]> }> {
    const emailEntries: Array<{ value: string; params: Record<string, string | string[]> }> = [];
    
    if (contact.emailAddresses) {
      for (const email of contact.emailAddresses) {
        const type = this.mapEmailType(email.type);
        emailEntries.push({
          value: email.address,
          params: { TYPE: type },
        });
      }
    }
    
    return emailEntries;
  }

  /**
   * Map Graph email type to vCard type.
   */
  private mapEmailType(graphType: string | undefined): EmailType {
    switch (graphType?.toLowerCase()) {
      case 'home':
        return 'home';
      case 'work':
        return 'work';
      default:
        return 'other';
    }
  }

  /**
   * Map Graph addresses to vCard format.
   */
  private mapAddresses(contact: GraphContact): ReadonlyArray<ContactAddress> {
    const addresses: ContactAddress[] = [];
    
    // Business address
    if (contact.businessAddress) {
      addresses.push({
        type: 'work',
        street: contact.businessAddress.street,
        city: contact.businessAddress.city,
        region: contact.businessAddress.state,
        postalCode: contact.businessAddress.postalCode,
        country: contact.businessAddress.countryOrRegion,
      });
    }
    
    // Home address
    if (contact.homeAddress) {
      addresses.push({
        type: 'home',
        street: contact.homeAddress.street,
        city: contact.homeAddress.city,
        region: contact.homeAddress.state,
        postalCode: contact.homeAddress.postalCode,
        country: contact.homeAddress.countryOrRegion,
      });
    }
    
    // Other address
    if (contact.otherAddress) {
      addresses.push({
        type: 'other',
        street: contact.otherAddress.street,
        city: contact.otherAddress.city,
        region: contact.otherAddress.state,
        postalCode: contact.otherAddress.postalCode,
        country: contact.otherAddress.countryOrRegion,
      });
    }
    
    return addresses;
  }

  /**
   * Map addresses to vCard ADR entries.
   */
  private mapAddressesToVCard(contact: GraphContact): Array<{ params: Record<string, string | string[]>; value: { street: string; city: string; region: string; postal: string; country: string } }> {
    const adrEntries: Array<{ params: Record<string, string | string[]>; value: { street: string; city: string; region: string; postal: string; country: string } }> = [];
    
    // Business address
    if (contact.businessAddress) {
      adrEntries.push({
        params: { TYPE: 'work' },
        value: {
          street: contact.businessAddress.street || '',
          city: contact.businessAddress.city || '',
          region: contact.businessAddress.state || '',
          postal: contact.businessAddress.postalCode || '',
          country: contact.businessAddress.countryOrRegion || '',
        },
      });
    }
    
    // Home address
    if (contact.homeAddress) {
      adrEntries.push({
        params: { TYPE: 'home' },
        value: {
          street: contact.homeAddress.street || '',
          city: contact.homeAddress.city || '',
          region: contact.homeAddress.state || '',
          postal: contact.homeAddress.postalCode || '',
          country: contact.homeAddress.countryOrRegion || '',
        },
      });
    }
    
    // Other address
    if (contact.otherAddress) {
      adrEntries.push({
        params: { TYPE: 'other' },
        value: {
          street: contact.otherAddress.street || '',
          city: contact.otherAddress.city || '',
          region: contact.otherAddress.state || '',
          postal: contact.otherAddress.postalCode || '',
          country: contact.otherAddress.countryOrRegion || '',
        },
      });
    }
    
    return adrEntries;
  }

  /**
   * Map Graph URLs to vCard format.
   */
  private mapUrls(contact: GraphContact): ReadonlyArray<ContactUrl> {
    const urls: ContactUrl[] = [];
    
    if (contact.websites) {
      for (const website of contact.websites) {
        const type = this.mapUrlType(website.type);
        urls.push({
          value: website.address,
          type,
        });
      }
    }
    
    return urls;
  }

  /**
   * Map URLs to vCard URL entries.
   */
  private mapUrlsToVCard(contact: GraphContact): Array<{ value: string; params: Record<string, string | string[]> }> {
    const urlEntries: Array<{ value: string; params: Record<string, string | string[]> }> = [];
    
    if (contact.websites) {
      for (const website of contact.websites) {
        const type = this.mapUrlType(website.type);
        urlEntries.push({
          value: website.address,
          params: { TYPE: type },
        });
      }
    }
    
    return urlEntries;
  }

  /**
   * Map Graph website type to vCard type.
   */
  private mapUrlType(graphType: string | undefined): UrlType {
    switch (graphType?.toLowerCase()) {
      case 'home':
        return 'home';
      case 'work':
        return 'work';
      case 'profile':
        return 'profile';
      default:
        return 'other';
    }
  }

  /**
   * Escape a value for vCard format.
   */
  private escapeVCardValue(value: string): string {
    if (!value) {
      return '';
    }
    // Escape special characters: backslash, semicolon, comma, newline
    return value
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '');
  }

  /**
   * Format vCard parameters.
   */
  private formatVCardParams(params: Record<string, string | string[]>): string {
    const parts: string[] = [];
    
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) {
        parts.push(`${key}=${value.join(',')}`);
      } else {
        parts.push(`${key}=${value}`);
      }
    }
    
    return parts.length > 0 ? `;${parts.join(';')}` : '';
  }

  /**
   * Encode cursor for storage.
   */
  private encodeCursor(cursor: GraphContactsDeltaCursor): string {
    return `graph-contacts-delta:${cursor.folderPath}:${cursor.deltaLink}`;
  }

  /**
   * Decode cursor from storage.
   */
  private decodeCursor(cursor: SyncCursor): GraphContactsDeltaCursor {
    const value = cursor.value;

    if (!value.startsWith('graph-contacts-delta:')) {
      throw new Error(`Invalid cursor format: ${value}`);
    }

    const parts = value.slice('graph-contacts-delta:'.length).split(':');
    if (parts.length < 2) {
      throw new Error(`Invalid cursor format: ${value}`);
    }

    const folderPath = parts[0]!;
    const deltaLink = parts.slice(1).join(':');

    return {
      deltaLink,
      folderPath,
    };
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
