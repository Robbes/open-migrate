# AGENTS.md

Single source of agent guidance for this repo. Works for Claude Code, OpenHands, and other coding agents. (Claude Code also reads `CLAUDE.md`, which just points here. OpenHands can be pointed at this file as repo instructions.)

**Before doing anything, read `docs/architecture/solution-architecture.md` — it is the source of truth.** This file is the operational contract; the architecture doc is the design.

Before any Stalwart or integration-test work, read docs/stalwart-integration-fix.md in full and do not deviate from it. Never change the pinned Stalwart version, never put accounts/domains/listeners in config.json, never skip the shadow-pass tests.

## What we are building
A sovereign migration/sync stack that moves families and SMBs off US cloud (O365/Google/Dropbox) to EU/CH targets. **Target protocols: JMAP is primary** (Stalwart reference; mosa.cloud / La Suite / MijnBureau), **IMAP/CalDAV/CardDAV/WebDAV is the parallel second family** (Soverin, openDesk, Nextcloud, Proton via import) — **both in MVP (ADR-0018)**. The **O365 source stays IMAP+OAuth2/Graph** (Microsoft has no JMAP), so JMAP is a target-side concern. Migration is **idempotent**, can **shadow-run** in parallel as long as the user wants, and the user stays **in control** via a clear UI.

## Tech stack (decided — see ADRs)
- **Language:** TypeScript (Node), pnpm workspaces monorepo. (ADR-0002)
- **Orchestration:** `Scheduler` interface with two impls — **in-process** (croner) for the self-host edition, **Trigger.dev** (Apache-2.0, self-hostable or cloud) for the managed edition. Self-host MUST stay possible, incl. local dev on an arm64 Spark. (ADR-0004)
- **State:** ledger in **Postgres + RLS** (managed) or **SQLite / small Postgres** (self-host), same schema contract. (ADR-0010)
- **Engines:** for **IMAP/DAV** targets, shell-out to **imapsync** (mail), **vdirsyncer** (cal/contacts), **rclone** (files) — do not reimplement; plus a custom **Microsoft Graph rich extractor** (versions/permissions/metadata/lists). For **JMAP** targets, a **JMAP writer** on a JS client (jmap-jam); the one-shot **JMAP migration utility** can seed the initial bulk copy. **Prefer JS-native engines where a maintained library gives equal fidelity** (portability / simpler packaging); keep the CLI engines for bulk and on Linux/container deployments. No commercial SharePoint tools. (ADR-0007, ADR-0018, ADR-0019)
- **O365 access:** one multi-tenant Entra app; application permissions + Application Access Policy (org/SMB), delegated (individuals); IMAP+OAuth2 primary, Graph fallback. (ADR-0006)
- **Targets:** provisioning behind a `TargetProvisioner` interface — `ManualProvisioner` + `ApiProvisioner`. (ADR-0008)
- **License:** Apache-2.0. (ADR-0001)

## Repo layout
```
docs/            # ALL documentation lives here (see docs/README.md)
  architecture/  # solution-architecture.md = source of truth
  adr/           # Architecture Decision Records (0000-template.md + numbered)
  guides/        # how-tos
  runbooks/      # cutover runbook, ops
packages/        # shared libraries (the core, identical across editions)
  core/          # reconcile loop + idempotency
  ledger/        # ledger schema + migrations + access
  connectors/    # source/target adapters (graph, imap, jmap, webdav, caldav, carddav, proton)
  engines/       # wrappers around imapsync/rclone/vdirsyncer + graph extractor
  scheduler/     # Scheduler interface + in-process (croner) + trigger.dev impls
  provisioner/   # TargetProvisioner interface + manual + api impls
  shared/        # types, config, logging, utils
apps/
  api/           # control-plane API (managed)
  web/           # UI/portal: scope-manifest, status, decision queue (see arch doc §11.2)
  worker/        # data-plane worker (runs engines; sees content)
  selfhost/      # self-host entrypoint (in-process scheduler + embedded state + UI)
deploy/
  compose/       # docker-compose dev/test stack (arm64): postgres + stalwart (JMAP+IMAP+DAV reference target) + nextcloud (Trigger.dev added later)
  helm/          # managed k8s charts
  homeassistant/ # HA add-on
test/            # fixtures, integration (against compose stack), e2e (incl. idempotency property tests)
```

## Commands (conventions — wire up as the project grows)
- Install: `pnpm install`
- Lint/format: `pnpm lint` / `pnpm format`
- Unit tests: `pnpm test`
- Test stack up (arm64): `docker compose -f deploy/compose/dev.yml up -d`
- Integration/e2e: `pnpm test:integration` / `pnpm test:e2e`

## Hard rules for agents (do not violate)
1. **Idempotency is sacred.** Any sync must converge: re-running produces no duplicates and no corruption. Add/keep idempotency property tests.
2. **Non-destructive by default.** NEVER auto-delete or overwrite on the target. Source deletions are surfaced as a user decision, never propagated automatically. (arch doc §11.1)
3. **Never commit secrets.** Use `.env` (gitignored) and a vault. No tokens/keys/credentials in code, tests, fixtures, or ADRs.
4. **Respect provider limits.** Honor Graph 429/`Retry-After`; keep per-tenant/provider concurrency budgets.
5. **Self-host must keep working.** No hard dependency on a managed-only service in shared `packages/` or in `apps/selfhost`. Orchestration stays behind the `Scheduler` interface.
6. **Apache-2.0 headers** on source files; `docs/` is the only home for documentation; keep the root `.md` allowlist (see CONTRIBUTING.md).
7. **Decisions → ADRs.** If you make or change an architectural decision, add/supersede an ADR in `docs/adr/` and reference it.
8. **Test gates must pass** before a change is "done": lint + unit + relevant integration; update docs.

## Testing against the real source
The test O365 source is a **real SMB tenant**. Treat it as production: **read-only, least-privilege** (Application Access Policy scoped to test mailboxes), never write back, never disrupt the live tenant. The one-way mirror + non-destructive defaults make this safe.

## Self-hosted CI runner (Spark)
The Spark is arm64 with a self-hosted GitHub runner and docker socket + root. Only run **trusted** workflows on it (no untrusted fork PRs) — docker+root = RCE risk. Build **multi-arch images (amd64 + arm64)**.

## Definition of done
Tests pass · docs updated · ADR added/updated if a decision changed · no secrets · idempotency + non-destructive invariants preserved · self-host path intact.
