# Workplans — index & sequencing

Ground rules (AGENTS.md): read `docs/architecture/solution-architecture.md` first; a workplan's
**Status block is ground truth** and must be updated with evidence at session end. This index
adds the cross-plan view: what is verifiably done, what each plan depends on, and in which order
to execute.

**Policy: workplans are never deleted.** Like ADRs they are append-only history — a replaced
plan gets a ⚠️ SUPERSEDED banner pointing to its successor (0003→0007, 0004→0009, 0005→0011)
and stays put, preserving the evidence trail and inbound links.

## State of the stack (verified against code, 2026-07-21, `main` post-#73)

Since the last index refresh (post-#56), PRs #57–#73 merged, landing the **0010 self-host edition**
(T1–T4 + T6, T5 e2e written) and hardening **0011** (real cutover/rollback triggers, tenant-authz
RLS gate, auth JWKS precedence, members/billing review fixes) plus web-auth/scheduler fixes.
Verified state:

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
| [0010](./0010-selfhost-edition.md) | Self-host edition | 🟡 **T1–T4 + T6 done & merged; T5 e2e written, needs a seeded run.** (PRs #62/#63 packaging+docs, #64 pool-leak, #65/#70/#73 review+T5). `apps/selfhost/src/index.ts` is now a **real entrypoint** (migrate → load config dir → `InProcessScheduler` → `/healthz`+`/status` → graceful shutdown, all four domains, zero managed leakage); startup migration runner (`packages/ledger/src/migrate.ts`), bundled-Postgres compose + Dockerfile, env-file secrets all present. **Only open:** T5's zero-duplicates assertion needs a **seeded, non-zero source** run on a Docker host (§5 acceptance centerpiece). **Postgres-only (ADR-0023).** |
| [0011](./0011-managed-edition-hardening.md) | Managed edition hardening | 🟡 **T1–T6 done & merged; only T7 remains.** T1 runtime RLS, T2 real API persistence, T3 Trigger.dev wiring, T4 usage metering, T5 billing + Mollie webhook e2e, T6 web on the real API. The **T3 remainder is now closed** (PR #67): cal/contact/file domains wired via `buildDomainDepsFromMapping`, and `run-cutover.ts`/`run-rollback.ts` are real (final pass + verification gate that aborts on FAIL; honest rollback). Post-#56 review PRs hardened it further — tenant-authz RLS gate (#71), auth JWKS precedence (#69), members-rollback (#68), billing-webhook (#66). **Remaining:** T7 — app-tier Dockerfiles + live `compose up` DoD verification (draft on PR #57, needs a Docker host); only DNS provider **writes** stay deferred (2026-07-16 verify-only decision). |
| [0012](./0012-cutover-completion-summary.md) | Cutover completion summary | 📄 History doc for the 0009 cutover work (not a forward plan). |
| [0013](./0013-discovery-preview-confirm.md) | Pre-sync discovery, preview & confirm | ⬜ **Drafted, not started.** Read-only per-domain counts (mail/cal/contacts/files) + the §11.2 scope manifest with a **"Start migration"** green light that flips the mapping `paused`→`active` (reuses the schedule-driven model). Background discovery job + poll. **Both editions get a confirm screen** — managed React wizard step; self-host a minimal appliance-served static page (hard rule 5). Decisions locked with the owner 2026-07-21. |

## What landed this cycle
**The 0010 self-host edition, plus 0011 hardening (PRs #57–#73).** Self-host went from a
one-line placeholder to a real single-tenant appliance: a startup migration runner under a
Postgres advisory lock (`packages/ledger/src/migrate.ts`), a real `apps/selfhost` entrypoint
(config-dir load → `InProcessScheduler` → `/healthz`+`/status` → graceful shutdown, all four
domains), bundled-Postgres compose + multi-stage Dockerfile, env-file secrets, and a
`no-managed-leakage` guard that walks the transitive import graph (T1–T4 + T6). The
restart-resume idempotency e2e (T5) is written but still needs a **seeded** run to actually
demonstrate zero-duplicates. On the managed side, the 0011 **T3 remainder closed** (real
cutover with a verification gate + honest rollback + non-mail domains, PR #67), and a wave of
review fixes hardened tenant-authz/RLS (#71), auth JWKS precedence (#69), members-rollback (#68),
and billing webhooks (#66); web-auth (consistent 401 logout) + scheduler single-flight were fixed
in #72. With these, **0011 T1–T6 are done** (only T7 — container images + a live `compose up` DoD —
is left) and **0010** is one seeded acceptance run from complete. **ADR-0023 (Postgres-only)**
still stands — **do not reintroduce SQLite / a second dialect.**

## Recommended order (from here)

The two open acceptance items both need a **Docker host** (this appliance-level verification can't
be done in a Docker-free CI runner):

1. **Finish 0011 T7** (the only open managed task) — build/verify the app-tier Dockerfiles and run
   the clean `docker compose -f deploy/compose/managed.yml up` → two-tenant DoD journey on a Docker
   host. Draft staged on PR #57; brief in `docs/design/0011-t7-dockerfiles-handoff.md`.
2. **Close 0010 T5** — seed Stalwart with N>0 items, then run first-pass / `docker compose restart
   app` / second-pass against `deploy/selfhost/compose.yml` and capture that `/status` `itemsSynced`
   does **not** grow (the §5 zero-duplicates centerpiece). Everything else in 0010 is done.
3. **0009 T3** — DoH-resolver upgrade (small; anytime) closes out cutover.
4. **0013 (discovery/preview & confirm)** — drafted; the pre-sync counts + scope manifest + "Start
   migration" green light. Fully testable without Docker (unit + jsdom component tests).
5. Later: rich Graph extractor (SharePoint), the §11.1 drift **decision queue** + policy presets
   (the schema `decision` table already exists), Proton path.

Numbering note: `0001-start-prompt.md` is a historical bootstrap prompt, not a plan. The
`migration/nextjs-15` branch was **not** adopted (Vite stays; tag `archive/nextjs-15` preserves
it), so its `0006-status-report.md` is dead — ignore it.
