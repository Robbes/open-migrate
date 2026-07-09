# Workplan 0003: Calendar, Contacts & Files (CalDAV, CardDAV, WebDAV)

> ⚠️ **SUPERSEDED by [workplan 0007](./0007-multi-domain-sync-completion.md)** (2026-07-09) —
> kept as history, do not execute from this file. Verified state at supersession: data models,
> hash functions, target-writer classes and vdirsyncer/rclone wrappers exist, but
> `runUnifiedSync` is a stub returning zeros, there are no calendar/contact/file **source**
> connectors, no ledger item-type support, and no integration tests for any non-mail domain.
> The "Completed Tasks" list below overstates; ground truth lives in 0007's Status block.

## Status: SUPERSEDED (was: IN PROGRESS)

This document tracks the implementation of Workplan 0003, which extends the sovereign migration stack to support calendar (CalDAV), contacts (CardDAV), and files (WebDAV) synchronization.

## Architecture Overview

The implementation follows the established pattern from Workplans 0001 and 0002:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   CalDAV/CardDAV│     │   Source        │     │   Target        │
│   WebDAV Source │────▶│   Connector     │────▶│   Writer        │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                │
                                ▼
                        ┌─────────────────┐
                        │   Ledger        │
                        │   (Idempotency) │
                        └─────────────────┘
```

## Completed Tasks (Stubs & Interfaces Only)

> ⚠️ **Reality Check**: All items below are **data models, interfaces, and stubs only**. No
> working source connectors or end-to-end sync exists. The `runUnifiedSync` function in
> `packages/core/src/unified-sync.ts` is explicitly a stub that returns zeros for all
> synchronization metrics. The ledger schema lacks item-type support for
> calendar/contact/file entities.

### 1. Data Models (packages/shared/src/)

#### Calendar Models (`calendar.ts`)
- `CalendarEvent`: Type definition for iCalendar event with UID, summary, start/end, recurrence, attendees, reminders
- `CalendarFolder`: Calendar collection metadata type
- `RawCalendarEvent`: Event with raw iCalendar data type
- **Note**: These are TypeScript types only; no source connector reads/calendars yet

#### Contact Models (`contact.ts`)
- `Contact`: Type definition for vCard with UID, name, phones, emails, addresses, organization, photo
- `ContactFolder`: Address book collection metadata type
- `RawContact`: Contact with raw vCard data type
- **Note**: These are TypeScript types only; no source connector reads contacts yet

#### File Models (`file.ts`)
- `FileItem`: Type definition for file/folder with path, size, content hash, timestamps, permissions
- `FileFolder`: File collection metadata type with quota info
- `RawFileItem`: File with raw content bytes type
- **Note**: These are TypeScript types only; no source connector reads files yet

### 2. Hash Functions (packages/shared/src/hash.ts)

Type-specific natural key and content hashing **functions exist** but are not exercised by
working sync flows:

```typescript
// Calendar - UID-based, case-insensitive (RFC 5545)
calendarNaturalKeyHash(uid: string): string
naturalKeyForCalendar(event: CalendarEvent): string
calendarContentHash(icalendar: string): string

// Contact - UID-based, case-sensitive (vCard)
contactNaturalKeyHash(uid: string): string
naturalKeyForContact(contact: Contact): string
contactContentHash(vcard: string): string

// File - Path-based
fileNaturalKeyHash(path: string): string
naturalKeyForFile(file: FileItem): string
fileContentHash(content: Uint8Array): string
```

### 3. Target Writer Interfaces (packages/shared/src/ports.ts)

Interface definitions only (no implementations):

```typescript
// CalDAV target writer (interface only)
interface CalendarTargetWriter {
  ensureCalendar(folder: CalendarFolder): Promise<string>;
  upsertCalendarEvent(calendarId: string, raw: RawCalendarEvent): Promise<UpsertResult>;
  findCalendarByNaturalKey(calendarId: string, naturalKey: string): Promise<string | undefined>;
}

// CardDAV target writer (interface only)
interface ContactTargetWriter {
  ensureContactFolder(folder: ContactFolder): Promise<string>;
  upsertContact(folderId: string, raw: RawContact): Promise<UpsertResult>;
  findContactByNaturalKey(folderId: string, naturalKey: string): Promise<string | undefined>;
}

// WebDAV target writer (interface only)
interface FileTargetWriter {
  ensureDirectory(folder: FileFolder): Promise<string>;
  upsertFile(parentId: string, raw: RawFileItem): Promise<UpsertResult>;
  findFileByNaturalKey(parentId: string, naturalKey: string): Promise<string | undefined>;
}
```

### 4. Sync Engines (packages/engines/src/)

> ⚠️ **Status**: Shell-out stubs exist but are not integrated into the worker or tested end-to-end.

#### CalDAV Sync Engine (`caldav-sync.ts`)
- `CalDAVSyncConfig`: Type for CalDAV sync configuration
- `runCalDAVSync()`: Stub that would execute vdirsyncer (not wired to worker/API)
- `cleanupCalDAVConfig()`: Stub for cleanup
- **Status**: Not tested, not integrated

#### CardDAV Sync Engine (`carddav-sync.ts`)
- `CardDAVSyncConfig`: Type for CardDAV sync configuration
- `runCardDAVSync()`: Stub that would execute vdirsyncer (not wired to worker/API)
- `cleanupCardDAVConfig()`: Stub for cleanup
- **Status**: Not tested, not integrated

#### WebDAV Sync Engine (`webdav-sync.ts`)
- `WebDAVSyncConfig`: Type for WebDAV sync configuration
- `runWebDAVSync()`: Stub that would execute rclone (not wired to worker/API)
- `cleanupWebDAVConfig()`: Stub for cleanup
- **Status**: Not tested, not integrated

## Pending Tasks

### 5. Target Writer Implementations

Create concrete implementations of the target writers:

- `packages/engines/src/caldav-target-writer.ts`: JMAP/CalDAV calendar writer
- `packages/engines/src/carddav-target-writer.ts`: JMAP/CardDAV contact writer
- `packages/engines/src/webdav-target-writer.ts`: WebDAV file writer

Each implementation must:
- Ensure collections/directories exist
- Perform idempotent upserts using ledger
- Support create-if-absent semantics
- Handle existence checks via natural key

### 6. Ledger Schema Extension

Extend the ledger to support all data types:

```sql
-- Add data_type column to existing ledger table
ALTER TABLE ledger ADD COLUMN data_type VARCHAR(20) NOT NULL DEFAULT 'email';

-- Or create separate tables per type (recommended for clarity)
CREATE TABLE calendar_ledger (
  id UUID PRIMARY KEY,
  tenant_id VARCHAR(255) NOT NULL,
  mapping_id VARCHAR(255) NOT NULL,
  natural_key_hash VARCHAR(64) NOT NULL,
  content_hash VARCHAR(64) NOT NULL,
  target_id VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(tenant_id, mapping_id, natural_key_hash)
);

-- Similar tables for contacts and files
```

### 7. Unified Sync Engine

Create a unified orchestrator that coordinates all data types:

```typescript
// packages/core/src/unified-sync.ts
interface UnifiedSyncConfig {
  tenantId: string;
  mappingId: string;
  enableMail: boolean;
  enableCalendar: boolean;
  enableContacts: boolean;
  enableFiles: boolean;
  // ... other config
}

export async function runUnifiedSync(deps: UnifiedSyncDeps): Promise<UnifiedSyncResult> {
  // Orchestrate all enabled data types
  // Run in sequence or parallel based on config
  // Aggregate results
}
```

### 8. Worker CLI Extension

Extend the worker CLI to support all data types:

```typescript
// apps/worker/src/build-deps.ts
interface WorkerConfig {
  // Existing mail config
  mail: {
    enabled: boolean;
    // ... mail config
  };
  // New data type configs
  calendar: {
    enabled: boolean;
    source: CalDAVSourceConfig;
    target: CalDAVTargetConfig;
  };
  contacts: {
    enabled: boolean;
    source: CardDAVSourceConfig;
    target: CardDAVTargetConfig;
  };
  files: {
    enabled: boolean;
    source: WebDAVSourceConfig;
    target: WebDAVTargetConfig;
  };
}
```

### 9. Idempotency Tests

Create comprehensive property tests:

```typescript
// packages/core/test/unified-sync.idempotency.test.ts
describe('Unified Sync Idempotency', () => {
  it('should be idempotent for calendar events', async () => {
    // Run sync twice, verify second run creates 0 items
  });
  
  it('should be idempotent for contacts', async () => {
    // Run sync twice, verify second run creates 0 items
  });
  
  it('should be idempotent for files', async () => {
    // Run sync twice, verify second run creates 0 items
  });
});
```

### 10. Documentation

Create comprehensive documentation:

- `docs/caldav-sync.md`: CalDAV integration guide
- `docs/carddav-sync.md`: CardDAV integration guide
- `docs/webdav-sync.md`: WebDAV integration guide
- `docs/unified-sync.md`: Unified sync orchestration guide
- Update `docs/architecture/solution-architecture.md` with new data types

## Testing Strategy

### Unit Tests
- Test data model serialization/deserialization
- Test hash functions for each data type
- Test sync engine config generation
- Test output parsing

### Integration Tests
- Test CalDAV sync with testcontainers (Stalwart)
- Test CardDAV sync with testcontainers
- Test WebDAV sync with mock server
- Test ledger operations for all data types

### Property Tests
- Idempotency: Running sync twice produces same result
- Non-destructive: Sync never deletes existing items
- Incremental: Subsequent runs only sync changed items

## Implementation Notes

### vdirsyncer Requirements
- Must be installed on the system
- Requires Python 3.x
- Configuration is file-based (generated per sync job)
- Supports CalDAV and CardDAV natively

### rclone Requirements
- Must be installed on the system
- Supports WebDAV natively
- Configuration is file-based (generated per sync job)
- More flexible than vdirsyncer for file operations

### Idempotency Anchors
- **Calendar**: UID (case-insensitive per RFC 5545)
- **Contact**: UID (case-sensitive per vCard)
- **File**: Path (normalized for case sensitivity)

### Content Verification
All data types use SHA-256 content hashing to detect changes:
- Calendar: Hash of normalized iCalendar data
- Contact: Hash of normalized vCard data
- File: Hash of raw file bytes

## Next Steps

1. Implement target writer classes for each data type
2. Extend ledger schema with migration scripts
3. Create unified sync orchestrator
4. Extend worker CLI configuration
5. Write comprehensive tests
6. Update documentation
7. Run full test suite and verify all gates

## References

- [RFC 5545 - iCalendar](https://tools.ietf.org/html/rfc5545)
- [RFC 4791 - CalDAV](https://tools.ietf.org/html/rfc4791)
- [RFC 6350 - vCard](https://tools.ietf.org/html/rfc6350)
- [RFC 4791 - CardDAV](https://tools.ietf.org/html/rfc4791)
- [WebDAV RFC 4918](https://tools.ietf.org/html/rfc4918)
- [vdirsyncer Documentation](https://vdirsyncer.pimutils.org/)
- [rclone Documentation](https://rclone.org/)
