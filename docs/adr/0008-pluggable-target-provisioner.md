# ADR-0008: Pluggable TargetProvisioner (manual + API)

- **Status:** Accepted
- **Date:** 2026-06-20

## Context
Soverin's provisioning API + white-label sit on the hoster/reseller tier, not SMB. We want both no-partnership and zero-touch paths, across multiple targets.

## Decision
Define a **`TargetProvisioner` interface** with `ManualProvisioner` (guides the owner + verifies connectivity; fits self-host and early managed) and `ApiProvisioner` (auto-provision via a reseller/hoster API; zero-touch for the managed service). Same interface for Nextcloud (OCS) and future targets.

## Consequences
- Ship Manual first; add API later without changing callers.
- Maps cleanly onto editions (self-host -> manual; managed -> API).

## Alternatives considered
- Hard-coding Soverin API: rejected — requires a partnership and locks to one target.
