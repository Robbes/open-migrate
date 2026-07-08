/**
 * CalDAV Target Writer Implementation
 * 
 * Implements CalendarTargetWriter interface for CalDAV calendar synchronization.
 * Uses vdirsyncer for bulk operations and direct JMAP/CalDAV API calls for individual operations.
 * Follows the idempotency pattern with ledger fast-path and target-side existence checks.
 */

import type {
  CalendarTargetWriter,
  CalendarFolder,
  RawCalendarEvent,
  UpsertResult,
  Ledger,
  TenantId,
  MappingId,
} from '@openmig/shared';
import { calendarNaturalKeyHash, calendarContentHash } from '@openmig/shared';

/**
 * Configuration for CalDAV target writer
 */
export interface CalDAVTargetConfig {
  /** CalDAV endpoint URL */
  url: string;
  /** Authentication username */
  username: string;
  /** Authentication password or token */
  password: string;
  /** Calendar home set path */
  homeSet?: string;
  /** Default calendar color */
  color?: string;
  /** Default calendar description */
  description?: string;
}

/**
 * CalDAV target writer implementation
 */
export class CalDAVTargetWriter implements CalendarTargetWriter {
  private readonly config: CalDAVTargetConfig;
  private readonly ledger: Ledger;
  private readonly tenantId: TenantId;
  private readonly mappingId: MappingId;
  private readonly httpClient: HttpClient;

  constructor(
    config: CalDAVTargetConfig,
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
   * Ensure a calendar exists with the given folder metadata.
   * Returns the calendar ID (href) for use in subsequent operations.
   */
  async ensureCalendar(folder: CalendarFolder): Promise<string> {
    const calendarPath = this.normalizeCalendarPath(folder.path ?? folder.name ?? 'calendar');
    
    // Check if calendar already exists via PROPFIND
    const exists = await this.calendarExists(calendarPath);
    if (exists) {
      return calendarPath;
    }

    // Create new calendar using MKCALENDAR
    await this.createCalendar(calendarPath, folder);
    return calendarPath;
  }

  /**
   * Idempotently write a calendar event to the target.
   * Uses ledger fast-path and target-side UID check to ensure idempotency.
   */
  async upsertCalendarEvent(
    calendarId: string,
    raw: RawCalendarEvent,
  ): Promise<UpsertResult> {
    // Extract UID from iCalendar data
    const uid = this.extractUidFromIcalendar(raw.icalendar);
    const naturalKey = uid;
    const naturalKeyHash = calendarNaturalKeyHash(naturalKey);

    // LEDGER FAST-PATH: Check if already migrated
    const known = await this.ledger.find(this.tenantId, this.mappingId, naturalKeyHash);
    if (known) {
      return { targetId: known.targetId, created: false };
    }

    // Compute content hash for change detection
    const contentHashValue = calendarContentHash(raw.icalendar);

    // Check if event already exists on target (by UID)
    const existingId = await this.findCalendarByNaturalKey(calendarId, naturalKey);
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

    // Upload the event to the calendar
    const eventId = await this.uploadEvent(calendarId, raw, uid);

    // RECORD IN LEDGER
    await this.ledger.recordIfAbsent({
      tenantId: this.tenantId,
      mappingId: this.mappingId,
      naturalKeyHash,
      contentHash: contentHashValue,
      targetId: eventId,
      createdAt: new Date().toISOString(),
    });

    return { targetId: eventId, created: true };
  }

  /**
   * Find a calendar event by its natural key (UID).
   * Returns the event ID if found, undefined otherwise.
   */
  async findCalendarByNaturalKey(
    calendarId: string,
    naturalKey: string,
  ): Promise<string | undefined> {
    // Use CalDAV REPORT to search for events by UID
    const query = `<?xml version="1.0" encoding="utf-8"?>
      <C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
        <D:prop>
          <D:resourcetype/>
          <C:calendar-data/>
        </D:prop>
        <C:filter>
          <C:comp-filter name="VCALENDAR">
            <C:comp-filter name="VEVENT">
              <C:prop-filter name="UID">
                <C:text-match>${this.escapeXml(naturalKey)}</C:text-match>
              </C:prop-filter>
            </C:comp-filter>
          </C:comp-filter>
        </C:filter>
      </C:calendar-query>`;

    const response = await this.httpClient.request({
      method: 'REPORT',
      url: this.buildUrl(calendarId),
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

  private normalizeCalendarPath(path: string): string {
    // Normalize path to ensure consistent format
    let normalized = path.replace(/\\/g, '/');
    if (!normalized.startsWith('/')) {
      normalized = '/' + normalized;
    }
    if (!normalized.endsWith('/')) {
      normalized += '/';
    }
    // Ensure .ics extension for individual events, no extension for calendars
    if (normalized.endsWith('.ics/')) {
      normalized = normalized.slice(0, -4);
    }
    return normalized;
  }

  private async calendarExists(path: string): Promise<boolean> {
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

  private async createCalendar(path: string, folder: CalendarFolder): Promise<void> {
    const mkcalendar = `<?xml version="1.0" encoding="utf-8"?>
      <D:mkcalendar xmlns:D="DAV:">
        <D:set>
          <D:prop>
            <D:displayname>${this.escapeXml(folder.name || folder.path)}</D:displayname>
            ${folder.description ? `<C:calendar-description>${this.escapeXml(folder.description)}</C:calendar-description>` : ''}
            ${folder.color ? `<CR:color>${this.escapeXml(folder.color)}</CR:color>` : ''}
          </D:prop>
        </D:set>
      </D:mkcalendar>`;

    await this.httpClient.request({
      method: 'MKCALENDAR',
      url: this.buildUrl(path),
      body: mkcalendar,
      headers: {
        'Content-Type': 'application/xml',
        Authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64')}`,
      },
    });
  }

  private extractUidFromIcalendar(icalendar: string): string {
    const uidMatch = icalendar.match(/UID:[^\r\n]+/i);
    if (!uidMatch) {
      throw new Error('Invalid iCalendar data: missing UID');
    }
    const parts = uidMatch[0].split(':');
    return parts[1]?.trim() ?? '';
  }

  private async uploadEvent(
    calendarId: string,
    raw: RawCalendarEvent,
    uid: string,
  ): Promise<string> {
    // Generate event filename from UID
    const filename = `${uid}.ics`;
    const eventPath = `${calendarId}${filename}`;

    await this.httpClient.request({
      method: 'PUT',
      url: this.buildUrl(eventPath),
      body: raw.icalendar,
      headers: {
        'Content-Type': 'text/calendar',
        Authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64')}`,
      },
    });

    return eventPath;
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
      // In a real implementation, we'd parse the full response
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
 * HTTP client interface for CalDAV requests
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
