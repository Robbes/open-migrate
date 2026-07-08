# IMAP/DAV Bulk Sync with imapsync

## Overview

The `imapsync` bulk sync feature provides an optional performance optimization for large mailboxes by using the `imapsync` command-line tool to perform an initial bulk copy before the incremental, ledger-based sync takes over.

## Why Use imapsync?

- **Performance**: imapsync is highly optimized for bulk email migration and can transfer thousands of messages much faster than the incremental JMAP/IMAP API approach.
- **Reliability**: imapsync has built-in retry logic, connection pooling, and error handling for network issues.
- **Compatibility**: Works with any IMAP server, making it ideal for diverse target environments (Soverin, openDesk, Stalwart, etc.).

## Important Notes

⚠️ **Ledger Integration Required**: The imapsync bulk copy is **not** ledger-aware. It simply copies messages between IMAP servers. To maintain idempotency and proper ledger tracking:

1. Run imapsync for the bulk initial copy
2. Run the normal incremental sync afterward to:
   - Populate the ledger with all copied messages
   - Handle any messages missed by imapsync
   - Ensure idempotency for future runs

The incremental sync will detect that messages already exist on the target and skip them (idempotency), so running imapsync + incremental sync is safe and converges correctly.

## Installation

### Prerequisites

- imapsync must be installed on the system where the migration will run.

### Installing imapsync

**Debian/Ubuntu:**
```bash
sudo apt-get update
sudo apt-get install imapsync
```

**RHEL/CentOS:**
```bash
sudo yum install imapsync
```

**macOS (Homebrew):**
```bash
brew install imapsync
```

**From Source (Perl):**
```bash
cpan IMAP::IMAPSync
# or
wget https://github.com/imapsync/imapsync/archive/refs/heads/master.tar.gz
tar xzf master.tar.gz
cd imapsync-*
perl imapsync --help
```

**Verify Installation:**
```bash
imapsync --version
# Expected output: imapsync version X.X (YYYY-MM-DD)
```

## Usage

### Programmatic API

```typescript
import { runImapsyncBulk, checkImapsyncAvailable, getImapsyncVersion } from '@openmig/engines';

// Check if imapsync is available
if (!checkImapsyncAvailable()) {
  throw new Error('imapsync is not installed');
}

// Get version
const version = getImapsyncVersion();
console.log(`Using imapsync ${version}`);

// Run bulk sync
const result = await runImapsyncBulk({
  source: {
    type: 'imap-oauth2',
    host: 'imap.outlook.com',
    port: 993,
    user: 'source@example.com',
    auth: {
      kind: 'xoauth2',
      tokenFromEnv: 'O365_ACCESS_TOKEN',
    },
  },
  target: {
    type: 'imap-dav',
    host: 'imap.soverin.net',
    port: 993,
    user: 'target@example.com',
    auth: {
      kind: 'login',
      passwordFromEnv: 'TARGET_PASSWORD',
    },
  },
  maxBytesPerSecond: 100000,  // Optional: throttle to 100KB/s
  skipMessageSize: 0,          // Optional: skip messages larger than N bytes (0 = no limit)
  timeoutSeconds: 3600,        // Optional: timeout in seconds (default: 1 hour)
  verbose: true,               // Optional: enable verbose logging
});

console.log(`Bulk sync completed: ${result.successCount}/${result.totalMessages} messages`);
console.log(`Duration: ${result.durationSeconds}s`);

if (result.failures.length > 0) {
  console.warn('Some messages failed to sync:');
  result.failures.forEach(f => {
    console.warn(`  - ${f.folder}: ${f.message} - ${f.error}`);
  });
}

// After bulk sync, run incremental sync to populate ledger and ensure idempotency
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `source` | `ImapOAuth2Source` | required | Source IMAP configuration |
| `target` | `ImapDavTarget` | required | Target IMAP configuration |
| `maxBytesPerSecond` | `number` | `100000` | Throttle bandwidth to avoid overwhelming servers |
| `skipMessageSize` | `number` | `0` | Skip messages larger than this size in bytes |
| `timeoutSeconds` | `number` | `3600` | Command timeout in seconds |
| `verbose` | `boolean` | `false` | Enable verbose logging |

### Authentication Support

The imapsync wrapper supports both authentication methods:

**XOAUTH2 (OAuth 2.0):**
```typescript
auth: {
  kind: 'xoauth2',
  tokenFromEnv: 'OAUTH2_TOKEN_ENV_VAR',
}
```

**LOGIN (Password):**
```typescript
auth: {
  kind: 'login',
  passwordFromEnv: 'PASSWORD_ENV_VAR',
}
```

## Integration Workflow

### Recommended Migration Process

1. **Initial Bulk Copy (Optional but Recommended for Large Mailboxes)**
   ```bash
   # Run imapsync bulk sync
   # (This is typically done programmatically via the API)
   ```

2. **Incremental Sync with Ledger**
   ```bash
   # Run the normal migration worker
   pnpm start:worker
   ```

3. **Verification**
   - Check ledger entries match message counts
   - Verify idempotency (re-run should create 0 new messages)
   - Spot-check random messages for flag preservation

### Example: Full Migration Script

```typescript
import { runImapsyncBulk } from '@openmig/engines';
import { startIncrementalSync } from './worker';

async function migrateMailbox() {
  // Step 1: Check imapsync availability
  if (!checkImapsyncAvailable()) {
    console.warn('imapsync not found, skipping bulk sync');
  } else {
    console.log('Running bulk sync with imapsync...');
    const bulkResult = await runImapsyncBulk({
      source: getSourceConfig(),
      target: getTargetConfig(),
      maxBytesPerSecond: 50000,  // Conservative throttle
      verbose: true,
    });
    
    console.log(`Bulk sync: ${bulkResult.successCount}/${bulkResult.totalMessages} messages in ${bulkResult.durationSeconds}s`);
    
    if (bulkResult.failures.length > 0) {
      console.warn(`${bulkResult.failures.length} messages failed during bulk sync`);
    }
  }
  
  // Step 2: Run incremental sync to populate ledger and ensure idempotency
  console.log('Running incremental sync...');
  await startIncrementalSync();
  
  console.log('Migration complete!');
}
```

## Troubleshooting

### imapsync Not Found

```
Error: Command failed: imapsync --version
/bin/sh: imapsync: command not found
```

**Solution**: Install imapsync using your package manager (see Installation section).

### Connection Timeout

```
Error: Connection timed out
```

**Solutions**:
- Check network connectivity to both IMAP servers
- Verify firewall rules allow IMAP connections (usually port 993 for IMAPS)
- Increase `timeoutSeconds` for slow connections

### Authentication Failure

```
Error: Authentication failed
```

**Solutions**:
- Verify credentials are correct
- Check if the account is locked or requires 2FA
- For XOAUTH2, ensure the token is valid and has sufficient scopes
- Verify the environment variable names match the config

### Rate Limiting (429 Errors)

```
Error: 429 Too Many Requests
```

**Solutions**:
- Reduce `maxBytesPerSecond` to be more conservative
- Add delays between sync operations
- Check provider-specific rate limits in `docs/target-providers.md`

### Messages Not Synced

If some messages are missing after imapsync:

1. Check imapsync logs for skipped messages
2. Run incremental sync to catch missed messages
3. Verify Message-ID uniqueness in source
4. Check for folder permission issues

## Performance Tuning

### Optimizing for Speed

```typescript
{
  maxBytesPerSecond: 500000,  // 500KB/s (adjust based on network)
  skipMessageSize: 0,          // Don't skip any messages
  // imapsync is fast by default
}
```

### Optimizing for Reliability

```typescript
{
  maxBytesPerSecond: 50000,   // Conservative 50KB/s
  skipMessageSize: 10485760,  // Skip messages > 10MB (handle separately)
  timeoutSeconds: 7200,       // 2 hour timeout for large mailboxes
}
```

### Large Mailboxes (>100k messages)

For very large mailboxes:
1. Split by folder if possible
2. Use lower `maxBytesPerSecond` to avoid server overload
3. Consider running multiple imapsync instances in parallel (one per folder)
4. Always follow with incremental sync for ledger population

## Limitations

- **No Ledger Awareness**: imapsync doesn't know about the ledger. Always run incremental sync afterward.
- **No Flag Customization**: imapsync transfers standard IMAP flags but may not handle custom keywords perfectly.
- **No Special Folder Handling**: imapsync doesn't automatically handle special-use folders (Sent, Drafts, etc.). Use `--automap` flag.
- **Calendar/Contacts Not Supported**: imapsync only handles emails. Use vdirsyncer for CalDAV/CardDAV.

## Comparison: imapsync vs Direct API

| Aspect | imapsync | Direct API (ImapDavMailTarget) |
|--------|----------|-------------------------------|
| **Speed** | Very fast (bulk transfer) | Slower (one-by-one) |
| **Ledger Integration** | ❌ None | ✅ Full |
| **Idempotency** | ❌ Manual | ✅ Built-in |
| **Flag Preservation** | ✅ Standard flags | ✅ Full support |
| **INTERNALDATE** | ✅ Preserved | ✅ Preserved |
| **Error Handling** | ✅ Built-in retry | ✅ Application-level |
| **Complexity** | External dependency | Pure TypeScript |
| **Best For** | Initial bulk copy | Incremental sync, ledger |

## Security Considerations

- **Temporary Password Files**: imapsync wrapper creates temporary files for passwords. These are deleted after execution.
- **Environment Variables**: Passwords/tokens are read from environment variables, never stored in code or logs.
- **TLS/SSL**: Always use IMAPS (port 993) for encrypted connections.
- **Token Scopes**: For XOAUTH2, ensure tokens have only the minimum required scopes (read/write access to mailboxes).

## Future Enhancements

Potential improvements for future iterations:

- [ ] Integration with `@openmig/ledger` for bulk population
- [ ] Parallel folder sync for additional speed
- [ ] Progress tracking and resume capability
- [ ] Automatic retry for failed messages
- [ ] Support for CalDAV/CardDAV via vdirsyncer

## References

- [imapsync GitHub](https://github.com/imapsync/imapsync)
- [imapsync Documentation](https://imapsync.lamereblanche.com/)
- [RFC 3501 - IMAP4rev1](https://tools.ietf.org/html/rfc3501)
- Provider-specific notes: `docs/target-providers.md`
