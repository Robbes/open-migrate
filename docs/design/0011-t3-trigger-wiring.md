# Design: Trigger.dev Job Wiring (T3)

**Workplan 0011, Task 3** — Wire Trigger.dev jobs to call the REAL core engine

**Status:** Design Proposal (awaiting owner approval before implementation)

**Date:** 2026-07-18

---

## Executive Summary

The Trigger.dev jobs in `apps/worker/src/jobs/` are currently **placeholders** that log messages but do NOT call the real core engine (`runShadowPass`, `runDomainSync`, cutover machine). T3's purpose is to wire these jobs to actually execute the sync/cutover logic that's already implemented and tested in `@openmig/core`.

**Critical Security Finding:** The jobs currently lack tenant scoping. They must wrap ALL database operations in `withTenant(tenantId)` to enforce RLS. The `tenant_id` must flow from the authenticated API request → job payload → job execution, never forgeable.

---

## Part A: Ground-Truth Report

### A(a) Job Enumeration

| Job File | Payload Schema | Current Behavior | Should Call |
|----------|---------------|------------------|-------------|
| **run-full-sync.ts** | `tenantId`, `mappingId`, `options.maxItems`, `options.forceFullScan` | Logs "Starting full sync", loops through domains but does NOT call any core function. Code for `syncFullData` is commented out. | `runDomainSync` for each enabled domain (email, calendar, contact, file) |
| **run-delta-sync.ts** | `tenantId`, `mappingId`, `domains[]` | Initializes DB, status store, ledger, cursors. For 'email': **THROWS ERROR** (previously had `null as unknown as SourceConnector` which was removed). For other domains: logs "not yet implemented", marks skipped. | `runShadowPass` with REAL source/target from credentials; `runCalendarSync`, `runContactSync`, `runFileSync` for other domains |
| **run-cutover.ts** | `tenantId`, `mappingId`, `options.skipFinalSync`, `options.skipVerification`, `options.gracePeriodHours`, `options.dnsDomain`, `options.targetMailServer` | Initializes cutover state via `CutoverStore`. Steps 1 (delta sync) and 2 (verification) are TODOs/placeholders. Steps 3-7 (state transitions, DNS update, grace period) work but DNS is TODO. | Final delta sync via `runShadowPass`; verification with real ledger/target checks; DNS update via DesecProvider |
| **run-rollback.ts** | `tenantId`, `mappingId`, `reason`, `options.restoreDns`, `options.notifyUsers`, `options.dnsDomain` | Loads cutover state. Steps 1 (DNS restore) and 2 (data source restoration) are TODOs. Step 3 (state transition) works. Step 4 (notification) is TODO. | DNS rollback via DesecProvider; data source restoration; user notification |

**Key Fix:** The `null as unknown as SourceConnector` forbidden type-cast in `run-delta-sync.ts` has been **removed**. It now throws a clear error explaining that secret storage must be implemented first.

**Summary:** Jobs have the right structure but are mostly placeholders. None call the real core engine with actual source/target connectors.

---

### A(b) Standalone Worker Dependency Construction

The standalone worker (`apps/worker/src/index.ts`) uses `buildDeps()` and `buildDomainDeps()` from `apps/worker/src/build-deps.ts`:

```typescript
// buildDeps() — for mail (runShadowPass)
export async function buildDeps(config: MappingConfig): Promise<ReconcileDeps> {
  const databaseUrl = process.env.DATABASE_URL;
  const db = createPgDb(databaseUrl);
  const ledger = new PgLedger(db);
  const cursors = new PgCursorStore(db);
  const throttleLimiter = buildThrottleLimiter(config);
  const source = buildSourceConnector(config.source, throttleLimiter);
  const target = buildTargetWriter(config.target);
  
  return { tenantId, mappingId, source, target, ledger, cursors, concurrency };
}

// buildDomainDeps() — for calendar, contact, file
export function buildDomainDeps(config, domain): { source, target, ledger, cursors } {
  const db = createPgDb(process.env.DATABASE_URL);
  const ledger = new PgLedger(db);
  const cursors = new PgCursorStore(db);
  // Build source/target based on domain config
  return { tenantId, mappingId, source, target, ledger, cursors };
}
```

**Secrets source:**
- `DATABASE_URL` — from environment
- OAuth2 credentials: `OAUTH2_TENANT_ID`, `OAUTH2_CLIENT_ID`, `OAUTH2_CLIENT_SECRET`, `OAUTH2_REFRESH_TOKEN`
- Source/target credentials: Referenced via `passwordFromEnv` or `tokenFromEnv` fields in the mapping config (e.g., `process.env[sourceConfig.auth.tokenFromEnv]`)

**Key insight:** The jobs need to reconstruct these same dependencies, but they must:
1. Load secrets from a per-mapping source (connection table or secret store), NOT from global environment
2. Wrap all DB operations in `withTenant(tenantId)` for RLS

---

### A(c) API Sync/Cutover Endpoints

**Current state (`apps/api/src/routes/migrations/index.ts`):**

```typescript
// POST /api/mappings/:mappingId/sync
router.post('/:mappingId/sync', authenticate, async (req, res) => {
  // ... authenticate, verify mapping via withTenantDb ...
  
  // TODO: Trigger Trigger.dev job
  // Mock response:
  res.json({
    success: true,
    runId: `run-${Date.now()}`,
    jobType: body.type,
    note: 'Sync trigger is a placeholder - actual Trigger.dev integration in T3',
  });
});

// POST /api/mappings/:mappingId/cutover
router.post('/:mappingId/cutover', authenticate, async (req, res) => {
  // ... authenticate, verify mapping via withTenantDb ...
  
  // TODO: Trigger Trigger.dev cutover job
  // Mock response:
  res.json({
    success: true,
    runId: `run-cutover-${Date.now()}`,
    note: 'Cutover trigger is a placeholder - actual Trigger.dev integration in T3',
  });
});
```

**Trigger.dev enqueue mechanism:**
- `apps/worker/src/trigger-client.ts` defines `triggerClient` using `@trigger.dev/sdk/v3`
- Requires `TRIGGER_DEV_ACCESS_TOKEN` and `TRIGGER_DEV_BASE_URL` environment variables
- Jobs are registered via `schemaTask()` decorator in the job files
- **No enqueue code exists yet** — the API endpoints return mock responses

---

### A(d) RLS Context in Async Jobs — CRITICAL SECURITY FINDING

**Problem:** Trigger.dev jobs run OUTSIDE the HTTP request context. There's no `req.tenantId`. The jobs currently:

1. Initialize DB directly with `DATABASE_URL`
2. Run queries without ANY tenant scoping
3. Have NO `withTenant()` wrapper

**This is a security hole.** Without `withTenant()`, the job can read/write data from ANY tenant — the RLS policies are never enforced.

**Required fix:** Every job must wrap ALL database operations in `withTenant(tenantId)`:

```typescript
export const runDeltaSync = schemaTask({
  id: 'run-delta-sync',
  schema: DeltaSyncJobSchema,
  run: async (payload, { ctx }) => {
    const { tenantId, mappingId } = payload as DeltaSyncJobPayload;
    
    // SECURITY: Wrap ALL DB work in tenant scoping
    const dbUrl = process.env.DATABASE_URL;
    const pool = new Pool({ connectionString: dbUrl });
    
    try {
      await withTenant(pool, tenantId, async (db) => {
        // ALL queries inside here are RLS-scoped
        const statusStore = new PgMigrationStatusStore(db);
        const ledger = new PgLedger(db);
        const cursors = new PgCursorStore(db);
        
        // ... run sync logic ...
      });
    } finally {
      await pool.end();
    }
  }
});
```

**Tenant_id flow (security invariant):**
1. API authenticates user → extracts `tenantId` from JWT
2. API verifies mapping belongs to tenant via `withTenantDb(tenantId, ...)`
3. API enqueues job with `payload: { tenantId, mappingId, ... }`
4. Job receives `tenantId` from payload
5. Job wraps ALL DB operations in `withTenant(tenantId, ...)`
6. If `tenantId` is missing/invalid → job FAILS CLOSED (does NOT run)

**The tenant_id MUST originate from the authenticated API request. It must NEVER be forgeable by a client.**

---

### A(e) Migration Status Updates

The jobs update `migration_status` via `PgMigrationStatusStore`:

```typescript
const statusStore = new PgMigrationStatusStore(db);

// Initialize
await statusStore.initDomainStatus(tenantId, mappingId, domain);

// Mark in progress
await statusStore.markInProgress(tenantId, mappingId, domain);

// On success
await statusStore.markCompleted(tenantId, mappingId, domain);

// On failure
await statusStore.markFailed(tenantId, mappingId, domain, errorMessage);
```

**State transitions:** `init` → `in_progress` → `completed` OR `failed`

The cutover job uses `CutoverStore` for cutover state:
- `initializeCutover()` → `transitionState('READY_FOR_CUTOVER')` → `transitionState('CUTOVER_IN_PROGRESS')` → `transitionState('COMPLETED')`

---

## Part A: Ground-Truth Report

### A(f) Secrets Handling — CRITICAL FINDING: NO SECRET STORE EXISTS

**Current mechanism:**
- Secrets are stored in **global environment variables only**
- Mapping config references env var names via `passwordFromEnv` or `tokenFromEnv` fields
- Example: `sourceConfig.auth.tokenFromEnv = 'OAUTH2_ACCESS_TOKEN'` → code reads `process.env.OAUTH2_ACCESS_TOKEN`
- `buildDeps()` in `apps/worker/src/build-deps.ts` reads directly from `process.env`

**Schema has `secretRef` field but NO implementation:**
- The `connection` table has a `secret_ref` column (text)
- **There is NO code to resolve or store secrets via this field**
- No SecretManager, Vault integration, or secret resolution logic exists anywhere in the codebase

**This is a PREREQUISITE BLOCKER for T3:**
- Jobs cannot run without credentials
- Jobs cannot read from global `process.env` (that would be shared across all tenants)
- **T3 cannot proceed without a secret storage/resolution mechanism**

**Proposed minimal secret mechanism for T3:**

Since a full secret manager doesn't exist, propose a **simple encrypted JSON storage** in the `connection` table:

1. **Store credentials encrypted in the `connection` table:**
   ```typescript
   // connection.config or a dedicated encrypted_credentials column
   {
     "source": {
       "imap_host": "imap.example.com",
       "imap_port": 993,
       "user": "user@example.com",
       "oauth2_token": "<encrypted>",
       "oauth2_refresh_token": "<encrypted>"
     }
   }
   ```

2. **Add a simple encryption layer:**
   ```typescript
   // packages/core/src/secrets.ts (new file)
   const ENCRYPTION_KEY = process.env.SECRET_ENCRYPTION_KEY; // 32-byte key from env
   
   export function encryptSecrets(secrets: Record<string, string>): string {
     const crypto = require('crypto');
     const iv = crypto.randomBytes(16);
     const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
     const encrypted = Buffer.concat([iv, cipher.update(JSON.stringify(secrets)), cipher.final()]);
     return encrypted.toString('base64');
   }
   
   export function decryptSecrets(encrypted: string): Record<string, string> {
     const crypto = require('crypto');
     const data = Buffer.from(encrypted, 'base64');
     const iv = data.slice(0, 16);
     const encryptedData = data.slice(16);
     const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
     const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
     return JSON.parse(decrypted.toString());
   }
   ```

3. **Jobs load and decrypt credentials:**
   ```typescript
   await withTenant(pool, tenantId, async (db) => {
     const [connection] = await db.select()
       .from(connection)
       .where(eq(connection.id, mapping.connectionId));
     
     const secrets = decryptSecrets(connection.encryptedCredentials);
     const source = new ImapSource({
       host: secrets.imap_host,
       auth: { accessToken: secrets.oauth2_token },
     });
   });
   ```

**Alternative (simpler for MVP):** Store credentials unencrypted in `connection.config` JSONB (same as current env var approach but per-mapping). **Not recommended for production** but works for testing/MVP.

**Recommendation:** Implement the encrypted storage approach above as part of T3. This is minimal and self-contained — no external secret manager needed.

---

## Part B: Design Proposal

### B1. Job Implementation Strategy — Scoped to SYNC Jobs Only

**Scope for T3:**
- **IN SCOPE:** `run-full-sync.ts`, `run-delta-sync.ts` (sync jobs)
- **OUT OF SCOPE:** `run-cutover.ts`, `run-rollback.ts` (these have DNS/verification TODOs and touch human-gated runbook steps)

**Cutover/rollback handling:**
- The cutover process follows **runbook 0009** which has a **DELIBERATE human gate** before DNS changes
- **DO NOT auto-run DNS cutover from a job** — this must remain manual
- Cutover/rollback jobs will be wired in a SEPARATE later step after the sync engine is proven

For each **SYNC job**, the implementation:

1. **Validate payload** (already done via Zod schema)
2. **Check tenant_id presence** — fail closed if missing
3. **Initialize DB pool** from `DATABASE_URL`
4. **Wrap ALL DB operations in `withTenant(tenantId, ...)`**
5. **Load mapping and connection credentials** from DB (via `withTenant`)
6. **Decrypt credentials** using the secret mechanism
7. **Build source/target connectors** using decrypted credentials
8. **Call the real core engine** (`runShadowPass`, `runCalendarSync`, etc.)
9. **Update status** via `PgMigrationStatusStore`

**Code reuse:** Create `buildDepsFromMapping()` that takes mapping/connection rows as input instead of reading from global env. This factors out the same dependency construction logic from `apps/worker/src/build-deps.ts` but accepts credentials as parameters.

---

### B2. Tenant-Context-in-Jobs Design

**Security-critical pattern:**

```typescript
export const runDeltaSync = schemaTask({
  id: 'run-delta-sync',
  schema: DeltaSyncJobSchema,
  run: async (payload, { ctx }) => {
    const typedPayload = payload as DeltaSyncJobPayload;
    
    // SECURITY: Fail closed if tenantId missing
    if (!typedPayload.tenantId) {
      throw new Error('tenantId is required in job payload');
    }
    
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      throw new Error('DATABASE_URL environment variable required');
    }
    
    const pool = new Pool({ connectionString: dbUrl });
    
    try {
      // SECURITY: Wrap ALL DB operations in tenant scoping
      await withTenant(pool, typedPayload.tenantId, async (db) => {
        const statusStore = new PgMigrationStatusStore(db);
        const ledger = new PgLedger(db);
        const cursors = new PgCursorStore(db);
        
        // Load mapping and connections (RLS-enforced)
        const mappings = await db.select()
          .from(mailboxMapping)
          .where(and(
            eq(mailboxMapping.id, typedPayload.mappingId),
            eq(mailboxMapping.tenantId, typedPayload.tenantId)
          ));
        
        if (mappings.length === 0) {
          throw new Error('Mapping not found or access denied');
        }
        
        // Load credentials from connection table
        const sourceConnection = await db.select()
          .from(connection)
          .where(and(
            eq(connection.tenantId, typedPayload.tenantId),
            eq(connection.role, 'source')
          ));
        
        // Build deps with loaded credentials
        const deps = await buildDepsFromMapping(
          mappings[0]!, 
          sourceConnection[0]!,
          { ledger, cursors }
        );
        
        // Run the actual sync
        const result = await runShadowPass(deps);
        
        // Update status
        await statusStore.markCompleted(...);
      });
    } finally {
      await pool.end();
    }
  }
});
```

**Key rules:**
- `withTenant()` wraps EVERYTHING that touches the database
- No queries outside `withTenant()`
- If `tenantId` is missing → throw error immediately
- If mapping not found → throw error (don't proceed)

---

### B3. API Enqueue Path

**Secure enqueue flow:**

```typescript
// POST /api/mappings/:mappingId/sync
router.post('/:mappingId/sync', authenticate, async (req, res) => {
  const { mappingId } = req.params;
  const tenantId = req.tenantId; // From JWT, authenticated
  
  // Verify mapping belongs to tenant (RLS-enforced)
  const mappings = await withTenantDb(tenantId, pool, async (db) => {
    return await db.select()
      .from(mailboxMapping)
      .where(eq(mailboxMapping.id, mappingId));
  });
  
  if (mappings.length === 0) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }
  
  // Enqueue Trigger.dev job with AUTHENTICATED tenantId
  const client = getTriggerClient();
  const run = await client.trigger({
    job: 'run-delta-sync',
    payload: {
      tenantId,           // From authenticated request, NOT from body
      mappingId,
      domains: body.domains,
    },
  });
  
  res.json({
    success: true,
    runId: run.id,
    triggeredAt: new Date().toISOString(),
  });
});
```

**Security invariant:**
- `tenantId` comes from `req.tenantId` (authenticated JWT), NOT from request body
- Client CANNOT enqueue a job for another tenant's mapping
- The API verifies mapping ownership BEFORE enqueuing

---

### B4. Status Feedback

Jobs update status exactly as the standalone worker does:

```typescript
// For each domain:
await statusStore.initDomainStatus(tenantId, mappingId, domain);
await statusStore.markInProgress(tenantId, mappingId, domain);

try {
  const result = await runShadowPass(deps);
  await statusStore.markCompleted(tenantId, mappingId, domain);
} catch (error) {
  await statusStore.markFailed(tenantId, mappingId, domain, error.message);
  throw error;
}
```

**API/UI can poll:** `GET /api/mappings/:mappingId/status` reads `migration_status` table

---

### B5. Secrets Handling

**Proposed mechanism:**

1. **Store credentials in `connection` table:**
   ```sql
   INSERT INTO connection (tenant_id, role, kind, display_name, config, secret_ref)
   VALUES (... , 'source', 'imap-oauth2', 'O365 Inbox', {...}, 'vault://openmig/tenant-uuid/connection-uuid');
   ```

2. **Job loads connection via `withTenant(tenantId, ...)`:**
   ```typescript
   const connection = await db.select()
     .from(connection)
     .where(and(
       eq(connection.tenantId, tenantId),
       eq(connection.role, 'source')
     ));
   ```

3. **Resolve secret from secret manager:**
   ```typescript
   const credentials = await secretManager.resolve(connection[0]!.secretRef);
   // Returns { accessToken, refreshToken, ... }
   ```

4. **Pass credentials to source builder:**
   ```typescript
   const source = new ImapSource({
     host: connectionConfig.host,
     auth: {
       user: connectionConfig.user,
       accessToken: credentials.accessToken,
     },
   });
   ```

5. **Never log secrets:**
   ```typescript
   // GOOD
   console.log('Connected to IMAP server:', config.host);
   
   // BAD
   console.log('Auth config:', config.auth); // Logs token!
   ```

---

### B6. Test Plan — Direct Invocation (No Trigger.dev Infra Required)

**Critical:** Tests must prove the job's core-calling logic WITHOUT requiring Trigger.dev infrastructure in CI.

**Approach:** Invoke the task's `run()` function directly with a mock payload — bypasses the Trigger.dev scheduler entirely.

**Integration Test 1: Sync Job Actually Runs Core**

```typescript
import { runDeltaSync } from '@openmig/worker/jobs'; // Export run function for testing
import { createTestContainer } from './test-helpers';

it('should run shadow pass and create ledger items', async () => {
  // Setup: Create test container with Postgres
  const { pool, tenantId, mappingId, credentials } = await createTestContainer();
  
  // Insert connection with encrypted credentials
  await insertConnection(pool, tenantId, 'source', credentials);
  
  // Directly invoke the job's run() function (bypasses Trigger.dev scheduler)
  const mockContext = {
    logger: { log: console.log },
    schedule: () => {},
    cancel: () => {},
  };
  
  await runDeltaSync.run(
    { tenantId, mappingId, domains: ['email'] },
    mockContext
  );
  
  // Assert: migration_status shows completed
  const status = await getStatus(pool, tenantId, mappingId, 'email');
  expect(status).toBe('completed');
  
  // Assert: ledger items were created
  const items = await db.select().from(ledgerItem)
    .where(eq(ledgerItem.mappingId, mappingId));
  expect(items.length).toBeGreaterThan(0);
});
```

**Integration Test 2: Cross-Tenant Isolation (Security)**

```typescript
it('should NOT access tenant A data when running job for tenant B', async () => {
  // Setup: Create tenant A with mapping and data
  const { pool, tenantA, mappingA } = await createTestContainer('tenant-a');
  await createLedgerItems(pool, tenantA, mappingA, ...);
  
  // Setup: Create tenant B with different mapping
  const { tenantB, mappingB } = await createTestContainer('tenant-b');
  
  // Invoke job for tenant B
  await runDeltaSync.run(
    { tenantId: tenantB, mappingId: mappingB, domains: ['email'] },
    mockContext
  );
  
  // Assert: tenant B's job could NOT see tenant A's data
  const tenantAItems = await db.select().from(ledgerItem)
    .where(eq(ledgerItem.tenantId, tenantA));
  expect(tenantAItems.length).toBe(originalCount); // Unchanged
  
  // Assert: tenant B has its own isolated data
  const tenantBItems = await db.select().from(ledgerItem)
    .where(eq(ledgerItem.tenantId, tenantB));
  expect(tenantBItems.length).toBeGreaterThan(0);
});
```

**Integration Test 3: Standalone Worker Still Works**

```typescript
it('standalone worker should still work unchanged', async () => {
  // Run the CLI worker directly with a mapping config
  const result = await execCLI('--config test-mapping.json --once');
  
  expect(result.exitCode).toBe(0);
  // Assert ledger items created, status updated, etc.
});
```

**Test Infrastructure:**
- Use **Testcontainers** for Postgres (same as existing integration tests)
- **No Trigger.dev server needed** — we call `run()` directly
- Mock external services (IMAP, JMAP) or use test fixtures
- Encryption key for secrets can be a test constant

**Why this works:**
- The job's `run()` function is a normal async function — it doesn't require Trigger.dev runtime
- We provide the same context object that Trigger.dev would provide
- Tests exercise the actual DB and core engine code paths
- CI can run these tests without any Trigger.dev infrastructure

---

## Dependencies & Blockers

**CRITICAL BLOCKER: Secret Storage Mechanism Does Not Exist**

1. **Secret Store (PREREQUISITE):** The `secretRef` field in the `connection` table has NO implementation. There is no SecretManager, Vault integration, or secret resolution logic. 
   - **Option A (Recommended):** Implement the encrypted JSON storage mechanism proposed in Section A(f) — AES-256-GCM encryption with a key from `SECRET_ENCRYPTION_KEY` env var
   - **Option B (MVP):** Store credentials unencrypted in `connection.config` JSONB (works for testing, not production)
   - **Decision needed:** Which approach to take before T3 implementation can proceed

2. **`buildDepsFromMapping()` refactoring:** Current `buildDeps()` reads from global env; need version that accepts credentials as input and doesn't use `null as unknown as SourceConnector`

3. **Trigger.dev infrastructure:** For actual job execution (not needed for testing — see B6)

**T3 cannot proceed without resolving the secret storage issue.** The minimal encrypted storage approach is recommended to unblock implementation.

---

## Recommendations

1. **Start with `run-delta-sync.ts`** — It's the simplest and has the most impact (frequent scheduled syncs)
2. **Implement `buildDepsFromMapping()`** — Factor out shared dependency construction
3. **Add `withTenant()` wrapper to ALL jobs** — Security-critical, do this first
4. **Create integration tests** — Prove the jobs actually run the core engine
5. **Document secrets mechanism** — Decide on vault/secret manager approach

---

## Next Steps

1. **Owner review** of this design proposal
2. **Approve or provide feedback** on the proposed approach
3. **Implementation** — Start with `run-delta-sync.ts` + `withTenant()` wrapper
4. **Test** — Run integration tests with Testcontainers
5. **Iterate** — Apply same pattern to other jobs

---

**This is a design proposal only. No implementation has been done.**
