// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

/**
 * Regression tests for the membership access-control guards (review findings on
 * members.ts: broken last-owner protection, broken self-removal, owner-grant
 * escalation).
 */

import { describe, it, expect } from 'vitest';
import {
  demotesLastOwner,
  removesLastOwner,
  grantsOwnerWithoutPermission,
  isSelfRemoval,
} from './member-guards';

describe('demotesLastOwner', () => {
  it('blocks demoting the sole owner (the bug: this used to slip through)', () => {
    expect(demotesLastOwner('owner', 'member', 1)).toBe(true);
    expect(demotesLastOwner('owner', 'admin', 1)).toBe(true);
  });
  it('allows demoting an owner when another owner remains', () => {
    expect(demotesLastOwner('owner', 'member', 2)).toBe(false);
  });
  it('allows role changes that keep or grant owner, and non-owner changes', () => {
    expect(demotesLastOwner('owner', 'owner', 1)).toBe(false); // no-op / stays owner
    expect(demotesLastOwner('member', 'admin', 1)).toBe(false); // target isn't an owner
    expect(demotesLastOwner('admin', 'owner', 0)).toBe(false); // promotion, not demotion
  });
});

describe('removesLastOwner', () => {
  it('blocks removing the sole owner', () => {
    expect(removesLastOwner('owner', 1)).toBe(true);
  });
  it('allows removing an owner when others remain, and any non-owner', () => {
    expect(removesLastOwner('owner', 3)).toBe(false);
    expect(removesLastOwner('member', 1)).toBe(false);
  });
});

describe('grantsOwnerWithoutPermission', () => {
  it('blocks a non-owner (e.g. admin) from granting owner', () => {
    expect(grantsOwnerWithoutPermission('owner', 'admin')).toBe(true);
    expect(grantsOwnerWithoutPermission('owner', undefined)).toBe(true);
  });
  it('allows an owner to grant owner, and any requester to set non-owner roles', () => {
    expect(grantsOwnerWithoutPermission('owner', 'owner')).toBe(false);
    expect(grantsOwnerWithoutPermission('admin', 'admin')).toBe(false);
  });
});

describe('isSelfRemoval', () => {
  it('matches on user id (not the membership row id)', () => {
    expect(isSelfRemoval('user-1', 'user-1')).toBe(true);
    expect(isSelfRemoval('user-1', 'user-2')).toBe(false);
  });
  it('is false when either id is missing', () => {
    expect(isSelfRemoval(undefined, 'user-1')).toBe(false);
    expect(isSelfRemoval('user-1', undefined)).toBe(false);
  });
});
