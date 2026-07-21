# Self-host quickstart (NAS / mini-PC / Raspberry Pi / Windows-WSL2)

The self-host edition is a **single-tenant appliance**: one small bundled
Postgres + one app container that migrates itself on startup, discovers what a
new mapping will move, waits for you to review and confirm it, then runs on an
in-process schedule and serves a local status endpoint. It runs **all four
domains** (mail / calendar / contacts / files) with the same engines as the
managed edition, and loads **none** of the managed-only machinery (no Trigger.dev,
no billing). Container-first per **ADR-0019**; Postgres-backed per **ADR-0023**.

> **Footprint note (ADR-0023).** Earlier designs imagined an embedded SQLite file.
> Both editions now standardise on Postgres, and the appliance bundles a small
> Postgres container. That costs ~a few hundred MB of RAM over a file, in exchange
> for one storage engine, one migration path, and the RLS option the managed
> edition needs. The "no container / embedded Postgres" path is parked as future
> work, not this bundle.

## What you need

- A host with **Docker + Docker Compose v2** on a **local disk** (see the warning
  below). ~1 GB RAM free is comfortable.
- Works on:
  - **Linux NAS / mini-PC** (Synology, Unraid, a spare box) — native `amd64`.
  - **Raspberry Pi 4/5 or other arm64 SBC** — the image is multi-arch (`arm64`).
  - **Windows** via **Docker Desktop / WSL2** — supported today.
- Source/target credentials (e.g. an app password or OAuth token for the source
  mailbox, a password for the JMAP/DAV target).

> ⚠️ **The Postgres data volume must be on a LOCAL filesystem.** Never place it on
> a network share (SMB/NFS) — Postgres can corrupt on network filesystems. On a
> NAS, use a local SSD/HDD volume, not a mounted share.

## 1. Get the compose files

Clone the repo (or copy the `deploy/selfhost/` directory and the source it
builds from) onto the host:

```sh
git clone https://github.com/robbes/open-migrate.git
cd open-migrate
```

## 2. Configure secrets

```sh
cp deploy/selfhost/selfhost.env.example deploy/selfhost/.env
chmod 600 deploy/selfhost/.env          # keep secrets readable only by you
```

Edit `deploy/selfhost/.env`:

- **`POSTGRES_PASSWORD`** — required; the stack refuses to start without it.
  Generate one: `openssl rand -hex 24`.
- **Credential variables** — your mapping references secrets by **env var name**
  (`tokenFromEnv` / `passwordFromEnv`), never inline. Add those variables here,
  e.g. `SOURCE_OAUTH_TOKEN=…`, `TARGET_JMAP_PASSWORD=…`, and match the names in
  your mapping (step 3).
- Optional: `SELFHOST_BIND` (default `127.0.0.1` — localhost only; set to
  `0.0.0.0` to reach `/status` from the LAN, behind your own firewall),
  `SELFHOST_PORT` (default `8080`), `SELFHOST_IMAGE` (pin to a `stable` tag or a
  digest for production — see **Upgrades** below).

`.env` is git-ignored; never commit a filled-in copy.

## 3. Add a mapping

Every `*.json` under `deploy/selfhost/config/` is loaded and scheduled on
startup (files ending in `.example` are ignored). Start from the template:

```sh
cp deploy/selfhost/config/mapping.json.example \
   deploy/selfhost/config/mapping.json
```

Edit `mapping.json` — set the source/target hosts and users, point
`tokenFromEnv` / `passwordFromEnv` at the variable names you defined in `.env`,
and set a `schedule.cron` (default is every 15 min). The mail domain uses the
top-level `source`/`target`; to also sync calendar/contacts/files, add a
`domains` block (see `packages/shared/src/config.ts` for the schema). Invalid or
duplicate-`mappingId` files fail fast on startup with the offending path.

## 4. Start it

```sh
docker compose -f deploy/selfhost/compose.yml up -d
```

Postgres comes up and passes its healthcheck → the app applies the ledger
migrations under an advisory lock → the app becomes healthy. Check it:

```sh
curl -s http://127.0.0.1:8080/healthz          # {"status":"ok"}
docker compose -f deploy/selfhost/compose.yml logs -f app
```

A new mapping loads **paused** — it is not scheduled yet. In the background the
appliance runs a read-only, body-free **discovery** pass against your source
(counting mailboxes/messages, calendars/events, address books/contacts,
drives/files — never fetching content) and stores the counts.

## 5. Review & confirm

Open `http://127.0.0.1:8080/` in a browser (or over the LAN if you set
`SELFHOST_BIND=0.0.0.0`). For each configured mapping you'll see the discovery
counts as they land, next to the scope manifest — what migrates, what's
partial, and what's explicitly **not** migrated (SAD §11.2, "no silent
omissions"). Nothing has been copied yet. Once you're satisfied, click
**Start migration** — this flips the mapping `paused`→`active` and the
in-process scheduler picks it up on its normal cron from then on.

The same information is available as JSON, if you'd rather script it:

```sh
curl -s http://127.0.0.1:8080/scope-manifest | jq   # what migrates / partial / does not
curl -s http://127.0.0.1:8080/discovery | jq         # per-mapping discovery counts
curl -si -X POST http://127.0.0.1:8080/mappings/<mappingId>/start   # green light
```

`POST /mappings/:id/start` is idempotent (a second click on an already-active
mapping is a no-op) and refuses with `409` once the mapping has moved on to
`cutover`/`done`.

The first scheduled pass after confirming is a **shadow pass**: it reads the
source and writes to the target idempotently. Re-runs converge — nothing is
duplicated.

## 6. Read `/status`

```sh
curl -s http://127.0.0.1:8080/status | jq
```

You get per-mapping, per-domain state derived from the ledger: `state`
(pending/in_progress/completed/failed/skipped), `itemsSynced`, `itemsFailed`,
`bytesTransferred`, `lastSyncedAt`, and `lastError` **verbatim** when a domain
failed (nothing is masked). `/status` only ever surfaces those fields — it never
echoes your config or credentials.

## Backup (do this before every upgrade)

The Postgres volume is the appliance's state (the ledger + cursors). Back it up
with a portable dump:

```sh
docker compose -f deploy/selfhost/compose.yml exec postgres \
  pg_dump -U openmigrate -d openmigrate > openmigrate-$(date +%F).sql
```

Keep the dump off the host. Restore into a fresh volume with `psql` if needed.

> **Recovery (ADR-0020): ledger loss ≠ data loss.** The ledger records what was
> migrated; the migrated data lives on the **target**. If you lose the ledger,
> a reindex rebuilds it from the target and the next pass resumes correctly —
> you don't re-copy everything. Still, backing up the volume saves that rework.

## Upgrades

The appliance is safe to upgrade in place:

```sh
# 1. BACK UP the volume first (above).
# 2. Pin/pull the new image (edit SELFHOST_IMAGE in .env, or pull the tag).
docker compose -f deploy/selfhost/compose.yml pull app
# 3. Recreate — migrations auto-apply under the advisory lock on startup.
docker compose -f deploy/selfhost/compose.yml up -d
```

Rules of the road (§22.1):

- **Never run two app versions against one database.** Bring the old one down
  before the new one up (compose `up -d` recreates in place, which is fine).
- **No downgrades.** If you start an app image **older** than the DB schema, the
  startup runner **refuses to start** (the downgrade guard) rather than risk the
  data — roll forward, or restore the matching backup.
- **Channels.** `edge` is the rolling build from `main` (good for trying it);
  `stable` is a promoted release. Pin production to a `stable` tag or an
  immutable `sha256` digest so upgrades are deliberate.

## Stopping / removing

```sh
docker compose -f deploy/selfhost/compose.yml down          # stop, keep data
docker compose -f deploy/selfhost/compose.yml down -v       # ALSO delete the DB volume
```

## Troubleshooting

- **App unhealthy / restarts:** `… logs app`. A bad `mapping.json` prints the
  offending path; a source/target auth failure shows up as a domain `lastError`
  in `/status`.
- **`POSTGRES_PASSWORD` error on `up`:** it's unset in `.env`.
- **Can't reach `/status` from another machine:** it binds to localhost by
  default — set `SELFHOST_BIND=0.0.0.0` (and firewall it).

See also: `deploy/selfhost/README.md` (file layout + channels) and
`docs/workplans/0010-selfhost-edition.md` (design + acceptance).
