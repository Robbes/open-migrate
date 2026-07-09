# Unified Sync Engine Guide

## Overview

The Unified Sync Engine is the orchestration layer that coordinates synchronization across all data types: mail, calendar, contacts, and files. It provides a single entry point for running complete migrations while maintaining the idempotency and non-destructive properties of individual sync engines.

**Key Design Principle**: Uses the `GenericSyncEngine` for domain-neutral sync logic, with domain-specific source connectors and target writers.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Unified Sync Engine                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │  Mail    │  │ Calendar │  │ Contacts │  │  Files   │       │
│  │  Sync    │  │  Sync    │  │  Sync    │  │  Sync    │       │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘       │
│       │             │              │             │              │
│       └─────────────┴──────────────┴─────────────┘              │
│                          │                                       │
│                          ▼                                       │
│                 ┌─────────────────┐                              │
│                 │   GenericSync   │                              │
│                 │     Engine      │                              │
│                 └────────┬────────┘                              │
│                          │                                       │
│                          ▼                                       │
│                 ┌─────────────────┐                              │
│                 │     Ledger      │                              │
│                 │  (Idempotency)  │                              │
│                 └─────────────────┘                              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Components

### 1. GenericSyncEngine

The core sync engine that works for all data types. Located in `packages/core/src/generic-sync.ts`:

**Features:**
- Domain-neutral item contract
- Ledger fast-path (skip already-migrated items)
- Create-if-absent on target (handles lost ledger)
- Incremental cursors
- Bounded concurrency
- Non-destructive sync (no deletions propagated)

```typescript
class GenericSyncEngine {
  async sync(): Promise<GenericSyncResult> {
    // 1. List all folders
    // 2. For each folder:
    //    a. Get cursor (if available)
    //    b. List items since cursor
    //    c. For each item:
    //       - Check ledger (fast-path skip if known)
    //       - Check target for existence (create-if-absent)
    //       - Fetch and create
    //       - Record in ledger
    //    d. Persist cursor
    // 3. Return stats
  }
}
```

### 2. Configuration

Located in `packages/shared/src/config.ts`:

```typescript
interface UnifiedSyncConfig {
  tenantId: string;
  mappingId: string;
  
  // Data type enablement
  mail: {
    enabled: boolean;
    source: SourceConnector;
    target: TargetWriter;
  };
  calendar: {
    enabled: boolean;
    source: CalendarSource;
    target: CalendarTargetWriter;
  };
  contacts: {
    enabled: boolean;
    source: ContactSource;
    target: ContactTargetWriter;
  };
  files: {
    enabled: boolean;
    source: FileSource;
    target: FileTargetWriter;
  };
  
  // Sync behavior
  concurrency: number;
  dryRun: boolean;
}
```

### 3. Domains Configuration (Multi-Domain Sync)

The optional `domains` block enables per-domain configuration for multi-domain sync. When absent, the root `source` and `target` are used (backward compatible).

```typescript
interface DomainsConfig {
  readonly mail?: DomainConfig;
  readonly calendar?: DomainConfig;
  readonly contacts?: DomainConfig;
  readonly files?: DomainConfig;
}

interface DomainConfig {
  readonly enabled: boolean;
  readonly source: SourceConfig;
  readonly target: TargetConfig;
  readonly concurrency?: number;
}
```

**Example Configuration:**

```json
{
  "tenantId": "tenant-123",
  "mappingId": "multi-domain-sync",
  "source": {
    "type": "imap-oauth2",
    "host": "outlook.office365.com",
    "port": 993,
    "user": "user@example.com",
    "auth": { "kind": "xoauth2", "tokenFromEnv": "O365_TOKEN" }
  },
  "target": {
    "type": "jmap",
    "baseUrl": "http://stalwart:8080",
    "user": "target@dev.local",
    "auth": { "kind": "basic", "passwordFromEnv": "TARGET_PASSWORD" }
  },
  "domains": {
    "mail": {
      "enabled": true,
      "source": { /* IMAP source */ },
      "target": { /* JMAP target */ },
      "concurrency": 4
    },
    "calendar": {
      "enabled": true,
      "source": {
        "type": "caldav",
        "url": "https://caldav.example.com/dav/",
        "user": "user@example.com",
        "auth": { "kind": "xoauth2", "tokenFromEnv": "CALDAV_TOKEN" }
      },
      "target": {
        "type": "caldav",
        "url": "https://caldav.target.com/dav/",
        "user": "target@dev.local",
        "auth": { "kind": "basic", "passwordFromEnv": "TARGET_CALENDAR_PASSWORD" }
      },
      "concurrency": 2
    }
  }
}
```

### 4. Sync Statistics

```typescript
interface TypeSyncStats {
  totalItems: number;
  createdCount: number;
  skippedCount: number;
  failureCount: number;
  bytesTransferred: number;
  durationSeconds: number;
  failures: Array<{ id: string; error: string }>;
}

interface UnifiedSyncResult {
  tenantId: string;
  mappingId: string;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;
  mail: TypeSyncStats;
  calendar: TypeSyncStats;
  contacts: TypeSyncStats;
  files: TypeSyncStats;
  completed: boolean;
}
```

### 3. Execution Flow

The unified sync follows this sequence:

1. **Initialization**
   - Validate configuration
   - Initialize ledger and cursor stores
   - Record sync start time

2. **Sequential Sync** (by default)
   - Mail sync (if enabled)
   - Calendar sync (if enabled)
   - Contacts sync (if enabled)
   - Files sync (if enabled)

3. **Aggregation**
   - Collect statistics from each data type
   - Calculate total duration
   - Determine overall completion status

4. **Completion**
   - Record sync end time
   - Return aggregated results

## Usage

### Basic Usage

```typescript
import { runUnifiedSync } from '@openmig/core';

const result = await runUnifiedSync({
  config: {
    tenantId: 'tenant-123',
    mappingId: 'mapping-456',
    mail: {
      enabled: true,
      source: o365Source,
      target: stalwartTarget
    },
    calendar: {
      enabled: true,
      source: o365CalendarSource,
      target: nextcloudCalendarWriter
    },
    contacts: {
      enabled: true,
      source: o365ContactsSource,
      target: nextcloudContactWriter
    },
    files: {
      enabled: true,
      source: onedriveSource,
      target: nextcloudFileWriter
    },
    concurrency: 5,
    dryRun: false
  },
  ledger: myLedger,
  cursors: myCursorStore
});

console.log(`Sync completed in ${result.durationSeconds}s`);
console.log(`Mail: ${result.mail.createdCount} created, ${result.mail.skippedCount} skipped`);
console.log(`Calendar: ${result.calendar.createdCount} created`);
console.log(`Contacts: ${result.contacts.createdCount} created`);
console.log(`Files: ${result.files.createdCount} created, ${result.files.bytesTransferred} bytes`);
```

### Partial Sync

Enable only specific data types:

```typescript
const result = await runUnifiedSync({
  config: {
    tenantId: 'tenant-123',
    mappingId: 'mapping-456',
    mail: {
      enabled: true,
      source: o365Source,
      target: stalwartTarget
    },
    calendar: {
      enabled: false, // Skip calendar
      source: null,
      target: null
    },
    contacts: {
      enabled: false, // Skip contacts
      source: null,
      target: null
    },
    files: {
      enabled: false, // Skip files
      source: null,
      target: null
    },
    concurrency: 5,
    dryRun: false
  },
  ledger: myLedger,
  cursors: myCursorStore
});
```

### Dry Run

Preview what would be synced without making changes:

```typescript
const result = await runUnifiedSync({
  config: {
    // ... config
    dryRun: true  // Preview mode
  },
  ledger: myLedger,
  cursors: myCursorStore
});

// In dry run mode, nothing is written to target
// but statistics show what would be synced
```

## Idempotency

The unified sync maintains idempotency across all data types:

### Mail Idempotency
- Uses Message-ID as natural key
- Ledger tracks email → target ID mapping
- Re-runs skip already-synced messages

### Calendar Idempotency
- Uses event UID as natural key (case-insensitive)
- Ledger tracks calendar UID → target ID mapping
- Re-runs skip already-synced events

### Contacts Idempotency
- Uses contact UID as natural key
- Ledger tracks contact UID → target ID mapping
- Re-runs skip already-synced contacts

### Files Idempotency
- Uses file path as natural key
- Ledger tracks file path → target ID mapping
- Re-runs skip already-synced files

## Non-Destructive Behavior

The unified sync is non-destructive by default:

- **No deletions**: Source deletions are not propagated to target
- **No overwrites**: Existing target items are not overwritten
- **Shadow mode**: Can run alongside production without disruption

To handle deletions, use explicit cleanup operations:

```typescript
// Separate cleanup process for deletions
await handleSourceDeletions({
  tenantId: 'tenant-123',
  mappingId: 'mapping-456',
  dataTypes: ['mail', 'calendar', 'contacts', 'files'],
  action: 'log' // or 'archive', 'delete'
});
```

## Concurrency

Control concurrency per data type:

```typescript
const result = await runUnifiedSync({
  config: {
    // ... config
    concurrency: 10  // 10 concurrent operations
  },
  ledger: myLedger,
  cursors: myCursorStore
});
```

**Recommended settings:**
- Mail: 5-10 concurrent operations
- Calendar: 3-5 concurrent operations
- Contacts: 3-5 concurrent operations
- Files: 10-20 concurrent transfers

## Error Handling

### Per-Item Errors

Individual item failures are tracked but don't stop the sync:

```typescript
if (result.mail.failureCount > 0) {
  console.log('Mail sync had failures:');
  result.mail.failures.forEach(f => {
    console.log(`  - ${f.id}: ${f.error}`);
  });
}
```

### Overall Completion

Check if sync completed successfully:

```typescript
if (result.completed) {
  console.log('All data types synced successfully');
} else {
  console.log('Sync completed with errors');
  // Check individual data type failures
}
```

## Performance Optimization

### Parallel Data Type Sync

For independent data types, run in parallel:

```typescript
const [mailResult, calendarResult] = await Promise.all([
  runMailSync(config.mail),
  runCalendarSync(config.calendar)
]);
```

### Batch Processing

Process items in batches for better performance:

```typescript
const BATCH_SIZE = 100;
const items = await source.listItems();

for (let i = 0; i < items.length; i += BATCH_SIZE) {
  const batch = items.slice(i, i + BATCH_SIZE);
  await processBatch(batch);
}
```

### Caching

Use cursor stores to track progress:

```typescript
const cursor = await cursors.get(tenantId, mappingId, folder);
const { items, nextCursor } = await source.listSince(folder, cursor);
await cursors.set(tenantId, mappingId, folder, nextCursor);
```

## Monitoring

### Progress Tracking

Track sync progress in real-time:

```typescript
const result = await runUnifiedSync({
  config: {
    // ... config
  },
  ledger: myLedger,
  cursors: myCursorStore,
  onProgress: (progress) => {
    console.log(`Progress: ${progress.createdCount}/${progress.totalItems}`);
  }
});
```

### Logging

Enable detailed logging:

```typescript
const result = await runUnifiedSync({
  config: {
    // ... config
  },
  ledger: myLedger,
  cursors: myCursorStore,
  logger: {
    level: 'debug',
    log: (level, message) => {
      console.log(`[${level}] ${message}`);
    }
  }
});
```

## Testing

### Unit Tests

```bash
pnpm test -- unified-sync
```

### Integration Tests

```bash
pnpm test:integration -- unified-sync
```

Tests verify:
- Multi-data type orchestration
- Idempotency across all types
- Error handling and recovery
- Statistics aggregation

## Troubleshooting

### Common Issues

**Issue**: Sync is slow  
**Solution**: Increase concurrency; enable parallel processing; check network bandwidth

**Issue**: Ledger errors  
**Solution**: Verify database connection; check ledger schema; ensure migrations applied

**Issue**: Cursor corruption  
**Solution**: Reset cursors; re-run sync from beginning

**Issue**: Memory issues with large datasets  
**Solution**: Use streaming; process in smaller batches; increase memory limits

### Debug Mode

Enable verbose logging:
```typescript
const result = await runUnifiedSync({
  config: {
    // ... config
  },
  ledger: myLedger,
  cursors: myCursorStore,
  debug: true  // Enable verbose output
});
```

## References

- [Workplan 0001 - JMAP Mail](./workplans/0001-first-slice-jmap-mail.md)
- [Workplan 0002 - IMAP/DAV Target](./workplans/0002-imap-dav-target.md)
- [Workplan 0003 - CalDAV/CardDAV/WebDAV](./workplans/0003-caldav-carddav-webdav.md)
- [ADR-0020 - Idempotency Pattern](./adr/0020-idempotency-pattern.md)

---

*This document is part of OpenMigrate sovereign migration stack. For complete documentation, see `docs/` directory.*
