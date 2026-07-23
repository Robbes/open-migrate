/**
 * CalDAV Source Connector Implementation
 * 
 * Implements CalendarSource interface for CalDAV calendar synchronization.
 * Follows RFC 4791 (CalDAV) and RFC 6578 (Collection Synchronization).
 * 
 * Features:
 * - Calendar home set discovery via PROPFIND
 * - Incremental sync using sync-collection REPORT (RFC 6578)
 * - CTag fallback when sync-token not supported
 * - Case-insensitive UID handling (UIDs are lowercased for comparison)
 */

import type { CalendarSource, CalendarFolder, SyncCursor, RawCalendarEvent } from '@openmig/shared';
import type { CalDAVSourceConfig, CalDAVSyncToken, CalDAVCalendarObject } from './caldav-source.types';
import type { HttpClient, HttpRequestOptions, HttpResponse } from './dav-http.types';

/**
 * CalDAV source connector implementation.
 */
export class CalDAVSource implements CalendarSource {
  private readonly config: CalDAVSourceConfig;
  private readonly httpClient: HttpClient;
  private calendarHomeSet: string | null = null;

  constructor(
    config: CalDAVSourceConfig,
    deps?: { httpClient?: HttpClient },
  ) {
    this.config = config;
    this.httpClient = deps?.httpClient ?? createDefaultHttpClient();
  }

  /**
   * Enumerate calendar folders (collections) with discovery.
   * Discovers calendar home set if not provided in config.
   */
  async listFolders(): Promise<ReadonlyArray<CalendarFolder>> {
    // Discover calendar home set if not configured
    if (!this.calendarHomeSet) {
      await this.discoverCalendarHomeSet();
    }

    if (!this.calendarHomeSet) {
      throw new Error('Failed to discover calendar home set');
    }

    // List all calendar collections under the home set
    return await this.listCollections(this.calendarHomeSet);
  }

  /**
   * List calendar items changed since cursor (or all if undefined).
   * Uses sync-collection REPORT (RFC 6578) for incremental sync.
   * Falls back to CTag if sync-token not supported.
   */
  async listSince(
    folder: CalendarFolder,
    cursor?: SyncCursor,
  ): Promise<{ items: ReadonlyArray<RawCalendarEvent>; nextCursor: SyncCursor }> {
    if (!this.calendarHomeSet) {
      await this.discoverCalendarHomeSet();
    }

    if (!this.calendarHomeSet) {
      throw new Error('Failed to discover calendar home set');
    }

    // Build the collection path from folder
    const collectionPath = this.buildCollectionPath(folder, this.calendarHomeSet);

    // Perform sync-collection REPORT
    const result = await this.syncCollection(collectionPath, cursor);

    // Parse the response and extract calendar events
    const items: RawCalendarEvent[] = [];
    for (const obj of result.objects) {
      const event = this.parseCalendarObject(obj);
      if (event) {
        items.push(event);
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
   * Discover the calendar home set using RFC 6764 well-known URIs.
   * First tries /.well-known/caldav, then falls back to PROPFIND on base URL.
   * RFC 6764 Section 4.1
   */
  private async discoverCalendarHomeSet(): Promise<void> {
    // Step 1: Try RFC 6764 well-known URI discovery
    try {
      const wellKnownUrl = this.buildUrl('.well-known/caldav');
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
          // Step 2: PROPFIND the principal to get calendar-home-set
          const homeSet = await this.discoverHomeSetFromPrincipal(principalUrl);
          if (homeSet) {
            this.calendarHomeSet = homeSet;
            return;
          }
        }
      } else if (response.status === 200 || response.status === 204) {
        // Well-known URI exists but may not redirect - try PROPFIND on it
        const homeSet = await this.discoverHomeSetFromPrincipal(wellKnownUrl);
        if (homeSet) {
          this.calendarHomeSet = homeSet;
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
          <C:calendar-home-set xmlns:C="urn:ietf:params:xml:ns:caldav"/>
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
      const homeSet = this.parseCalendarHomeSetResponse(response.body);
      if (homeSet) {
        this.calendarHomeSet = homeSet;
      } else {
        // Final fallback: construct calendar home set from username
        // Nextcloud typically serves calendars at /remote.php/dav/calendars/{username}/
        const baseUrl = this.config.url.replace(/\/$/, '');
        this.calendarHomeSet = `${baseUrl}/calendars/${this.config.username}/`;
      }
    } else if (response.status === 404) {
      // PROPFIND failed with 404, use fallback constructed URL
      const baseUrl = this.config.url.replace(/\/$/, '');
      this.calendarHomeSet = `${baseUrl}/calendars/${this.config.username}/`;
    } else {
      throw new Error(`PROPFIND failed with status ${response.status}: ${response.body}`);
    }
  }

  /**
   * Discover calendar-home-set by PROPFINDing a principal URL.
   * Used after following RFC 6764 well-known redirect.
   */
  private async discoverHomeSetFromPrincipal(principalUrl: string): Promise<string | null> {
    const propfind = `<?xml version="1.0" encoding="utf-8"?>
      <D:propfind xmlns:D="DAV:">
        <D:prop>
          <C:calendar-home-set xmlns:C="urn:ietf:params:xml:ns:caldav"/>
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

    return this.parseCalendarHomeSetResponse(response.body);
  }

  /**
   * List all calendar collections under a home set.
   * Uses PROPFIND with Depth: 1 to find MKCALENDAR collections.
   */
  private async listCollections(homeSet: string): Promise<CalendarFolder[]> {
    const propfind = `<?xml version="1.0" encoding="utf-8"?>
      <D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
        <D:prop>
          <D:displayname/>
          <D:resourcetype/>
          <C:calendar-description/>
          <C:calendar-timezone/>
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
  ): Promise<{ objects: CalDAVCalendarObject[]; syncToken?: string; ctag?: string }> {
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
    // Use empty string for full sync, actual token for incremental sync
    const syncTokenElement = syncToken
      ? `<D:sync-token>${this.escapeXml(syncToken)}</D:sync-token>`
      : '<D:sync-token/>';

    const ctagElement = ctag
      ? `<C:expand xmlns:C="urn:ietf:params:xml:ns:caldav" start="19700101T000000Z" end="20991231235959Z"/>`
      : '';

    return `<?xml version="1.0" encoding="utf-8"?>
      <D:sync-collection xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
        <D:prop>
          <D:resourcetype/>
          <C:calendar-data>
            ${ctagElement}
          </C:calendar-data>
        </D:prop>
        ${syncTokenElement}
      </D:sync-collection>`;
  }

  /**
   * Parse calendar home set from PROPFIND response.
   */
  private parseCalendarHomeSetResponse(body: string): string | null {
    // Look for calendar-home-set in the response
    const match = body.match(/<C:calendar-home-set[^>]*>([^<]+)<\/C:calendar-home-set>/i);
    if (match && match[1]) {
      return this.normalizePath(match[1].trim());
    }
    return null;
  }

  /**
   * Parse collections from PROPFIND multi-status response.
   */
  private parseCollectionsResponse(body: string, _homeSet: string): CalendarFolder[] {
    const folders: CalendarFolder[] = [];

    // Extract all response elements - namespace-agnostic regex
    const responseRegex = /<[A-Za-z]+:response[^>]*>([\s\S]*?)<\/[A-Za-z]+:response>/gi;
    let match: RegExpExecArray | null;

    while ((match = responseRegex.exec(body)) !== null) {
      const responseXml = match[1];
      if (!responseXml) continue;

      // Extract href - namespace-agnostic
      const hrefMatch = responseXml.match(/<[A-Za-z]+:href>([^<]+)<\/[A-Za-z]+:href>/i);
      if (!hrefMatch || !hrefMatch[1]) continue;

      const href = hrefMatch[1].trim();
      
      // Check if this is a calendar collection (has calendar-collection or calendar type) - namespace-agnostic
      const isCalendarCollection = /<[A-Za-z]+:calendar-collection|<calendar-collection|<[A-Za-z]+:calendar\/|<calendar\//i.test(responseXml);
      
      // Skip if not a calendar collection or if it's the home set itself
      if (!isCalendarCollection) continue;

      // Extract display name - namespace-agnostic
      const displayNameMatch = responseXml.match(/<[A-Za-z]+:displayname[^>]*>([^<]*)<\/[A-Za-z]+:displayname>/i);
      const displayName = displayNameMatch && displayNameMatch[1] ? displayNameMatch[1].trim() : undefined;

      // Extract description - namespace-agnostic
      const descriptionMatch = responseXml.match(/<[A-Za-z]+:calendar-description[^>]*>([^<]*)<\/[A-Za-z]+:calendar-description>/i);
      const description = descriptionMatch && descriptionMatch[1] ? descriptionMatch[1].trim() : undefined;

      // Extract timezone - namespace-agnostic
      const timezoneMatch = responseXml.match(/<[A-Za-z]+:calendar-timezone[^>]*>([^<]*)<\/[A-Za-z]+:calendar-timezone>/i);
      const timezone = timezoneMatch && timezoneMatch[1] ? timezoneMatch[1].trim() : undefined;

      // Extract color - namespace-agnostic
      const colorMatch = responseXml.match(/<[A-Za-z]+:color[^>]*>([^<]*)<\/[A-Za-z]+:color>/i);
      const color = colorMatch && colorMatch[1] ? colorMatch[1].trim() : undefined;

      // Skip Nextcloud internal collections
      const name = displayName || this.extractNameFromPath(href);
      if (this.isInternalCollection(name)) continue;

      // Build the folder path
      const path = this.normalizePath(href);

      folders.push({
        path,
        name,
        description,
        timezone,
        color,
      });
    }

    return folders;
  }

  /**
   * Parse sync-collection REPORT response.
   */
  private parseSyncCollectionResponse(body: string): { objects: CalDAVCalendarObject[]; syncToken?: string; ctag?: string } {
    const objects: CalDAVCalendarObject[] = [];
    let syncToken: string | undefined;
    let ctag: string | undefined;

    // Extract sync-token if present - namespace-agnostic
    const syncTokenMatch = body.match(/<[A-Za-z]+:sync-token>([^<]+)<\/[A-Za-z]+:sync-token>/i);
    if (syncTokenMatch && syncTokenMatch[1]) {
      syncToken = syncTokenMatch[1].trim();
    }

    // Extract CTag if present (in Content-Mod-Time or other headers) - namespace-agnostic
    const ctagMatch = body.match(/<[A-Za-z]+:getetag>([^<]+)<\/[A-Za-z]+:getetag>/i);
    if (ctagMatch && ctagMatch[1]) {
      ctag = ctagMatch[1].trim();
    }

    // Extract all calendar objects - namespace-agnostic
    const responseRegex = /<[A-Za-z]+:response[^>]*>([\s\S]*?)<\/[A-Za-z]+:response>/gi;
    let match: RegExpExecArray | null;

    while ((match = responseRegex.exec(body)) !== null) {
      const responseXml = match[1];
      if (!responseXml) continue;

      // Extract href - namespace-agnostic
      const hrefMatch = responseXml.match(/<[A-Za-z]+:href>([^<]+)<\/[A-Za-z]+:href>/i);
      if (!hrefMatch || !hrefMatch[1]) continue;

      const href = hrefMatch[1].trim();

      // Extract calendar data - namespace-agnostic
      const calendarDataMatch = responseXml.match(/<[A-Za-z]+:calendar-data[^>]*>([\s\S]*?)<\/[A-Za-z]+:calendar-data>/i);
      if (!calendarDataMatch || !calendarDataMatch[1]) continue;

      const icalendar = this.parseCalendarData(calendarDataMatch[1]);

      objects.push({
        href,
        icalendar,
        syncToken,
      });
    }

    return { objects, syncToken, ctag };
  }

  /**
   * Parse iCalendar data from XML response.
   * Handles XML entity decoding and line folding.
   */
  private parseCalendarData(rawData: string): string {
    // Decode XML entities
    let icalendar = this.decodeXmlEntities(rawData);
    
    // Handle iCalendar line folding (lines starting with space/tab are continuations)
    icalendar = this.unfoldLines(icalendar);
    
    return icalendar;
  }

  /**
   * Unfold iCalendar lines (RFC 5545 Section 3.1).
   * Lines starting with whitespace are continuations of the previous line.
   */
  private unfoldLines(text: string): string {
    return text.replace(/[\r\n]+[ \t]+/g, '');
  }

  /**
   * Decode XML entities in iCalendar data.
   */
  private decodeXmlEntities(text: string): string {
    // Numeric character references (&#13; / &#x0D;) too, not just the five named entities —
    // see the identical fix + rationale in carddav-source.ts's decodeXmlEntities. Not yet
    // observed to bite here (Nextcloud's calendar-data responses haven't needed it in
    // practice), but the underlying XML-serialization behavior is server-side, not
    // domain-specific, so the same corruption is possible for any control character in an
    // event field.
    return text
      .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec: string) => String.fromCharCode(parseInt(dec, 10)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }

  /**
   * Parse a calendar object and extract event data.
   */
  private parseCalendarObject(obj: CalDAVCalendarObject): RawCalendarEvent | null {
    try {
      // Extract UID from iCalendar data
      const uid = this.extractUidFromIcalendar(obj.icalendar);
      if (!uid) {
        return null;
      }

      // Create the calendar event
      const event: RawCalendarEvent = {
        item: {
          uid: this.normalizeUid(uid), // Normalize UID to lowercase
          type: 'event',
          summary: this.extractSummary(obj.icalendar),
          start: this.extractStart(obj.icalendar),
          end: this.extractEnd(obj.icalendar),
          description: this.extractDescription(obj.icalendar),
          location: this.extractLocation(obj.icalendar),
          sourcePath: obj.href,
          icalendar: obj.icalendar,
        },
        icalendar: obj.icalendar,
      };

      return event;
    } catch {
      return null;
    }
  }

  /**
   * Extract UID from iCalendar data.
   * Returns the UID value (normalized to lowercase).
   */
  extractUidFromIcalendar(icalendar: string): string | null {
    // Match UID property at start of line (RFC 5545: properties start at beginning of line)
    const uidMatch = icalendar.match(/^[ \t]*UID[:\s]([^\r\n]+)/im);
    if (!uidMatch || !uidMatch[1]) {
      return null;
    }
    return uidMatch[1].trim();
  }

  /**
   * Normalize UID for case-insensitive comparison.
   * RFC 5545 states UID is case-insensitive.
   */
  normalizeUid(uid: string): string {
    return uid.toLowerCase();
  }

  /**
   * Extract summary from iCalendar data.
   */
  private extractSummary(icalendar: string): string {
    const match = icalendar.match(/SUMMARY[:\s]([^\r\n]+)/i);
    return match && match[1] ? match[1].trim() : 'Untitled Event';
  }

  /**
   * Extract start time from iCalendar data.
   */
  private extractStart(icalendar: string): string {
    // Try DTSTART first
    const startMatch = icalendar.match(/DTSTART(?:;[^:]+)?[:\s]([^\r\n]+)/i);
    if (startMatch && startMatch[1]) {
      return this.convertIcalDateToIso(startMatch[1].trim());
    }
    return new Date().toISOString();
  }

  /**
   * Extract end time from iCalendar data.
   */
  private extractEnd(icalendar: string): string | undefined {
    const endMatch = icalendar.match(/DTEND(?:;[^:]+)?[:\s]([^\r\n]+)/i);
    if (endMatch && endMatch[1]) {
      return this.convertIcalDateToIso(endMatch[1].trim());
    }
    return undefined;
  }

  /**
   * Extract description from iCalendar data.
   */
  private extractDescription(icalendar: string): string | undefined {
    const match = icalendar.match(/DESCRIPTION[:\s]([^\r\n]+)/i);
    return match && match[1] ? match[1].trim() : undefined;
  }

  /**
   * Extract location from iCalendar data.
   */
  private extractLocation(icalendar: string): string | undefined {
    const match = icalendar.match(/LOCATION[:\s]([^\r\n]+)/i);
    return match && match[1] ? match[1].trim() : undefined;
  }

  /**
   * Convert iCalendar date format to ISO 8601.
   */
  private convertIcalDateToIso(dateStr: string): string {
    // Handle both formats:
    // - Date-time: 20240101T120000Z or 20240101T120000
    // - Date: 20240101
    
    const dateOnlyMatch = dateStr.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (dateOnlyMatch) {
      // Date-only (all-day event)
      const year = dateOnlyMatch[1];
      const month = dateOnlyMatch[2];
      const day = dateOnlyMatch[3];
      return `${year}-${month}-${day}T00:00:00Z`;
    }

    const dateTimeMatch = dateStr.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
    if (dateTimeMatch) {
      const year = dateTimeMatch[1];
      const month = dateTimeMatch[2];
      const day = dateTimeMatch[3];
      const hour = dateTimeMatch[4];
      const minute = dateTimeMatch[5];
      const second = dateTimeMatch[6];
      const isUtc = dateTimeMatch[7] === 'Z';
      
      if (isUtc) {
        return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
      } else {
        return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
      }
    }

    // Fallback: return as-is or current time
    return new Date().toISOString();
  }

  /**
   * Build collection path from folder info.
   */
  private buildCollectionPath(folder: CalendarFolder, homeSet: string): string {
    // Use the folder path if available, otherwise construct from home set
    if (folder.path) {
      return this.normalizePath(folder.path);
    }
    return this.normalizePath(`${homeSet}${folder.name}/`);
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
  private decodeSyncToken(cursor: SyncCursor): CalDAVSyncToken {
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
    const password = this.config.password ?? (this.config.passwordEnv ? process.env[this.config.passwordEnv] : undefined);
    if (!password) {
      throw new Error(`No password configured (set config.password or config.passwordEnv)`);
    }
    const credentials = Buffer.from(`${this.config.username}:${password}`).toString('base64');
    return `Basic ${credentials}`;
  }

  /**
   * Build URL from path.
   * Used for config-derived paths (e.g., .well-known/caldav).
   * Rule B: APPEND the path to the base, preserving any subpath prefix.
   * For CalDAV collections, always add trailing slash (RFC 4918).
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
    
    // For CalDAV collections (non-.well-known paths), add trailing slash
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
    return parts[parts.length - 1] || 'Calendar';
  }

  /**
   * Check if a collection name indicates it's an internal Nextcloud collection.
   * These are auto-created by Nextcloud and should be filtered out.
   */
  private isInternalCollection(name: string): boolean {
    // Nextcloud internal calendar collections
    const internalPatterns = [
      /^z-server-generated--system$/,
      /^z-app-generated--contactsinteraction--recent$/,
      /^contact_birthdays$/,
    ];
    return internalPatterns.some(pattern => pattern.test(name));
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
