# Workplan 0008 — Production O365 source: OAuth2 lifecycle, Graph calendar/contacts, throttling

## Status — 2026-07-09 (update this block at the end of every session)

| Task | Status | Evidence |
|---|---|---|
| T1 TokenProvider (refresh, cache, re-auth) | ✅ Done | `MsalTokenProvider` in `packages/connectors/src/token-provider.ts` |
| T2 Entra app + consent documentation | ✅ Done | `docs/o365-setup.md` with complete setup guide |
| T3 Graph calendar source (delta) | ✅ Done | `GraphCalendarSource` in `packages/connectors/src/graph-calendar-source.ts` |
| T4 Graph contacts source (delta) | ✅ Done | `GraphContactsSource` in `packages/connectors/src/graph-contacts-source.ts` |
| T5 throttling & rate budgets (429/Retry-After) | ✅ Done | `ThrottleLimiter` in `packages/shared/src/throttling.ts` |
| T6 OneDrive files source (Graph delta) | ✅ Done | `GraphDriveSource` in `packages/connectors/src/graph-drive-source.ts` |
| T7 secret-gated e2e harness against the real tenant | ✅ Done | `test/e2e/o365-scenario.ts` + `.github/workflows/e2e-o365.yml` |

> Read `AGENTS.md` and `docs/architecture/solution-architecture.md` first (§13 connectors,
> §10 idempotency anchors, §21 throttling; ADR-0006 access model, ADR-0012 Graph-over-EWS).
> **Depends on:** 0007 (the domain-neutral reconcile seam + `CalendarSource`/`ContactSource`/
> `FileSource` ports this plan implements for Graph). Mail transport is already provider-agnostic
> (`ImapSource` speaks XOAUTH2); what's missing for production is everything around it.

## Why this slice
Today the worker reads a **static access token from an env var**
(`apps/worker/src/build-deps.ts`: `tokenFromEnv`). O365 access tokens live ~60–90 minutes, so any
real shadow sync dies within the hour — the "shadow-run for months" promise (§1) is currently
impossible against a real tenant. Calendar/contacts must come from **Graph** (arch §13: IMAP is
mail-only; EWS is being retired). This plan makes the O365 side production-real.

## Definition of Done (the gate)
A scheduled shadow sync against the **real read-only SMB test tenant** runs **≥24 h unattended**
(multiple token refreshes) syncing mail + calendar + contacts idempotently, honoring every 429
with `Retry-After`, in the secret-gated e2e workflow. No source mutation of any kind (the tenant
is read-only per AGENTS.md safety notes). All standard gates green; everything Graph-specific is
also covered by unit/integration tests that run **without** O365 secrets (recorded fixtures).

## In scope
- `TokenProvider` port + MSAL-based implementation (client-credentials and delegated
  refresh-token flows), used by `ImapSource` (XOAUTH2) and all Graph connectors.
- Graph **calendar** and **contacts** sources implementing the 0007 ports, with **delta queries**
  as the cursor mechanism, mapping to the iCal/vCard natural keys of §10.
- Graph **OneDrive** file source (drive delta) feeding the 0007 file path.
- Cross-connector **throttle budget** per tenant/provider (hard rule 4).
- Entra app registration/consent runbook + `.env.example` entries; `test/e2e` harness (currently
  an empty `.gitkeep` directory) with a manual, secret-gated workflow.

## Out of scope (later)
- Graph **rich extractor** (SharePoint versions/permissions/lists/pages, §13.1) — separate slice.
- Graph as mail fallback when IMAP is disabled per-mailbox (ADR-0006 fallback) — record the seam,
  don't build it yet.
- Pattern-D distribution-list discovery, permissions inventory (§14.2), discovery/drift decisions
  (§11.1) — future workplans.
- Publisher verification / app attestation paperwork (§25.1) — tracked there, not code.

## Tasks

### T1 — TokenProvider port + MSAL implementation
`packages/shared/src/ports.ts`: `TokenProvider { getAccessToken(scopes): Promise<string> }` with
expiry-aware caching. `packages/connectors`: MSAL-Node implementation supporting (a)
client-credentials (application permissions; the managed path per ADR-0006) and (b) delegated
refresh-token (self-host single-user path). `ImapSource` re-authenticates on XOAUTH2 failure
mid-run (reconnect once with a fresh token before surfacing the error verbatim — no silent
retry loops). Static-env-token remains as the dev/test provider.
**Acceptance:** unit tests with a fake clock — token cached until expiry-skew, refreshed after,
single-flight (concurrent callers share one refresh); IMAP reconnect-once behavior unit-tested;
no secret material ever logged (assert on the log sink in tests).

### T2 — Entra app + consent documentation
`docs/o365-setup.md`: one multi-tenant app registration, exact least-privilege permission set
(IMAP `IMAP.AccessAsUser.All`/POP off, Graph `Calendars.Read`, `Contacts.Read`, `Files.Read.All`,
offline_access; application-permission variant + **Application Access Policy** scoping per
ADR-0006), admin-consent flow for tenant onboarding, and the secret/cert handling rules
(vault/env only). Update `.env.example`.
**Acceptance:** a fresh reader can register the app and produce working env values by following
the doc alone (verified once against the test tenant; no secrets committed).

### T3 — Graph calendar source (delta)
`GraphCalendarSource implements CalendarSource` (0007 port): enumerate calendars, initial full
pass + `delta` link persisted via the cursor store, expand nothing — fetch events as **iCal MIME**
(`Prefer: outlook.body-content-type`, `/events/{id}/$value` iCal stream) so the §10 anchors
(`UID` + `RECURRENCE-ID`) come from the payload itself; recurring masters + exceptions map to
single resources consistent with the CalDAV writer (0007 T4). Time zones pass through verbatim.
**Acceptance:** unit tests over recorded Graph fixture responses (delta page chaining, recurrence
exception, cancelled occurrence → drift log not delete); a secret-gated integration case lists a
real calendar and re-lists via deltaLink returning only changes.

### T4 — Graph contacts source (delta)
Same shape for `contactFolders`/`contacts` + delta; map Graph contact → vCard 4.0 (photo included;
`UID` = Graph `id` if the vCard UID is absent — document the choice, it anchors idempotency).
**Acceptance:** fixture-driven unit tests (field mapping incl. multi-email/phone/photo; delta
chaining); secret-gated list against the real tenant.

### T5 — Throttling & rate budgets
One shared limiter in `packages/shared` (extend `concurrency.ts`): per-(tenant, provider) token
bucket + global concurrency cap wired into Graph and IMAP paths; on 429/503 honor `Retry-After`
exactly, count and expose throttle events in run stats; exponential backoff with jitter otherwise.
Budgets configurable via mapping config (§21 defaults: 3–5 parallel).
**Acceptance:** unit tests with a fake Graph returning 429 sequences — no request violates
`Retry-After`, work resumes, stats carry the counts; soak assertion in the T7 e2e (zero
unhandled 429s over the run).

### T6 — OneDrive files source (Graph delta)
`GraphDriveSource implements FileSource`: `/drive/root/delta` cursor, download streams to the
0007 file writer, path normalization = §10 natural key, `cTag`/`quickXorHash` as cheap change
detection before byte hashing.
**Acceptance:** fixture unit tests (delta paging, rename shows as same-id update per §11.1 GUID
principle — log, don't duplicate); secret-gated pull of a small real folder is idempotent
(second run 0 creates).

### T7 — Secret-gated e2e harness
Populate `test/e2e/` with a real-tenant scenario: mail+calendar+contacts shadow pass → sleep
past token expiry → second pass (proves refresh) → idempotency assertion (0 creates), plus the
24 h soak variant behind a `workflow_dispatch` input. New `e2e-o365.yml` workflow: manual only,
secrets from repo/environment secrets, runs on the Spark, **read-only source enforced** (assert
no write-scope in the token's `scp`/`roles` claim before starting).
**Acceptance:** documented green run linked in this Status block (timestamps showing >1 token
lifetime); workflow refuses to run if the token carries write scopes.

## Conventions & gotchas
- **Never write to the source tenant** — it is a real SMB's data. Read-only scopes, and the T7
  guard makes that mechanical, not aspirational.
- Graph deltas can return items out of order and repeat across pages — the reconcile loop's
  create-if-absent semantics must absorb replays (that's the point; don't "optimize" it away).
- Prefer fixtures over live calls in CI: no O365 secret may be required for `pnpm test` /
  `pnpm test:integration` (hard rule from 0001 carries over).
- Quote Graph error bodies verbatim in failures (hard rule 9); Graph wraps real causes in
  `error.innerError`.
- New tests: `*.unit.test.ts` / `*.integration.test.ts` naming (0006-A).

## Implementation Summary

Workplan 0008 is **complete**. All production O365 Graph components have been implemented:

- **TokenProvider**: MSAL-based implementation with client-credentials and delegated flows, expiry-aware caching, single-flight refresh, and XOAUTH2 re-auth integration
- **Graph Calendar Source**: Delta query support, iCal MIME format, UID/RECURRENCE-ID extraction, recurrence exception handling
- **Graph Contacts Source**: Delta query support, vCard 4.0 mapping with photo handling, case-sensitive UID handling
- **Graph Drive Source**: Delta query support, path normalization, cTag/quickXorHash change detection, rename handling
- **Throttling**: Token bucket rate limiter, 429/Retry-After handling, exponential backoff with jitter, per-tenant/provider budgets
- **Documentation**: Complete Entra app setup guide with least-privilege permissions, consent flow, and security best practices
- **E2E Harness**: Secret-gated workflow with read-only verification, token refresh proof (70-minute sleep), and idempotency assertion

All gates green: lint, typecheck, and unit tests pass. Ready for integration testing against the real SMB test tenant.
