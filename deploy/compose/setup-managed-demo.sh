#!/bin/bash
set -euo pipefail

# Provision the T7 managed-edition demo backend: a real mail (Stalwart) source+target
# and a real DAV (Nextcloud) source+target for each of the two demo tenants
# seed-managed.ts creates, so a real shadow pass can actually complete against the
# managed compose stack instead of failing at "no credentials configured".
#
# This does NOT reinvent bring-up for either backend — it reuses the two canonical,
# already-proven scripts unchanged, just pointed at this stack's network/containers:
#   - deploy/selfhost/setup-stalwart.sh   (mail: IMAP source + JMAP target, two-phase
#     startup — see that script's header for why it can't be a compose service)
#   - deploy/selfhost/setup-nextcloud-users.sh (DAV: CalDAV/CardDAV/WebDAV accounts on
#     top of an already-running Nextcloud compose service)
#
# Run order:
#   1. docker compose -f deploy/compose/managed.yml up -d postgres nextcloud
#   2. ./deploy/compose/setup-managed-demo.sh
#   3. pnpm --filter @openmig/api seed:managed   (reads the fixed demo creds below)
#   4. docker compose -f deploy/compose/managed.yml up -d --build (rest of the stack)
#
# Idempotent: both underlying scripts are safe to re-run.
#
# Env overrides (all optional):
#   MANAGED_NETWORK          compose network the worker/api containers are on
#                             (default open-migrate-network, matches managed.yml)
#   NEXTCLOUD_CONTAINER       (default open-migrate-nextcloud, matches managed.yml)
#   NEXTCLOUD_HOST_PORT       host port nextcloud's :80 is published on
#                             (default 8083, matches managed.yml's NEXTCLOUD_PORT default)
#   STALWART_CONTAINER/VOLUME/JMAP_PORT/IMAPS_PORT — forwarded to setup-stalwart.sh with
#     managed-specific defaults so this never collides with the dev/e2e Stalwart instance
#     (deploy/compose/dev.yml + setup-stalwart.sh's own defaults) if both run on one host.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

MANAGED_NETWORK="${MANAGED_NETWORK:-open-migrate-network}"
NEXTCLOUD_CONTAINER="${NEXTCLOUD_CONTAINER:-open-migrate-nextcloud}"
NEXTCLOUD_HOST_PORT="${NEXTCLOUD_HOST_PORT:-8083}"

echo "[setup-managed-demo] Provisioning demo Stalwart (mail source+target)..."
STALWART_CONTAINER="${STALWART_CONTAINER:-open-migrate-stalwart}" \
STALWART_VOLUME="${STALWART_VOLUME:-open-migrate-stalwart-data}" \
STALWART_NETWORK="${MANAGED_NETWORK}" \
STALWART_JMAP_PORT="${STALWART_JMAP_PORT:-18081}" \
STALWART_IMAPS_PORT="${STALWART_IMAPS_PORT:-1994}" \
  "${REPO_ROOT}/deploy/selfhost/setup-stalwart.sh"
# Fixed demo accounts provisioned above (see setup-stalwart.sh's PLAN_FILE):
#   Tenant A: source@dev.local / source_password  ->  target@dev.local / target_password
#   Tenant B: shared@dev.local / shared_password  ->  target-shared@dev.local / target-shared_password
# seed-managed.ts's DEMO_TENANTS credentials must match these exactly.

echo "[setup-managed-demo] Provisioning demo Nextcloud accounts (DAV source+target)..."
NEXTCLOUD_CONTAINER="${NEXTCLOUD_CONTAINER}" \
NEXTCLOUD_HOST_PORT="${NEXTCLOUD_HOST_PORT}" \
NEXTCLOUD_ADMIN_PASSWORD="${NEXTCLOUD_ADMIN_PASSWORD:-admin_managed_pw}" \
NEXTCLOUD_SOURCE_USER=tenant-a-source NEXTCLOUD_SOURCE_PASSWORD=tenant_a_source_pw \
NEXTCLOUD_TARGET_USER=tenant-a-target NEXTCLOUD_TARGET_PASSWORD=tenant_a_target_pw \
  "${REPO_ROOT}/deploy/selfhost/setup-nextcloud-users.sh"

NEXTCLOUD_CONTAINER="${NEXTCLOUD_CONTAINER}" \
NEXTCLOUD_HOST_PORT="${NEXTCLOUD_HOST_PORT}" \
NEXTCLOUD_ADMIN_PASSWORD="${NEXTCLOUD_ADMIN_PASSWORD:-admin_managed_pw}" \
NEXTCLOUD_SOURCE_USER=tenant-b-source NEXTCLOUD_SOURCE_PASSWORD=tenant_b_source_pw \
NEXTCLOUD_TARGET_USER=tenant-b-target NEXTCLOUD_TARGET_PASSWORD=tenant_b_target_pw \
  "${REPO_ROOT}/deploy/selfhost/setup-nextcloud-users.sh"

echo "[setup-managed-demo] Done. Demo backend ready for seed-managed.ts:"
echo "[setup-managed-demo]   Mail:  stalwart:993 (IMAPS) / stalwart:8080 (JMAP) on ${MANAGED_NETWORK}"
echo "[setup-managed-demo]   DAV:   http://nextcloud/ on ${MANAGED_NETWORK}"
