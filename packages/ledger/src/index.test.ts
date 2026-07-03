import { describe, it, expect } from 'vitest';
import { packageName } from './index';

describe('@openmig/ledger', () => {
  it('exposes its package name', () => {
    expect(packageName).toBe('@openmig/ledger');
  });
});
