// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

/**
 * Pre-sync discovery snapshot for one domain (workplan 0013). A **read-only, body-free** count of
 * what a source holds — shown to the owner before they green-light the migration (SAD §11.2 "scope
 * manifest, shown before start"). Point-in-time only: the authoritative reconciliation stays the
 * cutover verification gate (§9/§14).
 */
export interface DomainDiscovery {
  /** Number of source collections (mail folders / calendars / address books / drives). */
  readonly collections: number;
  /** Total items across all collections (messages / events / contacts / files). */
  readonly items: number;
  /** Total bytes, when the listing carries per-item sizes cheaply (mail/files); omitted otherwise. */
  readonly bytes?: number;
  /** Optional per-collection breakdown, in listing order. */
  readonly perCollection?: ReadonlyArray<DiscoveryCollection>;
}

/** One collection's discovery counts. */
export interface DiscoveryCollection {
  /** Human label for the collection (folder name/path). */
  readonly name: string;
  /** Item count in this collection. */
  readonly items: number;
  /** Byte total for this collection, when available. */
  readonly bytes?: number;
}

/** The four sync domains discovery covers. */
export type DiscoveryDomain = 'email' | 'calendar' | 'contact' | 'file';

/** A stored discovery result for one domain (T2). Extends the counts with persistence metadata. */
export interface DiscoveryRecord extends DomainDiscovery {
  readonly domain: DiscoveryDomain;
  /** ISO 8601 timestamp of the most recent discovery pass for this domain. */
  readonly discoveredAt: string;
  /** Verbatim error from the last pass, if it failed (§11.2 honest passthrough); else absent. */
  readonly lastError?: string;
}
