# Workplan 0002 — IMAP/DAV Target Family (O365 → Soverin / openDesk mail)

---

## Status

**Status:** ✅ **COMPLETE**  
**Completed:** 2026-07-08  
**PR:** https://github.com/Robbes/open-migrate/pull/21  
**Branch:** feat/imap-dav-target-implementation (merged & deleted)

**Gates:**
- ✅ Lint: `pnpm lint` passes
- ✅ Typecheck: `pnpm typecheck` passes  
- ✅ Unit Tests: `pnpm test` passes
- ✅ Integration Tests: `pnpm test:integration` passes (24/24 tests)

**Evidence:**
- All 24 integration tests passing (JMAP + IMAP targets, ledger, shared mailboxes)
- Idempotency verified: re-run creates 0 messages
- Delta handling verified: adding 1 message creates exactly 1
- Flag preservation verified (`\Seen`, `\Answered`, etc.)
- INTERNALDATE preservation verified
- `buildTargetWriter` now supports both `jmap` and `imap-dav` target types
- Comprehensive provider documentation created (`docs/target-providers.md`)

---

> **Sketch for later** — refine before handing to the agent. Depends on **0001** (the JMAP slice)
> being green: 0002 reuses the same `SourceConnector`, reconcile loop, ledger, cursors, Pattern-S
> handling, scheduler, and the idempotency/delta property tests. The only genuinely new piece is a
> second `TargetWriter`. (ADR-0018: IMAP/DAV is the parallel second target family.)

## Goal / Definition of Done
The same one-way, non-destructive, **idempotent mail mirror** as 0001, but writing to an **IMAP/SMTP
target** (Soverin, or openDesk / Open-Xchange) instead of JMAP. The reconcile loop, ledger, cursors,
Pattern-S mapping, and scheduler are unchanged; only an `ImapDavMailTarget` implementation of
`TargetWriter` is added. The **idempotency property test must pass against the IMAP target too**
(run twice → zero creates; Sent + flags preserved).

## Approach
- Implement `TargetWriter` over **IMAP APPEND** for mail. Two complementary paths:
  - **Bulk:** shell out to **imapsync** (proven; ADR-0007) for the initial copy where it is faster.
  - **Incremental:** a thin IMAP client doing `APPEND`, idempotency gated by the **ledger**, keyed on
    the same `natural_key_hash` (Message-ID) used in 0001.
- Map special-use folders (RFC 6154) on the target (ensure/create **Sent**, etc.); preserve
  keywords/flags and `INTERNALDATE` on `APPEND`.
- Target is chosen from the **same mapping config** as 0001 — just a different target `type`.
- **Stalwart stays the dev reference** (it also speaks IMAP/SMTP/DAV), so e2e can point at the same
  container; a real Soverin/openDesk account is exercised only in a manual/secret-gated run.

## Tasks (sketch)
- **U1 — IMAP/DAV mail target.** `ImapDavMailTarget implements TargetWriter`: connect (IMAP+OAuth2 or
  LOGIN), `ensureMailbox` (create + set special-use where the server supports it), `upsertEmail` via
  `APPEND`, ledger-gated for idempotency; preserve flags + `INTERNALDATE`.
  *Acceptance:* write N messages to a target IMAP account on Stalwart; re-run creates 0; Sent + flags preserved.
- **U2 — imapsync bulk path (optional).** Wrap imapsync for the initial bulk copy; reconcile + ledger
  still own idempotency and the incremental delta.
  *Acceptance:* bulk copy followed by an incremental pass converges with no duplicates.
- **U3 — Target selection wiring.** Mapping config selects `jmap` vs `imapdav`; the reconcile loop is
  unchanged. Parametrize the 0001 idempotency/delta property tests over **both** target types.
  *Acceptance:* the same mapping runs against both target types from config; the property tests are green for both.
- **U4 — Provider specifics (Soverin / openDesk).** Handle quirks (folder naming, special-use
  advertisement, throttling/limits); document per-provider notes.
  *Acceptance:* a manual/secret-gated smoke run against a real Soverin/openDesk test account mirrors INBOX + Sent idempotently.

## Out of scope (this slice)
- **Calendar / contacts / files** over CalDAV/CardDAV/WebDAV (vdirsyncer/rclone) → **slice 0003**
  (kept out here to stay symmetric with the mail-only 0001).
- Microsoft Graph rich extractor; Pattern-D distribution lists; two-way; cutover UI; managed edition.

## Reuse vs new
- **Reuses:** `SourceConnector` (O365 IMAP+OAuth2), `Ledger`, reconcile loop + cursors, scheduler,
  Pattern-S mapping, and the idempotency + delta property tests (now parametrized over target type).
- **New:** one `TargetWriter` impl (`ImapDavMailTarget`) + an optional imapsync wrapper.
- **ADRs:** if "imapsync bulk + direct-APPEND incremental" becomes a firm decision, record it
  (e.g. ADR-0020).
