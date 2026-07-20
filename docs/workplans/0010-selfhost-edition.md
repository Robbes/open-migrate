# Workplan 0010 — Self-host edition: a runnable single-tenant bundle (NAS / mini-PC / Pi)

## Status — 2026-07-20 (update this block at the end of every session)

| Task | Status | Evidence |
|---|---|---|
| T1 startup migration runner (Postgres advisory lock) | ✅ Done | `packages/ledger/src/migrate.ts` — `runMigrations({connectionString})` enumerates `migrations/*.sql` (zero-padded → linear order), applies pending ones under advisory lock `727_0010`, records each in a `schema_migrations` table (one txn per migration), and **refuses to start** when the DB's highest applied version exceeds the highest the build ships (§22.1 downgrade guard). Idempotent re-run = no-op; runs as owner/superuser (0008/0009 create roles+RLS). Exported from `@openmig/ledger`. **Tests:** `migrate.integration.test.ts` (fresh→latest, re-run no-op, concurrent double-start applies once, newer-schema refusal) — each on a throwaway DB it creates/drops. **Gates:** lint + typecheck green (integration in CI). |
| T2 selfhost entrypoint app | ✅ Done (unit) | `apps/selfhost/src/index.ts` `start()`: applies T1 migrations → loads a **directory** of mapping JSONs (`loadConfigDir`, shared `parseMappingConfigJson`, fail-fast on invalid/duplicate) → schedules each with `InProcessScheduler` (croner + single-flight) → serves `GET /healthz` + `GET /status` (ledger-derived per-domain state, errors verbatim §11.2) → graceful shutdown (stop schedules, drain in-flight, close). **Shared, not forked:** `runAllDomains` extracted to `@openmig/worker/orchestration`; the real DAV connector factories (`dav-factories.ts`) are now used by **both** the file path (`build-deps.ts`) and the DB path (`build-deps-from-mapping.ts`), so self-host does **all four domains** for real. **Hard rule 5:** imports `@openmig/scheduler/in-process` (not the index, which re-exports the Trigger.dev client) — verified the whole selfhost graph has zero `@trigger.dev`/billing. **Tests:** `config-dir.unit.test.ts` + `status.unit.test.ts` run in a Docker-free selfhost vitest project (**7/7 green locally**). **Open:** integration start-against-Postgres + `SIGTERM` restart-resume is T5 (needs Docker). **Gates:** lint + typecheck green. |
| T3 all-in-one packaging (compose w/ bundled Postgres + multi-arch image) | 🟡 Scaffolded (build-verify needs Docker host) | `deploy/selfhost/compose.yml` — **two services**: `postgres` (`postgres:18-alpine`, **local** `pgdata` volume, `pg_isready` healthcheck) + `app` (built from `apps/selfhost/Dockerfile`, `depends_on` postgres healthy, `restart: unless-stopped`, `/healthz` healthcheck, `./config`→`/data/config` ro + `appdata`→`/data/state`, `DATABASE_URL` at the bundled DB). `apps/selfhost/Dockerfile` — multi-stage Node 24-slim, corepack pnpm, non-root `appuser`, runs the T2 entrypoint under `tsx` (source-ships-TS), `HEALTHCHECK` on `/healthz`. **App self-migrates on startup** (T1) — no initdb mount needed. `deploy/selfhost/selfhost.env.example` (POSTGRES_* + `tokenFromEnv`/`passwordFromEnv` seam, `SELFHOST_BIND`/`SELFHOST_PORT`/`SELFHOST_IMAGE`), `deploy/selfhost/config/mapping.json.example` (valid mail mapping; `*.example` is not loaded), `deploy/selfhost/README.md` (quickstart + **stable/edge channel** convention §22.1). **Hard rule 5 guard:** `apps/selfhost/src/no-managed-leakage.unit.test.ts` walks the real transitive `@openmig` import graph from the entrypoint and fails on any `@trigger.dev`/billing/Mollie specifier (or the scheduler index) — **9/9 selfhost unit tests green**. **Open (needs a Docker host):** `docker compose build && up` on **amd64 + arm64** to healthy, a demo `mapping.json` first shadow pass reflected in `/status`, multi-arch buildx, and base-image **digest pinning** (tag-pinned here; digest can't be resolved offline). **Gates:** lint + typecheck green. |
| T4 secrets & config for self-host | 🟡 Partial | The `.env`-file pattern is in place (`selfhost.env.example` + compose `env_file:`), documenting the `tokenFromEnv`/`passwordFromEnv` seam and the bundled `POSTGRES_PASSWORD` (compose refuses to start without it). File-permission (600) + rotation + ADR-0020 recovery guidance is in `deploy/selfhost/README.md` (fuller treatment lands with T6). **Open:** the "no secret in image layers / logs / `/status`" assertion test. |
| T5 restart-resume idempotency gate (the acceptance centerpiece) | ⬜ Pending | — |
| T6 quickstart + backup/upgrade docs | ⬜ Pending | — |

> Read `AGENTS.md` and the arch doc first (§7.1 self-host edition, §22.1 releases/migrations,
> **ADR-0023 persistence Postgres-only**, ADR-0019 packaging, ADR-0020 rebuildable ledger).
> **Depends on:** 0007 (done — the bundle ships all domains via the worker's multi-domain
> orchestration). **Hard rule 5 is the soul of this plan:** no *managed-only* dependency
> (Trigger.dev, vault, IdP, billing) may leak into this path.
>
> **⚠️ 2026-07-16 rewrite:** this plan originally assumed **SQLite** for self-host (per the old
> ADR-0010/0016). The owner has since decided (**ADR-0023**) that **both editions use Postgres**
> and the self-host edition **bundles a small Postgres container**. SQLite was already deleted
> from the tree (commit `6d9ecd4`, `schema-sqlite.ts`/`sqlite-ledger.ts` gone) and the 10
> migrations are Postgres-only. The old T1 "SQLite parity gates" is therefore **removed**; do not
> reintroduce a second dialect.

## Why this slice
"Self-host must keep working" is a hard rule, but today the self-host edition **does not exist as
a runnable thing**: `apps/selfhost/src/index.ts` is a one-line placeholder
(`export const app = '@openmig/selfhost';`), migrations don't run on startup, and there is no
packaging a NAS/Pi owner could actually deploy. Everything proven so far runs through dev-stack
scripts and the worker CLI. The migration *core* is done (0001/0002/0007) and the worker already
orchestrates all domains — this slice packages that into a single-tenant appliance.

## Definition of Done (the gate)
On a clean machine (amd64 **and** arm64): `docker compose -f deploy/selfhost/compose.yml up -d`
brings up a **bundled Postgres + one app container** that (a) applies ledger migrations on startup
under an advisory lock against a mounted `/data` Postgres volume, (b) schedules the configured
mappings with the in-process croner scheduler, (c) serves a local status endpoint, and (d) after
`docker restart` **resumes incrementally from cursors with zero duplicates** — the idempotency
property test run as a black box against the running stack. `pnpm` gates green; the
kill-and-restart test (T5) is the acceptance centerpiece (§5: "intermittently-on host resumes
cleanly").

## In scope
- A startup **migration runner** (Postgres advisory lock; refuses to start when the DB schema is
  newer than the app understands — §22.1), used by selfhost and reusable by the worker.
- A real `apps/selfhost` entrypoint composing existing pieces: config load → migrations →
  `InProcessScheduler` → the worker's multi-domain sync → status endpoint.
- Docker packaging: a small **bundled Postgres** service + one app image, multi-arch
  (amd64+arm64), pinned digests, `stable` tag convention (§22.1); align with the existing CI
  security-scan (signing/SBOM), don't duplicate.
- Self-host secrets: env-file based, documented; no vault dependency.
- The restart-resume black-box idempotency gate.

## Out of scope (later)
- Home Assistant add-on and the hybrid agent (§7.1) — after the compose path is proven.
- Tauri tray app / Windows-native (§25.3, ADR-0019) — container-first stands.
- Embedded/serverless Postgres (pglite/embedded-postgres) to drop the container — ADR-0023 parks
  this as the future "no container" path; **not** this slice.
- Web UI inside the bundle beyond a status endpoint — the managed web app (0011) is separate; the
  entrypoint must leave an obvious mount point for a future local UI.
- Multi-tenancy / RLS anything (that's managed, 0011). Self-host is single-tenant: isolation is
  trivial, RLS is not required (ADR-0023).

## Tasks

### T1 — Startup migration runner (Postgres advisory lock)
A small runner in `packages/ledger` (used by selfhost + reusable by worker/managed): enumerate
`migrations/*.sql`, apply linearly under a **Postgres advisory lock**, record applied versions in
a `schema_migrations` table, and **refuse to start** if the DB reports a version newer than the
binary supports (§22.1). Idempotent re-run is a no-op; skipping versions (N-2 → N) works by linear
application. (Single dialect now — no SQLite branch.)
**Acceptance:** §22.1 CI gates as integration tests (Testcontainers Postgres) — fresh-install
empty→latest, re-run no-op, **concurrent double-start applies once** (two processes race the lock,
one wins), newer-schema refusal path. Note migrations `0008/0009` create roles/RLS — the runner
must apply them as a superuser/owner while the *app* connects as a less-privileged role.

### T2 — Selfhost entrypoint app
Replace the placeholder: `apps/selfhost/src/index.ts` loads config (a directory of mapping JSONs
under `/data/config/`, same `parseMappingConfig` schema), runs T1 migrations, registers every
mapping with `InProcessScheduler` (croner + single-flight, already built), runs the worker's
existing multi-domain orchestration (`runAllDomains` pattern from `apps/worker/src/index.ts` —
extract/share it, don't fork it), and exposes `GET /status` + `GET /healthz` on localhost
(per-mapping/per-domain: last run, counts, errors, sync freshness — from `MigrationStatusStore`,
which already exists). Graceful shutdown finishes the in-flight folder and persists cursors.
**Acceptance:** unit tests for config-dir loading + status shape; integration: start against the
bundled Postgres + Stalwart, two scheduled passes occur idempotently, `SIGTERM` mid-pass →
restart → no duplicates, cursor advanced.

### T3 — All-in-one packaging (bundled Postgres)
`deploy/selfhost/`: `compose.yml` with **two services** — `postgres` (small, `POSTGRES_*` from
env-file, `/data/pgdata` volume, healthcheck) and `app` (the selfhost image, `depends_on` postgres
healthy, restart policy, healthcheck on `/healthz`, `/data/config` + `/data` mounted). App
`DATABASE_URL` points at the bundled Postgres. Dockerfile: multi-stage, Node 24-slim, non-root
user. CI job builds **amd64+arm64** via buildx (Spark runner verifies native arm64). Base images
digest-pinned; document `stable`/`edge` channels (§22.1) even if only `edge` publishes for now.
**Acceptance:** compose up on x64 CI and on the Spark (arm64) both reach healthy; app waits for
Postgres and self-migrates; a demo `mapping.json` runs a first shadow pass; `/status` reflects it.

### T4 — Secrets & config for self-host
`.env`-file pattern (compose `env_file:`) for the token/password env names the mapping schema
already references (`tokenFromEnv`/`passwordFromEnv` — the seam exists) plus the bundled
`POSTGRES_PASSWORD`. Document file permissions (600), rotation, and the ADR-0020 recovery story
(ledger loss ≠ data loss: reindex rebuilds from the target). Optional age-encryption (§7.3)
documented as a pattern, not a dependency.
**Acceptance:** bundle runs with secrets supplied only via env-file; no secret appears in image
layers, logs, or `/status` output (asserted in a test).

### T5 — Restart-resume idempotency gate (acceptance centerpiece)
A black-box integration/e2e test against the running compose stack: seed a source (Stalwart),
run one pass, `docker restart` the app mid/after a pass, run again → **zero duplicates, cursor
advanced, target state identical** (§5 "intermittently-on host resumes cleanly"). Wire it into the
e2e workflow against the built image.
**Acceptance:** the restart-resume test is green in the e2e workflow; evidence (counts First N /
restart / Second 0) pasted into this Status block.

### T6 — Quickstart + backup/upgrade docs
`docs/selfhost-quickstart.md`: NAS/Pi/Windows-WSL2 walkthrough (ADR-0019: container-first; Windows
via Docker Desktop/WSL2 works today) — from `mapping.json` to first shadow pass to reading
`/status`. Backup guidance per §22.1 (**back up the `/data` Postgres volume before upgrade**; use
`pg_dump` for a portable dump; never run two app versions against one DB) and the upgrade path
(pull new tag → restart → migrations auto-run under the lock). Note the ADR-0023 footprint
trade-off (a Postgres container vs the old embedded-SQLite idea) so self-hosters know why.
**Acceptance:** a fresh reader executes the quickstart on one target platform end-to-end;
docs-hygiene green; README links it.

## Conventions & gotchas
- **No managed leakage:** anything Trigger.dev/vault/IdP/billing-shaped in this path violates hard
  rule 5 — keep a compile-time check that `apps/selfhost` imports no `@trigger.dev/*` and no
  billing modules. (RLS is not needed here — single tenant.)
- **Postgres on NAS:** the `/data/pgdata` volume must be a **local** volume; document that network
  filesystems (SMB/NFS) are unsupported for the DB (corruption risk).
- **Migrator vs app roles:** the migration runner (T1) applies `CREATE ROLE`/RLS migrations as
  owner; for self-host the app can connect as owner too (single tenant, RLS unused) — but keep the
  runner/app connection seam so the managed edition (0011) can use a restricted `app_user`.
- Keep the image lean (no imapsync/vdirsyncer/rclone binaries by default — JS-native paths from
  0002/0007 are the default engines per ADR-0019; shell-out engines are opt-in docs).
- New tests follow the `*.unit.test.ts` / `*.integration.test.ts` naming; Stalwart rules per
  `docs/stalwart-integration-fix.md`.
