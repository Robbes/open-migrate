# ADR-0012: Prefer Microsoft Graph; avoid EWS/DavMail

- **Status:** Accepted
- **Date:** 2026-06-20

## Context
Microsoft is retiring Exchange Web Services (enforcement begins in 2026) and shipped Graph-based migration APIs (Mailbox Import/Export GA 2026). DavMail relies on EWS.

## Decision
Use **Microsoft Graph** for calendar/contacts and rich OneDrive/SharePoint extraction; use **IMAP + OAuth2 (XOAUTH2)** for mail (primary, via imapsync) with Graph as fallback. **Do not use DavMail/EWS** — it is a liability as EWS is retired.

## Consequences
- Durable, supported source access; granular least-privilege scopes.
- Calendar/contacts extraction is via Graph rather than a CalDAV/CardDAV gateway.

## Alternatives considered
- DavMail (EWS->CalDAV/CardDAV/IMAP): rejected — EWS retirement risk.
- Graph-primary for mail: more custom code than imapsync over IMAP.
