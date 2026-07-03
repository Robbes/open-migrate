# ADR-0006: O365 access model

- **Status:** Accepted
- **Date:** 2026-06-20

## Context
We read from many O365 tenants (org/SMB and individuals), including shared mailboxes, while minimizing privilege and onboarding friction.

## Decision
Publish **one multi-tenant Entra app**. Use **application permissions + Application Access Policy** (token scoped to in-scope mailboxes) for org/SMB tenants; **delegated permissions** for individuals/family. Mail read path: **IMAP + OAuth2 (imapsync) primary**, **Microsoft Graph fallback** when IMAP is disabled per mailbox (runtime detection). Files/rich data via Graph; cal/contacts via DavMail->vdirsyncer or Graph.

## Consequences
- One admin consent enables reading all/shared mailboxes for org tenants.
- Application Access Policy keeps it least-privilege.
- Requires Microsoft Publisher Verification (and possibly app compliance) — see backlog.

## Alternatives considered
- Per-customer app registration: more setup, less central trust.
- Graph-primary for mail: more custom code than imapsync over IMAP.
