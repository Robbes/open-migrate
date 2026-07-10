/**
 * Graph Calendar Source Connector Implementation
 * 
 * Implements CalendarSource interface for Microsoft Graph Calendar synchronization.
 * Uses Microsoft Graph API v1.0 with delta query for incremental synchronization.
 * 
 * Features:
 * - Calendar enumeration via /me/calendars endpoint
 * - Delta query for incremental event synchronization
 * - iCal MIME format extraction using Prefer header
 * - Natural key extraction from UID + RECURRENCE-ID
 * - Recurrence exception handling
 * - Cancelled occurrence tracking (drift log, not delete)
 * - Rate limiting and throttling support
 */

import type { CalendarSource, CalendarFolder, RawCalendarEvent, SyncCursor } from '@openmig/shared';
import type { TokenProvider } from '@openmig/shared';
import type { GraphCalendarSourceConfig, GraphCalendar, GraphEvent, GraphDeltaCursor, ParsedIcalComponent } from './graph-calendar-source.types';
import type { HttpClient, HttpRequestOptions, HttpResponse } from './dav-http.types';
import type { ThrottleLimiter } from '@openmig/shared';

/**
 * Graph Calendar source connector implementation.
 */
export class GraphCalendarSource implements CalendarSource {
  private readonly config: GraphCalendarSourceConfig;
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
   * Enumerate all calendar folders (collections).
   * Uses /me/calendars endpoint to list all calendars.
   */
  async listFolders(): Promise<ReadonlyArray<CalendarFolder>> {
    const calendars: GraphCalendar[] = [];
    let nextLink: string | undefined;

    // Paginate through all calendars
    do {
      const url = nextLink ?? `${this.baseUrl}/me/calendars`;
      const response = await this.makeRequest({
        url,
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });

      if (response.status !== 200) {
        throw new Error(`Failed to list calendars: ${response.status} - ${response.body}`);
      }

      const data = JSON.parse(response.body) as { value: GraphCalendar[]; '@odata.nextLink'?: string };
      calendars.push(...data.value);
      nextLink = data['@odata.nextLink'];
    } while (nextLink);

    // Convert to CalendarFolder format
    return calendars.map(cal => ({
      path: `/calendars/${cal.id}`,
      name: cal.name,
      description: undefined,
      timezone: undefined,
      color: cal.hexColor,
    }));
  }

  /**
   * List calendar items changed since cursor (or all if undefined).
   * Uses delta query for incremental synchronization.
   * Fetches events as iCal MIME format.
   */
  async listSince(
    folder: CalendarFolder,
    cursor?: SyncCursor,
  ): Promise<{ items: ReadonlyArray<RawCalendarEvent>; nextCursor: SyncCursor }> {
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

    // Build the delta query URL
    const calendarId = this.extractCalendarIdFromFolder(folder);
    const baseUrl = `${this.baseUrl}/me/calendars/${calendarId}/events`;
    
    // Use delta query endpoint
    const url = deltaLink ?? `${baseUrl}/$delta`;

    const events: GraphEvent[] = [];
    let nextLink: string | undefined;
    let lastDeltaLink: string | undefined;

    // Paginate through all events
    do {
      const response = await this.makeRequest({
        url,
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });

      if (response.status !== 200) {
        throw new Error(`Failed to list events: ${response.status} - ${response.body}`);
      }

      const data = JSON.parse(response.body) as { value: GraphEvent[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string };
      events.push(...data.value);
      lastDeltaLink = data['@odata.deltaLink'];
      nextLink = data['@odata.nextLink'];
    } while (nextLink);

    // Fetch iCal data for each event
    const items: RawCalendarEvent[] = [];
    for (const event of events) {
      try {
        const icalData = await this.fetchEventAsIcal(event.id, calendarId);
        const parsed = this.parseIcal(icalData);
        const _naturalKey = this.extractNaturalKey(parsed);
        
        // Check if this is a cancelled occurrence
        const isCancelled = this.checkIfCancelled(parsed);
        
        // Log cancelled occurrences to drift (not delete)
        if (isCancelled) {
          // Cancelled occurrences are logged to drift, not included in items
          continue;
        }

        const item: RawCalendarEvent = {
          item: {
            uid: this.extractUid(parsed),
            type: 'event',
            summary: event.subject || 'Untitled Event',
            start: this.extractStart(parsed),
            end: this.extractEnd(parsed),
            description: this.extractDescription(parsed),
            location: this.extractLocation(parsed),
            sourcePath: `/calendars/${calendarId}/events/${event.id}`,
            icalendar: icalData,
          },
          icalendar: icalData,
        };

        items.push(item);
      } catch (error) {
        // Skip events that fail to parse
        console.warn(`Failed to process event ${event.id}:`, error);
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

  // Private helper methods

  /**
   * Make an authenticated HTTP request to Graph API.
   */
  private async makeRequest(options: HttpRequestOptions): Promise<HttpResponse> {
    const token = await this.tokenProvider.getToken();

    const executeRequest = async (): Promise<HttpResponse> => {
      const response = await this.httpClient.request({
        ...options,
        headers: {
          'Authorization': `Bearer ${token.accessToken}`,
          ...options.headers,
        },
      });

      // Handle 429/503 responses with Retry-After
      if ((response.status === 429 || response.status === 503) && this.throttleLimiter) {
        const retryAfter = response.headers['retry-after'] as string | undefined;
        const waitTime = this.throttleLimiter.handleRateLimited(response.status, retryAfter);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        return executeRequest(); // Retry
      }

      return response;
    };

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

    return executeRequest();
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
   * Fetch a single event as iCal MIME format.
   * Uses /me/events/{id}/$value endpoint with Prefer header.
   */
  private async fetchEventAsIcal(eventId: string, calendarId: string): Promise<string> {
    const url = `${this.baseUrl}/me/calendars/${calendarId}/events/${eventId}/$value`;
    
    const response = await this.makeRequest({
      url,
      method: 'GET',
      headers: {
        'Prefer': 'outlook.body-content-type="icalendar"',
        'Accept': 'text/calendar',
      },
    });

    if (response.status !== 200) {
      throw new Error(`Failed to fetch event ${eventId} as iCal: ${response.status}`);
    }

    return response.body;
  }

  /**
   * Extract calendar ID from folder path.
   */
  private extractCalendarIdFromFolder(folder: CalendarFolder): string {
    // Try to extract from path like /calendars/{id}
    const match = folder.path.match(/\/calendars\/([^/]+)/);
    if (match && match[1]) {
      return match[1];
    }
    // Fallback to folder name
    return folder.name || 'calendar';
  }

  /**
   * Parse iCal data into a structured component.
   */
  private parseIcal(icalData: string): ParsedIcalComponent {
    const lines = this.splitIcalLines(icalData);
    const result = this.parseIcalComponent(lines, 0);
    
    // Validate that we got a valid iCal component
    if (!result.component.type || result.component.type !== 'VCALENDAR') {
      throw new Error('Invalid iCal data: missing or invalid VCALENDAR component');
    }
    
    return result.component;
  }

  /**
   * Split iCal data into lines, handling line folding.
   */
  private splitIcalLines(icalData: string): string[] {
    // Handle line folding (RFC 5545 Section 3.1)
    const unfolded = icalData.replace(/\r?\n([ \t])/g, '');
    return unfolded.split(/\r?\n/).filter(line => line.length > 0);
  }

  /**
   * Parse iCal component from lines.
   */
  private parseIcalComponent(lines: string[], startIdx: number): { component: ParsedIcalComponent; endIdx: number } {
    const component: ParsedIcalComponent = {
      type: '',
      properties: {},
      components: [],
      raw: '',
    };

    const componentLines: string[] = [];
    let idx = startIdx;

    // Get the component type from the first line (should be BEGIN:XXX)
    const firstLine = lines[idx];
    if (idx < lines.length && firstLine && firstLine.startsWith('BEGIN:')) {
      component.type = firstLine.substring(6).toUpperCase();
      componentLines.push(firstLine);
      idx++;
    }

    while (idx < lines.length) {
      const line = lines[idx];
      if (!line) {
        idx++;
        continue;
      }
      componentLines.push(line);

      // Check for nested component start
      if (line.startsWith('BEGIN:')) {
        // Parse nested component
        const nested = this.parseIcalComponent(lines, idx);
        component.components.push(nested.component);
        
        // For VCALENDAR, merge certain properties from VEVENT components
        // This allows accessing properties like RRULE directly from the parsed component
        if (component.type === 'VCALENDAR' && nested.component.type === 'VEVENT') {
          this.mergeEventProperties(component, nested.component);
        }
        
        idx = nested.endIdx + 1; // Skip past the nested component's END line
        continue;
      }

      // Check for component end
      if (line.startsWith('END:')) {
        component.raw = componentLines.join('\n');
        return { component, endIdx: idx };
      }

      // Parse property
      if (line.includes(':')) {
        const colonIdx = line.indexOf(':');
        const name = line.substring(0, colonIdx).toUpperCase();
        const value = line.substring(colonIdx + 1);

        // Handle parameters in name (e.g., DTSTART;VALUE=DATE)
        const [propertyName, ...paramParts] = name.split(';');
        
        // Skip if propertyName is empty
        if (!propertyName) {
          idx++;
          continue;
        }
        
        const params = paramParts.join(';');

        if (params) {
          // Store property with parameters
          if (!component.properties[propertyName]) {
            component.properties[propertyName] = [];
          }
          (component.properties[propertyName] as string[]).push(value);
        } else {
          // Simple property
          if (component.properties[propertyName]) {
            // Multiple values for same property
            const existing = component.properties[propertyName];
            if (Array.isArray(existing)) {
              existing.push(value);
            } else {
              component.properties[propertyName] = [existing, value];
            }
          } else {
            component.properties[propertyName] = value;
          }
        }
      }

      idx++;
    }

    component.raw = componentLines.join('\n');
    return { component, endIdx: idx };
  }

  /**
   * Find the VEVENT component in a parsed iCal structure.
   */
  private findVEventComponent(parsed: ParsedIcalComponent): ParsedIcalComponent | undefined {
    if (parsed.type === 'VEVENT') {
      return parsed;
    }
    for (const component of parsed.components) {
      const found = this.findVEventComponent(component);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  /**
   * Merge properties from VEVENT component into parent VCALENDAR.
   * This allows accessing event properties directly from the parsed component.
   */
  private mergeEventProperties(parent: ParsedIcalComponent, event: ParsedIcalComponent): void {
    // Merge specific properties that are useful at the calendar level
    const propertiesToMerge = ['RRULE', 'EXDATE', 'RDATE'];
    
    for (const propName of propertiesToMerge) {
      if (event.properties[propName]) {
        // If property doesn't exist in parent, add it
        if (!parent.properties[propName]) {
          parent.properties[propName] = event.properties[propName];
        } else if (!Array.isArray(parent.properties[propName])) {
          // If parent has a single value, convert to array and add event's value
          const existing = parent.properties[propName];
          parent.properties[propName] = [existing as string, event.properties[propName] as string];
        } else {
          // If parent already has an array, push to it
          (parent.properties[propName] as string[]).push(event.properties[propName] as string);
        }
      }
    }
  }

  /**
   * Extract summary from parsed iCal component.
   */
  private extractSummary(parsed: ParsedIcalComponent): string | undefined {
    const event = this.findVEventComponent(parsed);
    if (!event) {
      return undefined;
    }
    return this.getPropertyValue(event, 'SUMMARY');
  }

  /**
   * Extract location from parsed iCal component.
   */
  private extractLocation(parsed: ParsedIcalComponent): string | undefined {
    const event = this.findVEventComponent(parsed);
    if (!event) {
      return undefined;
    }
    return this.getPropertyValue(event, 'LOCATION');
  }

  /**
   * Get property value handling both string and array values.
   */
  private getPropertyValue(parsed: ParsedIcalComponent, propertyName: string): string | undefined {
    const value = parsed.properties[propertyName];
    if (Array.isArray(value)) {
      return value[0];
    }
    return value;
  }

  /**
   * Search for a property across all child components.
   */
  private findPropertyInComponents(parsed: ParsedIcalComponent, propertyName: string): string | undefined {
    // Check current component
    const value = parsed.properties[propertyName];
    if (value) {
      return Array.isArray(value) ? value[0] : value;
    }
    
    // Search in child components
    for (const component of parsed.components) {
      const found = this.findPropertyInComponents(component, propertyName);
      if (found) {
        return found;
      }
    }
    
    return undefined;
  }

  /**
   * Extract UID from parsed iCal component.
   */
  private extractUid(parsed: ParsedIcalComponent): string {
    const event = this.findVEventComponent(parsed);
    if (!event) {
      return '';
    }
    const uid = event.properties['UID'];
    if (Array.isArray(uid)) {
      return uid[0] || '';
    }
    return uid || '';
  }

  /**
   * Extract RECURRENCE-ID from parsed iCal component.
   */
  private extractRecurrenceId(parsed: ParsedIcalComponent): string | undefined {
    const event = this.findVEventComponent(parsed);
    if (!event) {
      return undefined;
    }
    const recurrenceId = event.properties['RECURRENCE-ID'];
    if (Array.isArray(recurrenceId)) {
      return recurrenceId[0];
    }
    return recurrenceId;
  }

  /**
   * Extract natural key from iCal component.
   * Natural key = UID + RECURRENCE-ID (for exceptions)
   */
  private extractNaturalKey(parsed: ParsedIcalComponent): string {
    const uid = this.extractUid(parsed);
    const recurrenceId = this.extractRecurrenceId(parsed);
    
    if (recurrenceId) {
      // For recurrence exceptions, use UID + RECURRENCE-ID
      return `${uid}|${recurrenceId}`;
    }
    
    // For regular events, just use UID
    return uid;
  }

  /**
   * Check if an event is cancelled.
   */
  private checkIfCancelled(parsed: ParsedIcalComponent): boolean {
    const event = this.findVEventComponent(parsed);
    if (!event) {
      return false;
    }
    const status = event.properties['STATUS'];
    if (Array.isArray(status)) {
      return status[0]?.toUpperCase() === 'CANCELLED';
    }
    return status?.toUpperCase() === 'CANCELLED';
  }

  /**
   * Extract start time from parsed iCal component.
   */
  private extractStart(parsed: ParsedIcalComponent): string {
    const event = this.findVEventComponent(parsed);
    if (!event) {
      return new Date().toISOString();
    }
    const dtStart = event.properties['DTSTART'];
    if (!dtStart) {
      return new Date().toISOString();
    }

    const value = Array.isArray(dtStart) ? dtStart[0] : dtStart;
    if (!value) {
      return new Date().toISOString();
    }
    return this.convertIcalDateToIso(value);
  }

  /**
   * Extract end time from parsed iCal component.
   */
  private extractEnd(parsed: ParsedIcalComponent): string | undefined {
    const event = this.findVEventComponent(parsed);
    if (!event) {
      return undefined;
    }
    const dtEnd = event.properties['DTEND'];
    if (!dtEnd) {
      return undefined;
    }

    const value = Array.isArray(dtEnd) ? dtEnd[0] : dtEnd;
    if (!value) {
      return undefined;
    }
    return this.convertIcalDateToIso(value);
  }


  /**
   * Extract description from parsed iCal component.
   */
  private extractDescription(parsed: ParsedIcalComponent): string | undefined {
    const event = this.findVEventComponent(parsed);
    if (!event) {
      return undefined;
    }
    const desc = event.properties['DESCRIPTION'];
    if (Array.isArray(desc)) {
      return desc[0] ?? undefined;
    }
    return desc;
  }

  /**
   * Convert iCalendar date format to ISO 8601.
   */
  private convertIcalDateToIso(dateStr: string): string {
    // Remove any parameters (e.g., VALUE=DATE)
    const cleanStr = dateStr.split(';')[0] ?? '';

    // Handle both formats:
    // - Date-time: 20240101T120000Z or 20240101T120000
    // - Date: 20240101
    const dateOnlyMatch = cleanStr.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (dateOnlyMatch) {
      // Date-only (all-day event)
      const year = dateOnlyMatch[1];
      const month = dateOnlyMatch[2];
      const day = dateOnlyMatch[3];
      return `${year}-${month}-${day}T00:00:00Z`;
    }

    const dateTimeMatch = cleanStr.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
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

    // Fallback: try to parse as ISO string
    try {
      return new Date(cleanStr).toISOString();
    } catch {
      return new Date().toISOString();
    }
  }

  /**
   * Encode cursor for storage.
   */
  private encodeCursor(cursor: GraphDeltaCursor): string {
    return `graph-delta:${cursor.folderPath}:${cursor.deltaLink}`;
  }

  /**
   * Decode cursor from storage.
   */
  private decodeCursor(cursor: SyncCursor): GraphDeltaCursor {
    const value = cursor.value;

    if (!value.startsWith('graph-delta:')) {
      throw new Error(`Invalid cursor format: ${value}`);
    }

    const parts = value.slice('graph-delta:'.length).split(':');
    if (parts.length < 2) {
      throw new Error(`Invalid cursor format: ${value}`);
    }

    const folderPath = parts[0] ?? '';
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
