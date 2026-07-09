import { describe, it, expect } from 'vitest';
import { packageName } from './index';

describe('@openmig/shared', () => {
  it('exposes its package name', () => {
    expect(packageName).toBe('@openmig/shared');
  });
});
