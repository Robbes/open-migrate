/**
 * Tests for SecretStore service.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SecretStore, initSecretStore } from '../src/secret-store';

const TEST_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('SecretStore', () => {
  beforeAll(() => {
    process.env.SECRET_ENCRYPTION_KEY = TEST_KEY;
  });

  afterAll(() => {
    delete process.env.SECRET_ENCRYPTION_KEY;
  });

  describe('initSecretStore', () => {
    it('should succeed with valid key', () => {
      expect(() => initSecretStore()).not.toThrow();
    });

    it('should throw without key', () => {
      delete process.env.SECRET_ENCRYPTION_KEY;
      expect(() => initSecretStore()).toThrow(/SECRET_ENCRYPTION_KEY.*required/i);
    });
  });

  describe('SecretStore.encrypt', () => {
    it('should encrypt a string', () => {
      const result = SecretStore.encrypt('my-secret');
      expect(result).toHaveProperty('encrypted');
      expect(result).toHaveProperty('encryptedAt');
      expect(result.encrypted.v).toBe(1);
    });

    it('should produce different blobs for same input (nonce randomness)', () => {
      const enc1 = SecretStore.encrypt('same-input');
      const enc2 = SecretStore.encrypt('same-input');
      expect(enc1.encrypted.n).not.toBe(enc2.encrypted.n);
      expect(enc1.encrypted.c).not.toBe(enc2.encrypted.c);
    });
  });

  describe('SecretStore.decrypt', () => {
    it('should decrypt to original value', () => {
      const original = 'my-super-secret-credential';
      const encrypted = SecretStore.encrypt(original);
      const decrypted = SecretStore.decrypt(encrypted);
      expect(decrypted).toBe(original);
    });

    it('should decrypt from string input', () => {
      const original = 'test-credential';
      const encrypted = SecretStore.encrypt(original);
      const jsonString = JSON.stringify(encrypted.encrypted);
      const decrypted = SecretStore.decrypt(jsonString);
      expect(decrypted).toBe(original);
    });

    it('should throw on tampered data', () => {
      const encrypted = SecretStore.encrypt('secret');
      const tampered = {
        ...encrypted.encrypted,
        c: Buffer.from('tampered').toString('base64'),
      };
      expect(() => SecretStore.decrypt(tampered)).toThrow(/authentication failed|Decryption failed/i);
    });
  });

  describe('SecretStore.encryptCredentials / decryptCredentials', () => {
    it('should encrypt and decrypt credential object', () => {
      const credentials = {
        username: 'user@example.com',
        password: 'super-secret-password',
        token: 'oauth2-token-abc123',
      };

      const encrypted = SecretStore.encryptCredentials(credentials);
      const decrypted = SecretStore.decryptCredentials(encrypted);

      expect(decrypted).toEqual(credentials);
    });

    it('should handle complex credential structures', () => {
      const credentials = {
        imap_host: 'imap.example.com',
        imap_port: '993',
        oauth2_token: 'ya29.a0AfH6SMB...',
        oauth2_refresh_token: '1//0g...',
        expires_at: '2024-12-31T23:59:59Z',
      };

      const encrypted = SecretStore.encryptCredentials(credentials);
      const decrypted = SecretStore.decryptCredentials(encrypted);

      expect(decrypted).toEqual(credentials);
    });

    it('should throw on invalid JSON after decryption', () => {
      const encrypted = SecretStore.encrypt('not-json-data');
      // Manually corrupt to produce invalid JSON after decryption
      const tampered = {
        ...encrypted.encrypted,
        c: Buffer.from('invalid').toString('base64'),
      };
      expect(() => SecretStore.decryptCredentials(tampered)).toThrow(/Failed to parse decrypted credentials/i);
    });
  });

  describe('Cross-tenant isolation', () => {
    it('should encrypt/decrypt independently for different tenants', () => {
      const tenantACreds = { token: 'tenant-a-token' };
      const tenantBCreds = { token: 'tenant-b-token' };

      const encryptedA = SecretStore.encryptCredentials(tenantACreds);
      const encryptedB = SecretStore.encryptCredentials(tenantBCreds);

      const decryptedA = SecretStore.decryptCredentials(encryptedA);
      const decryptedB = SecretStore.decryptCredentials(encryptedB);

      expect(decryptedA).toEqual(tenantACreds);
      expect(decryptedB).toEqual(tenantBCreds);
      expect(decryptedA).not.toEqual(decryptedB);
    });
  });
});
