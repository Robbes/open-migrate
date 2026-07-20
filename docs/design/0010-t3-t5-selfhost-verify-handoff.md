# Workplan 0010 T3 verify + T5 restart-resume — Docker-host handoff

**Status:** the self-host packaging (T3) is **scaffolded and gate-green** on
`feat/0010-t3-packaging` (PR #62, stacked on #61 = T1+T2) but **not verified on a
Docker host** — the authoring environment has no Docker runtime. This note is the
ground truth for whoever finishes T3's live verification and implements **T5**,
the restart-resume idempotency gate that is the 0010 acceptance centerpiece.

Work on `feat/0010-t5-selfhost-restart-resume` (branched from the T3 branch, so
you have `deploy/selfhost/` + the appliance image + the T1/T2 entrypoint).

## Read first
- `docs/workplans/0010-selfhost-edition.md` — the plan (Definition of Done, T3/T5).
- `AGENTS.md` — hard rule 5 (no managed leakage) + Docker hygiene (Stalwart cleanup).
- `docs/stalwart-integration-fix.md` — the **authoritative** Stalwart harness
  (pinned `stalwartlabs/stalwart:v0.16.10`, two-phase startup). Do not deviate.
- ADR-0023 (Postgres-only, both editions) — do **not** reintroduce SQLite.

## What already exists (don't rebuild)
- `deploy/selfhost/compose.yml` — bundled `postgres:18-alpine` + `app` (the
  appliance). App self-migrates on startup under the advisory lock (T1).
- `apps/selfhost/Dockerfile` — Node 24-slim, non-root, runs the T2 entrypoint
  under `tsx`. `HEALTHCHECK` on `/healthz`.
- `deploy/selfhost/selfhost.env.example`, `config/mapping.json.example`, `README.md`.
- `apps/selfhost/src/no-managed-leakage.unit.test.ts` — the hard-rule-5 graph
  guard (keep it green; if you add imports to the selfhost graph, it enforces
  no `@trigger.dev`/billing/Mollie sneaks in).

## Part 1 — T3 live verification (make the bundle real)
1. **Build both arches.** `docker buildx build --platform linux/amd64,linux/arm64
   -f apps/selfhost/Dockerfile .` — resolve any build breakage. Verify native
   arm64 on the Spark runner. The `pnpm --filter … exec tsx` CMD must actually
   launch `start()` (the entrypoint's `import.meta.url === argv[1]` CLI guard
   must fire under that invocation — confirm it does, adjust the CMD if not).
2. **Compose up, clean host.** `cp deploy/selfhost/selfhost.env.example
   deploy/selfhost/.env` (set `POSTGRES_PASSWORD`), drop a real
   `deploy/selfhost/config/mapping.json` pointed at the Stalwart test target, then
   `docker compose -f deploy/selfhost/compose.yml up -d`. Postgres healthy → app
   applies migrations → app healthy (`/healthz` 200).
3. **First pass reflected.** A demo mapping runs a first shadow pass; `curl
   http://127.0.0.1:8080/status` shows per-domain state (counts, freshness,
   errors verbatim). Paste the counts into the 0010 Status block (T3 row).
4. **Digest-pin the base image** (§22.1): replace the `node:24-slim` /
   `postgres:18-alpine` tags with `@sha256:…` digests once resolved on the host.
   Document the `stable`/`edge` publish (only `edge` need publish for now).

## Part 2 — T5 restart-resume idempotency gate (the acceptance centerpiece)
A **black-box** e2e against the running compose stack (new `*.e2e.test.ts`; the
`e2e` vitest project globs `**/*.e2e.test.ts`, and there are none yet):

1. Seed a source (Stalwart) with a known set of items across the domains the
   mapping enables.
2. Run **one pass** to the target. Record `created = N` from `/status` (or the
   ledger).
3. `docker compose -f deploy/selfhost/compose.yml restart app` — mid-pass or
   right after — to simulate the intermittently-on host (§5).
4. Run a **second pass**. Assert: **`created = 0` (zero duplicates), cursor
   advanced, target state byte-identical** to after pass 1. This is the property
   that must hold; a non-zero second-pass create count is a failure, not a flake.
5. Wire it into `.github/workflows/e2e.yml` (the manual, self-hosted Spark
   workflow — do **not** add it to the automated CI chain; it needs Docker +
   Stalwart). Follow the existing pattern (fresh volumes via `down -v`, attach
   runner to the compose network, `pnpm test:e2e`).
6. Paste the evidence — **First N / restart / Second 0** — into the 0010 Status
   block (T5 row), and flip T3 + T5 to ✅ Done with the pasted counts.

## Constraints / gotchas
- **Hard rule 5:** the appliance loads no Trigger.dev/billing. The guard test
  enforces the import graph; keep it green.
- **DB volume must be local** — never SMB/NFS (compose comment says so).
- **Downgrade guard:** never run an older app image against a newer DB — the
  startup runner refuses it (§22.1). Test the upgrade path is pull→up→auto-migrate.
- **Docker hygiene (AGENTS.md):** one Stalwart container per data volume, `--rm`
  on manual debug runs, clean up `docker ps -a | grep -i stalwart` + volumes at
  the end.
- Keep the image lean-ish but **JS-native engines only** (no imapsync/vdirsyncer/
  rclone binaries — ADR-0019).

## Gates before PR
`pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration` green, plus
the new e2e green on the Spark runner (evidence pasted into the workplan).
