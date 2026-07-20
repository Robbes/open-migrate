# Workplan 0011 T3 remainder — non-mail sync domains (handoff)

**Status:** cutover/rollback jobs are now real (this PR). The **calendar/contact/file
sync domains are still stubbed** — this note scopes that remaining work.

## The gap
The managed delta/full-sync jobs only sync **mail**. In `apps/worker/src/jobs/run-delta-sync.ts`
the `email` domain calls `runShadowPass`; `calendar`/`contact`/`file` log "not yet implemented".
The root cause is `apps/worker/src/build-deps-from-mapping.ts`:

```ts
export async function buildDomainDepsFromMapping(pool, tenantId, mappingId, _domain) {
  // Delegates to buildDepsFromMapping (MAIL only) and ignores _domain.
}
```

It ignores the domain and returns the mail source/target.

## What "done" looks like
`buildDomainDepsFromMapping` builds **domain-typed** deps from the DB-stored connection:
- **calendar** → `CalendarSource` (CalDAV) + calendar `TargetWriter`,
- **contact** → `ContactSource` (CardDAV) + contact `TargetWriter`,
- **file** → `FileSource` (WebDAV) + file `TargetWriter`,

then `run-delta-sync.ts` / `run-full-sync.ts` call the generalized `runDomainSync`
(`packages/core/src/domain-sync.ts`) for each enabled domain, recording metering the
same way the mail path does.

## Reuse — don't rebuild
The **config-file path already does this**: `apps/worker/src/build-deps.ts` exports
`buildDomainDeps(config, domain)` used by `runAllDomains` in `apps/worker/src/index.ts`
(0007, integration-tested against Stalwart). The native DAV connectors live in
`packages/connectors/src/{caldav,carddav,webdav}-source.ts`. The job path should build
the same connectors from the **DB** `connection.config` + decrypted credentials
(`SecretStore.decryptCredentials(connection.secretRef)`) instead of from the file config.

## Gotchas
- Credentials: connections store an encrypted `secret_ref` (see create-mapping); decrypt
  via `SecretStore`, don't read plaintext.
- DAV target kinds: `connection.kind` for targets is now protocol-based (`caldav`, `carddav`,
  `webdav`, `jmap`, `imap`); map to the right connector.
- Keep everything inside `withTenant` (RLS) as the mail path does.
- Per-domain scope lives in `scope_selection`; honor `included`.
- Stalwart rules per `docs/stalwart-integration-fix.md`; integration tests need Testcontainers.

## Out of scope (owner decisions)
- DNS provider **writes** stay deferred (verify-only DNS, 2026-07-16).
