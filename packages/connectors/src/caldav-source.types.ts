/**
 * CalDAV Source Connector Types
 * 
 * Types for CalDAV calendar source implementation following RFC 4791 and RFC 6578.
 */

/**
 * Configuration for CalDAV source connection.
 */
export interface CalDAVSourceConfig {
  /** CalDAV endpoint URL (e.g., https://caldav.example.com/) */
  url: string;
  /** Authentication username */
  username: string;
  /** Environment variable name containing the password or token (self-host/CLI path) */
  passwordEnv?: string;
  /** Direct password/token (managed path — credentials decrypted from the DB at runtime). */
  password?: string;
  /** Optional calendar home set path (if known, otherwise discovered via PROPFIND) */
  calendarHomeSet?: string;
}

/**
 * Sync token for incremental CalDAV synchronization (RFC 6578).
 * Can be either a sync-token (preferred) or CTag (fallback).
 */
export interface CalDAVSyncToken {
  /** The sync token value from the server */
  readonly token: string;
  /** Whether this is a sync-token (true) or CTag fallback (false) */
  readonly isSyncToken: boolean;
  /** The collection path this token applies to */
  readonly collectionPath: string;
}

/**
 * Calendar event data from CalDAV server.
 */
export interface CalDAVCalendarObject {
  /** The href/URL of the calendar object */
  readonly href: string;
  /** The iCalendar data content */
  readonly icalendar: string;
  /** The sync token for this object (if available) */
  readonly syncToken?: string;
}

/**
 * Parsed PROPFIND response for calendar home discovery.
 */
export interface CalDAVHomeSet {
  /** The calendar home set URL */
  readonly homeSet: string;
  /** List of calendar collections under the home set */
  readonly collections: CalDAVCollection[];
}

/**
 * Calendar collection information.
 */
export interface CalDAVCollection {
  /** The collection path/URL */
  readonly path: string;
  /** Human-readable display name */
  readonly displayName?: string;
  /** Calendar description */
  readonly description?: string;
  /** Timezone identifier */
  readonly timezone?: string;
  /** Color preference */
  readonly color?: string;
  /** Maximum date-time for calendar data */
  readonly maxDate?: string;
  /** Minimum date-time for calendar data */
  readonly minDate?: string;
}
