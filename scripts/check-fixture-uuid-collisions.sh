#!/bin/bash
# check-fixture-uuid-collisions.sh
# Detects cross-file UUID collisions in integration test fixtures.
# Exit 0 = no collisions, Exit 1 = collisions found (CI should fail)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Fixture UUID Collision Guard ==="
echo "Scanning for UUIDs in *.integration.test.ts files under packages/ and apps/"
echo ""

# Find all integration test files
mapfile -t TEST_FILES < <(find "$ROOT_DIR/packages" "$ROOT_DIR/apps" -name "*.integration.test.ts" -type f 2>/dev/null)

if [ ${#TEST_FILES[@]} -eq 0 ]; then
    echo "ERROR: No integration test files found!"
    exit 1
fi

# Create temp files
TEMP_FILE=$(mktemp)
TEMP_UNIQUE=$(mktemp)
trap "rm -f $TEMP_FILE $TEMP_UNIQUE" EXIT

# Extract all UUIDs with their source files
# Format: UUID FILEPATH (UUID first for easy grouping)
for file in "${TEST_FILES[@]}"; do
    rel_path="${file#$ROOT_DIR/}"
    # Extract UUIDs and append file path using awk instead of while loop
    grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' "$file" 2>/dev/null | \
        awk -v path="$rel_path" '{print $1, path}' >> "$TEMP_FILE" || true
done

# For each UUID, find how many DISTINCT files use it
# First, get unique UUID+file pairs (in case a UUID appears multiple times in same file)
sort -u "$TEMP_FILE" > "$TEMP_UNIQUE"

# Now find UUIDs that appear in more than one file
COLLISIONS=$(awk '{print $1}' "$TEMP_UNIQUE" | sort | uniq -d)

if [ -z "$COLLISIONS" ]; then
    echo "✅ PASS: No cross-file UUID collisions detected."
    echo ""
    echo "Total integration test files scanned: ${#TEST_FILES[@]}"
    echo "All fixture UUIDs are unique across files."
    exit 0
fi

# Collision detected — report details and fail
echo "❌ FAIL: Cross-file UUID collisions detected!"
echo ""
echo "The following UUIDs are shared by multiple test files:"
echo "This will cause silent data corruption in the shared test database."
echo ""

for uuid in $COLLISIONS; do
    echo "UUID: $uuid"
    echo "  Used by:"
    grep "^$uuid " "$TEMP_UNIQUE" | awk '{print "    - " $2}' | sort -u
    echo ""
done

echo "=== REMEDIATION ==="
echo "Assign a unique 4-character prefix to each test file (e.g., 5a0b, 5b0b, ...)."
echo "See docs/test-fixture-uuid-collision-audit.md for the namespace registry."
echo ""
echo "To fix: Replace the colliding UUIDs in the affected files with file-unique prefixes,"
echo "preserving the middle+suffix to maintain intra-file FK relationships."

exit 1
