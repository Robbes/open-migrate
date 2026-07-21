// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

import { describe, it, expect } from 'vitest';
import { startTransition } from './lifecycle';

describe('startTransition', () => {
  it('activates a paused (draft) mapping', () => {
    expect(startTransition('paused')).toEqual({ activate: true });
  });

  it('is idempotent for a mapping already active (no re-activation)', () => {
    expect(startTransition('active')).toEqual({ activate: false });
  });

  it('refuses a mapping already in cutover', () => {
    const result = startTransition('cutover');
    expect(result).toHaveProperty('conflict');
    expect((result as { conflict: string }).conflict).toMatch(/cutover/i);
  });

  it('refuses a mapping already done', () => {
    const result = startTransition('done');
    expect(result).toHaveProperty('conflict');
    expect((result as { conflict: string }).conflict).toMatch(/done/i);
  });
});
