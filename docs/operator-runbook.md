# Operator Runbook — Managed Edition

Operational procedures for whoever runs the **managed** control plane (the multi-tenant service),
as distinct from a self-host owner running the single-tenant appliance (see the future
`selfhost-quickstart.md`). Stack definition: [`deploy/compose/managed.yml`](../deploy/compose/managed.yml).

> **Scope & honesty note (workplan 0011 T7, updated 2026-07-23).** `apps/{api,worker,web}/Dockerfile`
> exist and `managed.yml` builds all three from them (no more "run from source" workaround needed).
> `worker` runs `apps/worker/src/managed-scheduler.ts`, a DB-polling scheduler — not the real
> Trigger.dev v4 task model yet (that still needs a `trigger.config.ts` + `trigger deploy` step).
> **Not yet verified end-to-end against a live Docker host** — see the 0011 workplan T7 Status block
> for exactly what has and hasn't been run. Update this note once someone with Docker access confirms
> the full clean-`up` → DoD-journey run and pastes the evidence into that Status block.

## What the operator can and cannot see

This is a core promise of the architecture (SAD §17, §17.1), not just a policy:

- **Can see:** job **status** and **metadata** — run state, counts, byte totals, errors, sync
  freshness, tenant/mapping ids, addresses and folder names. Note that even metadata (addresses,
  folder names) is **personal data** under GDPR (§17 metadata nuance); handle it accordingly.
- **Cannot see:** **message/file content.** The engines move data directly source → target;
  content never flows through the orchestrator or the control-plane DB. Never add a code path that
  routes content through Trigger.dev payloads or logs (AGENTS.md §12/§17; job payloads carry **ids
  only**).
- **Roles** (§4/§17): tenant **admin** (controller), **operator** (processor — status/ops, no
  content), **support** (read-only status/logs, no content). The operator role must never gain a
  content path.

## Prerequisites

- Docker + Docker Compose v2 on the host.
- A filled-in env file. Copy the template and edit every `change-me*` value:
  ```
  cp deploy/compose/managed.env.example deploy/compose/.env
  # edit deploy/compose/.env — set strong POSTGRES_PASSWORD, APP_DB_PASSWORD,
  # JWT_SECRET, and the TRIGGER_* secrets. Never commit the filled-in file.
  ```
  Compose auto-loads `.env` from the compose file's directory. To keep it elsewhere, pass
  `--env-file <path>`.

### The two database roles (why there are two DB URLs)

Migration `0009` creates a **non-owner `app_user`** role. RLS is enforced through it:

- `DATABASE_URL` → the DB **owner** (`POSTGRES_USER`). In the postgres image the bootstrap user is a
  **superuser**, which **bypasses RLS even under FORCE**. Used only for **migrations** and the
  **demo seed** — never for the request path.
- `APP_DATABASE_URL` → the **`app_user`** role. The API and worker connect through this for all
  tenant data, so row-level security is always in force (workplan 0011 T1). If you ever point the
  app at the owner URL, tenant isolation silently disappears — don't.

Change `APP_DB_PASSWORD` from the migration default (`app_password`) before any real deployment, and
rotate it in the DB (`ALTER ROLE app_user PASSWORD …`) to match.

## Start / stop

```bash
cd deploy/compose

# Start the infrastructure services.
docker compose -f managed.yml up -d postgres trigger-db trigger-redis trigger-api

# Migrations: applied automatically on first Postgres init from
# packages/ledger/migrations (mounted at /docker-entrypoint-initdb.d). This runs
# ONLY on an empty data volume. For an existing volume, apply new migrations with
# the migration runner / your migration step before starting the app (§22.1).

# Bring up the app tier (builds apps/{api,worker,web}/Dockerfile):
docker compose -f managed.yml up -d --build api worker web

# Status / logs (status only — no content is ever logged):
docker compose -f managed.yml ps
docker compose -f managed.yml logs -f api worker

# Stop (keep data):
docker compose -f managed.yml stop
# Tear down (KEEP volumes):
docker compose -f managed.yml down
# Tear down and DELETE all data (destructive):
docker compose -f managed.yml down -v
```

### Alternative: run apps from source (no image build)

To iterate without rebuilding images, run the three app services from source against the compose
Postgres (the DB port is published on `POSTGRES_PORT`, default 5432):

```bash
export DATABASE_URL="postgres://openmigrate:<POSTGRES_PASSWORD>@localhost:5432/openmigrate"
export APP_DATABASE_URL="postgres://app_user:<APP_DB_PASSWORD>@localhost:5432/openmigrate"
export JWT_SECRET="<same value as in .env>"
pnpm --filter @openmig/api dev       # API on :3001
pnpm --filter @openmig/web dev       # Web (Vite) dev server
pnpm --filter @openmig/worker dev    # Worker
```

## Seed a demo (two-tenant DoD journey)

Seeds two demo tenants — each with an owner, a source/target connection, mailboxes, and a mapping —
and prints a **demo owner JWT** for each (there is no password-login endpoint yet; auth is
bearer-token only). Idempotent: safe to re-run (see the script's header for the one exception —
credential rotation).

The demo tenants point at a **real backend** (not fake config) so a shadow pass can actually
complete instead of failing at "no credentials configured": Tenant A syncs mail against a demo
Stalwart, Tenant B syncs calendar/contact/file against a demo Nextcloud. Provision that backend
first:

```bash
# 1. Bring up Postgres + the demo Nextcloud (part of managed.yml):
docker compose -f managed.yml up -d postgres nextcloud

# 2. Provision the demo mail (Stalwart) + DAV (Nextcloud) accounts. Requires stalwart-cli
#    on PATH (see deploy/selfhost/setup-stalwart.sh's header for the install command).
./setup-managed-demo.sh

# 3. Seed the two demo tenants, pointed at the accounts setup-managed-demo.sh just created.
#    Runs as the DB owner (bypasses RLS to create tenants); JWT_SECRET and
#    SECRET_ENCRYPTION_KEY must match the API/worker's .env values.
DATABASE_URL="postgres://openmigrate:<POSTGRES_PASSWORD>@localhost:5432/openmigrate" \
JWT_SECRET="<same value as in .env>" \
SECRET_ENCRYPTION_KEY="<same value as in .env>" \
pnpm --filter @openmig/api seed:managed

# 4. Bring up the rest of the stack — the worker's managed-scheduler.ts polls
#    mailbox_mapping and starts running the seeded mappings' sync passes within
#    its poll interval (60s default):
docker compose -f managed.yml up -d --build api worker web
```

Use each printed token as `Authorization: Bearer <token>` against the API, or drop it into the web
app's stored auth token, to sign in as that tenant. The **cross-tenant check** is the acceptance
centerpiece: tenant B's token must never read or affect tenant A's data through any path — verified
at the SQL layer (RLS) and the HTTP layer (the T1/T2 integration tests).

## Backup & restore (§22.1)

**Back up the control-plane DB before every migration/upgrade.** Schema rollback is hard —
we prefer roll-forward + backups.

```bash
# Logical backup (portable):
docker compose -f managed.yml exec -T postgres \
  pg_dump -U openmigrate -d openmigrate --format=custom > backup-$(date +%F).dump

# Restore into a fresh DB:
docker compose -f managed.yml exec -T postgres \
  pg_restore -U openmigrate -d openmigrate --clean --if-exists < backup-YYYY-MM-DD.dump
```

Notes:
- The ledger is a **rebuildable cache** (ADR-0020): even without a ledger backup, a reindex/adopt
  from the target rehydrates idempotency state. Back up the DB anyway — it also holds tenant,
  member, mapping, billing, and audit rows that are not derivable from the target.
- Never run two app versions against one DB (§22.1). Migrate, verify, then deploy.

## Upgrade

1. Back up the DB (above).
2. Pull the new images / new code.
3. Apply migrations as a **gated step** — run and verify before/with the deploy (§22.1). Migrations
   are linear and idempotent; a runner applies only unapplied versions.
4. Start the new app tier; watch health checks and per-tenant run success.
5. Roll-forward preferred; if a release misbehaves, restore from backup rather than reversing schema.

## Tenant offboarding (GDPR right to erasure, §17)

Erasure = **revoke access, then purge data + ledger + logs** for that tenant.

1. **Revoke access.** With local JWTs there is no server-side session to kill, so:
   - Rotate `JWT_SECRET` to invalidate all outstanding tokens (affects every tenant — prefer
     short token lifetimes; see the seam for per-tenant/JWKS revocation when SSO lands), **or**
   - Suspend the tenant: set `tenant.status = 'suspended'` and `tenant_member.status = 'suspended'`
     so the app rejects the tenant even with a valid token.
2. **Purge.** Delete the tenant row; `ON DELETE CASCADE` removes all tenant-scoped rows
   (connections, mailboxes, mappings, items, runs, events, usage, invoices, payment methods, audit
   log). Because RLS is tenant-scoped, do this as the owner with the tenant context set, or via a
   dedicated purge routine. Verify zero residual rows for the tenant id across tenant-scoped tables.
3. **Logs.** Ensure no content was ever logged (it isn't, by design); purge status/metadata logs
   that reference the tenant per your retention policy. Metadata is personal data too.
4. **Record** the erasure in your DPA/audit process (operator = processor).

> A dedicated, audited purge endpoint/job is the correct home for steps 1–3; until it exists,
> perform them deliberately as the DB owner and record what was purged.

## Health & troubleshooting

- **API/worker won't connect / RLS errors on every query:** confirm `APP_DATABASE_URL` is set and
  points at `app_user` (not the owner), and that migration `0009` ran (the role exists).
- **"fail-closed" errors with no tenant context:** expected when a query runs without
  `app.current_tenant` set — that's RLS doing its job, not a bug. The request path must go through
  `withTenantDb`/`withTenant`.
- **Seed prints tokens but sign-in fails:** `JWT_SECRET` used by the seed must equal the API's.
- **Trigger.dev:** the self-host image tag is currently `latest` (placeholder) and the T3 jobs
  import the v3 SDK path while the dep is v4 — reconcile before wiring live tasks (noted in
  `managed.yml`).

## Related docs

- Architecture (source of truth): [`architecture/solution-architecture.md`](./architecture/solution-architecture.md) — §4 roles, §16 cost drivers, §17 security/GDPR, §22.1 releases.
- RLS details: [`rls-guide.md`](./rls-guide.md).
- Workplan: [`workplans/0011-managed-edition-hardening.md`](./workplans/0011-managed-edition-hardening.md) (T7).
- Deployment overview: [`deployment.md`](./deployment.md).
