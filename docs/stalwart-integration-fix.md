# Stalwart Integration Fix Summary

## Problem Diagnosis

The integration tests were failing with `ECONNREFUSED` errors when trying to connect to Stalwart's IMAP and JMAP ports.

### Root Cause

**Stalwart was running in Recovery Mode** (`STALWART_RECOVERY_MODE=1`), which **suspends all protocol listeners** (JMAP, IMAP, SMTP, CalDAV, CardDAV, WebDAV). Only the HTTP recovery admin API on port 8080 was accessible.

### Key Finding

From Stalwart's documentation and behavior:
- **Recovery mode** is designed for disaster recovery and data migration
- It **disables all service listeners** to prevent data corruption during recovery operations
- The comment in `dev.yml` explicitly stated: *"Recovery mode suspends JMAP/IMAP listeners - they only start in normal operation mode"*

## Solution

### 1. Removed Recovery Mode

**File: `packages/testing/src/testcontainers-setup.ts`**

```typescript
// REMOVED these environment variables:
// STALWART_RECOVERY_MODE: 'true',
// STALWART_RECOVERY_ADMIN: 'admin:devadmin123',
// STALWART_HOSTNAME: 'mail.stalwart.local',
```

### 2. Added Declarative JSON Configuration

**File: `packages/testing/src/testcontainers-setup.ts`**

Created a complete JSON configuration that defines:

```typescript
const STALWART_CONFIG = {
  dataStore: {
    '@type': 'RocksDb',
    path: '/var/lib/stalwart/data',
  },
  http: {
    listeners: {
      default: {
        address: '0.0.0.0:8080',
        protocols: ['jmap', 'admin'],
      },
    },
  },
  imap: {
    listeners: {
      default: {
        address: '0.0.0.0:143',
      },
    },
  },
  directory: {
    internal: {},
  },
  accessControl: {
    principals: {
      admin: {
        type: 'Individual',
        permissions: ['admin'],
        credentials: [
          {
            '@type': 'Password',
            secret: 'devadmin123',
          },
        ],
      },
    },
  },
  domains: {
    'dev.local': {
      isEnabled: true,
    },
  },
  accounts: {
    source: {
      domainId: 'dev-local',
      credentials: [
        {
          '@type': 'Password',
          secret: 'source_password',
        },
      ],
    },
    target: {
      domainId: 'dev-local',
      credentials: [
        {
          '@type': 'Password',
          secret: 'target_password',
        },
      ],
    },
  },
};
```

### 3. Updated Container Configuration

```typescript
const stalwartContainer = await new GenericContainer('stalwartlabs/stalwart:v0.16.10')
  .withExposedPorts(8080, 143)
  .withCopyContentToContainer([
    {
      content: JSON.stringify(STALWART_CONFIG, null, 2),
      target: '/etc/stalwart/config.json',
    },
  ])
  .withCommand(['--config', '/etc/stalwart/config.json'])
  .withWaitStrategy(Wait.forHttp('/healthz/live', 8080))
  // ... rest of configuration
```

### 4. Updated Docker Compose Configuration

**File: `deploy/compose/dev.yml`**

Removed the recovery mode environment variable and updated comments:

```yaml
stalwart:
  build:
    context: .
    dockerfile: Dockerfile.stalwart-config
  image: stalwart-custom:config
  # No STALWART_RECOVERY_MODE - run in normal operation mode with listeners enabled
  tmpfs:
    - /opt/stalwart/data:mode=777
  ports:
    - "8180:8080"  # JMAP/DAV HTTP API
    - "143:143"    # IMAP (plain)
    - "993:993"    # IMAPS (TLS)
```

### 5. Updated Static Configuration File

**File: `deploy/compose/stalwart-config.json`**

Updated with complete configuration including listeners, domains, and accounts (see full file above).

## Configuration Format Notes

### Stalwart v0.16 Configuration

- **Format**: JSON (NOT TOML as incorrectly stated in some documentation)
- **Schema**: Declarative configuration with nested objects
- **Key sections**:
  - `dataStore`: Storage backend configuration
  - `http`: HTTP server listeners
  - `imap`: IMAP server listeners  
  - `directory`: Authentication directory configuration
  - `accessControl`: User/role permissions
  - `domains`: Domain definitions
  - `accounts`: User account definitions

### Credential Schema

Accounts use this structure:

```json
{
  "accounts": {
    "username": {
      "domainId": "domain-name",
      "credentials": [
        {
          "@type": "Password",
          "secret": "plain-text-password"
        }
      ]
    }
  }
}
```

## Testing

After these changes, Stalwart should:
1. Start in normal operation mode (not recovery mode)
2. Have IMAP listener active on port 143
3. Have JMAP listener active on port 8080
4. Have pre-configured domains and accounts available
5. Accept connections from integration tests without `ECONNREFUSED` errors

## Files Modified

1. `packages/testing/src/testcontainers-setup.ts` - Main testcontainers setup
2. `deploy/compose/stalwart-config.json` - Static config for docker-compose
3. `deploy/compose/dev.yml` - Docker Compose stack definition

## Verification Steps

To verify the fix works:

```bash
# Start the test environment
docker compose -f deploy/compose/dev.yml up -d

# Check that Stalwart is running
docker ps | grep stalwart

# Test IMAP connectivity
nc -zv localhost 143

# Test JMAP/HTTP connectivity
curl http://localhost:8180/healthz/live

# Run integration tests
pnpm test:integration
```

## References

- Stalwart GitHub: https://github.com/stalwartlabs/stalwart
- Stalwart Documentation: https://stalw.art/docs
- ADR-0018: JMAP primary target / IMAP/DAV second / both MVP
