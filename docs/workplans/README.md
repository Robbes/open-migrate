# Workplans — index & sequencing

Ground rules (AGENTS.md): read `docs/architecture/solution-architecture.md` first; a workplan's
**Status block is ground truth** and must be updated with evidence at session end. This index
adds the cross-plan view: what is verifiably done, what each plan depends on, and in which order
to execute.

**Policy: workplans are never deleted.** Like ADRs they are append-only history — a replaced
plan gets a ⚠️ SUPERSEDED banner pointing to its successor (0003→0007, 0004→0009, 0005→0011)
and stays put, preserving the evidence trail and inbound links.

## State of the stack (verified against code, 2026-07-16, `main` @ `eb85b5d`)

10 PRs (#27–#40) merged since the last assessment. Verified state:

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
| [0010](./0010-selfhost-edition.md) | Self-host edition | ⬜ **Next.** **Rewritten 2026-07-16 for Postgres-only (ADR-0023)** — bundles a small Postgres; no SQLite. 0007 (its dependency) is done, so it's ready to start. |
| [0011](./0011-managed-edition-hardening.md) | Managed edition hardening | ⬜ **Next (big epic).** T1 RLS is 🟡 partial (DB-layer landed — `app_user` role, FORCE RLS, `rls.integration.test.ts`; **app-layer enforcement still missing** — nothing sets `app.current_tenant`). T2–T7 pending. |
| [0012](./0012-cutover-completion-summary.md) | Cutover completion summary | 📄 History doc for the 0009 cutover work (not a forward plan). |

## Architecture change this session
**ADR-0023 (persistence Postgres-only)** — owner decided both editions use Postgres; self-host
**bundles a small Postgres** container. This supersedes the SQLite option in ADR-0010/0016 (SQLite
had already been deleted from the tree). AGENTS.md + solution-architecture §7.3/§22.1 updated;
workplan 0010 rewritten accordingly. **Do not reintroduce SQLite / a second dialect.**

## Recommended order (from here)

1. **0011 T1 — runtime RLS enforcement** (security-critical): the DB layer is ready, but the
   app-layer tenant context (`withTenant()` + `SET LOCAL app.current_tenant`, connect as
   `app_user`) is missing, so tenant isolation is **not actually enforced** yet. Do this before
   any other managed task touches tenant data.
2. **0010 (self-host)** and **0011 T2–T7 (managed)** — largely parallel (self-host packaging vs
   managed control plane); coordinate only on the shared migration-runner / connection-role seam.
3. **0009 T3** — DoH-resolver upgrade (small; anytime) closes out cutover.
4. Later: rich Graph extractor (SharePoint), discovery/drift decision queue + UI, Proton path.

Numbering note: `0001-start-prompt.md` is a historical bootstrap prompt, not a plan. The
`migration/nextjs-15` branch was **not** adopted (Vite stays; tag `archive/nextjs-15` preserves
it), so its `0006-status-report.md` is dead — ignore it.
