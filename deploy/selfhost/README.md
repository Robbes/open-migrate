# Self-host appliance (`deploy/selfhost/`)

A single-tenant bundle for a NAS / mini-PC / Pi: a small **bundled Postgres** +
one **app** container that migrates itself on startup, schedules your mappings
with an in-process scheduler, and serves a local status endpoint. No Trigger.dev,
no billing — hard rule 5 (see `docs/workplans/0010-selfhost-edition.md`).

## Quick start

```sh
cp deploy/selfhost/selfhost.env.example deploy/selfhost/.env
chmod 600 deploy/selfhost/.env                       # then set POSTGRES_PASSWORD + creds
cp deploy/selfhost/config/mapping.json.example \
   deploy/selfhost/config/mapping.json               # then edit (one file per mapping)
docker compose -f deploy/selfhost/compose.yml up -d
curl -s http://127.0.0.1:8080/status | jq            # per-domain state
```

The full NAS/Pi/WSL2 walkthrough, backup, and upgrade guidance live in
`docs/selfhost-quickstart.md` (workplan T6).

## Files

| Path | What |
|---|---|
| `compose.yml` | The two-service stack (bundled Postgres + app). |
| `selfhost.env.example` | Env template — copy to `.env`, `chmod 600`. |
| `config/*.json` | Your mapping configs (each is scheduled). `*.example` is ignored. |
| `../../apps/selfhost/Dockerfile` | The app image (source-ships-TS, runs under `tsx`). |

## Image channels (§22.1)

Two rolling tags are published to the container registry:

- **`edge`** — built from `main` on every merge. What the example env pins by
  default; fine for trying the appliance, not for unattended production.
- **`stable`** — a promoted release. Pin your production `.env` to a `stable`
  tag, or to an immutable `sha256` **digest**, so an upgrade is a deliberate act:
  `SELFHOST_IMAGE=ghcr.io/robbes/open-migrate-selfhost:stable`.

Always **back up the `/data` Postgres volume before upgrading**, and never run
two app versions against one database (the startup downgrade guard refuses a
binary older than the DB schema — §22.1). Upgrade = pull the new tag → `up -d` →
migrations auto-apply under the advisory lock.

> **DB volume must be local.** Never place the Postgres volume on a network
> filesystem (SMB/NFS) — corruption risk. Use a local disk/SSD on the host.
