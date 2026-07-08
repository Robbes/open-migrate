/** CalDAV calendar event model for migration. */

/** VEVENT component types we support. */
export type CalendarEventType = 'event' | 'todo' | 'journal';

/** Event status. */
export type EventStatus = 'confirmed' | 'tentative' | 'cancelled';

/** Participation status. */
export type ParticipationStatus = 'needs-action' | 'accepted' | 'declined' | 'tentative' | 'delegated';

/** Calendar attendee. */
export interface CalendarAttendee {
  readonly email: string;
  readonly name?: string;
  readonly role?: 'req-participant' | 'opt-participant' | 'chair';
  readonly participationStatus: ParticipationStatus;
}

/** Recurrence rule (simplified iCalendar RRULE). */
export interface RecurrenceRule {
  readonly frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
  readonly interval?: number;
  readonly count?: number;
  readonly until?: string; // ISO 8601 date-time
  readonly byDay?: ReadonlyArray<string>; // e.g., ['MO', 'WE']
}

/**
 * Normalized calendar event.
 * The `uid` is the natural key (idempotency anchor); content is hashed from normalized event data.
 */
export interface CalendarEvent {
  /** RFC 5545 UID - the natural key for idempotency. */
  readonly uid: string;
  /** Event type. */
  readonly type: CalendarEventType;
  /** Summary/title. */
  readonly summary: string;
  /** Description. */
  readonly description?: string;
  /** Start time (ISO 8601). */
  readonly start: string;
  /** End time (ISO 8601). */
  readonly end?: string;
  /** Duration in seconds (alternative to end). */
  readonly duration?: number;
  /** All-day event flag. */
  readonly isAllDay?: boolean;
  /** Timezone identifier. */
  readonly timezone?: string;
  /** Location. */
  readonly location?: string;
  /** Status. */
  readonly status?: EventStatus;
  /** Organizer. */
  readonly organizer?: {
    readonly email: string;
    readonly name?: string;
  };
  /** Attendees. */
  readonly attendees?: ReadonlyArray<CalendarAttendee>;
  /** Recurrence rule. */
  readonly recurrenceRule?: RecurrenceRule;
  /** Reminders/alarms (simplified). */
  readonly reminders?: ReadonlyArray<{
    readonly action: 'display' | 'audio';
    readonly triggerSeconds: number;
    readonly description?: string;
  }>;
  /** Categories/tags. */
  readonly categories?: ReadonlyArray<string>;
  /** URL/link. */
  readonly url?: string;
  /** Last modified (ISO 8601). */
  readonly lastModified?: string;
  /** Created (ISO 8601). */
  readonly created?: string;
  /** Source folder/calendar collection. */
  readonly sourcePath: string;
  /** Raw iCalendar data (RFC 5545). */
  readonly icalendar: string;
}

/** Calendar folder/collection. */
export interface CalendarFolder {
  /** Calendar collection path. */
  readonly path: string;
  /** Human-readable name. */
  readonly name?: string;
  /** Calendar description. */
  readonly description?: string;
  /** Timezone. */
  readonly timezone?: string;
  /** Color. */
  readonly color?: string;
}

/** Calendar item with raw data. */
export interface RawCalendarEvent {
  readonly item: CalendarEvent;
  readonly icalendar: string;
}
