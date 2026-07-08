// Copyright 2026 OpenHands Agent (Apache-2.0)
// Unit tests for imapsync wrapper - basic validation tests.

import { describe, test, expect } from 'vitest';
import { checkImapsyncAvailable, getImapsyncVersion } from './imapsync-wrapper';

describe('imapsync-wrapper', () => {
  describe('checkImapsyncAvailable', () => {
    test('should be a function', () => {
      expect(typeof checkImapsyncAvailable).toBe('function');
    });

    test('should return a boolean', () => {
      const result = checkImapsyncAvailable();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('getImapsyncVersion', () => {
    test('should be a function', () => {
      expect(typeof getImapsyncVersion).toBe('function');
    });

    test('should return string or null', () => {
      const result = getImapsyncVersion();
      expect(result === null || typeof result === 'string').toBe(true);
    });
  });

  describe('runImapsyncBulk type signature', () => {
    test('should export runImapsyncBulk function', async () => {
      const { runImapsyncBulk } = await import('./imapsync-wrapper.js');
      expect(typeof runImapsyncBulk).toBe('function');
    });
  });
});
