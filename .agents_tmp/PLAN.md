# Workplan 0002 — IMAP/DAV Target Family Implementation Plan

## 1. OBJECTIVE

Implement Workplan 0002: Add IMAP/DAV target family support (O365 → Soverin/openDesk mail) as a parallel target to JMAP, maintaining the same idempotency, non-destructive, and shadow-running guarantees established in Workplan 0001.

---

## 2. CONTEXT SUMMARY

**Repository:** open-migrate - Sovereign migration tool for moving from O365/Google to EU sovereign platforms

**Workplan 0002:** IMAP/DAV target family (O365 → Soverin / openDesk mail)

**Prerequisites (Workplan 0001 - Complete):**
- `packages/core` - `runShadowPass` reconcile loop with idempotency guarantees ✅
- `packages/connectors` - `ImapSource` (O365 IMAP+OAuth2), `JmapTargetWriter` ✅
- `packages/ledger` - `SqlLedger`, `PgCursorStore` for idempotency state ✅
- `packages/scheduler` - `InProcessScheduler` with croner ✅
- `apps/worker` - CLI entrypoint ✅
- Idempotency property tests: run twice → zero creates; delta: add 1 → create 1 ✅

**Key Architecture Decisions:**
- **ADR-0018:** JMAP is primary target protocol; IMAP/DAV is parallel second family — both in MVP
- **ADR-0007:** Reuse proven engines (imapsync for bulk, direct IMAP for incremental)
- **ADR-0011:** Targets are managed EU/CH platforms (Soverin, openDesk); self-hosted targets are user-operated
- **ADR-0006:** O365 source uses IMAP+OAuth2 (unchanged for 0002)

**Target Platforms:**
- **Soverin:** IMAP/CalDAV/CardDAV/WebDAV based (OX/Nextcloud)
- **openDesk:** OX-based suites with IMAP/DAV
- **Stalwart:** Reference server for local dev (speaks both JMAP and IMAP/DAV)

**Current State:**
- JMAP target writer is fully implemented and tested
- IMAP source connector is fully implemented
- Core engine, ledger, and scheduler are complete
- **Missing:** IMAP target writer (`ImapDavMailTarget`) for writing to IMAP servers

---

## 3. APPROACH OVERVIEW

**Chosen Approach:**
Implement `ImapDavMailTarget` as a `TargetWriter` that uses IMAP APPEND for mail import, with ledger-gated idempotency. This mirrors the JMAP target's architecture but uses IMAP protocol instead.

**Rationale:**
1. **Minimal architecture change:** Reuses the existing reconcile loop, ledger, cursors, and scheduler from 0001
2. **Proven technology:** IMAP is mature and universally supported; imapsync is battle-tested
3. **Idempotency via ledger:** Same pattern as JMAP — check ledger first, then verify on target via SEARCH HEADER Message-ID
4. **Parallel to JMAP:** Both target types can coexist; mapping config selects which to use

**Two-Path Strategy:**
- **Bulk (optional):** Shell out to `imapsync` for initial full copy (faster for large mailboxes)
- **Incremental:** Direct IMAP client using APPEND with ledger-gated idempotency (for shadow/delta sync)

**Why Not imapsync-Only:**
- imapsync is excellent for one-shot bulk copy but doesn't integrate cleanly with our ledger-based idempotency
- Incremental shadow runs need fine-grained control (per-message ledger checks, flag preservation, INTERNALDATE)
- Best of both: imapsync for initial bulk, direct IMAP for incremental deltas

---

## 4. IMPLEMENTATION STEPS

### Step U1 — Core ImapDavMailTarget Implementation

**Goal:** Implement `ImapDavMailTarget` as a `TargetWriter` for IMAP mail targets

**Method:**
Create `packages/connectors/src/imap-dav-target.ts` with:

1. **Configuration interface:**
   ```typescript
   export interface ImapDavTargetConfig {
     host: string;
     port: number;
     tls: boolean;
     auth: {
       user: string;
       password: string; // or accessToken for OAuth2
     };
     authType?: "LOGIN" | "XOAUTH2";
   }
   ```

2. **`connect()` / `disconnect()`:** IMAP connection management using the `imap` package (same as ImapSource)

3. **`ensureMailbox(folder: MailFolder): Promise<string>`:**
   - Check if mailbox exists using `conn.getBoxes()`
   - Create if absent using CREATE command
   - Set special-use flags where server supports it (RFC 6154)
   - Return mailbox path as the target ID

4. **`upsertEmail(mailboxId, raw, keywords): Promise<UpsertResult>`:**
   - Extract Message-ID from raw RFC822
   - **Idempotency check:** `SEARCH HEADER Message-ID:<id>` on target mailbox
   - If found, return `{ targetId, created: false }`
   - If not found:
     - Parse headers to extract `Date:` for INTERNALDATE
     - Map keywords to IMAP flags (`$seen` → `\Seen`, etc.)
     - Use `APPEND` with:
       - Mailbox path
       - Flags (if any)
       - INTERNALDATE (ISO 8601 → IMAP date format)
       - RFC822 message bytes
   - Return `{ targetId: uid, created: true }`

5. **`findByNaturalKey(mailboxId, naturalKey): Promise<string | undefined>`:**
   - SEARCH for `HEADER Message-ID <naturalKey>`
   - Return UID if found, undefined otherwise

6. **`listEntries(mailboxId?): AsyncIterable<TargetEntry>`:**
   - For reindex/ledger recovery (ADR-0020)
   - FETCH all UIDs with headers (Message-ID)
   - Yield `{ naturalKey: messageId, targetId: uid, mailboxId }`

7. **Helper functions:**
   - `mapKeywordsToImapFlags()`: Convert `MailKeyword` → IMAP flags
   - `formatImapDate()`: Convert ISO 8601 → IMAP date format (`"01-Jan-2024 12:34:56 +0000"`)
   - `extractMessageIdFromRfc822()`: Parse Message-ID from raw RFC822

**Acceptance Criteria:**
- Unit tests for flag mapping and date formatting
- Integration test against Stalwart (IMAPS 993):
  - Write N messages to target
  - Re-run → creates 0 (idempotency)
  - Add 1 message → creates exactly 1 (delta)
  - Verify flags preserved
  - Verify INTERNALDATE preserved

**Reference Files:**
- `packages/connectors/src/jmap-target.ts` (reference for TargetWriter pattern)
- `packages/connectors/src/imap-source.ts` (reference for IMAP client usage)
- `packages/shared/src/ports.ts` (TargetWriter interface)

---

### Step U2 — imapsync Bulk Path (Optional Enhancement)

**Goal:** Add optional bulk copy capability using imapsync shell-out

**Method:**
Create `packages/engines/src/imapsync-wrapper.ts`:

1. **Wrapper function:**
   ```typescript
   async function runImapsyncBulk(source: ImapSourceConfig, target: ImapDavTargetConfig): Promise<BulkResult>
   ```

2. **Command construction:**
   ```bash
   imapsync \
     --host1 <source-host> --user1 <source-user> --passfile1 <source-pass> \
     --host2 <target-host> --user2 <target-user> --passfile2 <target-pass> \
     --automap --skipmessagesize 0 --maxbytespersecond 100000
   ```

3. **Integration with reconcile loop:**
   - Before incremental sync, check if target is empty
   - If yes, optionally run imapsync for bulk copy
   - After imapsync, run normal reconcile to ensure ledger is populated
   - Ledger guards against duplicates from imapsync

4. **Configuration flag:**
   - Add `bulkMethod?: "imapsync" | "direct"` to mapping config
   - Default: "direct" (simpler, more controlled)

**Acceptance Criteria:**
- imapsync command executes successfully against Stalwart
- Bulk copy followed by incremental pass converges with no duplicates
- Ledger is properly populated after bulk + incremental
- Documentation on when to use imapsync vs. direct

**Note:** This is optional for MVP. The direct APPEND path is sufficient; imapsync is a performance optimization for large mailboxes.

---

### Step U3 — Target Selection Wiring

**Goal:** Wire the mapping config to select between JMAP and IMAP/DAV target types

**Method:**

1. **Update mapping config schema** (`packages/shared/src/config.ts`):
   ```typescript
   export type TargetType = "jmap" | "imapdav";
   
   export interface TargetConfig {
     type: TargetType;
     // JMAP-specific
     baseUrl?: string;
     username?: string;
     password?: string;
     // IMAP/DAV-specific
     imapHost?: string;
     imapPort?: number;
     imapTls?: boolean;
     // Shared
     mailbox: string;
   }
   ```

2. **Target factory function:**
   ```typescript
   // packages/connectors/src/target-factory.ts
   export function createTargetWriter(config: TargetConfig): TargetWriter {
     switch (config.type) {
       case "jmap":
         return new JmapTargetWriter({ baseUrl: config.baseUrl!, username: config.username!, password: config.password! });
       case "imapdav":
         return new ImapDavMailTarget({
           host: config.imapHost!,
           port: config.imapPort!,
           tls: config.imapTls!,
           auth: { user: config.username!, password: config.password! }
         });
       default:
         throw new Error(`Unknown target type: ${config.type}`);
     }
   }
   ```

3. **Update worker CLI** (`apps/worker/src/index.ts`):
   - Use `createTargetWriter()` to instantiate the correct target based on config
   - No changes needed to the reconcile loop — it's target-agnostic

4. **Parametrize property tests:**
   - Create test fixtures for both JMAP and IMAP/DAV targets
   - Run the same idempotency and delta tests against both target types
   - Verify both pass with identical semantics

**Acceptance Criteria:**
- Mapping config with `type: "jmap"` creates JmapTargetWriter
- Mapping config with `type: "imapdav"` creates ImapDavMailTarget
- Same idempotency tests pass for both target types
- Worker CLI works with both target types

**Reference Files:**
- `packages/shared/src/config.ts` (config schema)
- `apps/worker/src/index.ts` (CLI wiring)
- `packages/ledger/src/shadow-pass.integration.test.ts` (property tests to parametrize)

---

### Step U4 — Provider Specifics & Documentation

**Goal:** Document and handle quirks for Soverin and openDesk providers

**Method:**

1. **Create `docs/target-providers.md`:**
   - **Soverin:**
     - IMAP server details (host, port, TLS requirements)
     - Special-use folder support (which RFC 6154 features are advertised)
     - Folder naming conventions (e.g., "Sent Messages" vs. "Sent")
     - Throttling/limits (if known)
     - Authentication method (password vs. OAuth2)
   
   - **openDesk (OX-based):**
     - IMAP server details
     - Special-use folder handling
     - Known quirks (e.g., folder creation requirements)
     - Throttling/limits
   
   - **Stalwart (reference):**
     - Already documented in `docs/stalwart-integration-fix.md`
     - IMAPS on 993, TLS required
     - Full RFC 6154 support

2. **Handle provider quirks in code:**
   - Folder name normalization (e.g., "Sent Messages" → "Sent")
   - Graceful handling of servers that don't advertise special-use
   - Retry logic for throttled requests (429 responses)

3. **Manual smoke test guide:**
   - Steps to test against real Soverin/openDesk accounts
   - Secret-gated environment setup (never commit credentials)
   - Expected behavior and verification steps

**Acceptance Criteria:**
- `docs/target-providers.md` documents Soverin and openDesk specifics
- Code handles missing special-use support gracefully
- Manual smoke test against real provider accounts succeeds
- Idempotency verified on real targets (run twice → zero creates)

---

### Step 5 — Integration & End-to-End Testing

**Goal:** Ensure the full IMAP/DAV stack works end-to-end

**Method:**

1. **Add IMAP target integration tests** (`packages/connectors/src/imap-dav-target.test.ts`):
   - Test against Stalwart (which supports IMAP)
   - Test mailbox creation with special-use
   - Test email APPEND with flags and INTERNALDATE
   - Test idempotency (write twice → second is no-op)
   - Test reindex (`listEntries`)

2. **Parametrize existing shadow-pass tests:**
   - Create test fixtures for IMAP target
   - Run same property tests as JMAP target
   - Verify identical semantics

3. **End-to-end test** (`apps/worker/src/imap-dav-e2e.test.ts`):
   - Source: Stalwart IMAP (as O365 proxy)
   - Target: Stalwart IMAP (as Soverin proxy)
   - Run full shadow pass
   - Verify idempotency and delta

4. **Update `docs/testing.md`:**
   - Add IMAP/DAV target test section
   - Document how to run IMAP-specific tests
   - Add provider-specific test notes

**Acceptance Criteria:**
- All integration tests pass (JMAP + IMAP targets)
- E2E test demonstrates full O365→IMAP migration flow
- Idempotency property verified for IMAP target
- Documentation updated with IMAP/DAV testing guidance

---

## 5. TESTING AND VALIDATION

**Definition of Done for Workplan 0002:**

1. **ImapDavMailTarget Implementation (U1):**
   - ✅ `ImapDavMailTarget` class implements `TargetWriter` interface
   - ✅ `ensureMailbox()` creates mailbox and sets special-use
   - ✅ `upsertEmail()` uses APPEND with INTERNALDATE and flags
   - ✅ `findByNaturalKey()` searches by Message-ID
   - ✅ `listEntries()` supports reindex/ledger recovery
   - ✅ Unit tests for flag mapping and date formatting
   - ✅ Integration tests against Stalwart IMAPS

2. **Idempotency Property (Critical):**
   - ✅ First run: N messages created
   - ✅ Second run: 0 messages created (idempotent skip)
   - ✅ Add 1 message, re-run: exactly 1 created (delta)
   - ✅ Flags and INTERNALDATE preserved across runs

3. **Target Selection (U3):**
   - ✅ Mapping config supports `type: "jmap"` or `type: "imapdav"`
   - ✅ Factory creates correct TargetWriter implementation
   - ✅ Worker CLI works with both target types
   - ✅ Same reconcile loop used for both target types

4. **Property Tests Parametrized:**
   - ✅ Idempotency tests pass for JMAP target
   - ✅ Idempotency tests pass for IMAP/DAV target
   - ✅ Delta tests pass for both target types
   - ✅ Reindex tests work for both target types

5. **Provider Documentation (U4):**
   - ✅ `docs/target-providers.md` documents Soverin and openDesk
   - ✅ Special-use folder handling documented
   - ✅ Known quirks and workarounds documented
   - ✅ Manual smoke test guide provided

6. **Gates Green:**
   - ✅ `pnpm lint` passes
   - ✅ `pnpm typecheck` passes
   - ✅ `pnpm test` (unit tests) passes
   - ✅ `pnpm test:integration` passes (JMAP + IMAP targets)
   - ✅ Workplan 0002 Status block updated with evidence

7. **Out of Scope (Confirmed):**
   - ❌ Calendar/contacts via CalDAV/CardDAV (slice 0003)
   - ❌ Files via WebDAV (slice 0003)
   - ❌ Graph rich extractor (later)
   - ❌ Pattern-D distribution lists (later)
   - ❌ Two-way sync (later)
   - ❌ Cutover UI (later)

**Validation Commands:**
```bash
# Run all unit tests
pnpm test

# Run integration tests (includes IMAP target tests)
pnpm test:integration

# Run linter
pnpm lint

# Type check
pnpm typecheck

# Optional: Run imapsync bulk test (if U2 implemented)
pnpm test:integration --grep imapsync
```

**Evidence Required:**
- Test output showing all tests pass
- Screenshots/logs of IMAP target integration tests
- Updated workplan Status block with timestamps and evidence
- Documentation updates in `docs/target-providers.md`

---

## 6. NEXT STEPS

With Workplan 0001 complete, proceed with Workplan 0002 implementation in this order:

1. **Start with U1** - Core `ImapDavMailTarget` implementation
2. **Add integration tests** - Verify against Stalwart IMAPS
3. **Wire target selection (U3)** - Factory pattern and config updates
4. **Parametrize property tests** - Ensure both JMAP and IMAP pass same tests
5. **Document providers (U4)** - Create `docs/target-providers.md`
6. **Optional: U2 imapsync** - Bulk path if needed for performance

**To proceed:** Click the **Build** button below to automatically switch to the code agent and execute this plan, or manually switch to the code agent and instruct it to begin with Step U1.
