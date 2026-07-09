# Workplan 0010 — Self-host edition: a runnable single-tenant bundle (NAS / mini-PC / Pi)

## Status — 2026-07-09 (update this block at the end of every session)

| Task | Status | Evidence |
|---|---|---|
| T1 SQLite parity gates (property tests on SQLite) | ⬜ Pending | — |
| T2 startup migration runner (locked, both dialects) | ⬜ Pending | — |
| T3 selfhost entrypoint app | ⬜ Pending | — |
| T4 all-in-one packaging (compose + multi-arch image) | ⬜ Pending | — |
| T5 secrets & config for self-host | ⬜ Pending | — |
| T6 quickstart + backup/upgrade docs | ⬜ Pending | — |

> Read `AGENTS.md` and the arch doc first (§7.1 self-host edition, §22.1 releases/migrations,
> ADR-0010 persistence, ADR-0019 packaging, ADR-0020 rebuildable ledger). **Depends on:** 0007
> (unified sync — the bundle should ship all domains; a mail-only bundle is an acceptable
> intermediate if 0007 lags). **Hard rule 5 is the soul of this plan:** no managed-only
> dependency may leak into this path.

## Why this slice
"Self-host must keep working" is a hard rule, but today the self-host edition **does not exist as
a runnable thing**: `apps/selfhost/src/index.ts` is a one-line placeholder
(`export const app = '@openmig/selfhost';`), `SqliteLedger` exists but no integration gate proves
it equivalent to Postgres, migrations don't run on startup, and there is no packaging a NAS/Pi
owner could actually deploy. Everything proven so far runs through dev-stack scripts.

## Definition of Done (the gate)
On a clean machine (amd64 **and** arm64): `docker compose -f deploy/selfhost/compose.yml up -d`
brings up one container that (a) applies ledger migrations to an embedded SQLite under a mounted
`/data` volume, (b) schedules the configured mappings with the in-process croner scheduler,
(c) serves a local status endpoint, and (d) after `docker restart` **resumes incrementally from
cursors with zero duplicates** — the idempotency property test run as a black box against the
container. `pnpm` gates green; the kill-and-restart test is the acceptance centerpiece (§5:
"intermittently-on host resumes cleanly").

## In scope
- SQLite as a first-class ledger backend, gated by the same property tests as Postgres.
- Startup migration runner (Postgres advisory lock / SQLite file lock; refuses to start when the
  DB schema is newer than the app — §22.1).
- A real `apps/selfhost` entrypoint composing existing pieces: config load → migrations →
  `InProcessScheduler` → unified sync passes → status endpoint.
- Docker packaging: one image, multi-arch (amd64+arm64), compose file, pinned digests; `stable`
  tag convention per §22.1 (signing/SBOM wiring exists in CI security scan — align, don't
  duplicate).
- Self-host secrets: env-file based, documented; no vault dependency.

## Out of scope (later)
- Home Assistant add-on and the hybrid agent (§7.1) — after the compose path is proven.
- Tauri tray app / Windows-native (§25.3, ADR-0019) — container-first stands.
- Web UI inside the bundle beyond a status endpoint — blocked on the 0006-G framework decision;
  the entrypoint must leave an obvious mount point for it.
- Multi-tenancy anything (managed edition is 0011).

## Tasks

### T1 — SQLite parity gates
Parametrize the ledger + shadow-pass + reindex integration suites over **both** backends
(Postgres via Testcontainers as today; SQLite via a temp file — no container needed). Fix
whatever divergence surfaces (`packages/ledger/src/sqlite-ledger.ts` and `schema-sqlite.ts` have
never been integration-gated; expect dialect drift vs `0001_init.sql`, e.g. upsert/returning
semantics and the 0007 `item_type` migration).
**Acceptance:** the same property tests (idempotency, delta, lost-ledger reindex, cursor
persistence) green on both dialects in `pnpm test:integration`.

### T2 — Startup migration runner
A small runner in `packages/ledger` (used by selfhost + worker): enumerate `migrations/*.sql`,
apply linearly under a lock (PG advisory lock / SQLite exclusive file lock), record applied
versions, **refuse to start** if the DB reports a newer version than the binary supports
(§22.1); idempotent re-run is a no-op. Skipping versions (N-2 → N) supported by linear
application.
**Acceptance:** §22.1's own CI gates implemented as tests — fresh-install both dialects,
re-run no-op, concurrent double-start applies once (two processes, one lock winner),
newer-schema refusal path.

### T3 — Selfhost entrypoint app
Replace the placeholder: `apps/selfhost/src/index.ts` loads config (a directory of mapping JSONs
under `/data/config/`, same `parseMappingConfig` schema), runs T2 migrations, registers every
mapping with `InProcessScheduler` (croner + single-flight, already built), exposes
`GET /status` + `GET /healthz` on localhost (per-mapping: last run, counts, errors, sync
freshness — derived from ledger/run data per §19). Graceful shutdown finishes the in-flight
folder and persists cursors.
**Acceptance:** unit tests for config-dir loading + status shape; integration: start against
Stalwart, two scheduled passes occur idempotently (reuse the 0001 T6 pattern), `SIGTERM`
mid-pass → restart → no duplicates, cursor advanced.

### T4 — All-in-one packaging
`deploy/selfhost/`: Dockerfile (multi-stage, Node 24-slim, non-root user, `/data` volume) +
`compose.yml` (one service, restart policy, healthcheck on `/healthz`) + CI job building
**amd64+arm64** via buildx (Spark runner covers native arm64 verification). Image digest-pinned
base; document the `stable`/`edge` channel intent (§22.1) even if only `edge` publishes for now.
**Acceptance:** compose up on x64 CI and on the Spark (arm64) both reach healthy; the DoD
kill-and-restart black-box test runs in the e2e workflow against the built image.

### T5 — Secrets & config for self-host
`.env`-file pattern (compose `env_file:`) for the token/password env names the mapping schema
already references (`tokenFromEnv`/`passwordFromEnv` — the seam exists); document permissions
(600), rotation, and the ADR-0020 recovery story (ledger loss ≠ data loss: reindex rebuilds).
Optional age-encryption (§7.3) documented as a pattern, not a dependency.
**Acceptance:** bundle runs with secrets supplied only via env-file; no secret appears in image
layers, logs, or `/status` output (asserted in a test).

### T6 — Quickstart + backup/upgrade docs
`docs/selfhost-quickstart.md`: NAS/Pi/Windows-WSL2 walkthrough (ADR-0019: container-first;
Windows via Docker Desktop/WSL2 works today) — from `mapping.json` to first shadow pass to
reading `/status`. Backup guidance per §22.1 (back up `/data` before upgrade; never two app
versions on one DB) and the upgrade path (pull new tag → restart → migrations auto-run).
**Acceptance:** a fresh reader executes the quickstart on one target platform end-to-end;
docs-hygiene green; README links it.

## Conventions & gotchas
- **No managed leakage:** anything Trigger.dev/RLS/vault-shaped in this path violates hard rule
  5 — the compile-time check is that `apps/selfhost` imports no `@trigger.dev/*` and no RLS
  helpers.
- SQLite lives on NAS filesystems in practice: WAL mode + busy-timeout explicitly set; document
  that network filesystems (SMB/NFS) are unsupported for the DB file (corruption risk) — `/data`
  must be a local volume.
- Keep the image lean (no imapsync/vdirsyncer/rclone binaries by default — the JS-native paths
  from 0002/0007 are the default engines per ADR-0019; shell-out engines are opt-in docs).
- New tests follow the 0006-A naming; Stalwart rules per `docs/stalwart-integration-fix.md`.
