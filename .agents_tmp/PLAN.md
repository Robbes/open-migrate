# 1. OBJECTIVE

Implement a fully integrated cutover system that wires together verification, state persistence, DNS management, and rollback capabilities against real data sources (ledger DB, Stalwart target). Transform the cutover from a purely in-memory, unit-tested concept into a production-ready workflow that can be executed through the worker CLI and Trigger.dev jobs, with proper audit trails and rollback support.

# 2. CONTEXT SUMMARY

**Current State:**
- `packages/core/src/verification.ts` - Has interface definitions but relies on fake dependencies; no real ledger/target integration
- `packages/core/src/cutover-state.ts` - Pure in-memory state machine; worker restarts lose cutover state
- `packages/core/src/dns-manager.ts` - Has DnsProvider interface but no real implementations; no verify-only checks
- `apps/worker/src/jobs/run-cutover.ts` and `run-rollback.ts` - Commented-out stubs; not wired to actual implementations
- `packages/ledger/src/schema-pg.ts` - Has a basic `cutover` table but missing `cutover_state` and `cutover_event` tables for full state machine persistence

**Dependencies:**
- Workplan 0004 (cutover-dns): Built the state machine and DNS scaffolding, but Phase 4 (Integration & Testing) was never completed
- Workplan 0007 (multi-domain-sync-completion): Verification should count all domains (mail-only first pass acceptable)
- Workplan 0006 (intermediate-remediation): Established testing patterns and Stalwart integration rules
- `docs/stalwart-integration-fix.md`: Authoritative Stalwart v0.16.10 integration guide
- `docs/architecture/solution-architecture.md` §11 (shadow & cutover), §20 (verification & rollback): Design principles

**Key Constraints:**
- Idempotency is sacred: re-runs must converge without duplicates or corruption
- Non-destructive by default: never auto-delete/overwrite on target
- Verification gate is the product promise: a failing gate must never be weakened to pass
- DNS mutations require approval gate + dry-run (destructive-adjacent)
- Stalwart rules: one container per data volume, two-phase startup, RocksDB lock prevention

# 3. APPROACH OVERVIEW

This implementation follows a "wiring-first" approach:

1. **Database Layer First**: Add the missing `cutover_state` and `cutover_event` tables to the ledger schema (both PostgreSQL and SQLite dialects), then implement persistence functions for the state machine.

2. **Verification Engine**: Replace fake dependencies in `verification.ts` with real implementations that query the ledger for source counts and use `TargetReindexer.listEntries` for target enumeration, plus content-hash sampling.

3. **DNS Layers**: Implement two distinct layers:
   - **Verify-only layer**: Resolver-based checks requiring no credentials (MX/SPF/DKIM/DMARC/autodiscover presence + propagation polling)
   - **Provider adapter layer**: One real provider (deSEC recommended) behind the existing `DnsProvider` interface

4. **Worker CLI**: Add subcommands (`start-cutover`, `approve`, `rollback`) that drive the persisted state machine, with explicit `--yes` confirmation for irreversible actions.

5. **Job Wiring**: Update `run-cutover.ts` and `run-rollback.ts` to call the real implementations instead of commented-out stubs.

6. **Integration Tests**: Build integration tests that exercise the full lifecycle against real dependencies (Stalwart + ledger DB), including a worker restart mid-flow to verify state persistence.

7. **Documentation**: Create the cutover runbook and end-user communication templates.

**Why this approach:**
- Database changes are foundational and must be done first
- Verification is the gatekeeper; it must work before cutover can proceed
- DNS is the only truly destructive action; it needs the most careful implementation
- Testing against real dependencies validates the entire integration chain
- Documentation last ensures it matches the actual implementation

# 4. IMPLEMENTATION STEPS

## Step 1: Database Schema Extensions

**Goal**: Add tables for persisting cutover state machine data.

**Method**:
- Create migration `packages/ledger/migrations/0003_cutover_state_tables.sql` with:
  - `cutover_state` table: id, tenant_id, mapping_id, state, phase, verification_status, verification_report, grace_period settings, timestamps, metadata
  - `cutover_event` table: id, tenant_id, mapping_id, timestamp, from_state, to_state, triggered_by, reason, metadata (append-only audit log)
- Update `packages/ledger/src/schema-pg.ts` with Drizzle definitions for both tables
- Update `packages/ledger/src/schema-sqlite.ts` with SQLite equivalents
- Run `pnpm drizzle-kit generate` to create the migration SQL
- Test migration on both PostgreSQL and SQLite

**Reference**: `packages/ledger/src/schema-pg.ts`, `packages/ledger/migrations/0001_init.sql`

## Step 2: Persist the Cutover State Machine

**Goal**: Make the state machine persistent and rehydratable from the database.

**Method**:
- Create `packages/core/src/cutover-persistence.ts` with:
  - `saveCutoverState(deps, status)` - persist to `cutover_state` table
  - `loadCutoverState(deps)` - rehydrate from database
  - `logCutoverEvent(deps, event)` - append to `cutover_event` table
- Modify `cutover-state.ts` to use the persistence layer instead of in-memory storage
- Add methods to query event history for audit purposes
- Ensure all state transitions log events

**Reference**: `packages/core/src/cutover-state.ts`, `packages/ledger/src/ledger.ts`

## Step 3: Implement Real Verification Engine

**Goal**: Wire verification to real data sources instead of fakes.

**Method**:
- Create `packages/core/src/verification-implementations.ts` with real implementations of `VerificationDeps`:
  - `getSourceCount()`: Query `item` table grouped by domain/collection
  - `getTargetCount()`: Use `TargetReindexer.listEntries` (JMAP/IMAP flavors from workplan 0001/0002)
  - `getSourceSamples()` / `getTargetSamples()`: Retrieve random samples for checksum comparison
  - `findMissingOnTarget()` / `findExtraOnTarget()`: Compare ledger vs target enumeration
  - `getTotalBytesSource()` / `getTotalBytesTarget()`: Sum size_bytes from ledger
- Update `runVerification()` to use these real implementations
- Add per-folder parity checks (not just totals)
- Implement content-hash sampling with configurable percentage
- Handle missing domains as `SKIPPED` status (never silently pass)

**Reference**: `packages/core/src/verification.ts`, `packages/core/src/reindex.ts`, `packages/ledger/src/schema-pg.ts` (item table)

## Step 4: DNS Verify-Only Implementation

**Goal**: Implement resolver-based DNS checks that require no credentials.

**Method**:
- Create `packages/core/src/dns-verify-only.ts`:
  - `verifyMX(domain)`: Check MX records via `dns/promises`
  - `verifySPF(domain)`: Check SPF TXT record contains target sender
  - `verifyDKIM(domain, selector)`: Check DKIM selector present
  - `verifyDMARC(domain)`: Check DMARC policy value
  - `verifyAutodiscover(domain)`: Check autodiscover host exists
  - `checkPropagation(domain, expectedRecords, maxAttempts, backoff)`: Poll for propagation with TTL-based backoff
- Create `packages/core/src/dns-runbook-generator.ts`:
  - Generate per-tenant manual DNS runbook (Markdown)
  - Include exact records before/after, TTL-lowering steps, §11 asymmetric-send SPF guidance
- Unit tests with stubbed resolver

**Reference**: Node.js `dns/promises`, `docs/architecture/solution-architecture.md` §11

## Step 5: Implement One Real DNS Provider Adapter

**Goal**: Implement a real DNS provider behind the `DnsProvider` interface.

**Method**:
- **Choose deSEC** (EU-based, free, clean REST API, token-scoped) - record choice in ADR
- Create `packages/core/src/dns-provider-desec.ts`:
  - Implement `DnsProvider` interface (getRecords, updateRecords, verifyPropagation)
  - Use deSEC REST API (https://desec.io/api/v1/)
  - Secrets via env/vault refs (DESEC_TOKEN)
  - Guard mutations behind state machine approval gate
  - Implement dry-run mode that prints diff without applying
- Create fixture-based unit tests (recorded responses)
- Manual smoke test against throwaway zone (secret-gated)

**Reference**: `packages/core/src/dns-manager.ts`, deSEC API documentation

## Step 6: Wire Worker CLI Subcommands

**Goal**: Create CLI commands to drive cutover from the worker.

**Method**:
- Create `apps/worker/src/cli/cutover.ts`:
  - `start-cutover --mapping-id <uuid> --yes`: Initialize cutover, transition to READY_FOR_CUTOVER
  - `approve --mapping-id <uuid> --yes`: Approve verification gate, transition to CUTOVER_IN_PROGRESS
  - `rollback --mapping-id <uuid> --reason <text> --yes`: Execute rollback
  - `status --mapping-id <uuid>`: Show current cutover state
- Add `--dry-run` flag to all mutating commands
- Require explicit `--yes` confirmation for irreversible actions
- Wire to persisted state machine from Step 2

**Reference**: `apps/worker/src/index.ts` (CLI structure), `packages/core/src/cutover-state.ts`

## Step 7: Wire Trigger.dev Jobs to Real Implementations

**Goal**: Update job stubs to call real implementations.

**Method**:
- Update `apps/worker/src/jobs/run-cutover.ts`:
  - Replace commented-out calls with actual function invocations
  - Step 1: Final delta sync (existing)
  - Step 2: Call `runVerification()` with real deps (Step 3), fail if gate doesn't pass
  - Step 3: Call state machine `transitionTo(CUTOVER_IN_PROGRESS)`
  - Step 4: Call DNS manager `execute()` (Step 5) or generate runbook (Step 4)
  - Step 5: Start grace period monitoring
  - Handle errors with proper state transitions to FAILED
- Update `apps/worker/src/jobs/run-rollback.ts`:
  - Step 1: Call DNS manager `rollback()` or runbook-guided manual rollback
  - Step 2: Restore data source connections
  - Step 3: Call state machine `rollbackCutover()`
  - Step 4: Notify users (if enabled)
  - Step 5: Cancel pending tasks

**Reference**: `apps/worker/src/jobs/run-cutover.ts`, `apps/worker/src/jobs/run-rollback.ts`

## Step 8: Integration Test - Full Cutover Lifecycle

**Goal**: Test the complete cutover flow against real dependencies.

**Method**:
- Create `packages/core/src/cutover.integration.test.ts`:
  - Setup: Start Stalwart (per `stalwart-integration-fix.md`), initialize ledger DB
  - Seed: Create test domain, source/target accounts, populate ledger with migrated items
  - Walk through states:
    1. PREPARING → run verification → READY_FOR_CUTOVER
    2. READY_FOR_CUTOVER → approve → CUTOVER_IN_PROGRESS
    3. CUTOVER_IN_PROGRESS → grace period → GRACE_PERIOD
    4. GRACE_PERIOD → complete → COMPLETED
  - **Worker restart mid-flow**: After step 2, restart worker, verify state survives and can continue
  - Assert: All state transitions logged, events queryable in order
  - Test illegal transitions are rejected (reuse 0004's 24 unit tests against persisted impl)

**Reference**: `test/integration/`, `stalwart-integration-fix.md`

## Step 9: Integration Test - Verification Gate

**Goal**: Verify the verification engine correctly identifies issues.

**Method**:
- Create `packages/core/src/verification.integration.test.ts`:
  - Setup: Stalwart with seeded data (3 messages in INBOX)
  - Test 1: Full sync then verify → PASS
  - Test 2: Delete one message directly on target → verify FAILS, naming the folder and delta
  - Test 3: Tolerance edges - add 1 extra message on target → WARN (within tolerance)
  - Test 4: Missing domain (no mapping) → SKIPPED status, never silently passed
  - Test 5: Checksum mismatch → FAIL with specific item details

**Reference**: `packages/worker/src/jmap-reindex.integration.test.ts`, `stalwart-integration-fix.md`

## Step 10: Integration Test - Rollback Paths

**Goal**: Test both rollback scenarios.

**Method**:
- Create `packages/core/src/rollback.integration.test.ts`:
  - **Gate-fail path**: Verify fails → rollback to Shadow, nothing external touched
    - Assert: DNS unchanged, state = ROLLED_BACK
  - **Grace-window path**: Post-cutover rollback
    - Assert: MX restore via provider/runbook
    - Reverse-read smoke: Write one message to target after cutover → detect and surface (not auto-copy, per §11.1)
  - **Step failure mid-rollback**: Continue remaining steps, report failures
  - Assert: Audit trail shows every step

**Reference**: `packages/core/src/rollback-orchestrator.ts`, `docs/rollback-mechanisms.md`

## Step 11: Cutover Runbook Documentation

**Goal**: Create end-to-end operator procedure.

**Method**:
- Create `docs/cutover-runbook.md`:
  - Final delta calculation
  - Read-only source option
  - DNS switch procedure (MX/SPF/DKIM/DMARC)
  - Client reconfiguration steps
  - Grace window monitoring (72h default, configurable)
  - Archive procedure
  - Cross-reference CLI subcommands from Step 6 (verify with `--help`)

**Reference**: `docs/architecture/solution-architecture.md` §11, §14.2

## Step 12: End-User Communication Templates

**Goal**: Create bilingual communication templates.

**Method**:
- Create `docs/templates/cutover-comms.en.md`:
  - "We're moving your email" announcement
  - Cutover date and what to expect
  - What changes / what stays the same
  - New login credentials
  - Action items for users
- Create `docs/templates/cutover-comms.nl.md`:
  - Dutch translation of above
- Ensure templates are plain-language, non-technical, reassuring (per §23)

**Reference**: `docs/architecture/solution-architecture.md` §23 (internationalization)

# 5. TESTING AND VALIDATION

**Definition of Done (the gate):**
A complete cutover lifecycle runs against the dev stack, driven through the worker:

1. **Shadow → Verification Gate**: Computed from real ledger + target counts (per-folder parity + checksum sampling)
2. **Approval**: Explicit user approval required
3. **Cutover**: DNS steps (verify-only in dev) executed
4. **Grace Window**: 72h monitoring period
5. **Done**: Final state reached

**Rollback Branch:**
- Gate-fail → back to Shadow (nothing external touched)
- Post-cutover → rollback runbook executed

**Validation Criteria:**
- Every state transition is persisted in `cutover_state` table
- Every state transition is event-logged in `cutover_event` table
- A deliberately broken target (one message deleted) **blocks** the verification gate
- Worker restart mid-flow: state survives and can continue
- All gates green including new integration tests:
  - `cutover.integration.test.ts` - Full lifecycle with restart
  - `verification.integration.test.ts` - Gate passes/fails correctly
  - `rollback.integration.test.ts` - Both rollback paths work
- No docker debris: clean up Stalwart containers and volumes after tests

**Acceptance Tests Summary:**
| Test | Acceptance Criteria |
|------|-------------------|
| T1 (Verification) | Full sync → verify passes; delete one message → verify FAILS naming folder/delta; tolerance edges unit-tested |
| T2 (Persistence) | Lifecycle with worker restart mid-flow (state survives); illegal transitions rejected; events queryable in order |
| T3 (DNS Verify) | Runbook generated enumerates exactly the records verify checks; propagation poller honors TTL-based backoff |
| T4 (DNS Provider) | Fixture unit tests pass; smoke test applies + verifies + rolls back MX change; dry-run matches apply |
| T5 (Rollback) | Both paths work; audit trail shows every step; step failure continues remaining steps |
| T6 (Documentation) | Docs-hygiene green; runbook steps match CLI `--help` output |

**Gates Before "Done":**
- Lint + typecheck + unit tests pass
- Integration tests against real Stalwart + ledger DB pass
- Documentation updated
- Workplan Status block updated with evidence
- No secrets in repo
- Idempotency + non-destructive intact
- Self-host intact
- No docker debris
