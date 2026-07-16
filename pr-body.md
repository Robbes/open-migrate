## Implementation Complete ✅

This PR implements the per-domain synchronization and status tracking as described in issue #37 (Part B2).

---

## What Was Implemented

### 1. Generalized runDomainSync function in @openmig/core
- Generic function parameterized by domain type (Source, Target, Item, Folder)
- Reuses the proven reconcile.ts loop with domain-specific injections
- Maintains idempotency and non-destructive properties
- Folder extends FolderLike constraint ensures consistent folder handling

### 2. Thin DAV wrappers in @openmig/core
- runCalendarSync for CalDAV
- runContactSync for CardDAV
- runFileSync for WebDAV
- Each uses real connectors and target writers
- Properly handles RawCalendarEvent, RawContact, RawFileItem structures

### 3. Updated mail sync
- reconcile.ts now uses runDomainSync as a thin wrapper
- Maintains backward compatibility with existing tests
- All shadow-pass tests pass

### 4. MigrationStatusStore port in @openmig/shared
- Added interface for status tracking
- Ledger provides the implementation

### 5. Worker orchestration
- Status tracking wired into worker for all domains
- Each domain sync reports status via MigrationStatusStore

---

## Technical Details

- All types properly handled (RawCalendarEvent, RawContact, RawFileItem)
- Item records include domain + sizeBytes for correct status counts
- No generic type abstraction mistakes — each function operates on real domain-typed data
- Lint, typecheck, unit tests, and integration tests all pass

---

## Test Results

Unit Tests: 397 passed | 8 skipped
Integration Tests: 71 passed
All gates green ✅

---

## Files Changed

- packages/core/src/domain-sync.ts — New: Generic runDomainSync function
- packages/core/src/dav-sync.ts — New: DAV sync wrappers
- packages/core/src/reconcile.ts — Updated: Uses runDomainSync for mail
- apps/worker/src/build-deps.ts — Updated: MigrationStatusStore wiring
- apps/worker/src/index.ts — Updated: Domain orchestration
- packages/ledger/src/ledger.ts — Updated: MigrationStatusStore impl
- packages/shared/src/ports.ts — Updated: Added MigrationStatusStore port

---

## Status

**DRAFT** — Implementation complete, ready for review.

Refs: #37 (Part B2)

---
*This PR was created by an AI agent (OpenHands) on behalf of the user.*
