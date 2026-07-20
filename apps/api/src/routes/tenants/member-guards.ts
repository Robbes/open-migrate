// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

/**
 * Pure access-control guards for tenant membership changes. Kept free of DB /
 * Express imports so they are cheaply unit-testable; the route supplies the
 * looked-up state (target member's current role, owner count).
 */

/**
 * True when changing `targetRole` → `newRole` would leave the tenant with zero
 * owners (demoting the sole remaining owner). ownerCount is the number of owners
 * currently in the tenant (including the target).
 */
export function demotesLastOwner(targetRole: string, newRole: string, ownerCount: number): boolean {
  return targetRole === 'owner' && newRole !== 'owner' && ownerCount <= 1;
}

/** True when removing a member with `targetRole` would leave the tenant with zero owners. */
export function removesLastOwner(targetRole: string, ownerCount: number): boolean {
  return targetRole === 'owner' && ownerCount <= 1;
}

/**
 * True when the request is trying to grant the `owner` role but the requester is
 * not an owner. Granting owner is owner-only (admins must not self-escalate).
 */
export function grantsOwnerWithoutPermission(newRole: string, requesterRole: string | undefined): boolean {
  return newRole === 'owner' && requesterRole !== 'owner';
}

/** True when the requester is trying to remove their own membership. */
export function isSelfRemoval(requesterUserId: string | undefined, targetUserId: string | undefined): boolean {
  return !!requesterUserId && requesterUserId === targetUserId;
}
