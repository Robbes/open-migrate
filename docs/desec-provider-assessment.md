# deSEC DNS Provider Assessment

## What it does

`packages/core/src/dns-provider-desec.ts` implements the `DnsProvider` interface using deSEC's REST API v1.

**Capabilities:**
- `getRecords(domain)` - Fetch all DNS records for a zone
- `updateRecords(records)` - Create/update/delete records via deSEC's RRset API
- `verifyRecords(domain, expected)` - Verify expected records exist
- `dryRun` mode - Print changes without applying

**Credentials:**
- Requires `DESEC_TOKEN` environment variable (deSEC API token)
- Optional `DESEC_DRY_RUN=true` for safe testing
- Token is passed as `Authorization: Token <token>` header

**API endpoints used:**
- `GET /v1/domains/{domain}/rrsets/` - List records
- `PATCH /v1/domains/{domain}/rrsets/` - Update records
- `DELETE /v1/domains/{domain}/rrsets/{type}/{name}` - Remove records

## Testing status

**No automated tests exist for deSEC provider.** The file has no corresponding `*.test.ts` file.

There is a `packages/core/src/dns-manager.unit.test.ts` that tests the `DnsManager` orchestrator, but it uses fakes, not the real deSEC provider.

## Provider swap impact

If the owner chooses a different provider, here's what changes:

### OVH Cloud DNS
- API: REST API with OAuth 1.0a authentication
- Endpoints: `/1.0/domain/zone/{zone}/record` (CRUD)
- Auth: consumerKey + OAuth signature (more complex than deSEC's token)
- SDK: `ovh` npm package available

### TransIP
- API: SOAP or REST (REST preferred)
- Endpoints: `/v6/domains/{domain}/dns`
- Auth: API key + private key (PEM format)
- No official npm SDK; requires custom implementation

### RFC 2136 (Dynamic DNS)
- Protocol: DNS UPDATE (RFC 2136) over UDP/TCP port 53
- No HTTP API; uses raw DNS protocol
- Requires TSIG key for authentication
- Implementation: `dns-updater` npm package or custom node-dns-lib
- **Major difference**: Not REST-based; requires different library entirely

### Common patterns across providers
All providers need:
1. Authentication credentials (token/key/secret)
2. Zone/domain management
3. Record CRUD operations
4. TTL handling
5. Priority handling for MX records

The `DnsProvider` interface abstraction allows swapping implementations without changing cutover logic.

## Current status

**NOT WIRRED TO PRODUCTION** - The deSEC provider is commented out in:
- `apps/worker/src/jobs/run-cutover.ts:128`
- `apps/worker/src/jobs/run-rollback.ts:77`

Per ADR-0002 and review finding C2, the first DNS provider choice is an **owner decision**, not an agent decision. This implementation was done unilaterally without owner approval.

## Recommendation

1. **Owner ratification required**: Confirm deSEC is acceptable, or choose OVH/TransIP/RFC 2136
2. **Add integration tests**: Create `dns-provider-desec.test.ts` with recorded fixtures
3. **Smoke test**: Manual test against throwaway deSEC zone before production use
4. **Secret management**: Ensure `DESEC_TOKEN` is properly vaulted (not in repo)
