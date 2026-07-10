# CalDAV Sync Integration Guide

## Overview

This document describes the CalDAV (Calendar) synchronization implementation for OpenMigrate. The CalDAV sync engine enables one-way or bidirectional synchronization of calendar events between source systems (O365, Google Calendar, generic CalDAV) and target systems (JMAP servers like Stalwart, Nextcloud, Soverin, Proton via bridge).

**Key Update**: OpenMigrate now includes a **native TypeScript CalDAV source connector** (`CalDAVSource`) that implements RFC 4791 and RFC 6578 directly, replacing any previous shell-out wrapper approaches.

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   CalDAV Source │────▶│   GenericSync   │────▶│   CalDAV        │
│  (Native TS)    │     │     Engine      │     │   Target Writer │
└─────────────────┘     └────────┬────────┘     └─────────────────┘
                                 │
                                 ▼
                         ┌─────────────────┐
                         │   Ledger        │
                         │   (Idempotency) │
                         └─────────────────┘
```

**Native Implementation Features:**
- **RFC 4791 Compliance**: Full CalDAV protocol support
- **RFC 6578 Sync-Token**: Incremental sync using sync-collection REPORT
- **CTag Fallback**: Graceful degradation when sync-token not supported
- **Case-Insensitive UID**: UID normalization per RFC 5545 Section 3.3.11
- **No Shell Dependencies**: Pure TypeScript, no vdirsyncer or external tools

## Components

### 1. Data Models

Located in `packages/shared/src/types/calendar.ts`:

- **`CalendarEvent`**: Complete iCalendar event with:
  - `uid`: Unique identifier (case-insensitive per RFC 5545)
  - `summary`: Event title
  - `description`: Event description
  - `start` / `end`: Event timing with timezone support
  - `recurrenceRule`: Recurring event patterns (RRULE)
  - `attendees`: Participant list with RSVP status
  - `reminders`: Alarm/reminder configurations
  - `location`: Event location
  - `status`: CONFIRMED, TENTATIVE, CANCELLED

- **`CalendarFolder`**: Calendar collection metadata
  - `path`: Folder path
  - `displayName`: Human-readable name
  - `description`: Collection description
  - `timezone`: Default timezone

- **`RawCalendarEvent`**: Event with raw iCalendar (.ics) data
  - `uid`: Unique identifier
  - `icalendar`: Raw iCalendar string
  - Metadata fields (summary, start, end, etc.)

### 2. Hash Functions

Located in `packages/shared/src/hash.ts`:

```typescript
// Natural key hashing (case-insensitive per RFC 5545)
calendarNaturalKeyHash(uid: string): string

// Content hashing for change detection
calendarContentHash(icalendar: string): string
```

**Design Decisions:**
- UID is case-insensitive (RFC 5545 Section 3.3.11)
- Content hash uses SHA-256 of normalized iCalendar data
- Normalization removes volatile properties (LAST-MODIFIED, DTSTAMP)

### 3. Target Writer Interface

Located in `packages/shared/src/ports.ts`:

```typescript
interface CalendarTargetWriter {
  // Ensure calendar collection exists
  ensureCalendar(folder: CalendarFolder): Promise<string>;
  
  // Idempotent event upsert
  upsertCalendarEvent(
    calendarId: string,
    raw: RawCalendarEvent
  ): Promise<UpsertResult>;
  
  // Find existing event by natural key
  findCalendarByNaturalKey(
    calendarId: string,
    naturalKey: string
  ): Promise<string | undefined>;
}
```

### 4. Sync Engine

Located in `packages/connectors/src/caldav-source.ts`:

**Features:**
- **Native TypeScript Implementation**: No shell-out to vdirsyncer or other external tools
- **PROPFIND Discovery**: Automatic calendar home set and collection discovery
- **sync-collection REPORT**: RFC 6578 compliant incremental synchronization
- **Sync-Token Support**: Primary cursor mechanism for efficient delta sync
- **CTag Fallback**: Falls back to CTag-based sync when server doesn't support sync-token
- **Case-Insensitive UID**: Normalizes UIDs to lowercase per RFC 5545

**Configuration:**
```typescript
interface CalDAVSourceConfig {
  url: string;                    // CalDAV server base URL
  username: string;               // Username for authentication
  passwordEnv: string;            // Environment variable name for password
  calendarHomeSet?: string;       // Optional: auto-discovered if omitted
}
```

**Sync Flow:**
1. **Discovery**: PROPFIND to find calendar-home-set
2. **List Collections**: PROPFIND Depth:1 to find calendar collections
3. **Incremental Sync**: sync-collection REPORT with sync-token or CTag
4. **Parse iCalendar**: Extract UID, summary, dates, etc.
5. **Normalize UID**: Lowercase for case-insensitive comparison
6. **Return Items**: Raw calendar events with full iCalendar data

## Idempotency Pattern

The CalDAV sync follows the established idempotency pattern:

1. **List source items** incrementally using cursors
2. **Check ledger** for existing mappings (fast-path skip)
3. **Fetch raw content** (.ics file)
4. **Check target** for existing items by UID
5. **Write to target** if absent
6. **Record in ledger** with natural key hash and content hash

**Key Properties:**
- **Idempotent**: Running sync multiple times creates each event exactly once
- **Non-destructive**: Existing events are never deleted
- **Delta-aware**: Only new or changed events are synced

## Target Support Matrix

| Target        | CalDAV Support | Notes                                    |
|---------------|----------------|------------------------------------------|
| Stalwart      | ✅ Full        | Native CalDAV support                    |
| Nextcloud     | ✅ Full        | Well-tested CalDAV implementation        |
| Soverin       | ✅ Full        | CalDAV compatible                        |
| Proton        | ⚠️ Snapshot    | Export only (vCalendar bundles)          |
| Mosa.cloud    | ✅ Full        | Stalwart-based, full CalDAV support      |

## Usage Examples

### Using CalDAVSource Directly

```typescript
import { CalDAVSource } from '@openmig/connectors';
import type { CalendarSource, SyncCursor } from '@openmig/shared';

// Create CalDAV source connector
const source: CalendarSource = new CalDAVSource({
  url: 'https://caldav.example.com/dav/',
  username: 'user@example.com',
  passwordEnv: 'CALDAV_PASSWORD',
  // calendarHomeSet is optional - will be auto-discovered via PROPFIND
});

// Step 1: List calendar folders
const folders = await source.listFolders();
console.log(folders);
// Output:
// [
//   {
//     name: 'Personal',
//     path: '/dav/calendars/user/personal/',
//     displayName: 'Personal Calendar',
//     description: 'My personal events',
//     timezone: 'America/New_York'
//   },
//   {
//     name: 'Work',
//     path: '/dav/calendars/user/work/',
//     displayName: 'Work Calendar',
//     ...
//   }
// ]

// Step 2: Incremental sync with cursor
let cursor: SyncCursor | undefined;
const allEvents: RawCalendarEvent[] = [];

for (const folder of folders) {
  do {
    const { items, nextCursor } = await source.listSince(folder, cursor);
    allEvents.push(...items);
    cursor = nextCursor;
  } while (cursor && cursor.value);
}

console.log(`Synced ${allEvents.length} events`);
```

### Using with GenericSyncEngine

```typescript
import { CalDAVSource } from '@openmig/connectors';
import { GenericSyncEngine } from '@openmig/core';

const caldavSource = new CalDAVSource({
  url: 'https://caldav.example.com/dav/',
  username: 'user@example.com',
  passwordEnv: 'CALDAV_PASSWORD',
});

const engine = new GenericSyncEngine({
  tenantId: 'tenant-123',
  mappingId: 'mapping-456',
  source: caldavSource,
  target: caldavTargetWriter,
  ledger: myLedger,
  cursors: myCursorStore,
  concurrency: 4,
  itemType: 'calendar',
});

const result = await engine.sync();
console.log(`Created: ${result.created}, Skipped: ${result.skipped}`);
```

### Sync-Collection (RFC 6578) Behavior

The CalDAV source uses the sync-collection REPORT for incremental synchronization:

```typescript
// First sync (no cursor) - full sync
const { items: firstBatch, nextCursor } = await source.listSince(folder);
// → Returns all events, cursor contains sync-token

// Subsequent syncs - delta sync
const { items: delta } = await source.listSince(folder, nextCursor);
// → Returns only changed events since last sync-token
```

**Sync-Token vs CTag Fallback:**
- **Primary**: Uses sync-token (RFC 6578) for efficient delta sync
- **Fallback**: If server returns 403 or doesn't support sync-token, falls back to CTag
- **Cursor Format**: 
  - sync-token: `sync-token:abc123...`
  - CTag: `ctag:/dav/calendars/user/:xyz789...`

## Recurring Events

CalDAV sync handles recurring events according to RFC 5545:

- **Master event**: The recurring event definition with RRULE
- **Exceptions**: Individual instances with overrides (RECURRENCE-ID)
- **Instances**: Generated instances for calendar display

**Sync Strategy:**
- Sync master event and all exceptions as separate items
- Each instance has its own UID (master UID + RECURRENCE-ID)
- Changes to master propagate to all future instances

## Timezone Handling

- Source and target timezones are preserved
- VTIMEZONE components included in iCalendar data
- Floating times (no timezone) handled correctly
- Recurring events respect timezone changes

## Testing

### Unit Tests

```bash
pnpm test -- caldav-sync
```

### Integration Tests

```bash
pnpm test:integration -- caldav
```

Tests verify:
- Calendar creation
- Event upsert idempotency
- UID-based deduplication
- Recurring event handling
- Timezone preservation

## Troubleshooting

### Common Issues

**Issue**: Recurring events create duplicates  
**Solution**: Ensure RECURRENCE-ID is properly parsed and used as part of natural key

**Issue**: Timezone mismatches  
**Solution**: Verify VTIMEZONE components are included in iCalendar data

**Issue**: Attendee sync failures  
**Solution**: Check target system supports attendee properties (RFC 4791)

### Debug Mode

Enable verbose logging:
```typescript
const config: CalDAVSyncConfig = {
  // ... config
  debug: true  // Enable verbose output
};
```

## Performance Considerations

- **Batch size**: vdirsyncer processes items in batches (default: 100)
- **Rate limiting**: Respect target API rate limits
- **Concurrency**: Sync multiple calendars in parallel
- **Caching**: Use ledger fast-path to skip already-synced items

## Security

- Credentials stored securely (environment variables or vault)
- OAuth2 tokens refreshed automatically
- TLS required for all CalDAV connections
- No secrets in logs or error messages

## References

- [RFC 5545 - iCalendar](https://tools.ietf.org/html/rfc5545)
- [RFC 4791 - CalDAV](https://tools.ietf.org/html/rfc4791)
- [vdirsyncer Documentation](https://vdirsyncer.pimutils.org/)
- [Microsoft Graph Calendar API](https://docs.microsoft.com/graph/api/calendar-overview)

---

*This document is part of OpenMigrate sovereign migration stack. For complete documentation, see `docs/` directory.*
