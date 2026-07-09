# AGENTS.md

Agent guidance for this repo (Claude Code via `CLAUDE.md` pointer, OpenHands, others). **Read `docs/architecture/solution-architecture.md` first — the source of truth.** This file is the operational contract. Detail lives in the docs it points to (progressive disclosure), not here.

Before any Stalwart or integration-test work: read `docs/stalwart-integration-fix.md` in full and do not deviate (decisions in ADR-0022). Never change the pinned Stalwart version; never put accounts/domains/listeners in config.json; never skip the shadow-pass tests.

## Session protocol (mandatory)
1. **Start:** read the arch doc, then the active workplan in `docs/workplans/` — its top **Status block** is ground truth for done/open. Trust it; never redo completed tasks.
2. **Plan:** create a task-tracker list before coding; keep it updated. Parallel subagents may do read-only audits; conclusions still need quoted evidence.
3. **Evidence-first:** never claim something works without pasting proof (test run, logs, wire dialogue). Quote errors verbatim before proposing fixes.
4. **Docker hygiene:** manual debug `docker run` uses `--rm` or is removed before session end.
   One Stalwart container per data volume, ever (RocksDB lock). At end:
   `docker ps -a | grep -i stalwart` + `docker volume ls | grep -i stalwart`, remove your debris.
5. **End:** update the workplan Status block with what you proved; commit docs with code; all gates green.

## Commands
- Install: `pnpm install` · Lint: `pnpm lint` · Typecheck: `pnpm typecheck`
- Unit: `pnpm test` · Integration: `pnpm test:integration` (self-manages its stack via Testcontainers) · E2E: `pnpm test:e2e`
- Optional dev stack: `docker compose -f deploy/compose/dev.yml up -d`

## What we are building
Sovereign migration/sync: families and SMBs move off US cloud (O365/Google/Dropbox) to EU targets. **JMAP is the primary target protocol** (Stalwart reference; mosa.cloud / La Suite / MijnBureau); **IMAP/CalDAV/CardDAV/WebDAV is the parallel second family** (Soverin, openDesk,
Nextcloud) — both in MVP (ADR-0018). The **O365 source stays IMAP+OAuth2/Graph**. Migration is idempotent, shadow-runs as long as the user wants, and the user stays in control via the UI.

## Decided stack (details in the ADRs — follow them, don't re-decide)
- TypeScript, Node 24, pnpm workspaces monorepo (ADR-0002); Apache-2.0 (ADR-0001).
- `Scheduler` interface: in-process croner (self-host) / Trigger.dev (managed) (ADR-0004).
- Ledger: Postgres+RLS (managed) or SQLite/small Postgres (self-host), one schema (ADR-0010/0016); migrations via Drizzle Kit + Atlas lint (ADR-0017).
- Engines: JMAP writer (jmap-jam) for JMAP targets; imapsync/vdirsyncer/rclone shell-outs for IMAP/DAV; prefer JS-native where fidelity is equal (ADR-0007/0018/0019).
- O365: one multi-tenant Entra app; IMAP+OAuth2 primary, Graph fallback (ADR-0006).
- Target provisioning behind `TargetProvisioner` (manual + API) (ADR-0008).

## Repo map (top level; don't trust paths blindly — verify before editing)
- `docs/` — all documentation: `architecture/` (source of truth), `adr/`, `workplans/` (Status blocks), canonical docs incl. `stalwart-integration-fix.md`, `testing.md`.
- `packages/` — `core` (reconcile+idempotency), `ledger`, `connectors`, `engines`, `scheduler`, `provisioner`, `shared`.
- `apps/` — `api`, `web`, `worker`, `selfhost`. `deploy/` — `compose/` (dev stack), `helm/`, `homeassistant/`. `test/` — fixtures, integration, e2e.

## Hard rules (each "don't" has its "do")
1. **Idempotency is sacred.** Re-runs converge: no duplicates, no corruption. Keep the idempotency property tests green; extend them with new behavior.
2. **Non-destructive by default.** Never auto-delete/overwrite on the target; surface source deletions as user decisions (arch doc §11.1).
3. **No secrets in the repo.** Use `.env` (gitignored) / vault refs; never in code, tests, fixtures, or ADRs.
4. **Respect provider limits.** Honor 429/`Retry-After`; keep per-tenant/provider concurrency budgets.
5. **Self-host must keep working.** No managed-only dependency in `packages/` or `apps/selfhost`; orchestration stays behind `Scheduler`.
6. **Docs discipline.** `docs/` is the only home for documentation; keep the root `.md` allowlist (CONTRIBUTING.md); Apache-2.0 headers on source files.
7. **Decisions → ADRs** (append-only; supersede, don't delete). Operational findings → a Rule + one-line rationale in the relevant reference doc (e.g. the Stalwart fix doc).
8. **Gates before "done":** lint + typecheck + unit + relevant integration; update docs.
9. **Never mask errors.** No null-fallbacks or catch-and-continue that turn failures into empty results (`scanned=0` must be unreachable via a swallowed error) — unmask, quote, fix the root cause. Connector (IMAP/JMAP) failures must surface.

## Safety notes
- The test O365 source is a **real SMB tenant**: read-only, least-privilege, never write back.
- The Spark arm64 runner has docker socket + root: trusted workflows only; build multi-arch (amd64+arm64) images.

## Skills (all agents)
Agent-neutral, reusable skills live in `.agents/skills/` — currently `caveman.md` (ultra-terse
output mode). Activate one only when the user asks for it by name (e.g. "caveman mode");
read the file and follow it for the rest of the session.

## Prompts for other agent sessions
Inline all code/commands/paths as backtick inline code within prose — no separate fenced blocks —
so the whole prompt is one copy-pasteable unit.

## Definition of done
Gates green · docs updated · workplan Status block updated · ADR if a decision changed ·
no secrets · idempotency + non-destructive intact · self-host intact · no docker debris.