#!/bin/bash
set -e

STALWART_URL="http://localhost:18080"
CONFIG_FILE="/tmp/stalwart-config.json"
PLAN_FILE="/tmp/stalwart-plan.jsonl"

echo "[Setup] Starting Stalwart in recovery mode..."
docker run -d \
  --name stalwart-setup \
  -v stalwart-test-data:/opt/stalwart/data \
  -v /tmp/stalwart-config.json:/etc/stalwart/config.json:ro \
  -e STALWART_HOSTNAME=0.0.0.0 \
  -e STALWART_RECOVERY_MODE=1 \
  -e STALWART_RECOVERY_ADMIN="admin:provision_password" \
  -p 18080:8080 \
  stalwartlabs/stalwart:v0.16.10 \
  --config /etc/stalwart/config.json

echo "[Setup] Waiting for Stalwart to be ready..."
sleep 5

echo "[Setup] Provisioning accounts..."
cat > "$PLAN_FILE" << 'PLAN'
{"@type":"upsert","object":"Domain","matchOn":["name"],"value":{"dom-a":{"name":"dev.local"}}}
{"@type":"upsert","object":"Account","matchOn":["name"],"value":{"source":{"@type":"User","name":"source","domainId":"#dom-a","credentials":{"0":{"@type":"Password","secret":"source_password"}},"roles":{"@type":"User"},"permissions":{"@type":"Inherit"},"encryptionAtRest":{"@type":"Disabled"}}}}
{"@type":"upsert","object":"Account","matchOn":["name"],"value":{"target":{"@type":"User","name":"target","domainId":"#dom-a","credentials":{"0":{"@type":"Password","secret":"target_password"}},"roles":{"@type":"User"},"permissions":{"@type":"Inherit"},"encryptionAtRest":{"@type":"Disabled"}}}}
{"@type":"upsert","object":"Account","matchOn":["name"],"value":{"shared":{"@type":"User","name":"shared","domainId":"#dom-a","credentials":{"0":{"@type":"Password","secret":"shared_password"}},"roles":{"@type":"User"},"permissions":{"@type":"Inherit"},"encryptionAtRest":{"@type":"Disabled"}}}}
{"@type":"upsert","object":"Account","matchOn":["name"],"value":{"target-shared":{"@type":"User","name":"target-shared","domainId":"#dom-a","credentials":{"0":{"@type":"Password","secret":"target-shared_password"}},"roles":{"@type":"User"},"permissions":{"@type":"Inherit"},"encryptionAtRest":{"@type":"Disabled"}}}}
PLAN

stalwart-cli --url "$STALWART_URL" --user admin --password provision_password apply --file "$PLAN_FILE"

echo "[Setup] Stopping recovery container..."
docker stop stalwart-setup
sleep 2

echo "[Setup] Starting Stalwart in normal mode..."
docker run -d \
  --name stalwart-test \
  -v stalwart-test-data:/opt/stalwart/data \
  -v /tmp/stalwart-config.json:/etc/stalwart/config.json:ro \
  -e STALWART_HOSTNAME=0.0.0.0 \
  -p 18080:8080 \
  -p 1993:993 \
  stalwartlabs/stalwart:v0.16.10 \
  --config /etc/stalwart/config.json

echo "[Setup] Waiting for Stalwart to be ready..."
sleep 5

echo "[Setup] Verifying accounts..."
stalwart-cli --url "$STALWART_URL" --user admin --password provision_password account list

echo "[Setup] Stalwart is ready!"
