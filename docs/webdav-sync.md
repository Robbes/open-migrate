# WebDAV Sync Integration Guide

## Overview

This document describes the WebDAV (Files) synchronization implementation for OpenMigrate. The WebDAV sync engine enables one-way or bidirectional synchronization of files and folders between source systems (OneDrive, SharePoint, generic WebDAV) and target systems (Nextcloud, ownCloud, Stalwart Files, other WebDAV servers).

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  WebDAV Source  │────▶│   Source        │────▶│   WebDAV        │
│  (OneDrive/SP)  │     │   Connector     │     │   Target Writer │
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

Located in `packages/engines/src/webdav-sync.ts`:

**Features:**
- Uses **rclone** as the sync engine (robust, feature-rich)
- Automatic configuration generation for rclone
- Support for multiple sync modes (copy, sync, move)
- Include/exclude pattern filtering
- Size-based filtering (min/max file size)
- Progress tracking and bytes transferred
- Error handling and reporting
- Dry run support for preview

**Configuration:**
```typescript
interface WebDAVSyncConfig {
  source: {
    type: 'webdav' | 'onedrive' | 'sharepoint';
    url: string;
    credentials: Credentials;
    rootPath: string;
  };
  target: {
    type: 'webdav';
    url: string;
    credentials: Credentials;
    rootPath: string;
  };
  sync: {
    mode: 'copy' | 'sync' | 'move';
    dryRun: boolean;
    // Filtering
    includePatterns: string[];
    excludePatterns: string[];
    minSize: number; // bytes
    maxSize: number; // bytes
    // Performance
    transfers: number; // concurrent transfers
    checkers: number;  // concurrent checksum checks
  };
}
```

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

## Sync Modes

### Copy Mode (Default)

```
Source → Target
```

- Copies new and changed files from source to target
- Does not delete files on target
- Does not propagate deletions
- Safe for one-way backup/migration

### Sync Mode

```
Source ↔ Target (mirror)
```

- Makes target an exact mirror of source
- Deletes files on target that don't exist on source
- Propagates deletions
- Use with caution - destructive

### Move Mode

```
Source → Target (then delete source)
```

- Moves files from source to target
- Deletes source after successful transfer
- Useful for migration with cleanup

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
