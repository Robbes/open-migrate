# ADR-0002: Implementation language is TypeScript

- **Status:** Accepted
- **Date:** 2026-06-20

## Context
The project is built with a coding agent (OpenHands) and must integrate Trigger.dev, Microsoft Graph, and WebDAV/CalDAV/CardDAV libraries. Heavy data movement is delegated to external engine binaries.

## Decision
Use **TypeScript (Node, pnpm workspaces)** for the control plane, workers, scheduler, connectors, and UI. Engines (imapsync/rclone/vdirsyncer) are invoked via shell-out.

## Consequences
- First-class SDKs: Trigger.dev, `@microsoft/microsoft-graph-client` + MSAL, `webdav`/`tsdav`.
- Strong agent ergonomics and typing.
- No single static binary, but self-host ships as a container, so this is moot.

## Alternatives considered
- Go: better single-binary self-host, weaker fit for the chosen orchestrator/SDKs and agent workflow.
- Python: rich libs, but TS preferred for the unified stack + UI.
