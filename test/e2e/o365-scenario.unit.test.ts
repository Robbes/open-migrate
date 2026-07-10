/**
 * O365 Scenario Unit Tests
 * 
 * Tests for:
 * - Read-only scope verification
 * - Token expiry detection
 * - Idempotency assertion
 * - Mocked version that doesn't require real secrets
 */

import { describe, it, expect, _vi, _beforeEach, _afterEach } from 'vitest';
import {
  decodeJwtToken,
  isTokenReadOnly,
  hasReadScopes,
  getTokenExpiryMs,
  IdempotencyTracker,
  type TokenClaims,
} from './o365-scenario';

// ============================================================================
// JWT Token Decoding Tests
// ============================================================================

describe('decodeJwtToken', () => {
  it('should decode a valid JWT token', () => {
    // Sample JWT with payload: {"scp":"Mail.Read Calendars.Read","exp":9999999999,"iat":1234567890}
    const validToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzY3AiOiJNYWlsLlJlYWQgQ2FsZW5kYXJzLlJlYWQiLCJleHAiOjk5OTk5OTk5OTksImlhdCI6MTIzNDU2Nzg5MH0.signature';
    
    const claims = decodeJwtToken(validToken);
    
    expect(claims.scp).toBe('Mail.Read Calendars.Read');
    expect(claims.exp).toBe(9999999999);
    expect(claims.iat).toBe(1234567890);
  });

  it('should decode app-only token with roles', () => {
    // Sample JWT with app-only roles
    const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlcyI6WyJNYWlsLlJlYWQiLCJDYWxlbmRhcnMuUmVhZCJdLCJleHAiOjk5OTk5OTk5OTl9.signature';
    
    const claims = decodeJwtToken(token);
    
    expect(claims.roles).toEqual(['Mail.Read', 'Calendars.Read']);
    expect(claims.scp).toBeUndefined();
  });

  it('should throw on invalid token format', () => {
    expect(() => decodeJwtToken('invalid')).toThrow('Failed to decode JWT');
  });

  it('should throw on malformed base64', () => {
    expect(() => decodeJwtToken('header.invalid.invalid')).toThrow('Failed to decode JWT');
  });
});

// ============================================================================
// Read-Only Scope Verification Tests
// ============================================================================

describe('isTokenReadOnly', () => {
  describe('delegated tokens (scp claim)', () => {
    it('should return true for read-only scopes', () => {
      const claims: TokenClaims = {
        scp: 'Mail.Read Calendars.Read Contacts.Read',
        exp: 9999999999,
      };
      
      expect(isTokenReadOnly(claims)).toBe(true);
    });

    it('should return false for Mail.ReadWrite scope', () => {
      const claims: TokenClaims = {
        scp: 'Mail.Read Mail.ReadWrite',
        exp: 9999999999,
      };
      
      expect(isTokenReadOnly(claims)).toBe(false);
    });

    it('should return false for Calendars.Write scope', () => {
      const claims: TokenClaims = {
        scp: 'Calendars.Read Calendars.Write',
        exp: 9999999999,
      };
      
      expect(isTokenReadOnly(claims)).toBe(false);
    });

    it('should return false for Contacts.ReadWrite scope', () => {
      const claims: TokenClaims = {
        scp: 'Contacts.Read Contacts.ReadWrite',
        exp: 9999999999,
      };
      
      expect(isTokenReadOnly(claims)).toBe(false);
    });

    it('should return false for Files.Write scope', () => {
      const claims: TokenClaims = {
        scp: 'Files.Read Files.Write',
        exp: 9999999999,
      };
      
      expect(isTokenReadOnly(claims)).toBe(false);
    });

    it('should return false for Files.ReadWrite.All scope', () => {
      const claims: TokenClaims = {
        scp: 'Files.Read Files.ReadWrite.All',
        exp: 9999999999,
      };
      
      expect(isTokenReadOnly(claims)).toBe(false);
    });

    it('should return false for Sites.ReadWrite.All scope', () => {
      const claims: TokenClaims = {
        scp: 'Sites.Read.All Sites.ReadWrite.All',
        exp: 9999999999,
      };
      
      expect(isTokenReadOnly(claims)).toBe(false);
    });

    it('should return false for Group.ReadWrite.All scope', () => {
      const claims: TokenClaims = {
        scp: 'Group.Read.All Group.ReadWrite.All',
        exp: 9999999999,
      };
      
      expect(isTokenReadOnly(claims)).toBe(false);
    });

    it('should return false for Directory.ReadWrite.All scope', () => {
      const claims: TokenClaims = {
        scp: 'Directory.Read.All Directory.ReadWrite.All',
        exp: 9999999999,
      };
      
      expect(isTokenReadOnly(claims)).toBe(false);
    });

    it('should return true for .default scope (resolved to read-only)', () => {
      const claims: TokenClaims = {
        scp: 'Mail.Read Calendars.Read Contacts.Read Files.Read',
        exp: 9999999999,
      };
      
      expect(isTokenReadOnly(claims)).toBe(true);
    });
  });

  describe('app-only tokens (roles claim)', () => {
    it('should return true for read-only roles', () => {
      const claims: TokenClaims = {
        roles: ['Mail.Read', 'Calendars.Read', 'Contacts.Read'],
        exp: 9999999999,
      };
      
      expect(isTokenReadOnly(claims)).toBe(true);
    });

    it('should return false for Mail.ReadWrite role', () => {
      const claims: TokenClaims = {
        roles: ['Mail.Read', 'Mail.ReadWrite'],
        exp: 9999999999,
      };
      
      expect(isTokenReadOnly(claims)).toBe(false);
    });

    it('should return false for Calendars.ReadWrite role', () => {
      const claims: TokenClaims = {
        roles: ['Calendars.Read', 'Calendars.ReadWrite'],
        exp: 9999999999,
      };
      
      expect(isTokenReadOnly(claims)).toBe(false);
    });

    it('should return false for Contacts.ReadWrite role', () => {
      const claims: TokenClaims = {
        roles: ['Contacts.Read', 'Contacts.ReadWrite'],
        exp: 9999999999,
      };
      
      expect(isTokenReadOnly(claims)).toBe(false);
    });

    it('should return false for Files.ReadWrite role', () => {
      const claims: TokenClaims = {
        roles: ['Files.Read', 'Files.ReadWrite'],
        exp: 9999999999,
      };
      
      expect(isTokenReadOnly(claims)).toBe(false);
    });

    it('should return false for Files.ReadWrite.All role', () => {
      const claims: TokenClaims = {
        roles: ['Files.Read.All', 'Files.ReadWrite.All'],
        exp: 9999999999,
      };
      
      expect(isTokenReadOnly(claims)).toBe(false);
    });

    it('should return false for Sites.ReadWrite.All role', () => {
      const claims: TokenClaims = {
        roles: ['Sites.Read.All', 'Sites.ReadWrite.All'],
        exp: 9999999999,
      };
      
      expect(isTokenReadOnly(claims)).toBe(false);
    });

    it('should return false for Group.ReadWrite.All role', () => {
      const claims: TokenClaims = {
        roles: ['Group.Read.All', 'Group.ReadWrite.All'],
        exp: 9999999999,
      };
      
      expect(isTokenReadOnly(claims)).toBe(false);
    });

    it('should return false for User.ReadWrite role', () => {
      const claims: TokenClaims = {
        roles: ['User.Read', 'User.ReadWrite'],
        exp: 9999999999,
      };
      
      expect(isTokenReadOnly(claims)).toBe(false);
    });

    it('should return false for Directory.ReadWrite.All role', () => {
      const claims: TokenClaims = {
        roles: ['Directory.Read.All', 'Directory.ReadWrite.All'],
        exp: 9999999999,
      };
      
      expect(isTokenReadOnly(claims)).toBe(false);
    });
  });

  describe('combined claims', () => {
    it('should return false if either scp or roles has write access', () => {
      const claims: TokenClaims = {
        scp: 'Mail.Read',
        roles: ['Calendars.ReadWrite'],
        exp: 9999999999,
      };
      
      expect(isTokenReadOnly(claims)).toBe(false);
    });

    it('should return true if both scp and roles are read-only', () => {
      const claims: TokenClaims = {
        scp: 'Mail.Read Calendars.Read',
        roles: ['Contacts.Read'],
        exp: 9999999999,
      };
      
      expect(isTokenReadOnly(claims)).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should return true for empty scopes', () => {
      const claims: TokenClaims = {
        scp: '',
        exp: 9999999999,
      };
      
      expect(isTokenReadOnly(claims)).toBe(true);
    });

    it('should return true for missing scp and roles', () => {
      const claims: TokenClaims = {
        exp: 9999999999,
      };
      
      expect(isTokenReadOnly(claims)).toBe(true);
    });

    it('should handle Mail.ReadWrite.Shared scope', () => {
      const claims: TokenClaims = {
        scp: 'Mail.Read Mail.ReadWrite.Shared',
        exp: 9999999999,
      };
      
      expect(isTokenReadOnly(claims)).toBe(false);
    });

    it('should handle Calendars.ReadWrite.Shared scope', () => {
      const claims: TokenClaims = {
        scp: 'Calendars.Read Calendars.ReadWrite.Shared',
        exp: 9999999999,
      };
      
      expect(isTokenReadOnly(claims)).toBe(false);
    });

    it('should handle Contacts.ReadWrite.Shared scope', () => {
      const claims: TokenClaims = {
        scp: 'Contacts.Read Contacts.ReadWrite.Shared',
        exp: 9999999999,
      };
      
      expect(isTokenReadOnly(claims)).toBe(false);
    });
  });
});

// ============================================================================
// Read Scopes Detection Tests
// ============================================================================

describe('hasReadScopes', () => {
  it('should return true for delegated read scopes', () => {
    const claims: TokenClaims = {
      scp: 'Mail.Read Calendars.Read',
      exp: 9999999999,
    };
    
    expect(hasReadScopes(claims)).toBe(true);
  });

  it('should return true for app-only read roles', () => {
    const claims: TokenClaims = {
      roles: ['Mail.Read', 'Calendars.Read'],
      exp: 9999999999,
    };
    
    expect(hasReadScopes(claims)).toBe(true);
  });

  it('should return false for no scopes', () => {
    const claims: TokenClaims = {
      exp: 9999999999,
    };
    
    expect(hasReadScopes(claims)).toBe(false);
  });

  it('should return true for Files.Read.All scope', () => {
    const claims: TokenClaims = {
      scp: 'Files.Read.All',
      exp: 9999999999,
    };
    
    expect(hasReadScopes(claims)).toBe(true);
  });

  it('should return true for Sites.Read.All scope', () => {
    const claims: TokenClaims = {
      scp: 'Sites.Read.All',
      exp: 9999999999,
    };
    
    expect(hasReadScopes(claims)).toBe(true);
  });

  it('should return true for Directory.Read.All role', () => {
    const claims: TokenClaims = {
      roles: ['Directory.Read.All'],
      exp: 9999999999,
    };
    
    expect(hasReadScopes(claims)).toBe(true);
  });
});

// ============================================================================
// Token Expiry Detection Tests
// ============================================================================

describe('getTokenExpiryMs', () => {
  it('should convert exp from seconds to milliseconds', () => {
    const claims: TokenClaims = {
      exp: 1700000000, // Some future timestamp in seconds
    };
    
    const result = getTokenExpiryMs(claims);
    
    expect(result).toBe(1700000000000);
  });

  it('should return default if exp is missing', () => {
    const claims: TokenClaims = {};
    
    const result = getTokenExpiryMs(claims);
    
    // Should be at least 1 hour from now
    expect(result).toBeGreaterThan(Date.now());
    expect(result).toBeLessThan(Date.now() + 7200000); // Within 2 hours
  });
});

// ============================================================================
// Idempotency Tracker Tests
// ============================================================================

describe('IdempotencyTracker', () => {
  let tracker: IdempotencyTracker;

  beforeEach(() => {
    tracker = new IdempotencyTracker();
  });

  afterEach(() => {
    tracker.clear();
  });

  it('should start empty', () => {
    expect(tracker.size()).toBe(0);
  });

  it('should track added items', () => {
    tracker.add('item-1');
    tracker.add('item-2');
    tracker.add('item-3');
    
    expect(tracker.size()).toBe(3);
  });

  it('should detect seen items', () => {
    tracker.add('item-1');
    
    expect(tracker.hasSeen('item-1')).toBe(true);
    expect(tracker.hasSeen('item-2')).toBe(false);
  });

  it('should handle duplicate adds', () => {
    tracker.add('item-1');
    tracker.add('item-1');
    tracker.add('item-1');
    
    expect(tracker.size()).toBe(1);
    expect(tracker.hasSeen('item-1')).toBe(true);
  });

  it('should clear all items', () => {
    tracker.add('item-1');
    tracker.add('item-2');
    
    tracker.clear();
    
    expect(tracker.size()).toBe(0);
    expect(tracker.hasSeen('item-1')).toBe(false);
    expect(tracker.hasSeen('item-2')).toBe(false);
  });

  it('should work with natural keys', () => {
    const naturalKeys = [
      'mail:message-uid-123',
      'calendar:event-uid-456',
      'contact:vcard-uid-789',
    ];
    
    for (const key of naturalKeys) {
      tracker.add(key);
    }
    
    expect(tracker.size()).toBe(3);
    
    for (const key of naturalKeys) {
      expect(tracker.hasSeen(key)).toBe(true);
    }
  });
});

// ============================================================================
// Idempotency Assertion Tests (Mocked)
// ============================================================================

describe('Idempotency Assertion (Mocked)', () => {
  it('should assert 0 creates on second run with full ledger', () => {
    const tracker = new IdempotencyTracker();
    
    // Simulate first run: all items added to ledger
    const items = ['item-1', 'item-2', 'item-3', 'item-4', 'item-5'];
    for (const item of items) {
      tracker.add(item);
    }
    
    // Simulate second run: check how many would be created
    let wouldCreate = 0;
    for (const item of items) {
      if (!tracker.hasSeen(item)) {
        wouldCreate++;
        tracker.add(item);
      }
    }
    
    expect(wouldCreate).toBe(0);
    expect(tracker.size()).toBe(5);
  });

  it('should show creates for new items on second run', () => {
    const tracker = new IdempotencyTracker();
    
    // First run: some items
    tracker.add('item-1');
    tracker.add('item-2');
    
    // Second run: existing + new items
    const newItems = ['item-1', 'item-2', 'item-3', 'item-4'];
    let creates = 0;
    
    for (const item of newItems) {
      if (!tracker.hasSeen(item)) {
        creates++;
        tracker.add(item);
      }
    }
    
    expect(creates).toBe(2); // item-3 and item-4
    expect(tracker.size()).toBe(4);
  });

  it('should prove idempotency with consistent data', () => {
    const tracker = new IdempotencyTracker();
    
    // Simulate sync with 100 items
    const allItems = Array.from({ length: 100 }, (_, i) => `item-${i}`);
    
    // First pass: all items are new
    let firstPassCreates = 0;
    for (const item of allItems) {
      if (!tracker.hasSeen(item)) {
        firstPassCreates++;
        tracker.add(item);
      }
    }
    
    expect(firstPassCreates).toBe(100);
    
    // Second pass: all items already in ledger
    let secondPassCreates = 0;
    for (const item of allItems) {
      if (!tracker.hasSeen(item)) {
        secondPassCreates++;
        tracker.add(item);
      }
    }
    
    expect(secondPassCreates).toBe(0);
  });
});

// ============================================================================
// Token Expiry Tests (Mocked)
// ============================================================================

describe('Token Expiry Detection (Mocked)', () => {
  it('should detect expired token', () => {
    const pastExpiry = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    const claims: TokenClaims = {
      exp: pastExpiry,
      scp: 'Mail.Read',
    };
    
    const expiresAt = getTokenExpiryMs(claims);
    const isExpired = Date.now() >= expiresAt;
    
    expect(isExpired).toBe(true);
  });

  it('should detect token about to expire', () => {
    const soonExpiry = Math.floor(Date.now() / 1000) + 120; // 2 minutes from now
    const claims: TokenClaims = {
      exp: soonExpiry,
      scp: 'Mail.Read',
    };
    
    const expiresAt = getTokenExpiryMs(claims);
    const timeUntilExpiry = expiresAt - Date.now();
    
    expect(timeUntilExpiry).toBeGreaterThan(0);
    expect(timeUntilExpiry).toBeLessThan(180000); // Less than 3 minutes
  });

  it('should detect valid token with long expiry', () => {
    const farExpiry = Math.floor(Date.now() / 1000) + 7200; // 2 hours from now
    const claims: TokenClaims = {
      exp: farExpiry,
      scp: 'Mail.Read Calendars.Read',
    };
    
    const expiresAt = getTokenExpiryMs(claims);
    const timeUntilExpiry = expiresAt - Date.now();
    
    expect(timeUntilExpiry).toBeGreaterThan(3600000); // More than 1 hour
  });
});

// ============================================================================
// Comprehensive Scenario Tests (Mocked)
// ============================================================================

describe('Comprehensive O365 Scenario (Mocked)', () => {
  it('should verify complete workflow with mocked data', () => {
    // Simulate the complete workflow
    
    // 1. Token verification
    const tokenClaims: TokenClaims = {
      scp: 'Mail.Read Calendars.Read Contacts.Read Files.Read',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      aud: 'https://graph.microsoft.com',
      iss: 'https://login.microsoftonline.com/tenant-id/v2.0',
    };
    
    expect(isTokenReadOnly(tokenClaims)).toBe(true);
    expect(hasReadScopes(tokenClaims)).toBe(true);
    
    // 2. First shadow pass
    const firstPassStats = {
      mailCount: 150,
      calendarCount: 45,
      contactsCount: 200,
      filesCount: 50,
      timestamp: new Date().toISOString(),
      durationMs: 5000,
    };
    
    expect(firstPassStats.mailCount).toBeGreaterThan(0);
    
    // 3. Simulate token expiry (sleep past expiry)
    const expiredClaims: TokenClaims = {
      ...tokenClaims,
      exp: Math.floor(Date.now() / 1000) - 60, // Expired 1 minute ago
    };
    
    expect(getTokenExpiryMs(expiredClaims)).toBeLessThan(Date.now());
    
    // 4. Token refresh (simulated)
    const refreshedClaims: TokenClaims = {
      scp: 'Mail.Read Calendars.Read Contacts.Read Files.Read',
      exp: Math.floor(Date.now() / 1000) + 3600, // New 1-hour expiry
    };
    
    expect(isTokenReadOnly(refreshedClaims)).toBe(true);
    
    // 5. Second shadow pass
    const secondPassStats = {
      mailCount: 150,
      calendarCount: 45,
      contactsCount: 200,
      filesCount: 50,
      timestamp: new Date().toISOString(),
      durationMs: 4800,
    };
    
    // 6. Idempotency assertion
    const tracker = new IdempotencyTracker();
    
    // Add all items from first pass
    for (let i = 0; i < firstPassStats.mailCount; i++) {
      tracker.add(`mail-${i}`);
    }
    for (let i = 0; i < firstPassStats.calendarCount; i++) {
      tracker.add(`calendar-${i}`);
    }
    for (let i = 0; i < firstPassStats.contactsCount; i++) {
      tracker.add(`contact-${i}`);
    }
    for (let i = 0; i < firstPassStats.filesCount; i++) {
      tracker.add(`file-${i}`);
    }
    
    // Check second pass items
    let wouldCreate = 0;
    for (let i = 0; i < secondPassStats.mailCount; i++) {
      if (!tracker.hasSeen(`mail-${i}`)) wouldCreate++;
    }
    for (let i = 0; i < secondPassStats.calendarCount; i++) {
      if (!tracker.hasSeen(`calendar-${i}`)) wouldCreate++;
    }
    for (let i = 0; i < secondPassStats.contactsCount; i++) {
      if (!tracker.hasSeen(`contact-${i}`)) wouldCreate++;
    }
    for (let i = 0; i < secondPassStats.filesCount; i++) {
      if (!tracker.hasSeen(`file-${i}`)) wouldCreate++;
    }
    
    expect(wouldCreate).toBe(0);
  });
});
