# CalDAV Sync Integration Guide

## Overview

This document describes the CalDAV (Calendar) synchronization implementation for OpenMigrate. The CalDAV sync engine enables one-way or bidirectional synchronization of calendar events between source systems (O365, Google Calendar, generic CalDAV) and target systems (JMAP servers like Stalwart, Nextcloud, Soverin, Proton via bridge).

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   CalDAV Source │────▶│   Source        │────▶│   CalDAV        │
│   (O365/Graph)  │     │   Connector     │     │   Target Writer │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                │
                                ▼
                        ┌─────────────────┐
                        │   Ledger        │
                        │   (Idempotency) │
                        └─────────────────┘
```

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

Located in `packages/engines/src/caldav-sync.ts`:

**Features:**
- Uses **vdirsyncer** as the sync engine (battle-tested, idempotent by design)
- Automatic configuration generation for vdirsyncer
- Output parsing for statistics (items synced, skipped, failed)
- Error handling and reporting
- Dry run support for preview

**Configuration:**
```typescript
interface CalDAVSyncConfig {
  source: {
    type: 'caldav' | 'graph';
    url: string;
    credentials: Credentials;
    calendars: string[];
  };
  target: {
    type: 'caldav' | 'jmap';
    url: string;
    credentials: Credentials;
    calendars: Map<string, string>; // source → target mapping
  };
  sync: {
    direction: 'push' | 'pull' | 'bidirectional';
    dryRun: boolean;
  };
}
```

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

## Usage Example

### Basic CalDAV Sync

```typescript
import { runCalDAVSync, cleanupCalDAVConfig } from '@openmig/engines';

const config: CalDAVSyncConfig = {
  source: {
    type: 'graph',
    url: 'https://graph.microsoft.com/v1.0',
    credentials: { /* OAuth2 tokens */ },
    calendars: ['primary', 'work']
  },
  target: {
    type: 'caldav',
    url: 'https://nextcloud.example.com/remote.php/dav/calendars/user/',
    credentials: { /* Basic auth or OAuth2 */ },
    calendars: { 'primary': 'personal', 'work': 'work-events' }
  },
  sync: {
    direction: 'push',
    dryRun: false
  }
};

try {
  const result = await runCalDAVSync(config);
  console.log(`Synced ${result.createdCount} events, skipped ${result.skippedCount}`);
} finally {
  await cleanupCalDAVConfig(config);
}
```

### With Ledger Integration

```typescript
import { runUnifiedSync } from '@openmig/core';

const result = await runUnifiedSync({
  config: {
    tenantId: 'tenant-123',
    mappingId: 'mapping-456',
    calendar: {
      enabled: true,
      source: caldavSource,
      target: caldavTargetWriter
    },
    // ... other data types
  },
  ledger: myLedger,
  cursors: myCursorStore
});
```

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
