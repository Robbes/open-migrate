# WebDAV Sync Integration Guide

## Overview

This document describes the WebDAV (Files) synchronization implementation for OpenMigrate. The WebDAV sync engine enables one-way or bidirectional synchronization of files and folders between source systems (OneDrive, SharePoint, generic WebDAV) and target systems (Nextcloud, ownCloud, Stalwart Files, other WebDAV servers).

**Key Update**: OpenMigrate now includes a **native TypeScript WebDAV source connector** (`WebdavFileSource`) that implements RFC 4918 directly, replacing any previous shell-out wrapper approaches (like rclone).

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  WebDAV Source  │────▶│   GenericSync   │────▶│   WebDAV        │
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
- **RFC 4918 Compliance**: Full WebDAV protocol support (PROPFIND, etc.)
- **ETag-Based Change Detection**: Primary mechanism for detecting file changes
- **Size/Mtime Fallback**: Secondary change indicators when ETag unavailable
- **Path Normalization**: Consistent path handling across different servers
- **No Shell Dependencies**: Pure TypeScript, no rclone or external tools

## Components

### 1. Data Models

Located in `packages/shared/src/types/file.ts`:

- **`FileItem`**: File/folder metadata
  - `path`: Normalized file path
  - `name`: File/folder name
  - `size`: File size in bytes (0 for directories)
  - `contentHash`: SHA-256 hash of file content
  - `modifiedAt`: Last modification timestamp
  - `createdAt`: Creation timestamp
  - `isDirectory`: Boolean indicating if it's a folder
  - `permissions`: File permissions (if available)
  - `mimeType`: Content type for files

- **`FileFolder`**: File collection metadata
  - `path`: Folder path
  - `displayName`: Human-readable name
  - `quota`: Storage quota information
  - `capabilities`: Server capabilities

- **`RawFileItem`**: File with raw content
  - `path`: File path
  - `content`: Raw file bytes (optional for directories)
  - Metadata fields

### 2. Hash Functions

Located in `packages/shared/src/hash.ts`:

```typescript
// Natural key hashing (path-based)
fileNaturalKeyHash(path: string): string

// Content hashing for change detection
fileContentHash(content: Uint8Array): string
```

**Design Decisions:**
- Path is normalized (lowercase, forward slashes, no trailing slash)
- Content hash uses SHA-256 of raw file bytes
- Directories use empty hash or path-based hash

### 3. Target Writer Interface

Located in `packages/shared/src/ports.ts`:

```typescript
interface FileTargetWriter {
  // Ensure directory exists (creates parent directories)
  ensureDirectory(folder: FileFolder): Promise<string>;
  
  // Idempotent file upsert
  upsertFile(
    parentId: string,
    raw: RawFileItem
  ): Promise<UpsertResult>;
  
  // Find existing file by natural key
  findFileByNaturalKey(
    parentId: string,
    naturalKey: string
  ): Promise<string | undefined>;
}
```

### 4. Sync Engine

Located in `packages/connectors/src/webdav-source.ts`:

**Features:**
- **Native TypeScript Implementation**: No shell-out to rclone or other external tools
- **PROPFIND Enumeration**: RFC 4918 compliant file/folder discovery
- **ETag-Based Change Detection**: Primary mechanism for detecting file modifications
- **Size/Mtime Fallback**: Uses size and modification time when ETag unavailable
- **Path Normalization**: Handles different path formats consistently
- **Binary Content Support**: Proper handling of all file types

**Configuration:**
```typescript
interface WebDAVSourceConfig {
  url: string;                    // WebDAV server base URL
  username: string;               // Username for authentication
  passwordEnv: string;            // Environment variable name for password
  rootPath: string;               // Root path for file operations
}
```

**Sync Flow:**
1. **List Folders**: PROPFIND Depth:1 to discover collections
2. **List Files**: PROPFIND Depth:1 for each folder
3. **Change Detection**: Compare ETag/size/mtime against cursor
4. **Fetch Content**: GET request for changed files
5. **Return Items**: Raw file items with content and metadata

## Idempotency Pattern

The WebDAV sync follows the established idempotency pattern:

1. **List source items** recursively (files + directories)
2. **Check ledger** for existing mappings (fast-path skip)
3. **Fetch raw content** for new/changed files
4. **Check target** for existing items by path
5. **Write to target** if absent or changed
6. **Record in ledger** with natural key hash and content hash

**Key Properties:**
- **Idempotent**: Running sync multiple times creates each file exactly once
- **Non-destructive**: By default, doesn't delete existing files (unless `sync` mode)
- **Delta-aware**: Only new or changed files are transferred
- **Resume-capable**: Large files can be resumed on failure

## Usage Examples

### Using WebdavFileSource Directly

```typescript
import { WebdavFileSource } from '@openmig/connectors';
import type { FileSource, SyncCursor } from '@openmig/shared';

// Create WebDAV source connector
const source: FileSource = new WebdavFileSource({
  url: 'https://webdav.example.com/dav/',
  username: 'user@example.com',
  passwordEnv: 'WEBDAV_PASSWORD',
  rootPath: '/files/user/',
});

// Step 1: List file folders
const folders = await source.listFolders();
console.log(folders);
// Output:
// [
//   {
//     name: 'Documents',
//     path: '/files/user/documents',
//     displayName: 'Documents',
//     quota: { used: 1024000, available: 10737418240 }
//   }
// ]

// Step 2: Incremental sync with cursor
let cursor: SyncCursor | undefined;
const allFiles: RawFileItem[] = [];

for (const folder of folders) {
  do {
    const { items, nextCursor } = await source.listSince(folder, cursor);
    allFiles.push(...items);
    cursor = nextCursor;
  } while (cursor && cursor.value);
}

console.log(`Synced ${allFiles.length} files`);
```

### Using with GenericSyncEngine

```typescript
import { WebdavFileSource } from '@openmig/connectors';
import { GenericSyncEngine } from '@openmig/core';

const webdavSource = new WebdavFileSource({
  url: 'https://webdav.example.com/dav/',
  username: 'user@example.com',
  passwordEnv: 'WEBDAV_PASSWORD',
  rootPath: '/files/user/',
});

const engine = new GenericSyncEngine({
  tenantId: 'tenant-123',
  mappingId: 'mapping-456',
  source: webdavSource,
  target: webdavTargetWriter,
  ledger: myLedger,
  cursors: myCursorStore,
  concurrency: 10,
  itemType: 'file',
});

const result = await engine.sync();
console.log(`Created: ${result.created}, Skipped: ${result.skipped}`);
console.log(`Bytes transferred: ${result.bytesTransferred}`);
```

### ETag-Based Change Detection

The WebDAV source uses ETags as the primary change detection mechanism:

```typescript
// First sync (no cursor) - full sync
const { items: firstBatch, nextCursor } = await source.listSince(folder);
// → Returns all files, cursor contains ETag/size/mtime snapshot

// Subsequent syncs - delta sync
const { items: delta } = await source.listSince(folder, nextCursor);
// → Returns only files with changed ETag, size, or mtime
```

**Change Detection Priority:**
1. **ETag comparison** (primary) - Detects any content change
2. **Size comparison** (secondary) - Fallback when ETag unavailable
3. **mtime comparison** (tertiary) - Final fallback indicator

**Cursor Format:**
The cursor is a base64-encoded JSON object containing:
```json
{
  "folder": "/files/user/documents",
  "etags": { "/files/user/documents/report.pdf": "abc123" },
  "sizes": { "/files/user/documents/report.pdf": 12345 },
  "mtimes": { "/files/user/documents/report.pdf": "2024-01-09T15:30:00Z" }
}
```

## Path Normalization

File paths are normalized to ensure consistent comparison:

```typescript
function normalizePath(path: string): string {
  // Remove leading/trailing slashes
  // Convert backslashes to forward slashes
  // Collapse multiple slashes
  // Handle special characters
  return path
    .replace(/^\/+|\/+$/g, '')  // Remove leading/trailing slashes
    .replace(/\\+/g, '/')        // Convert backslashes
    .replace(/\/+/g, '/');       // Collapse multiple slashes
}
```

**Examples:**
- `Documents/Reports/2024` → `Documents/Reports/2024`
- `Documents\\Reports\\2024` → `Documents/Reports/2024`
- `/Documents/Reports/2024/` → `Documents/Reports/2024`

## Large File Handling

For large files (>100MB):

1. **Chunked Upload**: rclone handles automatic chunking
2. **Checksum Verification**: Verify after transfer
3. **Progress Tracking**: Show upload progress
4. **Resume Support**: Resume interrupted transfers

**Configuration:**
```typescript
const config: WebDAVSyncConfig = {
  // ...
  sync: {
    // Chunk size for large files
    chunkSize: 5 * 1024 * 1024, // 5MB chunks
    // Retry settings
    retries: 3,
    // Timeout per transfer
    timeout: 3600, // 1 hour
  }
};
```

## Filtering

### Include/Exclude Patterns

Use glob patterns to filter files:

```typescript
const config: WebDAVSyncConfig = {
  // ...
  sync: {
    includePatterns: ['**/*.pdf', '**/*.docx'],
    excludePatterns: ['**/node_modules/**', '**/.git/**'],
  }
};
```

**Pattern Syntax:**
- `*` matches any characters except `/`
- `**` matches any characters including `/`
- `?` matches single character
- `[abc]` matches a, b, or c

### Size Filtering

Filter by file size:

```typescript
const config: WebDAVSyncConfig = {
  // ...
  sync: {
    minSize: 1024,      // Skip files < 1KB
    maxSize: 1024 * 1024 * 100, // Skip files > 100MB
  }
};
```

## Target Support Matrix

| Target        | WebDAV Support | Notes                                    |
|---------------|----------------|------------------------------------------|
| Nextcloud     | ✅ Full        | Well-tested WebDAV implementation        |
| ownCloud      | ✅ Full        | WebDAV compatible                        |
| Stalwart      | ✅ Full        | WebDAV files support                     |
| Proton        | ✅ Full        | WebDAV support via bridge                |
| Mosa.cloud    | ✅ Full        | Stalwart-based, full WebDAV support      |

## Testing

### Unit Tests

```bash
pnpm test -- webdav-sync
```

### Integration Tests

```bash
pnpm test:integration -- webdav
```

Tests verify:
- Directory creation
- File upsert idempotency
- Path-based deduplication
- Large file handling
- Filtering functionality
- Bytes transferred tracking

## Troubleshooting

### Common Issues

**Issue**: Permission denied errors  
**Solution**: Verify credentials have write access; check target folder permissions

**Issue**: Slow transfers  
**Solution**: Increase concurrent transfers; check network bandwidth; use --transfers flag

**Issue**: File name conflicts  
**Solution**: Enable conflict resolution; use --ignore-existing flag

**Issue**: Large file timeouts  
**Solution**: Increase timeout; use chunked transfers; check server limits

### Debug Mode

Enable verbose logging:
```typescript
const config: WebDAVSyncConfig = {
  // ... config
  debug: true  // Enable verbose output
};
```

## Performance Considerations

- **Concurrent transfers**: Use `--transfers` flag for parallel transfers
- **Checksum verification**: Use `--checksum` for content verification
- **Progress tracking**: Use `--progress` for real-time status
- **Bandwidth limiting**: Use `--bwlimit` to avoid saturating network
- **Caching**: Use ledger fast-path to skip already-synced files

### Performance Tuning

```typescript
const config: WebDAVSyncConfig = {
  // ...
  sync: {
    transfers: 10,        // Parallel file transfers
    checkers: 20,         // Parallel checksum checks
    bwlimit: '10M',       // 10MB/s limit
    chunkSize: 5 * 1024 * 1024, // 5MB chunks
  }
};
```

## Security

- Credentials stored securely (environment variables or vault)
- TLS required for all WebDAV connections
- No secrets in logs or error messages
- File content sanitized to prevent injection
- Path traversal attacks prevented

## References

- [WebDAV RFC 4918](https://tools.ietf.org/html/rfc4918)
- [rclone Documentation](https://rclone.org/)
- [rclone WebDAV Backend](https://rclone.org/webdav/)
- [OneDrive API](https://docs.microsoft.com/graph/api/overview)
- [SharePoint API](https://docs.microsoft.com/graph/sharepoint-overview)

---

*This document is part of OpenMigrate sovereign migration stack. For complete documentation, see `docs/` directory.*
