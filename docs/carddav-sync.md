# CardDAV Sync Integration Guide

## Overview

This document describes the CardDAV (Contacts) synchronization implementation for OpenMigrate. The CardDAV sync engine enables one-way or bidirectional synchronization of contacts between source systems (O365 People, Google Contacts, generic CardDAV) and target systems (JMAP servers like Stalwart, Nextcloud, Soverin).

**Key Update**: OpenMigrate now includes a **native TypeScript CardDAV source connector** (`CarddavSource`) that implements RFC 4791, RFC 6350, and RFC 6578 directly, replacing any previous shell-out wrapper approaches.

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  CardDAV Source │────▶│   GenericSync   │────▶│   CardDAV       │
│   (Native TS)   │     │     Engine      │     │   Target Writer │
└─────────────────┘     └────────┬────────┘     └─────────────────┘
                                 │
                                 ▼
                         ┌─────────────────┐
                         │   Ledger        │
                         │   (Idempotency) │
                         └─────────────────┘
```

**Native Implementation Features:**
- **RFC 6350 Compliance**: Full vCard 4.0 support with vCard 3.0 backward compatibility
- **RFC 4791/6578**: WebDAV and sync-collection REPORT support
- **Case-Sensitive UID**: Preserves exact UID casing per vCard spec
- **sync-token/CTag**: Incremental sync with automatic fallback
- **No Shell Dependencies**: Pure TypeScript, no vdirsyncer or external tools

## Components

### 1. Data Models

Located in `packages/shared/src/types/contact.ts`:

- **`Contact`**: Complete vCard with:
  - `uid`: Unique identifier (case-sensitive)
  - `name`: Formatted name (FN), structured name (N)
  - `emails`: Email addresses with types (home, work, other)
  - `phones`: Phone numbers with types (mobile, work, home)
  - `addresses`: Physical addresses with components
  - `organization`: Company, title, department
  - `photo`: Embedded photos (base64 or URL)
  - `urls`: Personal/professional websites
  - `notes`: Free-form notes
  - `customFields`: Vendor-specific properties

- **`ContactFolder`**: Address book collection metadata
  - `path`: Folder path
  - `displayName`: Human-readable name
  - `description`: Collection description
  - `supportedVCardTypes`: Array of supported versions (3.0, 4.0)

- **`RawContact`**: Contact with raw vCard data
  - `uid`: Unique identifier
  - `vcard`: Raw vCard string
  - Metadata fields

### 2. Hash Functions

Located in `packages/shared/src/hash.ts`:

```typescript
// Natural key hashing (case-sensitive per vCard spec)
contactNaturalKeyHash(uid: string): string

// Content hashing for change detection
contactContentHash(vcard: string): string
```

**Design Decisions:**
- UID is case-sensitive (vCard 4.0 Section 10.1)
- Content hash uses SHA-256 of normalized vCard data
- Normalization removes volatile properties (VERSION, PRODID)

### 3. Target Writer Interface

Located in `packages/shared/src/ports.ts`:

```typescript
interface ContactTargetWriter {
  // Ensure contact folder exists
  ensureContactFolder(folder: ContactFolder): Promise<string>;
  
  // Idempotent contact upsert
  upsertContact(
    folderId: string,
    raw: RawContact
  ): Promise<UpsertResult>;
  
  // Find existing contact by natural key
  findContactByNaturalKey(
    folderId: string,
    naturalKey: string
  ): Promise<string | undefined>;
}
```

### 4. Sync Engine

Located in `packages/connectors/src/carddav-source.ts`:

**Features:**
- **Native TypeScript Implementation**: No shell-out to vdirsyncer or other external tools
- **PROPFIND Discovery**: Automatic address book home set and collection discovery
- **sync-collection REPORT**: RFC 6578 compliant incremental synchronization
- **Sync-Token Support**: Primary cursor mechanism for efficient delta sync
- **CTag Fallback**: Falls back to CTag-based sync when server doesn't support sync-token
- **Case-Sensitive UID**: Preserves exact UID casing per vCard RFC 6350 Section 10.1
- **vCard Parsing**: Full support for vCard 3.0 and 4.0 formats

**Configuration:**
```typescript
interface CardDAVSourceConfig {
  url: string;                    // CardDAV server base URL
  username: string;               // Username for authentication
  passwordEnv: string;            // Environment variable name for password
  addressBookHomeSet?: string;    // Optional: auto-discovered if omitted
}
```

**Sync Flow:**
1. **Discovery**: PROPFIND to find addressbook-home-set
2. **List Collections**: PROPFIND Depth:1 to find address book collections
3. **Incremental Sync**: sync-collection REPORT with sync-token or CTag
4. **Parse vCard**: Extract UID, FN, emails, phones, addresses, etc.
5. **Preserve UID**: Keep exact case for case-sensitive comparison
6. **Return Items**: Raw contacts with full vCard data

## Idempotency Pattern

The CardDAV sync follows the established idempotency pattern:

1. **List source items** incrementally using cursors
2. **Check ledger** for existing mappings (fast-path skip)
3. **Fetch raw content** (.vcf file)
4. **Check target** for existing contacts by UID
5. **Write to target** if absent
6. **Record in ledger** with natural key hash and content hash

**Key Properties:**
- **Idempotent**: Running sync multiple times creates each contact exactly once
- **Non-destructive**: Existing contacts are never deleted
- **Delta-aware**: Only new or changed contacts are synced

## Target Support Matrix

| Target        | CardDAV Support | Notes                                    |
|---------------|-----------------|------------------------------------------|
| Stalwart      | ✅ Full         | Native CardDAV support                   |
| Nextcloud     | ✅ Full         | Well-tested CardDAV implementation       |
| Soverin       | ✅ Full         | CardDAV compatible                       |
| Proton        | ⚠️ Snapshot     | Export only (vCard bundles)              |
| Mosa.cloud    | ✅ Full         | Stalwart-based, full CardDAV support     |

## Usage Examples

### Using CarddavSource Directly

```typescript
import { CarddavSource } from '@openmig/connectors';
import type { ContactSource, SyncCursor } from '@openmig/shared';

// Create CardDAV source connector
const source: ContactSource = new CarddavSource({
  url: 'https://carddav.example.com/dav/',
  username: 'user@example.com',
  passwordEnv: 'CARDDAV_PASSWORD',
  // addressBookHomeSet is optional - will be auto-discovered via PROPFIND
});

// Step 1: List address book folders
const folders = await source.listFolders();
console.log(folders);
// Output:
// [
//   {
//     name: 'Contacts',
//     path: '/dav/addressbooks/user/contacts/',
//     displayName: 'My Contacts',
//     description: 'Personal contact list',
//     supportedVCardTypes: ['3.0', '4.0']
//   }
// ]

// Step 2: Incremental sync with cursor
let cursor: SyncCursor | undefined;
const allContacts: RawContact[] = [];

for (const folder of folders) {
  do {
    const { items, nextCursor } = await source.listSince(folder, cursor);
    allContacts.push(...items);
    cursor = nextCursor;
  } while (cursor && cursor.value);
}

console.log(`Synced ${allContacts.length} contacts`);
```

### Using with GenericSyncEngine

```typescript
import { CarddavSource } from '@openmig/connectors';
import { GenericSyncEngine } from '@openmig/core';

const carddavSource = new CarddavSource({
  url: 'https://carddav.example.com/dav/',
  username: 'user@example.com',
  passwordEnv: 'CARDDAV_PASSWORD',
});

const engine = new GenericSyncEngine({
  tenantId: 'tenant-123',
  mappingId: 'mapping-456',
  source: carddavSource,
  target: carddavTargetWriter,
  ledger: myLedger,
  cursors: myCursorStore,
  concurrency: 4,
  itemType: 'contact',
});

const result = await engine.sync();
console.log(`Created: ${result.created}, Skipped: ${result.skipped}`);
```

### Sync-Collection (RFC 6578) Behavior

The CardDAV source uses the sync-collection REPORT for incremental synchronization:

```typescript
// First sync (no cursor) - full sync
const { items: firstBatch, nextCursor } = await source.listSince(folder);
// → Returns all contacts, cursor contains sync-token

// Subsequent syncs - delta sync
const { items: delta } = await source.listSince(folder, nextCursor);
// → Returns only changed contacts since last sync-token
```

**Sync-Token vs CTag Fallback:**
- **Primary**: Uses sync-token (RFC 6578) for efficient delta sync
- **Fallback**: If server returns 403 or doesn't support sync-token, falls back to CTag
- **Cursor Format**: 
  - sync-token: `sync-token:abc123...`
  - CTag: `ctag:/dav/addressbooks/user/:xyz789...`

### Case-Sensitive UID Handling

**Important**: Unlike CalDAV where UIDs are case-insensitive (RFC 5545), vCard UIDs are **case-sensitive** per RFC 6350 Section 10.1. The CardDAV source preserves the exact UID casing:

```typescript
// vCard UID is case-sensitive - "John@Example.com" ≠ "john@example.com"
const contact = contacts.find(c => c.uid === 'John@Example.com');
// Must match exact case
```

### vCard 3.0 vs 4.0

CardDAV servers may support different vCard versions:

| Feature              | vCard 3.0 | vCard 4.0 |
|----------------------|-----------|-----------|
| Standard             | RFC 2426  | RFC 6350  |
| Unicode support      | Limited   | Full      |
| Gender property      | ❌        | ✅        |
| Relationship props   | ❌        | ✅        |
| Timezone support     | Limited   | Full      |
| Backward compatibility| ✅       | ✅        |

**Sync Strategy:**
- Detect target's supported versions via PROPFIND
- Convert to target's preferred version if needed
- Preserve original data during conversion
- Log version conversion for audit trail

### Version Conversion

When target requires different vCard version:

```typescript
// Convert vCard 4.0 → 3.0
function convertToVCard30(vcard: string): string {
  // Remove vCard 4.0 specific properties
  // Convert data types to vCard 3.0 equivalents
  // Update VERSION to 3.0
}

// Convert vCard 3.0 → 4.0
function convertToVCard40(vcard: string): string {
  // Add default values for new vCard 4.0 properties
  // Update VERSION to 4.0
}
```

## Photo Handling

Photos in vCards can be:

1. **Embedded**: Base64-encoded image data in vCard
2. **URL reference**: URI pointing to external image

**Sync Strategy:**
- Preserve embedded photos as-is
- For URL references, attempt to fetch and embed if target requires
- Handle large photos (some servers have size limits)
- Support multiple photo formats (JPEG, PNG, GIF)

## Testing

### Unit Tests

```bash
pnpm test -- carddav-sync
```

### Integration Tests

```bash
pnpm test:integration -- carddav
```

Tests verify:
- Contact folder creation
- Contact upsert idempotency
- UID-based deduplication
- vCard version conversion
- Photo handling
- Custom field preservation

## Troubleshooting

### Common Issues

**Issue**: vCard parsing errors  
**Solution**: Ensure source vCard is valid RFC 6350/2426; use libvcard for validation

**Issue**: Photo sync failures  
**Solution**: Check target server's size limits; consider URL references for large photos

**Issue**: Character encoding issues  
**Solution**: Ensure UTF-8 encoding; handle BOM correctly

**Issue**: Custom field loss  
**Solution**: Use X- prefix for vendor-specific properties; document supported fields

### Debug Mode

Enable verbose logging:
```typescript
const config: CardDAVSyncConfig = {
  // ... config
  debug: true  // Enable verbose output
};
```

## Performance Considerations

- **Batch size**: vdirsyncer processes items in batches (default: 100)
- **Rate limiting**: Respect target API rate limits
- **Concurrency**: Sync multiple address books in parallel
- **Caching**: Use ledger fast-path to skip already-synced contacts
- **Photo optimization**: Downscale large photos if needed

## Security

- Credentials stored securely (environment variables or vault)
- OAuth2 tokens refreshed automatically
- TLS required for all CardDAV connections
- No secrets in logs or error messages
- Photo data sanitized to prevent injection

## References

- [RFC 6350 - vCard 4.0](https://tools.ietf.org/html/rfc6350)
- [RFC 2426 - vCard 3.0](https://tools.ietf.org/html/rfc2426)
- [RFC 4791 - CardDAV](https://tools.ietf.org/html/rfc4791)
- [vdirsyncer Documentation](https://vdirsyncer.pimutils.org/)
- [Microsoft Graph Contacts API](https://docs.microsoft.com/graph/api/contact-overview)

---

*This document is part of OpenMigrate sovereign migration stack. For complete documentation, see `docs/` directory.*
