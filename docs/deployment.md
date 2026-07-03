# Deployment

Canonical doc. Summarises how the stack is deployed; full rationale in `architecture/solution-architecture.md` §7, §18, §22.1.

## Editions (one core)
- **Managed:** Trigger.dev (self-host or cloud) + managed Postgres (with RLS) + S3-compatible EU object storage + secrets vault (OpenBao/Infisical) + identity (Zitadel/Keycloak); IaC/GitOps (OpenTofu + Helm + Argo CD/Flux), Renovate.
- **Self-host:** Docker Compose or a Home Assistant add-on; **in-process scheduler** (no Trigger.dev); SQLite or a small Postgres; OS keychain / age-encrypted secrets. Targets remain managed EU/CH platforms (self-hosted email is permitted but user-operated, ADR-0011).

## Windows 11 & desktop tray (ADR-0019)
- **Today:** the self-host container runs on **Windows 11 via Docker Desktop + WSL2** (web UI in a browser) — no extra code. Recommended Windows path.
- **Planned (optional):** a **Tauri** system-tray app (tray icon, start-on-login, background service) wrapping the Node service + web UI — chosen over Electron for footprint/arm64. Not MVP.
- The **JMAP-first mail path is binary-free** (most portable); IMAP/DAV/files paths (imapsync especially) may need WSL2 or a bundled runtime on native Windows. Prefer JS-native engines where fidelity is equal.

## Dev / e2e stack
`deploy/compose/dev.yml` — Postgres (ledger) + **Stalwart** (reference target: JMAP **and** IMAP/SMTP/CalDAV/CardDAV/WebDAV) + Nextcloud (secondary DAV/files target). Light by design. **Trigger.dev is added later** from the official templates (github.com/triggerdotdev/docker); the first slice needs only Postgres + Stalwart.

## Release controls (see §22.1)
- SemVer; one release train; `CHANGELOG.md` + upgrade guide per release.
- **Migrations on startup behind a lock** (Drizzle Kit; Atlas lint in CI); the app refuses to start if the schema is newer than it understands.
- **Multi-arch images (amd64+arm64), signed (cosign), with an SBOM (syft)**; consumers pin by digest.
- **Release channels:** `stable` (default) and `edge`/`beta` (opt-in); self-host updates via image tags; back up the ledger before upgrading; never run two app versions against one database.
- Managed: staged/canary rollout, DB backup before migrate, roll-forward preferred over schema rollback.

## EU/CH provider options
Scaleway, OVHcloud (incl. SecNumCloud), Exoscale, StackIT, IONOS, Open Telekom Cloud, UpCloud, Elastx, Leafcloud; Aiven for managed data; Hetzner for cheap IaaS.
