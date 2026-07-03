# ADR-0013: English for development; bilingual (EN+NL) end-user UI

- **Status:** Accepted
- **Date:** 2026-06-20

## Context
The project is built with coding agents and may attract international contributors; the initial end-user audience is Dutch and English speaking.

## Decision
**English** is the language for code, comments, documentation and ADRs. The **end-user UI and interaction are bilingual: English + Dutch** (full i18n, locale-aware formatting, bilingual notifications and cutover comms templates).

## Consequences
- Lower contributor barrier; consistent docs.
- UI must be built i18n-first; copy maintained in EN + NL.

## Alternatives considered
- Dutch-first: rejected — limits contribution and reuse.
