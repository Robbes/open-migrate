// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

/**
 * Derive a stable, URL-safe collection slug for a DAV target from a source folder's
 * name (preferred) or its path's last segment.
 *
 * Why: in a real migration the domain-sync loop hands the target writer the SOURCE
 * folder (e.g. `/remote.php/dav/calendars/alice/personal/`). The target writer must
 * NOT reuse that path verbatim — it belongs to the source account/server. Instead we
 * re-home the collection under the target's own account, keyed by a slug of the source
 * folder so the same source collection always maps to the same target collection
 * (idempotent, and adopts a pre-existing collection of that name on the target).
 *
 * The slug is lowercased, non-alphanumeric runs collapse to '-', and leading/trailing
 * '-' are trimmed — matching the lowercase URI segments servers like Nextcloud/SabreDAV
 * use for their auto-created `personal`/`contacts` collections, so a source "Personal"
 * cleanly adopts the target's existing `personal` calendar.
 */
export function collectionSlug(
  name: string | undefined,
  path: string | undefined,
  fallback: string,
): string {
  const raw = (name && name.trim()) || lastSegment(path) || fallback;
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : fallback;
}

/** Last non-empty '/'-separated segment of a path (trailing slashes ignored). */
function lastSegment(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const parts = path.split('/').filter((p) => p.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : undefined;
}
