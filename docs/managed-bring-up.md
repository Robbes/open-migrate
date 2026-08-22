# Managed edition: bringing it up on a new machine

The managed edition is a **multi-tenant service**: Postgres behind PgBouncer, a
self-hosted **Trigger.dev** instance that is the one execution plane, the API,
the web app, and the tasks in `apps/worker` deployed onto Trigger.dev. It has
been stood up by hand more than once, each time from notes that were slightly
out of date. This document is those notes, kept next to the script that
executes them.

- **The script:** [`deploy/compose/bootstrap-managed.sh`](../deploy/compose/bootstrap-managed.sh)
- **This document:** the same steps in prose, with every dashboard screen
  written out, what "it worked" looks like at each step, and a failure table.

Read the two together. The script refuses rather than guesses, and every
refusal it prints names the section here that explains it.

---

## The one thing that cannot be automated

The self-hosted Trigger.dev webapp signs you in by **magic link** and exposes
**no admin API**. Creating the account, the organisation and the project is a
human at a browser, and no version of this script removes that.

What the script does instead is make it the *only* human step:

| Step | Who |
| --- | --- |
| Generate every secret, pin the image architecture | script |
| Bring up Postgres, create the pooler's lookup role, bring up PgBouncer | script |
| Bring up the whole Trigger.dev plane and wait for health | script |
| **Find the magic link in the logs** | script (`trigger-magic-link.sh`) |
| **Open it, name an organisation, name a project** | **you** |
| Read the project ref and production key back out of the instance | script (`trigger-credentials.sh`) |
| Log the deploy CLI in (opens a browser) | you, one command |
| Build and start the API and web app | script |
| Upload the task runtime environment, deploy the tasks | script |
| Prove an enqueue becomes a runner on this machine | script (`smoke-managed.sh`) |

Two of those are yours. Everything else is one command.

---

## Cutting over from the pre-rename stack (one time, ADR-0040)

The product was renamed, and with it the compose project, container, network and
volume names (`open-migrate-*` → `ownpace-*`). **Docker does not follow a rename.**
Bringing the new stack up next to an old one gives you a second, empty set of
volumes while the old data sits there dangling — the stack looks freshly broken
rather than un-migrated, which is the confusing failure this section exists to
prevent.

Deleting the checkout is **not** what does it: the state lives in Docker, not in
the working tree.

```bash
# 1. Tear the OLD project down WITH its volumes. This destroys its data — that is
#    the point, and it is only correct because nothing live is running.
docker compose -p open-migrate-managed down -v --remove-orphans
docker compose -p open-migrate-selfhost down -v --remove-orphans   # if present

# 2. `container_name:` is a fixed string, so `-p` never namespaced these. Any that
#    survived step 1 would collide with the new stack by name.
docker rm -f open-migrate-db open-migrate-pgbouncer open-migrate-api \
             open-migrate-web open-migrate-nextcloud \
             open-migrate-selfhost-db open-migrate-selfhost-app 2>/dev/null || true

# 3. The demo Stalwart is created by `docker run` (setup-stalwart.sh — it cannot
#    be a compose service, see that script's header), so it is NOT in the compose
#    project and `down -v` structurally cannot see it. It is also what keeps the
#    old network alive: step 1 reports "Resource is still in use" because this
#    container is still attached to it.
docker ps -a --filter network=open-migrate-managed_open-migrate-network --format '{{.Names}}'
docker rm -f open-migrate-stalwart 2>/dev/null || true
docker network rm open-migrate-managed_open-migrate-network 2>/dev/null || true

# 4. Its volumes are outside compose for the same reason. Three naming generations
#    exist on a long-lived box, as those defaults drifted:
docker volume rm $(docker volume ls -q --filter name=open-migrate-stalwart) 2>/dev/null || true

# 5. Confirm nothing is left holding the old name before you bring the new one up.
docker ps -a      --filter name=open-migrate --format '{{.Names}}'
docker volume ls  --filter name=open-migrate
docker network ls --filter name=open-migrate
```

**Do not delete `openmig-dev-stalwart*`.** That is the dev/e2e Stalwart instance,
named after the package scope rather than the product, so it is deliberately
untouched by the rename and is still in use.

**Do NOT delete `~/.persistent/open-migrate-managed`.** It holds the stack's `.env`
— including `SECRET_ENCRYPTION_KEY`, the key that decrypts every stored credential
in the database — and `pgbouncer/userlist.txt`. It lives outside the checkout
precisely so `actions/checkout`'s clean cannot reach it, which also means nothing
else will recreate it. **Move it:**

```bash
mv ~/.persistent/open-migrate-managed ~/.persistent/ownpace-managed
```

If the repository variable **`MANAGED_ENV_PERSIST_DIR`** is set explicitly, it
overrides the workflow default and still points at the old path — update it in
GitHub → Settings → Variables, or the nightly e2e restores `.env` from a directory
that is no longer there.

The Trigger.dev platform containers (`trigger-db`, `trigger-api`, `trigger-tls`, …)
are **not** product-named and keep their names; nothing above touches them.


## Before you start

**Host**

- Linux with **Docker** and **Docker Compose v2** (`docker compose version`).
- **Node 22+** and **pnpm** (the seed, the deploy CLI and the smoke run on the
  host, not in a container).
- `openssl`, `curl`, `git`.
- **~15 GB free disk.** ClickHouse, MinIO, the Trigger.dev images, the task
  registry and the built API/web images add up; running out midway leaves a
  stack that is partly built and wholly confusing.
- The repository cloned, and `pnpm install --frozen-lockfile` done.

**Architecture.** `DEPLOY_IMAGE_PLATFORM` decides what the task images are
built for, **server-side** — there is no CLI flag. Get it wrong and every task
run dies at `exec` in under a second with `AutoRemove` deleting the evidence.
`managed.env.example` ships `linux/amd64`, so on an **arm64 box the shipped
default is wrong**. The script fixes this for you from `uname -m`; it is
mentioned here because it is the single setting whose failure looks like
nothing at all.

**Ports** published on the host, all overridable in `.env`:

| Port | Service | Notes |
| --- | --- | --- |
| 3001 | API | `API_PORT` |
| 3123 | web | `WEB_PORT` |
| 5432 | Postgres | `POSTGRES_PORT` — the host-run seed and migrations need it |
| 3090 | Trigger.dev API (http) | `TRIGGER_PORT` — what the **deploy CLI** talks to |
| 3443 | Trigger.dev dashboard (https) | `TRIGGER_TLS_PORT` — what your **browser** talks to |
| 5000 | task image registry | `REGISTRY_PORT`, bound to loopback |
| 8083 | Nextcloud | demo backend only |

PgBouncer is deliberately **not** published: it is reached over the compose
network by name. That is why anything running on the host (the seed, the
migrations) connects to `postgres:5432`'s published port directly.

**Addressing the dashboard.** `TRIGGER_TLS_HOST=localhost` (the default) means
the dashboard is usable **only from the machine itself**. The dashboard's
session cookie is `Secure` in production mode, so plain http works from
localhost and nowhere else — which is why the `trigger-tls` service exists.
To reach it from your laptop, before the `trigger` phase set:

```bash
./deploy/compose/env-upsert.sh deploy/compose/.env \
  TRIGGER_TLS_HOST=10.0.0.5 \
  TRIGGER_APP_ORIGIN=https://10.0.0.5:3443 \
  TRIGGER_LOGIN_ORIGIN=https://10.0.0.5:3443
```

Leave `TRIGGER_API_ORIGIN=http://localhost:3090` alone. The deploy CLI follows
the server-advertised API origin and must not meet a self-signed certificate on
the way — when it did, deploys died with a bare `Connection error`.

---

## The short version

```bash
git clone … && cd Ownpace
pnpm install --frozen-lockfile

./deploy/compose/bootstrap-managed.sh          # creates .env, then stops
#   … read deploy/compose/.env and make the decisions in it …
./deploy/compose/bootstrap-managed.sh --from data
#   … create the organisation and project in the dashboard …
./deploy/compose/bootstrap-managed.sh --from account
#   … one `npx trigger.dev login` when it asks …
./deploy/compose/bootstrap-managed.sh --from login
```

Three stops on a brand-new machine, and the first of them goes away with
`--accept-defaults` on a throwaway demo box.

Add `--with-demo` on a demo box or a CI runner: it provisions the demo mail and
DAV backends, seeds two demo tenants, and runs the live smoke at the end. **A
real deployment must not use it** — it creates tenants with fixed credentials
that are published in this repository.

The script exits **2**, not 1, when it is waiting for you, and prints the exact
command to resume with. Re-running it from the top is always safe: every phase
checks whether it is already done.

---

## The long version, phase by phase

`./deploy/compose/bootstrap-managed.sh --list` prints them in order. Any phase
can be run alone with `--only <phase>`, or resumed from with `--from <phase>`.

### 1. `preflight` — the tools, and the one setting that cannot be fixed later

Checks Docker, Compose v2, Node, pnpm, `openssl`, `curl`, that the daemon is
reachable and that `node_modules` exists, and warns below 15 GB free.

**Verify:** it prints the versions it found. Nothing is started yet.

### 2. `env` — `deploy/compose/.env`

Creates `.env` from `managed.env.example` if it is missing (mode `600`), then
runs [`ensure-env-secrets.sh`](../deploy/compose/ensure-env-secrets.sh), which
generates every missing secret — `JWT_SECRET`, `SECRET_ENCRYPTION_KEY`, the
five Trigger.dev secrets, `PGBOUNCER_AUTH_PASSWORD` — and writes
`pgbouncer/userlist.txt`. It is idempotent: a value you already set is never
rotated. Then it pins `DEPLOY_IMAGE_PLATFORM` to this host's architecture.

**What it will not decide for you.** It *reports* these and moves on:

- `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `CLICKHOUSE_PASSWORD`,
  `MINIO_ROOT_PASSWORD`, `NEXTCLOUD_ADMIN_PASSWORD` still at their shipped
  defaults. Fine for a demo box on localhost; not fine for anything a customer
  reaches. **Change them before the `data` phase** — changing
  `POSTGRES_PASSWORD` after the volume exists does not change the password
  inside it.
- `CORS_ORIGIN` / `WEB_URL` / `API_URL`. On a real deployment these are the
  public https addresses. `API_URL` is where **Mollie's servers** deliver
  payment webhooks: with `MOLLIE_API_KEY` set, the API refuses to boot in
  production on a localhost `API_URL`, because the alternative is payments
  that complete while invoices never leave `sent`.
- `PRICING_*` — integer **cents**, never euros. They are a template for *new*
  tenants; each tenant's agreed prices are pinned in the `tenant_pricing` table
  the first time their money is computed and never follow this file again. That
  table is created by the MANAGED migration chain (ADR-0036), which the API
  applies after the shared one — an appliance applies only the shared chain and
  has no such table.
- `SMTP_*` / `NOTIFY_*` — set them all or none. Half-set, the channel stays off
  and names what is missing.
- `OAUTH2_*` — only for a stack with a Microsoft Graph source or 0028's drift
  detector. An IMAP-only stack needs none of it.

Edit `.env` by hand, or use
[`env-upsert.sh`](../deploy/compose/env-upsert.sh), which replaces a key where
it already sits instead of appending a second copy of it:

```bash
./deploy/compose/env-upsert.sh deploy/compose/.env POSTGRES_PASSWORD=…
```

It refuses a value containing whitespace, a quote, `$`, a backtick or a
backslash. That is not fussiness: every consumer of this file reads it with
`set -a; . .env`, so such a value is re-interpreted by a shell, and compose's
own parser would disagree about what happened.

**It stops here the first time.** The file has just been created, so none of
those decisions has been made — and the next phase creates the Postgres volume,
after which changing `POSTGRES_PASSWORD` in this file changes nothing at all
while the stack looks configured and fails to authenticate. Read the file,
then resume with `--from data`. On a throwaway demo box where the shipped
values are the right answer, `--accept-defaults` removes the pause.

**Verify:** `grep -c '=.' deploy/compose/.env`, and that
`deploy/compose/pgbouncer/userlist.txt` exists.

**Never commit `.env`.**

### 3. `data` — Postgres, the pooler's lookup role, PgBouncer

```bash
docker compose -f deploy/compose/managed.yml up -d --wait postgres
PGOPTIONS="-c my.pw=$PGBOUNCER_AUTH_PASSWORD" \
  docker compose -f deploy/compose/managed.yml exec -T postgres \
  psql -U openmigrate -d openmigrate -f - < deploy/compose/pgbouncer/setup-auth.sql
docker compose -f deploy/compose/managed.yml up -d --wait pgbouncer
```

**The order is the whole point.** PgBouncer's healthcheck authenticates as
`pgbouncer_auth`, and that role is created by `setup-auth.sql`, which needs
Postgres up. Bring both up together on a fresh box and it hangs at the
healthcheck complaining about a password, when the cause is a role that does
not exist yet.

**Verify:**

```bash
docker compose -f deploy/compose/managed.yml exec -T pgbouncer \
  psql "postgresql://pgbouncer_auth:${PGBOUNCER_AUTH_PASSWORD}@127.0.0.1:6432/pgbouncer" -tAc "SHOW POOLS"
```

Anything back, containing `transaction`, is the pooler serving in the right
mode.

### 4. `demo` — the demo backends and the two demo tenants *(only with `--with-demo`)*

Runs [`setup-managed-demo.sh`](../deploy/compose/setup-managed-demo.sh) — real
Stalwart (IMAP source, JMAP target) and real Nextcloud (CalDAV/CardDAV/WebDAV)
— then the seed:

```bash
DATABASE_URL=postgresql://…@localhost:5432/openmigrate \
DIRECT_DATABASE_URL=… JWT_SECRET=… SECRET_ENCRYPTION_KEY=… \
  ./deploy/compose/seed-managed.sh
```

Those exports matter. The seed runs **on the host** and inherits nothing;
nothing in `apps/api` loads a dotenv file. It also runs the migrations itself —
**both chains**, shared then managed (ADR-0036), each advisory-locked under its
own key, so racing an API boot is safe — which is why the schema exists before
the API has ever started. The order is not a preference: every table in the
managed chain references `public.tenant`.

**Verify:** the seed prints two demo owner tokens. Re-running it is a no-op.

### 5. `trigger` — the Trigger.dev plane

Brings up `trigger-db`, `trigger-redis`, `clickhouse`, `minio`,
`trigger-registry`, `trigger-docker-proxy`, `trigger-api`, `trigger-tls`,
`trigger-supervisor` and waits for all of them to be **healthy**, not merely
started.

**Verify:** `curl -fsS http://localhost:3090 -o /dev/null && echo up`

### 6. `account` — **your turn**

If `.env` already has `TRIGGER_PROJECT_REF` and `TRIGGER_SECRET_KEY`, this
phase does nothing. If the project exists on the instance but `.env` is behind
(a re-clone, a rotated file), the script reads them back and carries on. Only
if the instance genuinely has no project does it stop, and then:

1. **Open the dashboard** — `TRIGGER_APP_ORIGIN` from `.env`, by default
   <https://localhost:3443>. It serves a **self-signed certificate**. Accept
   the browser warning; this is the `trigger-tls` front, and it exists because
   the dashboard's session cookie is `Secure` in production mode.

2. **Type the email address** the account should belong to and press
   **Continue**. No mail is sent — there is no mail server — so the sign-in
   link goes to the log instead.

3. **Fetch the link:**

   ```bash
   ./deploy/compose/trigger-magic-link.sh
   ```

   Open it **in the same browser**. Links are single-use and short-lived; if
   one is spent, ask the dashboard for another and run the command again — it
   always prints the newest. `--all` prints every link still in the log buffer.

   *If it finds nothing*, you have almost certainly not done step 2 yet: the
   link is only written when one is requested. That is not a broken stack.

4. **Name an organisation**, then **name a project**. Both are yours to choose
   and nothing in this repository depends on either. (Suggestion:
   organisation `Ownpace`, project `ownpace`.)

5. **Do not hand-copy anything.** Resume:

   ```bash
   ./deploy/compose/bootstrap-managed.sh --from account
   ```

   [`trigger-credentials.sh`](../deploy/compose/trigger-credentials.sh) reads
   the `proj_…` ref and the **production** `tr_prod_…` key straight out of the
   instance, checks the shape of both, writes them with `env-upsert.sh`, and
   restarts the API so it picks the key up.

   It introspects the Trigger.dev schema before querying it and **refuses**
   rather than guessing if the shape is not the one it knows — that schema
   belongs to Trigger.dev and can change under a version bump. Every refusal
   prints the two dashboard pages to read instead: **Project → Settings** for
   the ref, **Project → API keys → the PROD environment** for the key. A `dev`
   key is refused on purpose: it is personal to a CLI session and would not
   work from a container.

   If the instance holds several projects it will not choose for you —
   re-run it with `--project <name>`.

> The `tr_prod_` key is a credential. Treat this script's output like the
> `.env` it is destined for; do not paste a run of it into an issue.

### 7. `login` — the deploy CLI, once per machine

The CLI version is read from `@trigger.dev/sdk` in `apps/worker/package.json`,
so there is one version number and it lives where it already lived.

```bash
npx -y trigger.dev@<version> login -a http://localhost:3090 --profile openmig
```

The script prints the exact line with the version filled in and stops, because
the command opens a browser and waits for you. Note the address is the plain
**http api origin**, not the https front.

**Verify:** `npx -y trigger.dev@<version> whoami --profile openmig`

### 8. `app` — API and web

`docker compose up -d --build --wait`, with `GIT_SHA` passed so `GET /version`
reports a commit rather than `unknown`. The API runs both migration chains at
boot (ADR-0036), shared first.

Without `--with-demo` the services are **named explicitly** rather than swept
up, so a bare `up` does not start Nextcloud — whose admin password is
`change-me-nextcloud-admin` by default.

**Verify:**

```bash
curl -fsS http://localhost:3001/health && curl -fsS http://localhost:3001/version
```

### 8b. Sign-in — the identity provider *(optional, but the paste box is the alternative)*

Not a `bootstrap-managed.sh` phase, and deliberately separate: a stack is
usable without it, and skipping it leaves exactly the sign-in that existed
before ([ADR-0042](./adr/0042-who-holds-the-passwords.md)) — the owner mints a
token with the seed script and whoever needs one pastes it into `/login`.

To have real accounts instead:

```bash
./deploy/compose/setup-zitadel.sh
```

It generates the provider's own secrets, starts it against the existing
Postgres, waits for it to be healthy, creates the project and a **public**
client (authorization-code + PKCE, no client secret — this is a browser app,
and a secret shipped to every visitor is not a secret), and writes
`JWT_ISSUER`, `JWT_AUDIENCE` and the two `VITE_OIDC_*` values back into
`deploy/compose/.env`. Re-running it is safe; it adopts what already exists.

**Then restart the API and REBUILD the web app, or nothing changes.** The API
only needs the new environment; the web app bakes `VITE_*` in at build time, so
a container built before the script ran has no issuer in its bundle and still
renders the paste box. The script prints these two lines when it finishes:

```bash
docker compose -f deploy/compose/managed.yml up -d --force-recreate api
docker compose -f deploy/compose/managed.yml up -d --build web
```

**Verify** — `/login` shows a *Sign in* button rather than only a token box,
and the round trip ends on the dashboard:

```bash
curl -fsS "$(grep '^JWT_ISSUER=' deploy/compose/.env | cut -d= -f2-)/.well-known/openid-configuration" | head -c 200
```

The API reads the key-set URL from that document rather than composing one, and
the browser reads its endpoints from the same place — which is what makes the
provider a component rather than a foundation. Replacing it is `JWT_ISSUER` +
`JWT_AUDIENCE` + `VITE_OIDC_*` pointed somewhere else and a rebuild; two tests
fail if that stops being true.

> **The issuer's address ends up inside every token.** `ZITADEL_EXTERNALDOMAIN`
> is what the provider stamps as `iss`, and the API compares it byte for byte.
> Changing the address later invalidates every live session — it belongs with
> the other browser-visible addresses in `.env`, decided once.

### 8c. Somebody who can answer the door *(needed before anybody can be let in)*

Also not a `bootstrap-managed.sh` phase. `access_request` is written by
strangers and readable by nobody until an **operator** exists (workplan 0093
T6) — so a deployment with no operators has a queue nobody can read and a
front door that only records knocks.

An operator is identified by their OIDC **subject**, not their email, and there
is no way to know it before they have signed in once. So:

1. Sign in at `/login` (§8b) — this creates the account in the provider.
2. Ask the API who you are:

```bash
curl -fsS -H "Authorization: Bearer <token>" http://localhost:3001/api/me
```

3. Take the `userId` from that answer and appoint it, over the **owner**
   connection — `app_user` cannot write this table, which is the point of it:

```bash
DATABASE_URL="$(grep '^DATABASE_URL=' deploy/compose/.env | cut -d= -f2-)"   pnpm --filter @openmig/api operator:add <userId> you@example.com "first operator"
```

`operator:list` shows who can currently answer; `operator:remove <userId>` takes
it away. Adding somebody twice updates their row rather than failing, so a typo
is fixed by re-running.

**Why not an email address, and why not a screen.** Keying the appointment on an
email would mean whoever can register that address becomes an operator. Making
it a route would mean an operator could appoint another one — and then the owner
is no longer the one deciding who decides. It is three steps because each of the
shorter versions gives something away.

**Verify** — the queue answers, and answers only for them:

```bash
curl -fsS -H "Authorization: Bearer <token>" http://localhost:3001/api/access-requests
```

Once appointed, signing in again lands the operator on **Access requests** in
the web app (workplan 0093 T7), which is the same queue with buttons on it.

Granting is `POST /api/access-requests/<id>/grant`, which creates the
organisation and invites the asker as its owner; they become a real member the
first time they sign in, provided the identity provider asserts
`email_verified` for their address. Declining is the same shape and provisions
nothing. Neither can be undone by deleting the row: nobody has DELETE on that
table, so a decision stays on the record.

### 8d. The status page *(optional, comes up with the stack)*

`gatus` is in `managed.yml` and starts with everything else (workplan 0094). It
listens on `STATUS_PORT` (default `3124`); put it behind the reverse proxy at
`status.<your domain>` alongside the app.

```bash
docker compose -f deploy/compose/managed.yml up -d gatus
curl -fsS "http://localhost:${STATUS_PORT:-3124}/health"
```

**Read [`status-page.md`](./status-page.md) before you trust a green light.**
This page runs INSIDE the stack it watches, so it cannot tell you the stack is
down — when the box is off, the page is off. It answers three narrower questions
honestly: is a provider down (the usual cause of a stalled migration), is part
of Ownpace unwell while the rest serves, and was there an outage recently. The
page says this itself, in the button beside its heading.

What it watches is `deploy/compose/gatus.yaml` — in git, reviewed, and edited
with a restart rather than through a web console.

### 9. `tasks` — the task environment, then the deploy

```bash
./deploy/compose/set-task-env.sh
./deploy/compose/deploy-tasks.sh
```

**Deploying to a non-production environment.** One Trigger instance can serve a test stack and a
production stack side by side — a project has several environments, and each has its own secret
key, its own deployed task version and its own runs. To move a stack onto one of them:

1. **Take that environment's key** from the dashboard (project → API keys) and put it in
   `deploy/compose/.env` as `TRIGGER_SECRET_KEY`. This is the key the **api** enqueues with.
2. **Set `TRIGGER_ENV`** in the same file to that environment's name (`prod` is the default).
   This is what the **deploy** targets.
3. **Restart the api** so it picks up the new key:
   `docker compose -f deploy/compose/managed.yml up -d api`
4. **Re-upload the task environment variables**, which are stored per environment and do not
   follow the key: `./deploy/compose/set-task-env.sh`
5. **Re-deploy the tasks**: `./deploy/compose/deploy-tasks.sh`

Steps 1 and 2 must name the **same** environment. If they disagree, nothing errors — the deploy
succeeds, the enqueue succeeds, and the runs simply never meet a deployed task, leaving a queue
that grows beside a dashboard that looks idle. `deploy-tasks.sh` refuses the two combinations
that are unambiguously that mistake; it cannot catch every one, because only the `tr_prod_` key
prefix is known here.

Step 4 is the one most easily forgotten, and its failure is the one the script's own header
already warns about: *"a task that lands before its environment exists runs once against no
database and fails in a way that reads like a broken task."*


**Environment before deploy, deliberately.** Task containers inherit
**nothing** from compose: a run gets only what the Trigger.dev platform stores
for the project's environment. `set-task-env.sh` uploads `DATABASE_URL`,
`APP_DATABASE_URL`, `DIRECT_DATABASE_URL`, `SECRET_ENCRYPTION_KEY` and the
optional `OAUTH2_*` / `SMTP_*` / `NOTIFY_*` from `.env`, with `override: true`
so a stale dashboard value cannot win over a rotated file. The addresses it
uploads are **in-network** (`pgbouncer:6432`, `postgres:5432`), because runners
join the compose network — `localhost` there would point a task at itself.

`deploy-tasks.sh` re-checks the architecture and refuses on a mismatch, then
deploys. **Re-run it after every `git pull` that touches `apps/worker`.**

**Verify:** the dashboard's Deployments page lists the tasks. That is
registration, not execution — see the next phase for the difference.

### 10. `smoke` — the only proof that counts

```bash
./deploy/compose/smoke-managed.sh
```

Mints a seeded-member token, runs a verify to a terminal state and an apply to
`applied` or `refused` (a refusal is a legitimate pass — the gates said no and
said why), and captures runner logs live, because `AutoRemove` destroys them at
exit.

Only runs with `--with-demo`: it drives the demo tenants. A green CI says
nothing about whether an enqueue becomes a runner container **on this machine**
— that lesson cost a whole bring-up session, and this is the step that answers
it.

> Runner debug logs print the **full task environment** — `DATABASE_URL`,
> `SECRET_ENCRYPTION_KEY`, the `tr_prod_` key. The smoke's evidence file is
> secret-bearing by construction. `deploy/compose/redact-evidence.sh` cleans it
> before anything is uploaded anywhere.

---

## The CI runner is a different checkout from wherever you did this by hand

If you brought the stack up manually — following this document, on this same
machine — **that checkout and the CI runner's checkout are not the same
directory**, even on a self-hosted runner. `actions/checkout` clones into its
own workspace (typically `<runner>/_work/<repo>/<repo>`), and `deploy/compose/.env`
in your manual clone does nothing for a workflow running from there.

Worse: `actions/checkout` defaults to `clean: true`, which runs `git clean
-ffdx` before every checkout — the `-x` reaches gitignored files, `.env`
among them. So even hand-placing `.env` in the runner's checkout once does
not survive the *next* run. `e2e-managed.yml` now works around this by
persisting the one-time setup **outside** any checkout — at
`$MANAGED_ENV_PERSIST_DIR` (default `~/.persistent/ownpace-managed` on
the runner, overridable as a repository variable) — and restoring it into
the checkout at the start of every run, before the refuse-early check.

**Because `docker compose -f deploy/compose/managed.yml` pins its project
name, the containers are the same regardless of which checkout ran the
command that created them.** So if you already have a working manual stack,
the one-time setup for CI is not a second bring-up — it is copying your
already-correct `.env` into the persist directory:

```bash
mkdir -p ~/.persistent/ownpace-managed
cp deploy/compose/.env ~/.persistent/ownpace-managed/.env
cp deploy/compose/pgbouncer/userlist.txt ~/.persistent/ownpace-managed/userlist.txt
```

**Do not run a fresh `bootstrap-managed.sh` or `ensure-env-secrets.sh` in the
CI checkout to "set it up independently.**" It would generate different
random secrets for the *same*, pinned-name containers your manual checkout
is already using — the same class of outage as rotating
`TRIGGER_ENCRYPTION_KEY` without a plan, self-inflicted on a stack that was
just proven working. Reuse what already works; only generate fresh secrets
when there is no working stack yet at all.

**The deploy CLI's login is the same gap, one phase later — and it has a
better answer than restoring a session file.** `deploy` reads
`TRIGGER_ACCESS_TOKEN` directly, before ever touching a profile file, and
this is the CLI's *own* documented answer for CI: unable to run the
interactive flow, it throws

> Authentication required in CI environment. Please set the
> TRIGGER_ACCESS_TOKEN environment variable with a Personal Access Token.

**Preferred**, one-time, in the GitHub UI: mint a token at the self-hosted
instance's own dashboard — *Account → Personal Access Tokens* — or reuse an
existing `tr_pat_…` from `${XDG_CONFIG_HOME:-$HOME/.config}/trigger/config.json`
if you already have one. Then, in the repository: **Settings → Secrets and
variables → Actions → New repository secret**, named `TRIGGER_ACCESS_TOKEN`.
`e2e-managed.yml` also sets `TRIGGER_API_URL` alongside it — required,
because unset, the CLI's env-var login path defaults to the SAAS cloud
(`api.trigger.dev`), not this instance.

**Fallback, if you would rather not mint a token:** the session file still
gets restored the same way `.env` does —

```bash
mkdir -p ~/.persistent/ownpace-managed
cp "${XDG_CONFIG_HOME:-$HOME/.config}/trigger/config.json" \
   ~/.persistent/ownpace-managed/trigger-cli-config.json
```

— though note `whoami` structurally cannot see `TRIGGER_ACCESS_TOKEN` (it
never reads that variable, only `deploy` does), so a manual bring-up that
sets the token will still print "not logged in" from `whoami` even though
`deploy` works fine. That asymmetry is the CLI's, not this repo's.

Neither path makes the login *itself* automatable — creating the account
and project is still the one step that opens a browser (0084 T6). Both only
let a credential obtained once survive to the next run.

## When it goes wrong

| What you see | What it is | What to do |
| --- | --- | --- |
| `pgbouncer` logs `could not open auth_file … Permission denied`, then `no such user: pgbouncer_auth` | `userlist.txt` was written 0600 by the host user; PgBouncer reads it as a different user inside the container, finds no users, and rejects every login | `chmod 644 deploy/compose/pgbouncer/userlist.txt`, then force-recreate. `ensure-env-secrets.sh` now writes 644 and `--only data` repairs the mode |
| The seed or a host-run script talks to the wrong Postgres | On a shared host, `localhost:5432` may belong to something else entirely — this stack's Postgres is published wherever `POSTGRES_PORT` says | The `demo` phase asks `docker compose port postgres 5432` rather than trusting a default. For your own commands, do the same |
| `deploy-tasks.sh` proceeds past its own login check and then fails with `Unable to validate existing personal access token` / `Invalid or Missing Access Token` | `whoami` exits 0 whether or not you are actually logged in — confirmed from the CLI's own source, an auth failure returns data rather than throwing. A stale profile (e.g. left over after `reset-trigger.sh`) passes the check and only fails once `deploy` tries to use it | `npx -y trigger.dev@<version> login -a http://localhost:${TRIGGER_PORT:-3090} --profile <profile>`, then re-run. Fixed at the source in `trigger-cli-lib.sh`, which both scripts now use instead of trusting the exit code |
| `deploy-tasks.sh` says **`Not logged in`** while `trigger.dev login` answers **`You are already logged in`** | The instance's database was destroyed (a wipe, `down -v`, a rename cutover) but the CLI profile at `~/.config/trigger/config.json` is on the HOST and survived it. `login` sees a token in the profile and short-circuits without validating it against the instance, so it reports success for a token whose account no longer exists; `trigger_cli_logged_in()` reads `whoami`'s output properly and correctly says no. **`login` alone cannot fix this** — it never gets far enough to replace the token | `npx -y trigger.dev@<version> logout --profile <profile>` **first**, then `login` as above. If `logout` also short-circuits, delete the profile's entry from `~/.config/trigger/config.json` |
| `trigger-supervisor` is `Restarting`, its log says **`Unable to read worker token from file: EACCES … /home/node/shared/worker_token`**, and `up` aborts with `container trigger-supervisor is unhealthy` | trigger-api bootstraps the worker token into the shared volume as **root, mode 0600**; the supervisor reads it as **node**. On a FRESH `trigger_shared` volume — first install, or after a `down -v` — it cannot open its own credential. Everything else reports healthy, so the stack looks fine while dequeuing nothing | `docker exec -u 0 trigger-api chown node:node /home/node/shared/worker_token`, then `docker restart trigger-supervisor`. **chown, not `chmod 644`** — the token is a credential and root bypasses permissions anyway. `bootstrap-managed.sh`'s `trigger` phase now does this between trigger-api and the supervisor, so a fresh volume no longer needs the manual step |
| `set-task-env.sh` fails **`Invalid or Missing API key`** against a `proj_…` ref that looks right | Same cause, other credential: `TRIGGER_PROJECT_REF` and `TRIGGER_SECRET_KEY` in `.env` belong to the destroyed instance. `bootstrap-managed.sh`'s `account` phase **short-circuits when both are already set** (it cannot tell a stale value from a good one), so re-running bring-up never replaces them | `./deploy/compose/trigger-credentials.sh --write` — it reads the ref and the prod key out of the INSTANCE and upserts both, overwriting whatever `.env` held. Then re-run `set-task-env.sh` |
| A config fix to `pgbouncer.ini` seems to change nothing — same error after pulling | `pgbouncer.ini` is a bind mount read once at start-up, and `up -d` does not recreate a container whose spec has not changed, so the old process keeps running the old file | `docker compose -f deploy/compose/managed.yml up -d --force-recreate pgbouncer`. `--only data` now does this automatically when the container is unhealthy |
| `pgbouncer` log says `cannot use the reserved "pgbouncer" database as an auth_dbname` | `auth_user` set in the **global** `[pgbouncer]` section governs the admin console too, and the console's database name is reserved — so `auth_query` cannot run and every connection is refused. A per-database `auth_dbname` does not help: the console is not matched by `*` | Fixed by moving `auth_user` onto the `*` entry, where it applies to real databases only. `auth_dbname` there must equal `POSTGRES_DB`; `--only data` refuses if they disagree |
| `pgbouncer` reports `unhealthy` after ~80s, and its own log says the user is not allowed | The healthcheck reads `SHOW POOLS` from the admin console, which PgBouncer refuses to anyone not in `stats_users`/`admin_users` | Fixed in `pgbouncer/pgbouncer.ini` (`stats_users = pgbouncer_auth`). On an older checkout, pull and `--only data` |
| Any `docker compose` command fails with `required variable X is missing a value` | Compose interpolates the **whole** file before running anything, so one unset variable breaks every command — including ones that never touch the service named in the error. An `.env` that predates the pooler hits this on `PGBOUNCER_AUTH_PASSWORD` | `./deploy/compose/ensure-env-secrets.sh`, then `--only data` to create the matching Postgres role and start the pooler |
| `pgbouncer` never becomes healthy, complains about a password | `setup-auth.sql` has not run, or ran without `my.pw` set | `--only data`. The SQL now refuses an unset `my.pw` rather than creating a role with no password |
| Every app connection: `password authentication failed`, though `.env` and the container agree | A volume from a *different* project — compose's project name derived from the directory basename | `managed.yml` pins `name: ownpace-managed`. Check `docker volume ls` for a stray `compose_postgres_data` |
| `trigger-magic-link.sh` finds nothing | The link is only written when one is **requested** | Submit your email on the dashboard's login page first, then re-run |
| Dashboard loads but the login never completes | `TRIGGER_APP_ORIGIN` / `TRIGGER_LOGIN_ORIGIN` do not match the address the browser is using; the `Secure` cookie is dropped | Set both (and `TRIGGER_TLS_HOST`) to the real address, then `--from trigger` |
| `npx trigger.dev deploy` dies with a bare `Connection error` | The CLI was pointed at the https front | Log in against `http://localhost:3090` |
| `git status` shows `apps/worker/package.json` modified after a deploy | The Trigger.dev CLI rewrites the file — usually only stripping its trailing newline | `git diff` it; discard unless it is a real SDK bump. `deploy-tasks.sh` now says so rather than leaving you to find it |
| `Seed failed: DATABASE_URL (DB owner connection) is required to seed` | The seed runs on the host and inherits nothing; nothing in `apps/api` loads a dotenv file | Use `./deploy/compose/seed-managed.sh`, which reads `.env` and asks compose for the published port |
| Demo owner tokens are rejected by the API | They expire after seven days | Re-run `./deploy/compose/seed-managed.sh` — it is idempotent and mints fresh ones |
| Supervisor loops on `Snapshot changed inside startRunAttempt`, runs pile up `EXECUTING`, runner containers accumulate | Almost certainly **not** about snapshots. Check `docker compose logs trigger-api` for `Unsupported state or unable to authenticate data` at `PrismaSecretStore.getSecrets` — that is `TRIGGER_ENCRYPTION_KEY` no longer matching the stored secrets | See "Rotating `TRIGGER_ENCRYPTION_KEY`" above. `set-task-env.sh` alone does not fix it |
| `set-task-env.sh` fails with a bare `Connection error`, and works when re-run | It was run straight after `trigger-api` was recreated, before the webapp was accepting requests | Nothing — it now waits for the webapp before uploading, and says so |
| A secret in `.env` is a `change-me-…` value and was never generated | `ensure-env-secrets.sh` used to treat any non-empty value as set, so an `.env` copied from an older template kept its shipped placeholders for ever | Re-run `./deploy/compose/ensure-env-secrets.sh` — it now replaces placeholders and prints what to recreate afterwards |
| `--from trigger` refuses with "Trigger.dev version drift" | `TRIGGER_IMAGE_TAG` and `@trigger.dev/sdk` disagree (0018 T0). Unset, the tag falls back to `managed.yml`'s default, which is easy to miss | Set `TRIGGER_IMAGE_TAG` to `v<sdk version>`, or pin the SDK back. The refusal prints both commands |
| The deploy asks "Would you like to apply those updates?" mid-script | `apps/worker/package.json` pins one SDK version and `node_modules` holds another, so the CLI offers to reconcile them — and waits. In CI there is no terminal to answer from | `pnpm install --frozen-lockfile`, then re-run. `deploy-tasks.sh` now refuses up front rather than letting the deploy become interactive |
| The CLI sits at its version banner for tens of minutes | `npx`'s "Ok to proceed?" install prompt, invisible because output is discarded | Every script here uses `npx -y`; if you are running it by hand, do too |
| Task runs die instantly, no logs, runner container gone | `DEPLOY_IMAGE_PLATFORM` does not match the host | Fix it in `.env`, `up -d --force-recreate trigger-api` (it is read server-side), then `--from tasks` |
| Enqueues fail by name; runs land `failed` immediately | `TRIGGER_SECRET_KEY` unset or not a `tr_prod_` key | `--only account`, then `up -d api` |
| Tasks run but cannot reach the database | The task environment was never uploaded, or holds `localhost` | `./deploy/compose/set-task-env.sh`. Values are read at run start; no redeploy needed |
| `trigger-credentials.sh` says the schema is not the one it knows | A Trigger.dev version bump renamed a column | Read the two values from the dashboard by hand; the refusal names both pages |
| Seed fails on `DATABASE_URL … is required` | It is running on the host and inherits nothing | Use the `demo` phase, which exports them from `.env` |

---

## Redoing a rollout somewhere else

The whole configuration is `deploy/compose/.env` plus the two human steps.
On a new machine:

```bash
git clone … && cd Ownpace && pnpm install --frozen-lockfile
./deploy/compose/bootstrap-managed.sh
```

Do **not** copy an old `.env` across wholesale. Copy the *decisions* — prices,
SMTP, OAuth, the public URLs — and let `ensure-env-secrets.sh` mint fresh
secrets. A secret that exists on two machines is a secret that gets rotated on
neither. `TRIGGER_PROJECT_REF` and `TRIGGER_SECRET_KEY` in particular belong to
the *old* instance and are meaningless on the new one; the script will read the
new instance's own.

**Upgrading Trigger.dev** is one number in two places that must agree:
`TRIGGER_IMAGE_TAG` in `.env` and `@trigger.dev/sdk` in
`apps/worker/package.json`. Check both when bumping either — `--from trigger`
refuses when they disagree.

> ⚠️ **Do not upgrade with runs in flight.** Recreating the webapp and
> supervisor under load left the reference deployment looping on
> `Failed to start run … "Snapshot changed inside startRunAttempt"` for every
> run: nothing reached a task body, and the schedule kept adding one run a
> minute on top (2026-08-18). Cancelling the backlog through the API did not
> help — new runs failed identically — so it was the version, not the state.
>
> The order that avoids it:
>
> 1. Stop the schedule producing work, or accept a backlog you will cancel.
> 2. Wait for `TaskRun` to have nothing in `EXECUTING`.
> 3. Change the tag AND the SDK together, `pnpm install`.
> 4. `--from trigger`, then **redeploy the tasks** — an image built by one CLI
>    version and run by another platform version is the same drift by a
>    different route.
> 5. Watch the first few runs reach `COMPLETED_SUCCESSFULLY` before walking
>    away.
>
> Rolling back is the same procedure in reverse, and is the right first move
> when an upgrade goes wrong: the older version has run history behind it and
> the newer one does not.

**Rotating a secret**: change it in `.env`, `docker compose up -d` the affected
services, re-run `set-task-env.sh` if a task variable changed, and re-mint any
JWTs signed with a rotated `JWT_SECRET`. Rotating `SECRET_ENCRYPTION_KEY`
**strands stored connection credentials** — they have to be re-entered.
Rotating `TRIGGER_LOGIN_SECRET` signs everyone out **including the deploy
CLI**, whose stored token then fails with `Unable to validate existing personal
access token — 500`; a `login` fixes it.

### `whoami` says nothing about whether you are logged in

`trigger.dev whoami --profile <name>` **exits 0 regardless of login state.**
Read from the installed CLI's own source (`dist/esm/commands/whoami.js` +
`cli/common.js`): an auth failure returns `{success:false}` as data rather than
throwing, and the CLI's command wrapper only marks the process failed on a
thrown exception. So a script that does

```bash
whoami --profile X >/dev/null 2>&1   # WRONG — 0 either way
```

cannot tell "logged in" from "never logged in" from "token was just revoked".
This bit the `login` phase and `deploy-tasks.sh`'s own preflight the same day,
on the same box: both reported "already logged in" against a profile left over
from before a `reset-trigger.sh`, and the deploy that followed died with

```
Error: Unable to validate existing personal access token
Invalid or Missing Access Token
```

which reads like a broken deployment rather than a login nobody actually did.
`trigger-cli-lib.sh`'s `trigger_cli_logged_in()` is the fix both scripts now
share: run `whoami` for real and look for the `User ID:` line a genuine
successful lookup prints, regardless of exit code. If you ever call the CLI
directly in a script, do the same rather than trusting `$?`.

### Rotating `TRIGGER_ENCRYPTION_KEY`

**Not a normal rotation, and `ensure-env-secrets.sh` refuses to do it for you.**

This key encrypts the Trigger.dev secret store. Changing it does not re-encrypt
anything — it strands every secret written under the old key. The failure is not
at boot; it is every run, at `startRunAttempt`:

```
Error: Unsupported state or unable to authenticate data
  at PrismaSecretStore.getSecrets
  at AuthenticatedWorkerInstance.getEnvVars
  at AuthenticatedWorkerInstance.startRunAttempt
```

which the supervisor reports as `Snapshot changed inside startRunAttempt` —
a message about snapshots with nothing in it about keys. Runs pile up
`EXECUTING`, retry containers accumulate, and nothing reaches a task body.

**Re-running `set-task-env.sh` alone does not cure it**, and the reason is
worth knowing: `envvars.upload(..., { override: true })` **skips a value whose
plaintext has not changed.** Re-encryption requires a re-write, so any variable
whose value happens to be identical is quietly left on the old key — while the
script reports success and lists it among the uploaded names.

On the reference box that was exactly one variable out of four:
`SECRET_ENCRYPTION_KEY`, whose value had not changed while the three database
URLs had. Three readable secrets, one unreadable, every run dead.

Use the force flag, which **deletes** each variable before writing it, so the
write is a creation and cannot be skipped:

```bash
SET_TASK_ENV_FORCE_REWRITE=1 ./deploy/compose/set-task-env.sh
```

**Delete, not overwrite** — and this is the part that costs a round if you get
it wrong. `envvars.upload` *reads* the existing value to decide whether the
write is a no-op, so on a variable it cannot decrypt, the repair fails on the
same error as the fault:

```
[set-task-env] FAILED: Unsupported state or unable to authenticate data
```

Deletion needs no plaintext. To repair a single variable by hand:

```bash
cd apps/worker
TRIGGER_API_URL=http://localhost:3090 TRIGGER_SECRET_KEY=… TRIGGER_PROJECT_REF=… \
  node -e 'require("@trigger.dev/sdk").envvars.del(process.env.TRIGGER_PROJECT_REF, "prod", "SECRET_ENCRYPTION_KEY").then(()=>console.log("deleted"))'
cd .. && ./deploy/compose/set-task-env.sh
```

The order that works:

1. **Before rotating**, list what is in the store:
   `SELECT key, "updatedAt" FROM "SecretStore"` — everything there has to be
   re-creatable, or you cannot rotate without losing it.
2. Drain the queue (nothing in `EXECUTING`) and stop the schedule.
3. Rotate the key, recreate `trigger-api` and `trigger-supervisor`.
4. Re-write every stored secret under the new key —
   `SET_TASK_ENV_FORCE_REWRITE=1 ./deploy/compose/set-task-env.sh` for the task
   environment, and by hand for anything else step 1 found. Then check
   `SELECT key, "updatedAt" FROM "SecretStore"`: **every** row must show a
   timestamp after the rotation. One that does not is one dead run away.
5. Redeploy the tasks and watch the first runs reach a terminal state.

**On a stack whose Trigger.dev data is disposable — which a reference or demo
box usually is — the wipe is faster and more certain than the surgery, and it is
a script because the sequence has two traps:**

```bash
./deploy/compose/reset-trigger.sh --yes
./deploy/compose/bootstrap-managed.sh --from trigger
```

The traps, in case you do it by hand anyway: the volume belongs to **`trigger-db`**,
so stopping only `trigger-api` and `trigger-supervisor` leaves `docker volume rm`
refusing with "volume is in use" — and the bring-up afterwards then quietly
reuses the old database and fails exactly as before. And the stale
`TRIGGER_PROJECT_REF` has to be cleared from `.env`, or the `account` phase sees
it populated, reports "nothing to do", and skips the human step that is now
mandatory.

The reset destroys the orchestration database only. The ledger, tenants,
mappings, items and invoices live in `ownpace-db`, a different volume, and
are untouched; the API and pooler keep serving throughout. You are then back at
the one human step, and `trigger-credentials.sh` reads the new project's
credentials.

**Turning the pooler off** is two values: `DB_HOST=postgres`, `DB_PORT=5432`,
then `up -d`. Every service reads them, so nothing in `managed.yml` is edited.

---

## What this does not cover

- **TLS and a public hostname for the API and web app.** Everything above is
  addressed by IP or `localhost`. A real deployment needs a reverse proxy with
  real certificates in front of ports 3001 and 3123, and `CORS_ORIGIN` /
  `WEB_URL` / `API_URL` set to those addresses.
- **Backups.** Nothing here backs up the Postgres volume — including the
  identity provider's tables, which after 8b hold the only copy of who can sign
  in.
- **Anybody's first account.** `setup-zitadel.sh` stands the provider up; it
  does not create people. Invite-only means the owner does that, and the
  provisioning path for it is workplan 0093 T6, not yet built.
- **The Trigger.dev instance's own upgrade path** between major versions.
- **Bring-up from scratch, tested.** The nightly
  [`e2e-managed.yml`](../.github/workflows/e2e-managed.yml) runs this script
  from the `data` phase against a stack whose Trigger.dev half already exists,
  because tearing that half down would need a person to rebuild it. So the
  phases up to `trigger` are exercised by that gate; `account` and `login` are
  exercised only by somebody doing this on a new machine. If you are that
  person and something here is wrong, fix this document in the same change.

## See also

- [`deployment.md`](./deployment.md) — the editions and what each one is for
- [`operator-runbook.md`](./operator-runbook.md) — running it once it is up
- [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) — symptoms across both editions
- [`rls-guide.md`](./rls-guide.md) — why the app connects as `app_user`
- [`status-page.md`](./status-page.md) — what the status page can and cannot tell you
- [`performance.md`](./performance.md) — the pooler, the rate budget, the tick
