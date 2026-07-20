# Workplan 0011 T7 — App-tier Dockerfiles + live compose verification (handoff)

**Status:** draft images + env wiring prepared on `feat/0011-t7-dockerfiles-prep`;
**not verified** on a Docker host (the authoring environment has no Docker runtime).
This note is the ground truth for whoever finishes T7.

## What T7 still needs (the Definition-of-Done gate)
`docker compose -f deploy/compose/managed.yml up` from clean → the two-tenant DoD
journey is possible; runbook commands verified by execution (see
`docs/operator-runbook.md`).

Blocking pieces:
1. **App-tier images build and run** — `apps/api`, `apps/worker`, `apps/web`
   Dockerfiles (drafted here, unverified).
2. **Trigger.dev** — pin the self-host image to a version matching
   `@trigger.dev/sdk` (currently **v4** in `apps/worker`), and reconcile the T3
   jobs still importing `@trigger.dev/sdk/v3`. Decide how the worker image runs
   under the v4 task model (deploy tasks vs. long-lived process).
3. **Live journey** — seed (`pnpm --filter @openmig/api seed:managed`), sign in as
   each demo tenant (paste the printed JWT into the web login), create a mapping,
   run a shadow sync via Trigger.dev, watch ledger-derived status, generate an
   invoice, pay via Mollie test mode, confirm the webhook flips it to `paid`.

## What's already prepared on this branch
- **Draft Dockerfiles** (`apps/{api,worker,web}/Dockerfile`) + root `.dockerignore`.
- **`SECRET_ENCRYPTION_KEY`** wired into `managed.yml` (api + worker) and
  `managed.env.example` — required now that create-mapping encrypts credentials.

## Known issues to resolve in the drafts (do not trust blindly)
- **Runtime = tsx, not tsc→node.** The `@openmig/*` packages ship TypeScript
  source (`package.json` "main"/"exports" → `src/*.ts`; no JS build step), so the
  api/worker images run `tsx src/index.ts`. If you want lean prod images, add a
  real build (tsup/esbuild bundle, or `tsc -b` across packages) and switch the
  CMD to `node`. The current drafts copy the whole `/app` (incl. dev deps) — not
  lean, but preserves pnpm's symlink layout. Leaning this out is a follow-up.
- **Web build-time env.** Vite bakes `VITE_*` at build time. `managed.yml` passes
  `VITE_API_URL`/`VITE_AUTH_URL` as **runtime** env on the `web` service, which a
  static nginx build ignores. Either pass them as Docker **build args** (the draft
  exposes them) and set at build, or switch to runtime config injection
  (e.g. an `env.js` templated at container start). Reconcile with `managed.yml`.
- **Trigger.dev image tag** is still `latest` in `managed.yml` — pin it, and
  settle the v3/v4 SDK mismatch (noted inline in `managed.yml`).
- **Migrations on an existing volume.** Migrations auto-apply only on an empty
  Postgres volume (`/docker-entrypoint-initdb.d`). For upgrades, run the migration
  step explicitly before starting the app tier (see the operator runbook).

## Verification steps (on a Docker host — amd64 and the Spark arm64)
1. `cp deploy/compose/managed.env.example deploy/compose/.env` and fill secrets
   (incl. `SECRET_ENCRYPTION_KEY=$(openssl rand -hex 32)`).
2. `docker compose -f deploy/compose/managed.yml build` — all three images build.
3. `docker compose -f deploy/compose/managed.yml up -d` — postgres healthy →
   trigger.dev up → api/worker/web healthy.
4. Seed + click the DoD journey; paste evidence (counts, invoice→paid) into the
   0011 workplan Status block.
5. Build multi-arch (amd64+arm64) per §22.1; digest-pin base images.

## Docker hygiene (AGENTS.md)
One Stalwart container per data volume; `--rm` on manual debug runs; clean up
`docker ps -a | grep -i stalwart` + volumes at the end.
