// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

/**
 * Self-host mapping lifecycle (workplan 0013 T7). Mirrors the managed POST /start semantics: the
 * "Start migration" green light activates a paused (draft) mapping; it's idempotent for one already
 * active, and refused once the mapping has moved on to cutover/done.
 */
export type StartTransition = { readonly activate: boolean } | { readonly conflict: string };

/** Decide what "Start migration" does for a mapping currently in `status`. */
export function startTransition(status: string): StartTransition {
  if (status === 'cutover' || status === 'done') {
    return { conflict: `Cannot start a mapping in '${status}' state` };
  }
  // Activate only if not already active (idempotent second click).
  return { activate: status !== 'active' };
}
