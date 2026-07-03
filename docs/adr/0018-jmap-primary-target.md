# ADR-0018: JMAP is the primary target protocol; IMAP/DAV is the parallel second family

- **Status:** Accepted
- **Date:** 2026-06-21
- **Supersedes:** the earlier "JMAP as a roadmap/planned adapter" framing.

## Context
A growing class of EU sovereign suites — **La Suite numérique** (DINUM) and its SaaS resellers (**mosa.cloud**, the Dutch **MijnBureau**) — are **JMAP-first and deliberately omit IMAP** (the La Suite *Messages* brick states "no POP3 or IMAP, by design"). **JMAP** (RFC 8620/8621, plus JMAP for Calendars/Contacts/Files) is the modern, JSON-over-HTTP open successor to IMAP/CalDAV/CardDAV/WebDAV, with superior native delta-sync. Meanwhile, **OX-based suites (openDesk)** and **Soverin** speak classic **IMAP/CalDAV/CardDAV/WebDAV**.

## Decision
- Build the **JMAP target adapter first**; ship the **IMAP/CalDAV/CardDAV/WebDAV** target family in parallel. **Both are in the MVP.**
- JMAP applies to the **target write-path** and the internal normalized model. The **O365 source remains IMAP+OAuth2/Graph** — Microsoft has no JMAP, so source extraction is unchanged (ADR-0006/0012).
- **Reference target: Stalwart** (speaks both JMAP and IMAP/DAV) for local dev/e2e; **real targets:** mosa.cloud (JMAP) and openDesk (OX over IMAP/DAV).
- **Engine:** a JMAP writer on a JS client (e.g. jmap-jam). For the initial bulk copy, reuse the existing **one-shot JMAP migration utility** (imports from IMAP/CalDAV/CardDAV/WebDAV/Exchange/Takeout into a JMAP server, much like imapsync); **incremental shadow** uses JMAP change-tracking (`/changes`, state strings) against the ledger.
- **Mail leads.** JMAP for Calendars/Contacts/Files is newer (Stalwart since late 2025), so those follow mail.

## Consequences
- Aligns the stack with the direction EU sovereign suites are actually taking; unlocks mosa.cloud/La Suite/MijnBureau as **primary** targets, with OX/Soverin reached via DAV.
- One reference server (Stalwart) exercises both target families in tests.
- The connector layer stays protocol-pluggable behind one interface.
- **Risks:** JMAP for cal/contacts/files is less widely implemented than DAV; JMAP tooling is less battle-tested than imapsync. Mitigations: Stalwart as a complete reference, the one-shot migration utility for bulk, and the idempotency property test as the acceptance gate.

## Alternatives considered
- **IMAP/DAV-first** (JMAP later): rejected — delays the JMAP-first sovereign targets that motivate the project.
- **JMAP-only**: rejected — excludes OX-based openDesk and Soverin, which are IMAP/DAV.
