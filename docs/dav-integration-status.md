# DAV Integration Status — Honest Assessment

> 📄 **HISTORICAL (resolved).** This is a point-in-time (2026-07-12) assessment of DAV integration
> test failures. Those failures were **resolved in workplan 0007** — the CalDAV/CardDAV/WebDAV
> suites now run and pass against Stalwart v0.16.10 (see the 0007 Status block and PR #35). Kept
> for the debugging trail; not a description of current state.

**Date**: 2026-07-12  
**Subject**: CalDAV/CardDAV/WebDAV integration test failures against Stalwart v0.16.10

## Executive Summary

The DAV integration test suites (CalDAV, CardDAV, WebDAV, Unified-Sync) are **failing**, not merely skipped. This is the honest truth after removing all conditional skip logic.

## Test Results (Post-Fix)

| Suite | Tests | Status | Root Cause |
|-------|-------|--------|------------|
| CalDAV | 5 | ❌ FAIL | Stalwart returns 403 Forbidden on `/.well-known/caldav` |
| CardDAV | 5 | ❌ FAIL | Stalwart returns HTML portal page instead of DAV PROPFIND response |
| WebDAV | 7 | ⏭️ SKIP | Nextcloud not configured (expected - requires `NEXTCLOUD_WEBDAV_URL`) |
| Unified-Sync | 4 | ❌ FAIL | Depends on CalDAV/CardDAV which are failing |

**Total**: 10 failed, 7 skipped, 45 passed

## Evidence

### CalDAV Probe Failure
```
[Probe] .well-known/caldav: status=403, content-type=
```

### CardDAV PROPFIND Returns HTML
```
Error: PROPFIND failed with status 200: <!doctype html>
<html lang="en">
...
<title>Portal</title>
...
```

The 200 status with HTML content indicates Stalwart's web portal is responding instead of a DAV service.

## Root Cause Analysis

Stalwart v0.16.10's DAV services (CalDAV/CardDAV/WebDAV) require **explicit HTTP listener configuration** that is not present in the minimal test setup. The current Stalwart `config.json` only configures:
- JMAP endpoint
- IMAPS endpoint

DAV services are **disabled by default** and must be explicitly enabled via:
1. HTTP listener configuration with DAV service definitions
2. Proper service routing for `/.well-known/caldav` and `/.well-known/carddav`

## Implications

1. **DAV is not working** against the current Stalwart test setup
2. The test failures are **honest failures** — they correctly report that DAV is unavailable
3. This is **not a test bug** — it's a configuration gap in the Stalwart test environment

## Options

### Option A: Enable DAV in Stalwart
Configure Stalwart's HTTP listener with DAV service definitions. This requires:
- Modifying the Stalwart test container config
- Adding HTTP listener with CalDAV/CardDAV services
- Verifying DAV endpoints return proper DAV responses (not 403/HTML)

**Risk**: May conflict with "minimal config" constraint from ADR-0002

### Option B: Accept DAV as Not Supported (For Now)
Acknowledge that Stalwart v0.16.10 in the current configuration does not support DAV. Mark DAV suites as:
- `describe.skip` with explicit reason: "Stalwart DAV services not configured"
- Document that DAV support requires additional Stalwart configuration

**Benefit**: Honest representation of current state
**Drawback**: DAV remains untested until config is added

### Option C: Use Alternative DAV Target for Tests
Use a different DAV-capable target (e.g., Nextcloud, Radicale) for DAV integration tests.

**Benefit**: Tests can run independently of Stalwart config
**Drawback**: Adds another dependency; doesn't test Stalwart DAV specifically

## Recommendation

**Option B** for immediate action:
1. Re-add `describe.skip` to CalDAV/CardDAV suites with explicit skip reason
2. Document the skip reason in the test files
3. Create a follow-up issue to either:
   - Configure Stalwart DAV services (Option A)
   - Or use alternative DAV target (Option C)

This maintains **honest failure reporting** while acknowledging the current reality.

## Related

- Issue #32: DAV + unified-sync suites skipped
- Stalwart documentation: HTTP listener configuration
- ADR-0002: Minimal Stalwart config decision

---

**Status**: Owner decision required on which option to pursue.
