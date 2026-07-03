# ADR-0007: Reuse proven engines + a Graph rich extractor; no commercial SharePoint tools

- **Status:** Accepted
- **Date:** 2026-06-20

## Context
We want high-fidelity, idempotent transfer without reinventing sync, and "as complete as possible" extraction from OneDrive/SharePoint — but the destination (Nextcloud) is not a SharePoint clone.

## Decision
Shell out to **imapsync** (mail), **vdirsyncer** (cal/contacts), **rclone** (files). Build a custom **Microsoft Graph extractor** for the rich layer (versions, permissions, metadata, lists, pages); optionally use **PnP** (MIT) for deep SharePoint structure and **libpst** for PST archives. **Do not** use Metalogix/ShareGate/AvePoint/MetaVis (closed, costly, SharePoint->SharePoint oriented, wrong fit). See solution-architecture.md section 13.1.

## Consequences
- Less code, proven idempotency; open-source throughout.
- "Complete" = extract everything of value and land it sensibly; inventory + flag what cannot map.

## Alternatives considered
- Commercial SP migration suites: rejected (closed, costly, wrong destination).
- Reimplementing sync engines: rejected (cost/risk).
