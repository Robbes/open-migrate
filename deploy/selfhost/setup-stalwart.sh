#!/bin/bash
set -euo pipefail

# Stand up a real, working Stalwart v0.16.10 for local dev / e2e (workplan 0010 T5 and
# friends — the self-host restart-resume idempotency gate needs a real IMAP+JMAP source
# and target). This is the ONE canonical way to do that in this repo; do not re-invent a
# second path (see docs/stalwart-integration-fix.md, "DO NOT deviate").
#
# Two-phase startup is REQUIRED by Stalwart itself, not a convenience choice — provisioning
# (recovery mode) and serving (normal mode) cannot share one process: recovery mode exposes
# only the management API (mail listeners suspended), and normal mode auto-starts listeners
# for whatever accounts already exist in the datastore. This script does both phases against
# one named Docker volume, then leaves a normal-mode container running.
#
# Idempotent: safe to re-run against an already-provisioned volume — account provisioning
# uses upsert semantics, so re-running phase 1 just re-applies the same accounts.
#
# Uses ONLY the official image (no custom build — docs/stalwart-integration-fix.md's own
# "Verified Image" finding: a custom image provided no benefit over the official one).
#
# Requires: docker, curl, and stalwart-cli on PATH (or STALWART_CLI_PATH set). Install:
#   curl --proto '=https' --tlsv1.2 -LsSf \
#     https://github.com/stalwartlabs/cli/releases/latest/download/stalwart-cli-installer.sh | sh
#
# Also joins `openmig_dev-network` (the fixed-name network deploy/compose/dev.yml declares
# for postgres/nextcloud) under the network alias "stalwart", creating it first if it doesn't
# exist yet. This is what makes the confirmed Docker-outside-of-Docker fix work (see
# docs/stalwart-integration-fix.md, "Running from inside a sandboxed agent container"): a
# sandboxed agent joins that same network and reaches this container at `stalwart:8080` /
# `stalwart:993` directly, without published host ports or `host.docker.internal` at all.
#
# Env overrides (all optional):
#   STALWART_CONTAINER          container name (default openmig-dev-stalwart)
#   STALWART_VOLUME             data volume name (default openmig-dev-stalwart-data)
#   STALWART_CONFIG_VOLUME      config volume name (default openmig-dev-stalwart-config)
#   STALWART_NETWORK            shared network to join (default openmig_dev-network)
#   STALWART_JMAP_PORT          host port for JMAP/management (default 18080)
#   STALWART_IMAPS_PORT         host port for IMAPS (default 1993)
#   STALWART_RECOVERY_PASSWORD  recovery-mode admin password (default provision_password)

IMAGE="stalwartlabs/stalwart:v0.16.10"
CONTAINER="${STALWART_CONTAINER:-openmig-dev-stalwart}"
VOLUME="${STALWART_VOLUME:-openmig-dev-stalwart-data}"
CONFIG_VOLUME="${STALWART_CONFIG_VOLUME:-openmig-dev-stalwart-config}"
NETWORK="${STALWART_NETWORK:-openmig_dev-network}"
JMAP_PORT="${STALWART_JMAP_PORT:-18080}"
IMAPS_PORT="${STALWART_IMAPS_PORT:-1993}"
RECOVERY_PASSWORD="${STALWART_RECOVERY_PASSWORD:-provision_password}"

STALWART_CLI="${STALWART_CLI_PATH:-stalwart-cli}"
command -v "$STALWART_CLI" >/dev/null 2>&1 || {
  echo "[setup-stalwart] $STALWART_CLI not found. Install it (see this script's header) or set STALWART_CLI_PATH." >&2
  exit 1
}

PLAN_FILE="$(mktemp)"
trap 'rm -f "$PLAN_FILE"' EXIT

docker volume inspect "$VOLUME" >/dev/null 2>&1 || docker volume create "$VOLUME" >/dev/null
docker volume inspect "$CONFIG_VOLUME" >/dev/null 2>&1 || docker volume create "$CONFIG_VOLUME" >/dev/null
docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null

# The ENTIRE config.json, both phases, nothing else (docs/stalwart-integration-fix.md).
# Accounts/domains/listeners NEVER go in this file — they're provisioned via stalwart-cli
# below, into the datastore, not declared statically.
#
# Delivered via a named volume, seeded by a throwaway --rm container that writes the file
# directly with shell redirection (foreground, not detached — a detached container's stdin
# is never attached, so piping into `docker run -d` silently lands an empty config, see
# docs/stalwart-integration-fix.md's "Note on bind-mount vs copy for config delivery").
# NOT a bind mount: a host path bind-mounted from inside a Docker-outside-of-Docker sandbox
# (an agent that only reaches Docker via a mounted docker.sock) resolves against the HOST's
# filesystem, not the sandbox's — the path doesn't exist there, so Docker silently creates an
# empty DIRECTORY at the mount point instead of mounting the file, and Stalwart fails with
# "Is a directory (os error 21)". A named volume has no such host-path ambiguity and works
# identically on a bare runner and inside a sandbox, so it replaces the bind mount everywhere
# rather than being a DinD-only special case.
docker run --rm --entrypoint /bin/sh --user root \
  -v "$CONFIG_VOLUME:/etc/stalwart" \
  "$IMAGE" \
  -c 'echo "{\"@type\":\"RocksDb\",\"path\":\"/opt/stalwart/data\"}" > /etc/stalwart/config.json && chmod 644 /etc/stalwart/config.json' >/dev/null

wait_for_jmap() {
  local label="$1"
  for i in $(seq 1 60); do
    curl -sf "http://127.0.0.1:${JMAP_PORT}/.well-known/jmap" >/dev/null 2>&1 && return 0
    if [ "$i" -eq 60 ]; then
      echo "[setup-stalwart] $label never came up after 60s" >&2
      docker logs "$CONTAINER" 2>&1 | tail -100 >&2
      return 1
    fi
    sleep 1
  done
}

echo "[setup-stalwart] Phase 1: recovery mode (provisioning)..."
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
# --user root: named Docker volumes are created root-owned, but the Stalwart image runs as a
# non-root user, so without this it can't write to /opt/stalwart/data ("Permission denied ...
# /opt/stalwart/data/LOG"). This mirrors packages/testing/src/testcontainers-setup.ts, which
# runs its Stalwart containers with .withUser('root') for exactly the same reason.
docker run -d \
  --name "$CONTAINER" \
  --user root \
  --network "$NETWORK" \
  --network-alias stalwart \
  -v "$VOLUME:/opt/stalwart/data" \
  -v "$CONFIG_VOLUME:/etc/stalwart:ro" \
  -e STALWART_HOSTNAME=0.0.0.0 \
  -e STALWART_RECOVERY_MODE=1 \
  -e STALWART_RECOVERY_ADMIN="admin:${RECOVERY_PASSWORD}" \
  -p "${JMAP_PORT}:8080" \
  "$IMAGE" --config /etc/stalwart/config.json >/dev/null

wait_for_jmap "Recovery listener"

echo "[setup-stalwart] Provisioning accounts..."
cat > "$PLAN_FILE" <<'PLAN'
{"@type":"upsert","object":"Domain","matchOn":["name"],"value":{"dom-a":{"name":"dev.local"}}}
{"@type":"upsert","object":"Account","matchOn":["name"],"value":{"source":{"@type":"User","name":"source","domainId":"#dom-a","credentials":{"0":{"@type":"Password","secret":"source_password"}},"roles":{"@type":"User"},"permissions":{"@type":"Inherit"},"encryptionAtRest":{"@type":"Disabled"}}}}
{"@type":"upsert","object":"Account","matchOn":["name"],"value":{"target":{"@type":"User","name":"target","domainId":"#dom-a","credentials":{"0":{"@type":"Password","secret":"target_password"}},"roles":{"@type":"User"},"permissions":{"@type":"Inherit"},"encryptionAtRest":{"@type":"Disabled"}}}}
{"@type":"upsert","object":"Account","matchOn":["name"],"value":{"shared":{"@type":"User","name":"shared","domainId":"#dom-a","credentials":{"0":{"@type":"Password","secret":"shared_password"}},"roles":{"@type":"User"},"permissions":{"@type":"Inherit"},"encryptionAtRest":{"@type":"Disabled"}}}}
{"@type":"upsert","object":"Account","matchOn":["name"],"value":{"target-shared":{"@type":"User","name":"target-shared","domainId":"#dom-a","credentials":{"0":{"@type":"Password","secret":"target-shared_password"}},"roles":{"@type":"User"},"permissions":{"@type":"Inherit"},"encryptionAtRest":{"@type":"Disabled"}}}}
PLAN

"$STALWART_CLI" --url "http://127.0.0.1:${JMAP_PORT}" --user admin --password "${RECOVERY_PASSWORD}" apply --file "$PLAN_FILE"

echo "[setup-stalwart] Stopping recovery container..."
docker stop "$CONTAINER" >/dev/null
docker rm "$CONTAINER" >/dev/null
# The RocksDB lock can outlive `docker stop` returning — give it a moment before phase 2
# (docs/stalwart-integration-fix.md, "RocksDB Lock Collision Prevention").
sleep 2

echo "[setup-stalwart] Phase 2: normal mode (serving)..."
docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --user root \
  --network "$NETWORK" \
  --network-alias stalwart \
  -v "$VOLUME:/opt/stalwart/data" \
  -v "$CONFIG_VOLUME:/etc/stalwart:ro" \
  -e STALWART_HOSTNAME=0.0.0.0 \
  -p "${JMAP_PORT}:8080" \
  -p "${IMAPS_PORT}:993" \
  "$IMAGE" --config /etc/stalwart/config.json >/dev/null

wait_for_jmap "Normal-mode server"

echo "[setup-stalwart] Ready."
echo "[setup-stalwart]   JMAP:  http://127.0.0.1:${JMAP_PORT}/.well-known/jmap  (or http://stalwart:8080 from ${NETWORK})"
echo "[setup-stalwart]   IMAPS: 127.0.0.1:${IMAPS_PORT} (TLS, self-signed cert; or stalwart:993 from ${NETWORK})"
echo "[setup-stalwart]   Accounts: source@dev.local/source_password, target@dev.local/target_password,"
echo "[setup-stalwart]             shared@dev.local/shared_password, target-shared@dev.local/target-shared_password"
