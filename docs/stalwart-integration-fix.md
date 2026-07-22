# Stalwart v0.16.10 Testcontainers Integration — Authoritative Reference

DO NOT deviate from this. DO NOT change the pinned version. DO NOT put accounts/domains/listeners
in config.json. DO NOT skip the shadow-pass tests. Prior sessions repeatedly re-fabricated the
config below; this file is the corrected ground truth.

## Verified Image: stalwartlabs/stalwart:v0.16.10 (official, no custom image needed)

**Finding**: The custom image `stalwart-test-custom:latest` provides NO benefit over the official
image. It was previously thought to contain workarounds for config or listener issues, but those
were solving non-problems. The official image `stalwartlabs/stalwart:v0.16.10` works correctly
when used with the proper two-phase startup pattern.

**Dockerfile inspection** (from prior session):
```
docker inspect stalwart-test-custom:latest --format '{{json .Config.Entrypoint}}'
# Result: [] (no custom entrypoint)
docker inspect stalwart-test-custom:latest --format '{{json .Config.Cmd}}'
# Result: [] (no custom command)
```
The custom image had no special configuration baked in. Switch to the official image.

## config.json — the ENTIRE file, both phases, nothing else
{"@type": "RocksDb", "path": "/opt/stalwart/data"}

The root IS the DataStore object. There is NO dataStore wrapper key. There are NO http / imap /
directory / accessControl / domains / accounts sections. Accounts, domains, and listeners live in
the database and are provisioned via stalwart-cli — never in config.json. Mail listeners
(IMAP/JMAP) start AUTOMATICALLY in normal mode; you do not configure or "create" listener objects.

## Delivery
- config.json: via withCopyContentToContainer (content = the JSON string above, target
  /etc/stalwart/config.json). NEVER a bind mount (bind-mounting a file creates a directory →
  "Is a directory (os error 21)").
- Data dir: a named Docker volume mounted at /var/lib/stalwart (or /opt/stalwart) — a DIFFERENT
  path from the config file. Prefer a named volume over a host bind mount (UID/userns permission
  wall).

## Two-phase startup (required — provisioning and serving cannot share one process)
Phase 1 (provisioning): image stalwartlabs/stalwart:v0.16.10, config.json mounted, data volume,
  STALWART_RECOVERY_MODE=1 + STALWART_RECOVERY_ADMIN=admin:<pw>. Recovery mode exposes only the
  management API (mail listeners suspended). Provision via stalwart-cli, then STOP the container.
Phase 2 (serving): new container, SAME config.json, SAME data volume, NO recovery env vars →
  normal mode → IMAP/JMAP listeners start automatically with the provisioned accounts present.

## Provisioning (stalwart-cli as a HOST binary, not a container)
Install: curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/stalwartlabs/cli/releases/latest/download/stalwart-cli-installer.sh | sh
Run via child_process.execFile against the container's HOST-MAPPED 8080 port, with an explicit
timeout. stalwart-cli speaks only JMAP; there is no /auth/login or /api/v1/* REST API.

apply plan (NDJSON, one object per line, piped to `stalwart-cli apply` via stdin):
{"@type":"upsert","object":"Domain","matchOn":["name"],"value":{"dom-a":{"name":"dev.local"}}}
{"@type":"upsert","object":"Account","matchOn":["name"],"value":{"src":{"@type":"User","name":"source","domainId":"#dom-a","credentials":{"0":{"@type":"Password","secret":"source_password"}},"roles":{"@type":"User"},"permissions":{"@type":"Inherit"},"encryptionAtRest":{"@type":"Disabled"}}}}
{"@type":"upsert","object":"Account","matchOn":["name"],"value":{"tgt":{"@type":"User","name":"target","domainId":"#dom-a","credentials":{"0":{"@type":"Password","secret":"target_password"}},"roles":{"@type":"User"},"permissions":{"@type":"Inherit"},"encryptionAtRest":{"@type":"Disabled"}}}}

Rules: credentials is a MAP keyed by client id, NEVER an array. Credential @type is "Password",
never "AccountPassword". roles/permissions/encryptionAtRest are required. matchOn is ["name"],
never ["emailAddress"]. Cross-refs use "#id" strings. Use upsert (idempotent), never create.

## Postgres
Run the schema migration EXACTLY ONCE in vitest.global-setup.ts (per-file parallel migration causes
23505 catalog unique-violation races).

## CRITICAL: RocksDB Lock Collision Prevention
Stalwart uses RocksDB which permits EXACTLY ONE process per data directory. The following MUST be
observed to prevent "LOCK: Resource temporarily unavailable" errors:

1. **Unique volume per test run**: Use a dynamically-generated volume name
   (e.g., `stalwart-test-<timestamp>-<random>`) instead of a fixed name. Reusing a fixed volume
   name across runs can leave stale LOCK files from previous processes.

2. **Strict Phase 1 → Phase 2 sequencing**: After `containerA.stop()` in Phase 1, WAIT until the
   container is FULLY REMOVED before starting Phase 2. The `stop()` method may return before the
   RocksDB lock file is released. Poll `docker ps -q --filter id=<containerId>` until it returns
   empty, then wait an additional 1-2 seconds before starting Phase 2.

3. **Volume cleanup on teardown**: Remove the Stalwart data volume in the test teardown to prevent
   stale locks for subsequent runs.

4. **Single instance per run**: Stalwart must be started exactly ONCE in vitest.global-setup.ts
   and shared by all integration tests. Never start multiple Stalwart containers on the same volume
   (even across parallel test files).

## Verified Findings from Integration Testing

**Image**: The official `stalwartlabs/stalwart:v0.16.10` image works correctly. No custom image
is needed. The custom image `stalwart-test-custom:latest` provided no benefit.

**TLS Ports**: Stalwart v0.16.10 in Normal Mode auto-binds TLS listeners:
- IMAPS on port 993 (implicit TLS)
- POP3S on port 995 (implicit TLS)
- HTTPS on port 443
- SMTPS on port 465
- Management HTTP on port 8080 (unencrypted, for JMAP/management)

**Plaintext ports NOT bound by default**: IMAP (143), POP3 (110), SMTP (25/587) are NOT
auto-bound in v0.16.10. This is a hardening change from earlier versions. Tests MUST use TLS
ports (993 for IMAPS).

## IMAP Authentication Fix (Resolved)

**Problem**: IMAP authentication was failing with error "localhost.local" during the login phase.

**Root Cause**: The test was using a bare username (`source`) instead of the full email address
(`source@dev.local`). Stalwart v0.16.x requires full email addresses for IMAP authentication.
When a bare username is provided, Stalwart appends its default domain (which appears to be
`localhost.local` when not explicitly configured), resulting in a lookup for
`source@localhost.local` which doesn't exist.

**Fix**: Changed the IMAP username from `source` to `source@dev.local` in the test configuration.
This aligns with standard mail server behavior where the IMAP username should be the full email
address.

**Evidence**: After the fix, the test output shows "IMAP server is ready" instead of failing
with the "localhost.local" error.

## Known Issues

**Empty Folder List**: The integration test currently scans 0 folders instead of the expected
messages. This appears to be a separate issue where Stalwart's IMAP server is not returning
folders via the `LIST` command, or the node-imap library isn't parsing the response correctly.
This issue is unrelated to the IMAP authentication fix and requires further investigation.

**Debugging Steps**:
1. Verify that the INBOX was created during message seeding
2. Check Stalwart logs for IMAP LIST command handling
3. Test with raw IMAP commands to isolate the issue
4. Consider using a different IMAP client library or raw socket testing

## Critical Lessons from Integration Testing

### Wrong AccountId Root Cause (FIXED)

**Problem**: The JMAP target connector was importing emails into the WRONG account (source instead of target).

**Root Cause**: The `jmap-target.ts` connector used `session.primaryAccounts?.['urn:ietf:params:jmap:mail']` which returns the FIRST account in the session, not the authenticated user's account. The test authenticated as `source@dev.local` but the connector resolved accountId to `b` (source) instead of `c` (target).

**Evidence from CI logs**:
```
[DEBUG JMAP] Session primaryAccounts: {"urn:ietf:params:jmap:mail":"b",...}
[DEBUG JMAP] Email import response: {"accountId":"b",...}
```
Every email import showed `accountId: "b"` (source), causing source INBOX to grow 3→6→7 across runs.

**Fix**: 
1. Authenticate JMAP client with TARGET credentials (`target@dev.local`, not `source@dev.local`)
2. Resolve accountId by matching the configured target email against `session.accounts` map
3. Add hard fail at connector init if resolved account's email doesn't match configured target

**Rule**: JMAP connectors MUST resolve accountId by matching the configured target email against the session's account list (or `primaryAccounts` for `urn:ietf:params:jmap:mail`). NEVER take the first session account. Hard-fail on mismatch — a wrong-account mirror must be impossible to reach silently.

### IMAP Cursor Filtering (FIXED)

**Problem**: Cursor-based delta scans were not working correctly - second run was scanning 1 message instead of 0.

**Root Cause**: node-imap library doesn't support the `'UID 4:*'` range search syntax correctly. The search was finding UID 3 even when searching for UID >= 4.

**Fix**: Fetch ALL messages and filter by UID >= cursor.uidNext in JavaScript. This is more reliable than relying on IMAP range search syntax.

**Rule**: When using cursor-based delta scans with node-imap, always fetch all messages and filter client-side by UID >= cursor value. Do not rely on IMAP range search syntax.

### Cursor Isolation (FIXED)

**Problem**: Tests were reading leftover cursors from other tests, causing "Invalid cursor format" errors and unexpected full scans.

**Root Cause**: Both `ledger.integration.test.ts` and `shadow-pass.integration.test.ts` use the same `TEST_TENANT_ID` and `TEST_MAPPING_ID`. Cursors from one test could leak into another.

**Fix**: Add cursor cleanup at the START of each test's `beforeAll` hook:
```typescript
await db.execute(sql`DELETE FROM cursor WHERE tenant_id = ${TEST_TENANT_ID}`);
```

**Rule**: Ledger cursors MUST be isolated between tests. Either truncate cursors at the start of each test, or namespace cursors per test. Never allow one test to read another test's cursor.

### Log Consumer Retry Trap (FIXED)

**Problem**: Phase 2 logs (`stalwart-phase2.log`) were empty (header/footer only) across runs.

**Root Cause**: The log consumer was attached to the wrong container builder instance during the retry loop. The consumer was attached to `containerBBuilder` but the actual container started was a new instance created inside the retry loop.

**Fix**: Ensure the log consumer is attached AFTER the container successfully starts, or attach it to the correct builder instance that's actually used.

**Rule**: When using `withLogConsumer()` in testcontainers, verify the consumer is attached to the actual container instance being started, not a builder that gets discarded during retry logic.

### Source INBOX Regression Guards (ADDED)

**Purpose**: Prevent cross-account pollution from going undetected.

**Implementation**: After each mirror run, assert via IMAP that source@dev.local INBOX still contains exactly the seeded count (3 initially, 4 after delta append).

**Rule**: Always verify source INBOX count after mirror operations to catch cross-account pollution immediately.

## Running from inside a sandboxed agent container (Docker-outside-of-Docker)

**Symptom**: an agent (e.g. an OpenHands sandbox) that itself runs inside a container — with
`sudo` + a mounted `docker.sock` giving it access to the *host's* Docker daemon — reports Docker
and "port not available"/connection-refused failures on work that is proven green in this repo's
own CI. This is a real, distinct environment shape: neither `integration-tests` (GitHub-hosted
`ubuntu-latest`, a plain VM with a local daemon) nor `e2e.yml` (the self-hosted Spark runner,
running directly on the host, no extra container layer) ever exercises it, so nothing here
accounts for it by default.

**Root cause**: when the agent process is itself inside a container and only reaches Docker via a
mounted socket, every container it starts (directly, or indirectly via Testcontainers /
`docker compose`) is a **sibling on the host's daemon**, not a child nested inside the agent's own
container. `localhost`/`127.0.0.1` inside the agent's container is its **own** loopback — a
different network namespace from the host's, where the sibling container actually publishes its
mapped port. The `docker` CLI call to start the container succeeds (which is why this looks like a
Docker problem), then the connection to `getHost()`/`getMappedPort()` times out, because it's
looking in the wrong namespace. `packages/testing/src/testcontainers-setup.ts` calls
`container.getHost()` for Postgres, both Stalwart phases, and Nextcloud — all of these are affected,
not just Stalwart.

**Fixes** (apply in the agent's own container/environment, not in this repo's CI), in order of
what actually resolves the problem vs. what merely works around it:

0. **Best fix: put the agent's own container on the same Docker network as the target container,
   and address it by Docker DNS name instead of a published host port at all.** Confirmed working
   on the DGX Spark box this repo's e2e work happens on:
   `deploy/compose/dev.yml` declares a **fixed-name** network, `openmig_dev-network`
   (`networks: dev-network: name: openmig_dev-network`), and `deploy/selfhost/setup-stalwart.sh`
   joins it under the alias `stalwart` (creating the network first if `dev.yml` hasn't been brought
   up yet). Once Stalwart is up (`./deploy/selfhost/setup-stalwart.sh`), run
   `docker network connect openmig_dev-network <agent-container-name>` once from the host (or
   wherever has access to the host daemon) — after that the agent can reach Stalwart at
   `stalwart:8080` / `stalwart:993` directly, no `host.docker.internal`, no published port, no
   collision with whatever else is squatting on a host port. This sidesteps the whole
   localhost-namespace problem in item "Root cause" above rather than working around it.
   **Caveat**: this only stays this simple because `dev.yml`'s network has a *fixed* name. The
   Testcontainers-managed path (`packages/testing/src/testcontainers-setup.ts`) creates a **new,
   randomly-named** `Network` every run for Postgres (and Stalwart's phase 1/2 containers aren't on
   any shared network at all — see below) — reusing this trick there needs extra automation to
   discover and (re)join the fresh network name each run, or an explicit `withNetwork(sharedNetwork)`
   call added to those container builders. **This manual `docker network connect` is not persisted
   anywhere** (not in a compose file, not in the agent's own env/config) — it has to be redone for
   every fresh agent container/session until something automates it.
1. If joining a shared network isn't practical, set `TESTCONTAINERS_HOST_OVERRIDE`
   (Testcontainers-node's official escape hatch for exactly this case) to `host.docker.internal` or
   the host's real address, so `getHost()` returns something the agent's container can actually
   reach instead of `localhost`. (Not yet verified working on this repo's setup — item 0 was
   confirmed instead; try this only if item 0 doesn't apply.)
2. Make sure the agent's own container was started with `--add-host=host.docker.internal:host-gateway`
   — Linux does not wire this up automatically the way Docker Desktop does, so without it
   `host.docker.internal` won't resolve inside the agent at all. (Already correctly wired on the
   Spark box's agent container — confirmed via `/etc/hosts` showing `172.17.0.1 host.docker.internal`
   — so if this is your symptom, look at item 0/1 instead of this one.)
3. If the agent's sessions get killed abruptly (common for time-boxed sandboxes), Testcontainers'
   Ryuk reaper — which also talks over the same mounted socket — can leak containers instead of
   cleaning them up, and those leftovers block ports/volume names on retry. Either let Ryuk do its
   job by exiting cleanly, or set `TESTCONTAINERS_RYUK_DISABLED=true` and take on cleanup explicitly
   (`docker compose down -v --remove-orphans`, stale `stalwart-test-*` volumes) at the **start** of
   each attempt, not just the end. **Observed on the Spark box**: ~250 orphaned `stalwart-test-*`
   volumes accumulated over 13 days (roughly 19 failed/abandoned runs a day) — `docker volume prune`
   periodically, and don't assume a standing container that merely passes its healthcheck is actually
   functional (see the bootstrap-mode trap below).
4. Don't assume fixed host ports are free — and not just from other agent sessions. **Observed on
   the Spark box**: port 8080 is permanently held by an unrelated `searxng` service, nothing to do
   with this repo or Docker-in-Docker at all. `deploy/compose/dev.yml`'s Postgres port,
   `deploy/selfhost/setup-stalwart.sh`'s JMAP/IMAPS ports (`STALWART_JMAP_PORT`/
   `STALWART_IMAPS_PORT` env overrides), and `e2e.yml`'s selfhost-appliance port (`SELFHOST_PORT`)
   are all overridable precisely so a shared box doesn't collide on 5433/18080/1993/8081.
   `e2e.yml`'s "Pick free host ports" step is the reference implementation: bind to port 0, read
   back the OS-assigned free port, close, use that. Do the same in the agent rather than
   hardcoding a port — or, better, use item 0 and skip host ports for this purpose entirely.
5. If the agent drives the Testcontainers integration suite directly (not just `e2e.yml`'s compose
   flow), it also needs `stalwart-cli` on its own `PATH` (or `STALWART_CLI_PATH` set) — a real
   host-level binary dependency in `testcontainers-setup.ts`'s provisioning phase, separate from the
   networking issue above.

**Rule**: Before assuming a Docker/port failure inside a nested-container agent is a bug in this
repo's test setup, check whether it reproduces in a plain (non-nested) Docker environment first —
if it only fails when Docker is reached via a mounted socket, it's almost certainly one of the
items above, not a regression here.

## Bugs found via Spark box forensics, and how they were actually fixed

Three **independent, already-committed bugs** surfaced while diagnosing a stranded agent session,
across two rounds of investigation. All three are now fixed — this section is the historical record
+ the reasoning, not an open item.

- **`deploy/selfhost/stalwart-compose.yml` never delivered a config.json to the container.** No
  `command: --config ...`, no mounted/copied file. Without one, Stalwart ignored
  `STALWART_RECOVERY_MODE=1` and fell back to **bootstrap mode** (first-run setup wizard — only
  port 8080's *initial-setup* UI up, no mail listeners, no accounts). Evidence: container logs read
  `WARN Server started in bootstrap mode ... "No configuration file was found."` after 9 hours
  "healthy" (the healthcheck just curls `/.well-known/jmap`, which responds in bootstrap mode too —
  a passing healthcheck there does **not** mean Stalwart is usable).
- **`deploy/compose/stalwart-config.json`** (baked into `dev.yml`'s custom-built image via
  `Dockerfile.stalwart-config`) was in the legacy multi-section format — but a more careful look
  (prompted by a *second* agent's investigation of an `e2e.yml` failure) found it wasn't just
  "legacy," it was **structurally invalid**: `credentials` as an array instead of the required map,
  missing `@type`/`name`/`roles`/`permissions`/`encryptionAtRest` on the account objects. A clean
  rebuild surfaced Stalwart's real parse error: `missing field @type at line 63`. **This file had
  probably never once successfully started Stalwart in this repo's history** — the earlier framing
  in this doc ("load-bearing, treat as an open decision") assumed the file worked and was worth
  protecting; it didn't, so there was nothing to protect. It also confirmed there was never a
  legitimate exception to the header rule ("DO NOT put accounts/domains/listeners in config.json")
  hiding here — just an invalid file nobody had cleanly rebuilt against until then.
- **`apps/worker/src/build-deps.ts` hardcoded `tls: true`** for the IMAP *source* connector
  regardless of the configured port, while the IMAP/DAV *target* connector correctly derived it
  (`tls: targetConfig.port === 993`). Found while tracing why seeding would still fail even after
  Stalwart itself was fixed: the self-host appliance's real sync path would keep attempting a TLS
  handshake against whatever port was configured, independent of whether that port actually spoke
  TLS. Fixed to match the target side's own pattern.

**The actual fix, not a per-file patch:** all three collapse into one change — stop trying to make
a second, parallel Stalwart configuration (accounts in a static file, plaintext 143) coexist with
the proven two-phase pattern. `deploy/compose/Dockerfile.stalwart-config` and
`deploy/compose/stalwart-config.json` are deleted; `dev.yml` no longer has a `stalwart` service at
all (compose can't express a two-phase startup for one service anyway). `deploy/selfhost/
stalwart-compose.yml` is deleted too — superseded, not fixed in place. In their place,
**`deploy/selfhost/setup-stalwart.sh`** is the one canonical way to stand up Stalwart for local dev
and `e2e.yml`: the exact two-phase dance from this doc (minimal config.json, recovery-mode
`stalwart-cli apply`, then a normal-mode restart), official image only, run via plain `docker run`
so it isn't fighting `docker compose`'s single-service model. It also joins `dev.yml`'s
`openmig_dev-network` under the alias `stalwart` — preserving the confirmed DooD fix above without
needing a `stalwart` compose service to hang it off of. `e2e.yml`'s fixture and seed step moved to
IMAPS 993, matching the Testcontainers path's already-proven doctrine instead of a second one.

## Round 3: getting a real e2e.yml run past Stalwart, into the appliance itself

Fixing Stalwart (above) surfaced two more issues on the next attempt — both real, both now fixed,
neither Stalwart's fault:

- **`deploy/selfhost/compose.yml` alone can't reach a dev Stalwart.** Two independent gaps: (1)
  `host.docker.internal` doesn't resolve inside a Linux container without an explicit `extra_hosts`
  entry — Docker Desktop adds this automatically, native Linux does not, and `compose.yml` didn't
  declare one; (2) `deploy/selfhost/compose.yml` creates its own compose-project network, entirely
  separate from `setup-stalwart.sh`'s `openmig_dev-network`, so addressing Stalwart by name
  (`stalwart`) never resolved either. **Fix**: `deploy/selfhost/compose.dev.yml` — a new,
  **dev/e2e-only** override (real self-host operators never reference it; `compose.yml` alone stays
  the product) that adds the `extra_hosts` entry and attaches `app` to `openmig_dev-network` too:
  `docker compose -f deploy/selfhost/compose.yml -f deploy/selfhost/compose.dev.yml up -d`.
  `e2e.yml` uses it instead of generating a throwaway per-run override file, and the T5 fixture now
  addresses Stalwart as `stalwart:8080`/`stalwart:993` (the shared network, fixed internal ports) —
  a manual `docker network connect` for the *appliance* container is no longer needed at all. (A
  sandboxed **agent's own** `docker network connect openmig_dev-network <agent-container>`, to poll
  `/status` itself, is still a separate, still-necessary step — see the DooD section above.)
- **`apps/worker/src/build-deps.ts`'s `buildImapSource()` hardcoded `authType: 'XOAUTH2'`**
  regardless of the configured `auth.kind`, and never read a password for `auth.kind: 'login'` at
  all — so any login-kind IMAP source (including the T5 fixture itself) always sent an empty
  XOAUTH2 attempt, and IMAP servers correctly rejected it with `"No supported authentication
  method(s) available"`. This one had **zero test coverage** before now — nothing exercised
  `buildDeps`/`buildImapSource` with `auth.kind: 'login'`. Fixed to derive `authType` from
  `auth.kind` and extract the password from `passwordFromEnv` when it's `'login'`, matching what
  `ImapSource`'s connector (`packages/connectors/src/imap-source.ts`) already supported — the bug
  was purely in the wiring, not the connector. Regression-tested in
  `apps/worker/src/build-deps.unit.test.ts` (asserts both `login` and `xoauth2` wire through
  correctly, by inspecting the built connector's internal config).

**Pattern across all of round 2 and round 3**: every one of these five bugs (bootstrap mode,
invalid config.json, hardcoded source TLS, missing compose networking, hardcoded source auth type)
was **real and pre-existing**, not a Docker-in-Docker artifact — a sandboxed agent kept running into
them because it's the first thing to actually attempt a full, real T5 run end-to-end, not because
nested Docker caused any of them. Don't reflexively blame DooD for a new failure here; check
whether it reproduces for any agent, nested or not, first.

## Round 4: the first actual `e2e.yml` dispatch on the bare Spark runner

The first real `e2e.yml` dispatch on the self-hosted runner (not a nested agent sandbox) failed at
`setup-stalwart.sh` phase 1 with:

```
Failed to read data store settings at /etc/stalwart/config.json: Permission denied (os error 13)
```

Note this is **"Permission denied", not "Is a directory"** — i.e. the config bind mount worked
*structurally* (the runner is a bare host, so the `mktemp`'d file is a real local path that mounts
as a file, unlike the DooD "creates a directory" trap). The failure is pure Unix permissions:
`mktemp` makes the file mode **600 owned by the runner's uid**, it's bind-mounted read-only, and
Stalwart inside the container runs as a **different uid**, so it can't read a `0600` file owned by
someone else. **Fix**: `setup-stalwart.sh` now `chmod 644`s the config file after writing it. Safe
because the file carries no secret — just `{"@type":"RocksDb","path":"/opt/stalwart/data"}`; all
accounts/domains/credentials are provisioned via `stalwart-cli` into the datastore, never in this
file (per the header rules above).

The **next** dispatch got one layer deeper — config now readable, but the data volume wasn't
writable:

```
Failed to open database: Error { message: "IO error: While open a file for appending: /opt/stalwart/data/LOG: Permission denied" }
```

Named Docker volumes are created **root-owned**, and the Stalwart image runs as a **non-root user**,
so it can't write to `/opt/stalwart/data`. **Fix**: run both phases with `--user root`, mirroring
`packages/testing/src/testcontainers-setup.ts`, which uses `.withUser('root')` on both its Stalwart
containers for exactly this reason (its comment: "sidesteps any UID/permission issues"). With
`--user root` the process owns the write path; this also makes the earlier `chmod 644` redundant for
the container's own reads, but that stays as defense-in-depth and to keep the config readable to any
tooling.

**Note on bind-mount vs copy for config delivery.** This repo's Testcontainers path uses
`withCopyContentToContainer` and this doc's header says "NEVER a bind mount". `setup-stalwart.sh`
deliberately uses a bind mount instead, which is fine **on a bare host** (the file exists locally
and mounts as a file, and `chmod 644` makes it readable) but would fail **structurally** in a
Docker-outside-of-Docker sandbox (the host daemon can't see the agent-container-local path → "Is a
directory"). So `setup-stalwart.sh` is written for the bare runner, which is where `e2e.yml` runs.
If it ever needs to run by hand inside a DooD sandbox, switch config delivery to a copy-based
approach (`docker create` → `docker cp` → `docker start`, or a named-volume stage) — do **not**
pipe via `docker run -d ... < file` (a detached container doesn't attach stdin, so the config lands
empty → bootstrap mode, i.e. round 2's bug again).
