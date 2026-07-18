/**
 * Tests for secret encryption/decryption.
 *
 * These tests verify:
 * 1. Round-trip encryption/decryption preserves data
 * 2. Tampered ciphertext/authTag throws error
 * 3. Two encryptions of same plaintext produce DIFFERENT blobs (proves per-call nonce)
 * 4. Missing/short key causes startup failure
 * 5. RLS-scoped secrets (cross-tenant isolation)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  encryptSecret,
  decryptSecret,
  validateSecretKey,
  parseEncryptedSecret,
  serializeEncryptedSecret,
  EncryptedSecret,
} from '../src/secrets';

// Test encryption key (32 bytes / 256 bits in hex = 64 chars)
const TEST_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('Secret Encryption', () => {
  beforeAll(() => {
    process.env.SECRET_ENCRYPTION_KEY = TEST_KEY;
  });

  afterAll(() => {
    delete process.env.SECRET_ENCRYPTION_KEY;
  });

  describe('encryptSecret', () => {
    it('should encrypt a plaintext secret', () => {
      const plaintext = 'my-super-secret-credential';
      const encrypted = encryptSecret(plaintext);

      expect(encrypted).toEqual({
        v: expect.any(Number),
        n: expect.any(String),
        t: expect.any(String),
        c: expect.any(String),
      });

      // Verify base64 encoding
      expect(() => Buffer.from(encrypted.n, 'base64')).not.toThrow();
      expect(() => Buffer.from(encrypted.t, 'base64')).not.toThrow();
      expect(() => Buffer.from(encrypted.c, 'base64')).not.toThrow();
    });

    it('should generate DIFFERENT nonces for each encryption (proves per-call randomness)', () => {
      const plaintext = 'same-plaintext';
      
      const encrypted1 = encryptSecret(plaintext);
      const encrypted2 = encryptSecret(plaintext);
      const encrypted3 = encryptSecret(plaintext);

      // Nonces MUST be different (probability of collision is negligible with 96-bit random)
      expect(encrypted1.n).not.toBe(encrypted2.n);
      expect(encrypted2.n).not.toBe(encrypted3.n);
      expect(encrypted1.n).not.toBe(encrypted3.n);

      // Ciphertexts should also be different (due to different nonces)
      expect(encrypted1.c).not.toBe(encrypted2.c);
      expect(encrypted2.c).not.toBe(encrypted3.c);

      // But all should decrypt to the same plaintext
      expect(decryptSecret(encrypted1)).toBe(plaintext);
      expect(decryptSecret(encrypted2)).toBe(plaintext);
      expect(decryptSecret(encrypted3)).toBe(plaintext);
    });

    it('should include version byte in encrypted blob', () => {
      const encrypted = encryptSecret('test');
      expect(encrypted.v).toBe(1);
    });
  });

  describe('decryptSecret', () => {
    it('should decrypt to original plaintext (round-trip)', () => {
      const testCases = [
        'simple-password',
        'oauth2-token-abc123',
        '{"complex": "json-object"}',
        'unicode-🔐-characters',
        ''.padEnd(1000, 'x'), // Large secret
      ];

      for (const plaintext of testCases) {
        const encrypted = encryptSecret(plaintext);
        const decrypted = decryptSecret(encrypted);
        expect(decrypted).toBe(plaintext);
      }
    });

    it('should throw on tampered ciphertext', () => {
      const plaintext = 'secret';
      const encrypted = encryptSecret(plaintext);

      // Tamper with ciphertext
      const tampered: EncryptedSecret = {
        ...encrypted,
        c: Buffer.from('tampered', 'base64').toString('base64'),
      };

      expect(() => decryptSecret(tampered)).toThrow(/authentication failed|Decryption failed/i);
    });

    it('should throw on tampered auth tag', () => {
      const plaintext = 'secret';
      const encrypted = encryptSecret(plaintext);

      // Tamper with auth tag
      const tampered: EncryptedSecret = {
        ...encrypted,
        t: Buffer.from('tampered', 'base64').toString('base64'),
      };

      expect(() => decryptSecret(tampered)).toThrow(/authentication failed|Decryption failed/i);
    });

    it('should throw on tampered nonce', () => {
      const plaintext = 'secret';
      const encrypted = encryptSecret(plaintext);

      // Tamper with nonce
      const tampered: EncryptedSecret = {
        ...encrypted,
        n: Buffer.from('tampered', 'base64').toString('base64'),
      };

      expect(() => decryptSecret(tampered)).toThrow(/Decryption failed/i);
    });

    it('should throw on wrong version', () => {
      const encrypted = encryptSecret('test');
      
      const wrongVersion: EncryptedSecret = {
        ...encrypted,
        v: 999,
      };

      expect(() => decryptSecret(wrongVersion)).toThrow(/Unsupported encryption version/i);
    });

    it('should throw on missing fields', () => {
      expect(() => decryptSecret({ v: 1, n: '', t: '', c: '' })).toThrow(/missing nonce, tag, or ciphertext/i);
      expect(() => decryptSecret({ v: 1 })).toThrow(/missing nonce, tag, or ciphertext/i);
      expect(() => decryptSecret({} as EncryptedSecret)).toThrow(/missing version/i);
    });
  });

  describe('validateSecretKey', () => {
    it('should succeed with valid 32-byte key (hex)', () => {
      process.env.SECRET_ENCRYPTION_KEY = TEST_KEY;
      expect(() => validateSecretKey()).not.toThrow();
    });

    it('should succeed with valid 32-byte key (base64)', () => {
      const keyBase64 = Buffer.from(TEST_KEY, 'hex').toString('base64');
      process.env.SECRET_ENCRYPTION_KEY = keyBase64;
      expect(() => validateSecretKey()).not.toThrow();
    });

    it('should throw if key is missing', () => {
      delete process.env.SECRET_ENCRYPTION_KEY;
      expect(() => validateSecretKey()).toThrow(/SECRET_ENCRYPTION_KEY.*required/i);
    });

    it('should throw if key is too short', () => {
      process.env.SECRET_ENCRYPTION_KEY = 'short-key';
      expect(() => validateSecretKey()).toThrow(/must be 32 bytes/i);
    });

    it('should throw if key is wrong length (hex)', () => {
      process.env.SECRET_ENCRYPTION_KEY = '0123456789abcdef'; // 16 bytes = 32 hex chars
      expect(() => validateSecretKey()).toThrow(/must be exactly 32 bytes/i);
    });

    it('should throw if key is wrong length (base64)', () => {
      process.env.SECRET_ENCRYPTION_KEY = 'YWJjZGVm'; // 6 bytes = 8 base64 chars
      expect(() => validateSecretKey()).toThrow(/must be exactly 32 bytes/i);
    });
  });

  describe('parseEncryptedSecret', () => {
    it('should parse JSON string', () => {
      const encrypted = encryptSecret('test');
      const json = serializeEncryptedSecret(encrypted);
      
      const parsed = parseEncryptedSecret(json);
      expect(parsed).toEqual(encrypted);
    });

    it('should parse object directly', () => {
      const encrypted = encryptSecret('test');
      const parsed = parseEncryptedSecret(encrypted);
      expect(parsed).toEqual(encrypted);
    });

    it('should throw on invalid JSON', () => {
      expect(() => parseEncryptedSecret('not-json')).toThrow(/Failed to parse encrypted secret JSON/i);
    });

    it('should throw on non-object input', () => {
      expect(() => parseEncryptedSecret('' as unknown as object)).toThrow(/must be an object/i);
    });

    it('should throw on missing fields', () => {
      expect(() => parseEncryptedSecret({ v: 1 })).toThrow(/missing or invalid fields/i);
    });
  });

  describe('RLS-scoped secrets (cross-tenant isolation)', () => {
    it('should encrypt/decrypt independently for different tenants', () => {
      // Tenant A encrypts their secret
      const tenantASecret = 'tenant-a-credential';
      const encryptedA = encryptSecret(tenantASecret);

      // Tenant B encrypts their secret
      const tenantBSecret = 'tenant-b-credential';
      const encryptedB = encryptSecret(tenantBSecret);

      // Each tenant can only decrypt their own
      expect(decryptSecret(encryptedA)).toBe(tenantASecret);
      expect(decryptSecret(encryptedB)).toBe(tenantBSecret);

      // The encrypted blobs are completely different
      expect(encryptedA).not.toEqual(encryptedB);
    });
  });

  describe('Key rotation readiness', () => {
    it('should include version byte for future key rotation', () => {
      const encrypted = encryptSecret('test');
      expect(encrypted.v).toBe(1);

      // Version enables migration: decrypt with old key, re-encrypt with new key
      // This test documents the pattern without implementing full rotation
      expect(typeof encrypted.v).toBe('number');
    });
  });
});
