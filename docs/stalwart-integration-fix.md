# Stalwart v0.16.10 Testcontainers Integration — Authoritative Reference

DO NOT deviate from this. DO NOT change the pinned version. DO NOT put accounts/domains/listeners
in config.json. DO NOT skip the shadow-pass tests. Prior sessions repeatedly re-fabricated the
config below; this file is the corrected ground truth.

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

## Open item (the ONLY real remaining work)
IMAP auth succeeds but the connection drops after auth, during commands — a test-client TLS-mode or
APPEND-literal mismatch. Diagnose with `nc` and `openssl s_client -starttls imap`, align the client
(APPEND literal needs \r\n endings + exact octet count; match the server's advertised CAPABILITY).
Do NOT change config.json for this — listeners need no config.
