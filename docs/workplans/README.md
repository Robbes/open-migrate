# Workplans — index & sequencing

Ground rules (AGENTS.md): read `docs/architecture/solution-architecture.md` first; a workplan's
**Status block is ground truth** and must be updated with evidence at session end. This index
adds the cross-plan view: what is verifiably done, what each plan depends on, and in which order
to execute.

**Policy: workplans are never deleted.** Like ADRs they are append-only history — a replaced
plan gets a ⚠️ SUPERSEDED banner pointing to its successor (0003→0007, 0004→0009, 0005→0011)
and stays put, preserving the evidence trail and inbound links.

## State of the stack (verified against code, 2026-07-09, `main` @ `f1acd4a`)

| Plan | Subject | Verified state |
|---|---|---|
| [0001](./0001-first-slice-jmap-mail.md) | O365 → JMAP mail slice | ✅ Done — integration-tested (ledger, IMAP source, JMAP writer, shadow engine, scheduler, reindex). Note: T7's "wiring pending" caveat is stale; `apps/worker/src/build-deps.ts` exists (mail only). |
| [0002](./0002-imap-dav-target.md) | IMAP/DAV mail target family | ✅ Done — `ImapDavMailTarget` + imapsync bulk wrapper, integration-tested, both target types config-selectable. |
| [0003](./0003-caldav-carddav-webdav.md) | Calendar/contacts/files | ⚠️ Partially done, status overstated — models/hashes/interfaces/writers exist; `runUnifiedSync` is a **stub returning zeros**; no cal/contact/file **sources**; no ledger item-type; worker syncs mail only. Superseded by **0007**. |
| [0004](./0004-cutover-dns.md) | Cutover & DNS | ⚠️ Unit-level only, header contradicts body — state machine/verification/DNS types/rollback exist against fakes; nothing persisted, wired, or integration-tested; no real DNS I/O. Superseded by **0009**. |
| [0005](./0005-implementation-summary.md) | Managed edition | ⚠️ Scaffolding — RLS SQL + Trigger scheduler/jobs + API/web skeletons + Mollie service merged, but API routes are TODO shells, jobs don't call the core, and **RLS is not enforced at runtime** (no `SET app.current_tenant` anywhere). The original plan doc was deleted with `.agents_tmp/`; restoring it is 0006-C. Superseded by **0011**. |

## The new plans (created 2026-07-09)

| Plan | Subject | Depends on | Status |
|---|---|---|---|
| [0006](./0006-intermediate-remediation.md) | **Intermediate remediation** — findings outside the feature plans (test-selection gap, docs case collision, CI hardening, stale docs/deps, two owner decisions) | — | Ready to plan |
| [0007](./0007-multi-domain-sync-completion.md) | Calendar/contacts/files end-to-end (real sources, writers wired, unified sync, worker/config) | 0006-A | ⬜ Ready after 0006-A |
| [0008](./0008-o365-graph-source.md) | Production O365 source: token lifecycle, Graph cal/contacts/files, throttling, secret-gated e2e | 0007 (ports) | ⬜ Pending |
| [0009](./0009-cutover-integration.md) | Cutover made real: verification gate on real data, persisted state machine, DNS verify + one provider, rollback tests | 0007 (soft — mail-only gate acceptable) | ⬜ Pending |
| [0010](./0010-selfhost-edition.md) | Self-host edition: SQLite parity, startup migrations, entrypoint app, multi-arch packaging | 0007 (soft) | ⬜ Pending |
| [0011](./0011-managed-edition-hardening.md) | Managed edition: **runtime RLS enforcement**, real API persistence, Trigger.dev wiring, metering + Mollie e2e, web on real API | 0006-A/G/I | ⬜ Pending (T1 is security-critical) |

## Recommended order

1. **0006** — after owner validation. Item A (17 test files, including the idempotency property
   tests, currently match no vitest project and never run) gates trust in every other plan's
   green checkmarks.
2. **0007** and **0011-T1** (RLS enforcement) — parallelizable; different areas.
3. **0008** and **0010** — both consume 0007's seams; parallelizable.
4. **0009**, then the rest of **0011**, then the web epic once the 0006-G framework decision
   (Vite vs the `migration/nextjs-15` branch) is made.

Numbering note: the unmerged `migration/nextjs-15` branch carries a
`0006-status-report.md` that predates this index; per the 0006-G recommendation the branch is
**not** adopted (Vite stays) — its head is preserved as tag `archive/nextjs-15`, so the branch
can be deleted once the owner confirms. `0001-start-prompt.md` is a historical bootstrap prompt,
not a plan.
