# Workplans — index & sequencing

Ground rules (AGENTS.md): read `docs/architecture/solution-architecture.md` first; a workplan's
**Status block is ground truth** and must be updated with evidence at session end. This index
adds the cross-plan view: what is verifiably done, what each plan depends on, and in which order
to execute.

**Policy: workplans are never deleted.** Like ADRs they are append-only history — a replaced
plan gets a ⚠️ SUPERSEDED banner pointing to its successor (0003→0007, 0004→0009, 0005→0011)
and stays put, preserving the evidence trail and inbound links.

## State of the stack (verified against code, 2026-07-20, `main` post-#56)

Since the last assessment, PRs #41–#50 merged, landing **0011 T1–T4** (RLS enforcement, API
persistence, Trigger.dev wiring for the mail path, usage metering). Verified state:

| Plan | Subject | Verified state |
|---|---|---|
| [0001](./0001-first-slice-jmap-mail.md) | O365 → JMAP mail slice | ✅ Done. |
| [0002](./0002-imap-dav-target.md) | IMAP/DAV mail target family | ✅ Done. |
| [0003](./0003-caldav-carddav-webdav.md) | Calendar/contacts/files | ⚠️ Superseded by **0007** (done there). |
| [0004](./0004-cutover-dns.md) | Cutover & DNS | ⚠️ Superseded by **0009**. |
| [0005](./0005-implementation-summary.md) | Managed edition | ⚠️ Superseded by **0011**. |
| [0006](./0006-intermediate-remediation.md) | Intermediate remediation | ✅ **Done** — tests renamed so they run, `mollie-api-node` removed, CI uses `ubuntu-latest` for PRs (Spark only on push), root compose removed → `deploy/compose/managed.yml`, deployment case-collision resolved, caveman skill moved to `.agents/`. |
| [0007](./0007-multi-domain-sync-completion.md) | Multi-domain sync (cal/contacts/files) | ✅ **Done** — worker `runAllDomains` orchestrates all domains independently with status tracking; native DAV sources integration-tested. **Approach changed:** the `GenericSyncEngine`/`runUnifiedSync` were removed (PR #38); real impl is `packages/core/src/domain-sync.ts` (see `docs/design/domain-sync.md`). |
| [0008](./0008-o365-graph-source.md) | Production O365 source | ✅ **Reported done** — `MsalTokenProvider`, Graph calendar/contacts/drive sources, `ThrottleLimiter`, secret-gated e2e harness all present. The 24 h real-tenant soak is manual/secret-gated (not verifiable from the repo). |
| [0009](./0009-cutover-integration.md) | Cutover made real | 🟡 **Near-complete** — T1/T2/T5/T6 done & integration-tested. **Owner decision (2026-07-16): verify-only DNS** → T4 (deSEC provider writes) deferred; only open item is the T3 DoH-resolver upgrade + verify-only tests. |
| [0010](./0010-selfhost-edition.md) | Self-host edition | ⬜ **Not started.** **Rewritten 2026-07-16 for Postgres-only (ADR-0023)** — bundles a small Postgres; no SQLite. 0007 (its dependency) is done. `apps/selfhost/src/index.ts` is still a one-line placeholder; no startup migration runner yet. |
| [0011](./0011-managed-edition-hardening.md) | Managed edition hardening | 🟡 **T1–T6 done & merged; only T7 remains.** T1 runtime RLS, T2 real API persistence, T3 Trigger.dev wiring (mail path), T4 usage metering, T5 billing + Mollie webhook e2e, T6 web on the real API (runnable component tests). The two backend mock remainders are **closed**: real run-history endpoints (#55) + real create-mapping persistence with encrypted credentials (#56). **Remaining:** T7 — app-tier Dockerfiles + live `compose up` DoD verification (draft on PR #57, needs a Docker host); and the T3 remainder (cal/contact/file domains + real cutover/rollback jobs). |
| [0012](./0012-cutover-completion-summary.md) | Cutover completion summary | 📄 History doc for the 0009 cutover work (not a forward plan). |

## What landed this cycle
**0011 T5, T6, and the backend mock remainders (PRs #52–#56).** Billing + Mollie test-mode is
end-to-end (invoice generation from metered usage + a real, idempotent webhook state machine); the
web app talks to the real API with component tests that actually run (jsdom + testing-library) and
real bearer-token login; and the two discovered mocks are gone — real run-history endpoints and
real create-mapping persistence (full connection→mailbox→mapping chain with **encrypted**
credentials via `SecretStore`; migration `0013` added `name`/`schedule` to `mailbox_mapping`, and
`jmap` joined the Drizzle `connection.kind` enum). With these, **T1–T6 are done**; only **T7** (the
container images + a live `compose up` DoD run) is left. **ADR-0023 (Postgres-only)** still
stands — **do not reintroduce SQLite / a second dialect.**

## Recommended order (from here)

1. **Finish 0011 T7** (the only open managed task) — build/verify the app-tier Dockerfiles and run
   the clean `docker compose -f deploy/compose/managed.yml up` → two-tenant DoD journey on a Docker
   host. Draft staged on PR #57; brief in `docs/design/0011-t7-dockerfiles-handoff.md`.
2. **0011 T3 remainder** — wire cal/contact/file domains via `buildDomainDepsFromMapping`, and
   replace the `run-cutover.ts` / `run-rollback.ts` TODO shells with the real cutover machine (0009).
   Fully testable without Docker.
3. **0010 (self-host)** — still unstarted and a hard-rule gap ("self-host must keep working"); the
   appliance doesn't exist as a runnable thing yet. Can proceed in parallel; coordinate only on the
   shared migration-runner / connection-role seam.
4. **0009 T3** — DoH-resolver upgrade (small; anytime) closes out cutover.
5. Later: rich Graph extractor (SharePoint), discovery/drift decision queue + UI, Proton path.

Numbering note: `0001-start-prompt.md` is a historical bootstrap prompt, not a plan. The
`migration/nextjs-15` branch was **not** adopted (Vite stays; tag `archive/nextjs-15` preserves
it), so its `0006-status-report.md` is dead — ignore it.
