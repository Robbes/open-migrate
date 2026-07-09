# ADR-0022: IMAP Dependency Security Strategy

**Status:** Accepted  
**Date:** 2026-07-08  
**Authors:** OpenHands Agent  
**Supersedes:** None

## Context

The project uses `imap-simple` as the IMAP client library for connecting to O365 and generic IMAP servers. This library has a transitive dependency chain that includes `utf7@1.0.2`, which depends on `semver@5.3.0`.

**Vulnerability:** CVE-2022-25883 (Prototype Pollution in semver@5.3.0)
- **Severity:** Low to Medium
- **Affected Package:** `semver@5.3.0`
- **Dependency Path:** `imap-simple` → `imap` → `utf7` → `semver@5.3.0`
- **Impact:** Prototype pollution could potentially lead to denial of service or code execution in specific contexts

## Decision

We will use **pnpm overrides** to force the use of a patched `semver` version (`^7.5.2`) throughout the dependency tree, rather than immediately migrating to a different IMAP library.

### Implementation

In `pnpm-workspace.yaml`:
```yaml
overrides:
  semver: ^7.5.2
```

This ensures that all packages, including transitive dependencies, use the secure `semver@7.8.5` (or later 7.x version) instead of the vulnerable `5.3.0`.

## Consequences

### Positive
- **Immediate remediation:** The vulnerability is eliminated without code changes
- **Low risk:** No breaking changes to existing functionality
- **Fast implementation:** Resolved in minutes
- **Maintainable:** Documented in workspace configuration
- **Cost-effective:** No development time required for migration

### Negative
- **Temporary workaround:** The underlying `utf7` package still has the vulnerable dependency declaration
- **Future maintenance:** If `imap-simple` or `utf7` are deprecated, migration will still be needed
- **Security scanner noise:** Some scanners may still flag the dependency chain even though the actual version used is patched

### Alternatives Considered

**Option 1: Ignore the vulnerability**
- Rejected: Even low-severity vulnerabilities should be addressed, especially when easy fixes exist

**Option 2: pnpm override (Selected)**
- Pros: Immediate fix, no code changes, low risk
- Cons: Temporary workaround, doesn't address root cause

**Option 3: Migrate to `imapflow`**
- **Pros:** 
  - Modern, actively maintained library (last update: July 2026)
  - No vulnerable dependencies
  - Better TypeScript support
  - More features (async iterators, mailbox locking, etc.)
- **Cons:**
  - Significant code refactoring required
  - API differences require testing
  - Higher risk of introducing bugs
  - Takes days/weeks to complete

**Option 4: Fork and patch `utf7`**
- Rejected: Overly complex, creates maintenance burden

## Future Consideration

If the project requires long-term maintenance of IMAP functionality, consider migrating to **imapflow** (https://github.com/andris9/imapflow):

- Modern, actively maintained (weekly updates)
- No vulnerable dependencies
- Better TypeScript support with built-in type definitions
- More features: async iterators, mailbox locking, SOCKS proxy support
- Cleaner API design with promise-based interface

Migration would involve:
1. Replacing `imap-simple` with `imapflow` in `packages/connectors/package.json`
2. Refactoring `packages/connectors/src/imap-source.ts` to use `ImapFlow` API
3. Refactoring `packages/connectors/src/imap-dav-target.ts` to use `ImapFlow` API
4. Comprehensive testing of IMAP operations (list folders, search, fetch, append)
5. Update documentation

This migration is **not urgent** given the pnpm override fix, but should be considered for:
- Major version upgrades of `imap-simple`
- Addition of new IMAP features
- Long-term maintenance strategy

## References

- CVE-2022-25883: https://nvd.nist.gov/vuln/detail/CVE-2022-25883
- pnpm overrides documentation: https://pnpm.io/next/settings#overrides
- imapflow library: https://github.com/andris9/imapflow
- imap-simple (deprecated): https://www.npmjs.com/package/imap-simple
