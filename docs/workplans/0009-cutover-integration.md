# Workplan 0009 — Cutover made real: verification gate, DNS, rollback — integrated & tested

## Status — 2026-07-16 (update this block at the end of every session)

> **Near-complete.** T1/T2/T5/T6 done and integration-tested. **Owner decision 2026-07-16:
> verify-only DNS** — T4 (automated provider writes) is deferred; the only remaining work is the
> T3 DoH-resolver upgrade + verify-only tests. After that, 0009 is done.

| Task | Status | Evidence |
|---|---|---|
| T1 verification engine on real ledger/targets | ✅ Done | PR #31 merged (56f4a50); commits: 7d15237 (verification logic + RLS), 60a9337 (force RLS + verification fix), 321b2f0 (verification + state machine), 04ba8ab (LedgerVerificationReader interface), eopba8ab (discrepancy detection), c340a65 (ledger queries), 6d9ecd4 (persistence to ledger); integration test: `packages/core/src/verification.integration.test.ts` |
| T2 cutover state machine persisted + driven by worker | ✅ Done | PR #31 merged (56f4a50); commits: ffde0c9, 8672893, 37f500c (state machine fixes), 96c6249 (state-machine tests), 34dbb0a (complete cutover), 765abc7 (foundation), 35956b0 (integration tests Steps 8-10); persistence via `packages/ledger/src/cutover-store.ts`; CLI via `apps/worker/src/cli/cutover-commands.ts` |
| T3 DNS: verify-only resolver checks + guided runbook | ⚠️ Partial — **now the primary DNS path** | `packages/core/src/dns-verify-only.ts` implements verifyMX/SPF/DKIM/DMARC/autodiscover + checkPropagation; wired into cutover CLI (`cutover-commands.ts:245`). **Open (finish this):** uses Node's system resolver, not public DoH resolvers (1.1.1.1/8.8.8.8/9.9.9.9) — propagation checks can't confirm global visibility from one vantage point; add DoH-based `PropagationChecker` + dedicated unit tests for the verify-only functions. Owner chose **verify-only** (2026-07-16), so this path *is* the cutover DNS story — its quality matters. |
| T4 DNS provider adapter (one real provider) | ⏸️ **Deferred by owner (2026-07-16)** | Owner decided: **keep verify-only, defer automated DNS writes**. `packages/core/src/dns-provider-desec.ts` (deSEC adapter) **stays as an unwired template only** — leave it commented out in `run-cutover.ts`/`run-rollback.ts`; do **not** wire any provider write-path. Cutover DNS remains guided/manual via the runbook (T6) + verify checks (T3). Revisit provider automation in a later slice if demanded. |
| T5 rollback path integration test | ✅ Done | PR #31 merged (56f4a50); commit 35956b0 "Add cutover integration tests (Steps 8-10)"; `packages/core/src/rollback.integration.test.ts` tests gate-fail and grace-window rollback paths |
| T6 cutover runbook + user comms templates | ✅ Done | PR #31 merged (56f4a50); commit c96ae51 "Add cutover runbook and communication templates (Steps 11-12)"; `docs/cutover-runbook.md` (283 lines) + `docs/cutover-communication-templates.md` (368 lines) contain runbook + comms templates |

> Read `AGENTS.md`, the arch doc (§11 shadow & cutover, §20 verification & rollback) and
> workplan 0004 first. **Depends on:** 0007 (verification should count all domains, but a
> mail-only first pass is acceptable — see T1). **Supersedes** workplan 0004's open end: 0004
> built the state machine (`packages/core/src/cutover-state.ts`), verification scaffolding
> (`verification.ts`), DNS types (`dns-manager.ts`) and a rollback orchestrator — all
> **unit-tested against fakes only** (its "Phase 4: Integration & Testing" was never started,
> and its Status header contradicts its body; see 0006-C). Nothing persists state, nothing is
> reachable from the worker/API, and no DNS record is ever actually read or written.

## Definition of Done (the gate)
A complete cutover lifecycle runs against the dev stack, driven through the worker: shadow →
**verification gate computed from the real ledger + target counts** (per-folder parity + checksum
sampling per §20) → approval → cutover with DNS steps (verify-only in dev) → grace window →
done; plus the rollback branch (gate-fail → back to shadow; post-cutover → rollback runbook
executed). Every state transition is persisted and event-logged; a deliberately broken target
(one message deleted) **blocks** the gate. All gates green incl. new integration tests.

## In scope
- Wiring `verification.ts` to real data sources (ledger counts vs `TargetReindexer.listEntries`
  counts + sampled content-hash comparison).
- Persisting `CutoverStateMachine` state + events to the ledger DB (it currently lives in
  memory only — a worker restart loses the cutover).
- Driving cutover/rollback from the worker CLI (self-host path) — the Trigger.dev job wrappers
  (`apps/worker/src/jobs/run-cutover.ts`, `run-rollback.ts`) get wired to the same core in 0011.
- DNS in two honest layers: (a) **verify-only**: resolver checks (MX/SPF/DKIM/DMARC/autodiscover
  presence + propagation polling) requiring no credentials; (b) **one real provider adapter**
  behind the existing `DnsProvider` interface.
- The §11 asymmetric-send prerequisites surfaced as checks (SPF includes both senders, DMARC
  `p=none` during transition) — verification warnings, not writes.

## Out of scope (later)
- UI wizard & decision queue (§11.2) — a web workplan after the 0006-G framework decision.
- Autodiscover/MTA-STS/DANE record *management*, mail-flow warm-up choreography — the runbook
  documents them; automation later.
- Reverse **sync** implementation for post-cutover rollback (§20 "reverse read") beyond a smoke
  test — full reverse-mirror is its own slice when demanded.
- Multi-provider DNS coverage (one adapter proves the seam).

## Tasks

### T1 — Verification engine on real ledger/targets
Replace the fake-fed paths in `packages/core/src/verification.ts`: per mapping, compare (a)
ledger row counts per folder/collection vs target enumeration via the existing
`TargetReindexer.listEntries` (JMAP + IMAP flavors shipped in 0001/0002), (b) a configurable
random sample of content hashes source-vs-target, (c) totals within tolerance. Missing domains
(no 0007 yet) are reported as `SKIPPED`, never silently passed — the gate result lists every
domain with counted/sampled/skipped status.
**Acceptance:** integration test on Stalwart — full sync then verify passes; delete one message
directly on the target → verify **fails** naming the folder and delta; tolerance edges
unit-tested.

### T2 — Persist + drive the state machine
New ledger tables (Drizzle migration, both dialects) `cutover_state` + `cutover_event`
(append-only audit per 0004's design); rehydrate the machine from DB on start; expose
`start-cutover`, `approve`, `rollback` as worker CLI subcommands behind explicit `--yes`
confirmation (§11.2 control actions; nothing irreversible without approval — hard rule 2 spirit).
**Acceptance:** integration test walks Shadow→Verify→(approve)→Cutover→Grace→Done with a worker
restart mid-flow (state survives); illegal transitions rejected (reuse 0004's 24 unit tests
against the persisted impl); events queryable in order.

### T3 — DNS verify-only checks + guided runbook generator
Implement resolver-based checks (Node `dns/promises` over the configured resolver, plus a
public-resolver cross-check for propagation): current MX target, SPF contains the target sender,
DKIM selector present, DMARC policy value, autodiscover host. Generate a per-tenant **manual DNS
runbook** (Markdown: exact records before/after, TTL-lowering step, §11 asymmetric-send SPF
guidance) — this is the §14.2 "guide" philosophy applied to DNS.
**Acceptance:** unit tests with a stubbed resolver; integration: runbook generated for the dev
domain enumerates exactly the records the verify step then checks; propagation poller honors
TTL-based backoff (no hot loops).

### T4 — One real DNS provider adapter
Pick one EU-friendly API-capable provider and implement `DnsProvider` (get/update/verify) for it
— **recommendation: deSEC** (EU, free, clean REST, token-scoped) with the choice recorded as an
ADR; secrets via env/vault refs. Guard every mutation behind the state machine's approval gate +
a dry-run mode that prints the diff it would apply.
**Acceptance:** recorded-fixture unit tests for the adapter; a manual secret-gated smoke test
against a throwaway zone applies + verifies + rolls back an MX change; dry-run output matches
what apply then does.

### T5 — Rollback integration test
Wire 0004's `rollback-orchestrator.ts` to the persisted machine and the T3/T4 DNS layers:
gate-fail path (Verify→Shadow, nothing external touched) and grace-window path (MX restore via
provider-or-runbook + reverse-read smoke: one message written to the target after cutover is
detected and surfaced — not auto-copied — per §11.1 deletions/decisions principle).
**Acceptance:** integration test for both paths; audit trail shows every step; a step failure
mid-rollback continues remaining steps and reports (0004's design, now proven against real deps).

### T6 — Cutover runbook + comms templates
`docs/cutover-runbook.md`: end-to-end operator/self-host procedure (final delta, read-only
source option, DNS switch, client reconfiguration, grace window, archive). Add the §23
plain-language EN/NL end-user templates ("we're moving your email", "cutover date, what to
expect") as `docs/templates/cutover-comms.{en,nl}.md`.
**Acceptance:** docs-hygiene green; runbook steps cross-reference the CLI subcommands from T2
and match their actual names/flags (spot-check by running `--help`).

## Conventions & gotchas
- **The verification gate is the product promise** (§1 "fear of data loss") — never weaken a
  failing gate to pass a test; unmask and fix (hard rule 9).
- DNS mutations are the one genuinely destructive-adjacent action in the stack: approval gate +
  dry-run are mandatory paths through the code, not optional flags.
- Grace-window default stays 72 h (0004); make it config, keep the safe default.
- Stalwart rules per `docs/stalwart-integration-fix.md`; new tests use the 0006-A naming.

## Related: DAV Integration Status (Issue #32)

CalDAV/CardDAV/WebDAV integration tests are **failing** against Stalwart v0.16.10 due to missing
DAV service configuration. See `docs/dav-integration-status.md` for full assessment.

**Current state**:
- CalDAV/CardDAV: 10 tests FAIL (Stalwart returns 403/HTML instead of DAV responses)
- WebDAV: 7 tests SKIP (Nextcloud not configured — expected)
- Unified-Sync: 4 tests FAIL (depends on CalDAV/CardDAV)

**Root cause**: Stalwart's DAV services require explicit HTTP listener configuration not present
in the minimal test setup.

**Action required**: Owner decision on whether to:
1. Configure Stalwart DAV services
2. Accept DAV as unsupported for now (re-skip with explicit reason)
3. Use alternative DAV target for tests
