#!/bin/bash
set -euo pipefail

# Provision two Nextcloud user accounts (source + target) on top of the shared dev
# Nextcloud container (deploy/compose/dev.yml's `nextcloud` service) so the multi-domain
# e2e (workplan issue #114 follow-up) can prove calendar/contacts sync ACROSS accounts —
# not just within the admin account the DAV source/target integration tests already use.
#
# Requires the container to already be up (`docker compose -f deploy/compose/dev.yml up -d
# nextcloud`) — this script only waits for readiness, configures trusted domains, and
# provisions users; it does not start the container itself.
#
# Idempotent: re-running against already-provisioned users is safe (OCS returns 102 "user
# already exists", which this script tolerates).
#
# Env overrides (all optional except NEXTCLOUD_HOST_PORT):
#   NEXTCLOUD_CONTAINER      container name (default openmig-dev-nextcloud)
#   NEXTCLOUD_HOST_PORT      the host port the container's :80 is published on (required —
#                            the e2e workflow picks this dynamically; see "Pick free host ports")
#   NEXTCLOUD_ADMIN_USER     admin username (default admin, matches dev.yml)
#   NEXTCLOUD_ADMIN_PASSWORD admin password (default admin_dev_pw, matches dev.yml)
#   NEXTCLOUD_SOURCE_USER    source account userid (default e2e-source)
#   NEXTCLOUD_SOURCE_PASSWORD source account password (required)
#   NEXTCLOUD_TARGET_USER    target account userid (default e2e-target)
#   NEXTCLOUD_TARGET_PASSWORD target account password (required)

CONTAINER="${NEXTCLOUD_CONTAINER:-openmig-dev-nextcloud}"
HOST_PORT="${NEXTCLOUD_HOST_PORT:?NEXTCLOUD_HOST_PORT is required}"
ADMIN_USER="${NEXTCLOUD_ADMIN_USER:-admin}"
ADMIN_PASSWORD="${NEXTCLOUD_ADMIN_PASSWORD:-admin_dev_pw}"
SOURCE_USER="${NEXTCLOUD_SOURCE_USER:-e2e-source}"
SOURCE_PASSWORD="${NEXTCLOUD_SOURCE_PASSWORD:?NEXTCLOUD_SOURCE_PASSWORD is required}"
TARGET_USER="${NEXTCLOUD_TARGET_USER:-e2e-target}"
TARGET_PASSWORD="${NEXTCLOUD_TARGET_PASSWORD:?NEXTCLOUD_TARGET_PASSWORD is required}"

BASE_URL="http://127.0.0.1:${HOST_PORT}"

echo "[setup-nextcloud-users] Waiting for internal readiness (status.php via docker exec)..."
internal_ready=false
for _ in $(seq 1 60); do
  code="$(docker exec "$CONTAINER" curl -s -o /dev/null -w '%{http_code}' http://localhost/status.php || echo 000)"
  if [ "$code" = "200" ]; then
    internal_ready=true
    break
  fi
  sleep 5
done
if [ "$internal_ready" != "true" ]; then
  echo "[setup-nextcloud-users] Nextcloud did not become internally ready" >&2
  exit 1
fi
echo "[setup-nextcloud-users] Internal readiness OK"

# Trusted domains: the appliance reaches this container by its compose service/alias name
# ("nextcloud", on openmig_dev-network); this script and the seed step reach it via the
# dynamically-picked host-published port. Both host forms must be trusted or Nextcloud
# rejects every request with its "untrusted domain" error page.
echo "[setup-nextcloud-users] Registering trusted domains..."
docker exec "$CONTAINER" php occ config:system:set trusted_domains 0 --value=localhost
docker exec "$CONTAINER" php occ config:system:set trusted_domains 1 --value=nextcloud
docker exec "$CONTAINER" php occ config:system:set trusted_domains 2 --value="127.0.0.1:${HOST_PORT}"
sleep 2
echo "[setup-nextcloud-users] Trusted domains registered"

echo "[setup-nextcloud-users] Verifying external DAV readiness (PROPFIND)..."
propfind_ready=false
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' -X PROPFIND -H 'Depth: 0' \
    -u "${ADMIN_USER}:${ADMIN_PASSWORD}" "${BASE_URL}/remote.php/dav/" || echo 000)"
  if [ "$code" = "207" ]; then
    propfind_ready=true
    break
  fi
  sleep 2
done
if [ "$propfind_ready" != "true" ]; then
  echo "[setup-nextcloud-users] External DAV did not become ready (last PROPFIND status: ${code:-unknown})" >&2
  exit 1
fi
echo "[setup-nextcloud-users] External DAV ready at ${BASE_URL}"

create_user() {
  local userid="$1" password="$2"
  echo "[setup-nextcloud-users] Creating user '${userid}'..."
  local body
  body="$(curl -s -u "${ADMIN_USER}:${ADMIN_PASSWORD}" \
    -H 'OCS-APIRequest: true' \
    -d "userid=${userid}" --data-urlencode "password=${password}" \
    "${BASE_URL}/ocs/v1.php/cloud/users")"
  # statuscode 100 = created, 102 = user already exists — both fine (idempotent re-run).
  if echo "$body" | grep -qE '<statuscode>(100|102)</statuscode>'; then
    echo "[setup-nextcloud-users] User '${userid}' ready"
  else
    echo "[setup-nextcloud-users] Unexpected OCS response creating '${userid}':" >&2
    echo "$body" >&2
    exit 1
  fi
}

create_user "$SOURCE_USER" "$SOURCE_PASSWORD"
create_user "$TARGET_USER" "$TARGET_PASSWORD"

# Touch each account's calendar-home-set / addressbook-home-set once as that user — this is
# what makes Nextcloud lazily auto-provision the default 'personal' calendar and 'contacts'
# address book (the same lazy-provision the existing caldav-source/carddav-source integration
# tests rely on for the admin account; freshly-created OCS users get it on first DAV touch too).
# MUST be Depth: 1 (enumerate children), not Depth: 0 (just the home-set collection's own
# properties) — Nextcloud's CalDAV/CardDAV backends provision the default collection lazily
# when the children are LISTED, exactly what CalDAVSource/CarddavSource.listFolders() does
# via a Depth: 1 PROPFIND; a Depth: 0 touch on the home-set itself does not trigger it.
for user_pass in "${SOURCE_USER}:${SOURCE_PASSWORD}" "${TARGET_USER}:${TARGET_PASSWORD}"; do
  user="${user_pass%%:*}"
  pass="${user_pass#*:}"
  curl -s -o /dev/null -X PROPFIND -H 'Depth: 1' -u "${user}:${pass}" "${BASE_URL}/remote.php/dav/calendars/${user}/" || true
  curl -s -o /dev/null -X PROPFIND -H 'Depth: 1' -u "${user}:${pass}" "${BASE_URL}/remote.php/dav/addressbooks/users/${user}/" || true
done

echo "[setup-nextcloud-users] Done: source='${SOURCE_USER}', target='${TARGET_USER}'"
