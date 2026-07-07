# 1. OBJECTIVE

Verify the actual implementation status of Workplan 0001 (O365 → JMAP mail slice), update the workplan Status block with evidence, and determine the next actionable tasks. If T0-T9 are complete, prepare for Workplan 0002 (IMAP/DAV target family).

---

# 2. CONTEXT SUMMARY

**Repository:** open-migrate - Sovereign migration tool for moving from O365/Google to EU sovereign platforms

**Current Workplan:** 0001-first-slice-jmap-mail.md - First buildable slice: O365 → JMAP mail (one-way shadow)

**Key Components:**
- `packages/core` - reconcile loop (runShadowPass), idempotency logic
- `packages/connectors` - ImapSource, JmapTargetWriter
- `packages/ledger` - SqlLedger, PgCursorStore for idempotency
- `packages/scheduler` - InProcessScheduler with croner
- `apps/worker` - CLI entrypoint for running migrations
- `docs/workplans/` - Active workplans with Status blocks

**Evidence Found:**
- `apps/worker/src/index.ts` - Complete CLI with --config and --once flags (T7)
- `packages/scheduler/src/scheduler.ts` - croner integration with schedule() (T6)
- `apps/worker/src/shared-mailbox.integration.test.ts` - Pattern-S shared mailbox tests (T5)
- `apps/worker/src/jmap-reindex.integration.test.ts` - Reindex tests (T9)
- Integration tests in `packages/ledger/src/` - Shadow pass and ledger tests (T4)

**Workplan Status Block Discrepancy:** The Status block in workplan 0001 marks T5, T6, T7 as "Open — verify first", but code evidence suggests these are implemented. The Status block needs verification and updating.

---

# 3. APPROACH OVERVIEW

1. **Audit Implementation Status:** Systematically verify each task (T0-T9) against actual code and test evidence
2. **Run Integration Tests:** Execute `pnpm test:integration` to confirm all tests pass (the "11/11" mentioned in T4)
3. **Update Workplan Status:** Correct the Status block in workplan 0001 to reflect actual implementation state
4. **Identify Next Actions:** Based on verification results, determine if:
   - Workplan 0001 needs completion of remaining items (likely just T8 docs)
   - Workplan 0002 should be started (IMAP/DAV target family)
   - Additional verification is needed

**Why This Approach:** The workplan Status block appears outdated. Before proceeding with new work, we need accurate knowledge of what's actually done vs. what's open. Running the integration tests provides definitive proof of implementation completeness.

---

# 4. IMPLEMENTATION STEPS

## Step 1: Verify Task Implementation Status

**Goal:** Confirm which tasks are truly complete vs. open

**Method:**
- Review code evidence for each task T0-T9
- Check for test files and their locations
- Verify key implementation files exist and are functional

**Files to Review:**
- `apps/worker/src/index.ts` (T7 - CLI)
- `packages/scheduler/src/scheduler.ts` (T6 - croner)
- `apps/worker/src/shared-mailbox.integration.test.ts` (T5 - shared mailbox)
- `apps/worker/src/jmap-reindex.integration.test.ts` (T9 - reindex)
- `packages/ledger/src/shadow-pass.integration.test.ts` (T4 - shadow engine)
- `packages/connectors/src/imap-source.ts` (T2 - IMAP source)
- `packages/connectors/src/jmap-target.ts` (T3 - JMAP target)
- `packages/ledger/src/ledger.ts` and `cursor-store.ts` (T0 - ledger)

**Reference:** Workplan 0001 docs/workplans/0001-first-slice-jmap-mail.md

---

## Step 2: Run Integration Tests

**Goal:** Verify all integration tests pass (the "11/11" mentioned in T4 Status)

**Method:**
```bash
# Bring up the dev stack
docker compose -f deploy/compose/dev.yml up -d

# Run integration tests
pnpm test:integration
```

**Expected Outcome:**
- All integration tests pass (ledger, shadow-pass, shared-mailbox, jmap-reindex)
- Idempotency property tests confirm: run twice → zero creates on second run
- Delta tests confirm: adding one message creates exactly one new item

**Evidence Required:**
- Test output showing pass/fail status
- Any error messages if tests fail
- Coverage of all 4 integration test files found

---

## Step 3: Update Workplan 0001 Status Block

**Goal:** Correct the Status block to reflect actual implementation state

**Method:**
- Edit `docs/workplans/0001-first-slice-jmap-mail.md`
- Update each task's status with evidence from Steps 1-2
- Add test run output as evidence

**Status Block Template:**
```markdown
## Status — 2026-07-07 (update this block at the end of every session)

| Task | Status | Evidence |
|---|---|---|
| T0 dev stack + ledger | **Done** | PgLedger + PgCursorStore in packages/ledger; ledger.integration.test.ts green |
| T1 core model + interfaces | **Done** | MailItem, SourceConnector, TargetWriter interfaces in packages/shared/core |
| T2 IMAP source | **Done** | ImapSource in packages/connectors; integration-tested against Stalwart |
| T3 JMAP target writer | **Done** | JmapTargetWriter in packages/connectors; integration-tested |
| T4 shadow engine | **Done** | runShadowPass in packages/core; shadow-pass.integration.test.ts green |
| T5 Pattern-S shared mailbox | **Done** | shared-mailbox.integration.test.ts; tests Pattern-S idempotency |
| T6 croner wiring | **Done** | InProcessScheduler.schedule() uses croner; scheduler.ts |
| T7 worker CLI | **Done** | apps/worker/src/index.ts with --config/--once flags |
| T8 docs + ADRs | **Partial** | stalwart-integration-fix.md current; README quickstart unverified |
| T9 reindex | **Done** | jmap-reindex.integration.test.ts; TargetReindexer.listEntries() implemented |
```

---

## Step 4: Complete T8 (Docs) if Needed

**Goal:** Ensure documentation is complete and accurate

**Method:**
- Verify `README.md` quickstart works from clean clone
- Check `docs/testing.md` covers idempotency property tests
- Verify `docs/stalwart-integration-fix.md` is authoritative
- Add any missing ADRs if decisions crystallized

**Acceptance Criteria:**
- README quickstart works end-to-end
- Testing documentation matches actual test structure
- No outdated or contradictory documentation

---

## Step 5: Determine Next Workplan

**Goal:** Decide whether to start Workplan 0002 (IMAP/DAV target family)

**Method:**
- If Workplan 0001 is fully complete (all gates green, docs updated), begin Workplan 0002
- If Workplan 0001 has gaps, complete them first

**Workplan 0002 Scope (from sketch):**
- U1: IMAP/DAV mail target (ImapDavMailTarget implements TargetWriter)
- U2: imapsync bulk path (optional)
- U3: Target selection wiring (jmap vs imapdav from config)
- U4: Provider specifics (Soverin/openDesk)

---

# 5. TESTING AND VALIDATION

**Success Criteria:**

1. **Workplan 0001 Status Verified:**
   - All tasks T0-T9 have accurate status (Done/Open/Partial)
   - Status block includes concrete evidence (test files, test results)
   - No discrepancies between claimed and actual implementation

2. **Integration Tests Pass:**
   - `pnpm test:integration` runs successfully
   - All 4 integration test files execute without errors:
     - `packages/ledger/src/ledger.integration.test.ts`
     - `packages/ledger/src/shadow-pass.integration.test.ts`
     - `apps/worker/src/shared-mailbox.integration.test.ts`
     - `apps/worker/src/jmap-reindex.integration.test.ts`
   - Idempotency property confirmed: second run creates 0 items
   - Delta property confirmed: adding 1 item creates exactly 1 new item

3. **Documentation Complete:**
   - README.md quickstart works from clean clone
   - `docs/testing.md` accurately describes test structure
   - `docs/stalwart-integration-fix.md` is the authoritative reference

4. **Next Steps Clear:**
   - If 0001 complete: Workplan 0002 is ready to start
   - If gaps exist: Specific remaining tasks identified with priorities

**Validation Methods:**
- Run `pnpm test:integration` and capture output
- Verify each integration test file exists and has meaningful test cases
- Check that workplan Status block matches code evidence
- Confirm README quickstart instructions are accurate and complete
