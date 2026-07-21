// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

/**
 * Static scope manifest (SAD §11.2) — "what migrates, what doesn't, and why", shown on the
 * pre-sync confirm screen alongside the live discovery counts (workplan 0013). Explicit and
 * readable: no silent omissions. Versioned so the UI can note when the promise set changes.
 */

export interface ScopeManifestEntry {
  /** Short label (e.g. "Email", "Teams chat"). */
  readonly item: string;
  /** One-line note on coverage / caveats. */
  readonly detail: string;
}

export interface ScopeManifest {
  /** Bump when the promise set changes. */
  readonly version: string;
  /** Fully migrated. */
  readonly migrates: ReadonlyArray<ScopeManifestEntry>;
  /** Migrated with known limitations. */
  readonly partial: ReadonlyArray<ScopeManifestEntry>;
  /** Explicitly NOT migrated (named, per §11.2 "no silent omissions"). */
  readonly doesNotMigrate: ReadonlyArray<ScopeManifestEntry>;
}

export const SCOPE_MANIFEST: ScopeManifest = {
  version: '2026-07-21',
  migrates: [
    { item: 'Email', detail: 'Folders incl. Sent / Drafts / Archive, flags/keywords, timestamps.' },
    { item: 'Calendar', detail: 'Events, recurrence, attendees (ICS).' },
    { item: 'Contacts', detail: 'Address books and contacts (vCard).' },
    { item: 'Files', detail: 'OneDrive / SharePoint document libraries (files + folders).' },
    { item: 'Shared mailboxes', detail: 'Pattern S — the shared store is copied.' },
    { item: 'Distribution lists', detail: 'Pattern D — the group definition + member list (no separate store).' },
  ],
  partial: [
    { item: 'Permissions', detail: 'Inventoried and guided; only the clean, reversible subset is auto-applied (§14.2).' },
    { item: 'SharePoint extras', detail: 'Metadata/columns, version history and lists are best-effort (§13.1).' },
    { item: 'Proton calendar/contacts', detail: 'ICS / vCard snapshots only.' },
  ],
  doesNotMigrate: [
    { item: 'Teams chat & calls', detail: 'Not migrated.' },
    { item: 'Planner', detail: 'Not migrated.' },
    { item: 'Power Automate', detail: 'Not migrated.' },
    { item: 'InfoPath', detail: 'Not migrated.' },
    { item: 'OneNote', detail: 'Not migrated unless set up separately.' },
    { item: 'Retention holds', detail: 'Not migrated.' },
    { item: 'Other O365 apps', detail: 'No sovereign equivalent — not migrated.' },
  ],
};
