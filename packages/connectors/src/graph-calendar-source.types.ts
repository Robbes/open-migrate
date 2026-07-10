/**
 * Graph Calendar Source Types
 * 
 * Types for Microsoft Graph Calendar API implementation.
 * Follows Microsoft Graph API v1.0 for calendar synchronization.
 */

/**
 * Configuration for Graph Calendar source connection.
 */
export interface GraphCalendarSourceConfig {
  /** Microsoft Graph API base URL (default: https://graph.microsoft.com/v1.0) */
  baseUrl?: string;
  /** Azure AD tenant ID */
  tenantId: string;
}

/**
 * Microsoft Graph calendar object.
 */
export interface GraphCalendar {
  /** The calendar ID */
  readonly id: string;
  /** Display name of the calendar */
  readonly name: string;
  /** Default calendar flag */
  readonly isDefaultCalendar: boolean;
  /** Change key for optimistic concurrency */
  readonly changeKey: string;
  /** Calendar color */
  readonly color?: string;
  /** Hex color code */
  readonly hexColor?: string;
  /** Is shared calendar flag */
  readonly isShared?: boolean;
  /** Can be shared flag */
  readonly canShare?: boolean;
  /** Can read/write items flag */
  readonly canViewOnly?: boolean;
}

/**
 * Microsoft Graph event object (metadata only).
 */
export interface GraphEvent {
  /** The event ID */
  readonly id: string;
  /** Event subject/title */
  readonly subject: string;
  /** Event body content */
  readonly body?: {
    readonly contentType: 'text' | 'html';
    readonly content: string;
  };
  /** Start time */
  readonly start?: {
    readonly dateTime: string;
    readonly timeZone?: string;
  };
  /** End time */
  readonly end?: {
    readonly dateTime: string;
    readonly timeZone?: string;
  };
  /** Location */
  readonly location?: {
    readonly displayName: string;
    readonly address?: {
      readonly street?: string;
      readonly city?: string;
      readonly state?: string;
      readonly countryOrRegion?: string;
      readonly postalCode?: string;
    };
  };
  /** Is all day event */
  readonly isAllDay: boolean;
  /** Is cancelled flag */
  readonly isCancelled: boolean;
  /** Is recurring flag */
  readonly isRecurring: boolean;
  /** Event status */
  readonly showAs?: 'free' | 'tentative' | 'busy' | 'oof' | 'workingElsewhere' | 'unknown';
  /** Sensitivity level */
  readonly sensitivity?: 'normal' | 'personal' | 'private' | 'sensitive';
  /** Organizer */
  readonly organizer?: {
    readonly emailAddress: {
      readonly name: string;
      readonly address: string;
    };
  };
  /** Attendees */
  readonly attendees?: Array<{
    readonly type: 'required' | 'optional' | 'organizer';
    readonly status: {
      readonly response: 'none' | 'accepted' | 'tentative' | 'declined';
      readonly time: string;
    };
    readonly emailAddress: {
      readonly name: string;
      readonly address: string;
    };
  }>;
  /** Recurrence pattern */
  readonly recurrenceRule?: {
    readonly pattern: {
      readonly type: 'daily' | 'weekly' | 'absoluteMonthly' | 'relativeMonthly' | 'absoluteYearly' | 'relativeYearly';
      readonly interval: number;
      readonly month?: number;
      readonly dayOfMonth?: number;
      readonly daysOfWeek?: Array<'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday'>;
      readonly firstDayOfWeek?: 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday';
      readonly index?: 'first' | 'second' | 'third' | 'fourth' | 'last';
    };
    readonly range: {
      readonly type: 'noEnd' | 'endDate' | 'numbered';
      readonly startDate?: string;
      readonly endDate?: string;
      readonly numberOfIterations?: number;
    };
  };
  /** Response status */
  readonly responseStatus?: {
    readonly response: 'none' | 'organizer' | 'tentativelyAccepted' | 'accepted' | 'declined' | 'unknown';
    readonly time: string;
  };
  /** Web link to the event */
  readonly webLink?: string;
  /** OData delta link for incremental sync */
  readonly '@odata.deltaLink'?: string;
  /** OData next link for pagination */
  readonly '@odata.nextLink'?: string;
}

/**
 * Graph API response for calendar list.
 */
export interface GraphCalendarListResponse {
  /** List of calendars */
  readonly value: GraphCalendar[];
  /** Next page link for pagination */
  readonly '@odata.nextLink'?: string;
}

/**
 * Graph API response for events list.
 */
export interface GraphEventListResponse {
  /** List of events */
  readonly value: GraphEvent[];
  /** Delta link for incremental sync */
  readonly '@odata.deltaLink'?: string;
  /** Next page link for pagination */
  readonly '@odata.nextLink'?: string;
}

/**
 * Graph API response for delta query.
 */
export interface GraphDeltaQueryResponse {
  /** List of changed events */
  readonly value: GraphEvent[];
  /** Delta link for next incremental sync */
  readonly '@odata.deltaLink': string;
  /** Next page link for pagination */
  readonly '@odata.nextLink'?: string;
}

/**
 * Parsed iCalendar component from Graph event.
 */
export interface ParsedIcalComponent {
  /** Component type (VEVENT, VCALENDAR, etc.) */
  type: string;
  /** Key-value properties */
  properties: Record<string, string | string[]>;
  /** Nested components */
  components: ParsedIcalComponent[];
  /** Raw iCal string */
  raw: string;
}

/**
 * Graph calendar event with iCal data.
 */
export interface GraphCalendarEvent {
  /** Event ID from Graph */
  readonly id: string;
  /** iCal data */
  readonly icalendar: string;
  /** Parsed iCal component */
  readonly parsed: ParsedIcalComponent;
  /** Natural key (UID + RECURRENCE-ID if present) */
  readonly naturalKey: string;
  /** Is cancelled flag */
  readonly isCancelled: boolean;
}

/**
 * Delta cursor for Graph Calendar sync.
 */
export interface GraphDeltaCursor {
  /** The delta token/URL */
  readonly deltaLink: string;
  /** Calendar folder path this cursor applies to */
  readonly folderPath: string;
}
