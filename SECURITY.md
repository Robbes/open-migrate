# Security Policy

## Reporting
Report vulnerabilities privately to the maintainers (add contact). Do not open public issues for security reports.

## Principles
- **Secrets** never live in git. OAuth tokens / API keys / DB creds go in a vault; `.env` is gitignored.
- **Least privilege** for source access (O365 Application Access Policy scoped to in-scope mailboxes; read-only for one-way mirror).
- **Non-destructive defaults**; deletions never auto-propagate.
- **Tenant isolation** in the managed edition (Postgres RLS, per-tenant secret scope, per-tenant rate budgets).
- **Trust boundary:** data-plane workers may briefly hold plaintext during copy - minimize at-rest staging, encrypt spool, short TTL, TLS everywhere. Proton Bridge (if used) is self-host/local only.
- **Self-hosted CI runner:** trusted workflows only (docker socket + root = RCE risk).
- **Supply chain:** pin dependencies, Renovate updates, sign release images, publish an SBOM.

A full threat model is tracked in the architecture backlog (docs/architecture/solution-architecture.md, section 26).
