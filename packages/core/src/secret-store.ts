/**
 * Secret Store service for managing encrypted credentials.
 *
 * Provides a secure interface for storing and retrieving tenant-scoped
 * credentials using AES-256-GCM encryption.
 *
 * ## Threat Model
 *
 * **Protects against:**
 * - Database-at-rest exposure (DB dumps, backup theft)
 * - Accidental SELECT queries revealing plaintext credentials
 * - Log leakage of credential values
 * - Tampering with stored credentials (GCM auth tag verification)
 *
 * **Does NOT protect against:**
 * - Fully compromised host that can read SECRET_ENCRYPTION_KEY
 * - Memory dumps of the running application
 * - Social engineering / insider threats with key access
 *
 * ## Key Storage
 *
 * The SECRET_ENCRYPTION_KEY must be provided via environment variable.
 * In Docker Compose deployments, use environment files or secrets:
 * ```yaml
 * services:
 *   api:
 *     environment:
 *       - SECRET_ENCRYPTION_KEY=${SECRET_ENCRYPTION_KEY}
 * ```
 *
 * The key MUST NOT be committed to version control.
 *
 * ## Key Rotation
 *
 * To rotate the encryption key:
 * 1. Generate a new 32-byte key
 * 2. Update SECRET_ENCRYPTION_KEY environment variable
 * 3. Run a migration script that:
 *    - Decrypts each secret with the old key
 *    - Re-encrypts with the new key
 *    - Updates the database
 *
 * The version byte in the encrypted blob enables this migration.
 *
 * @module secret-store
 */

import {
  encryptSecret as doEncrypt,
  decryptSecret as doDecrypt,
  validateSecretKey,
  parseEncryptedSecret,
  serializeEncryptedSecret,
  EncryptedSecret,
} from '@openmig/core/secrets';

/**
 * Encrypted credential blob for storage.
 */
export interface EncryptedCredential {
  /** The encrypted secret blob */
  encrypted: EncryptedSecret;
  /** Timestamp of encryption */
  encryptedAt: string;
}

/**
 * Secret store for managing encrypted credentials.
 */
export class SecretStore {
  /**
   * Validate that the encryption key is properly configured.
   * Call this at application startup.
   *
   * @throws Error if key is missing or invalid
   */
  static validate(): void {
    validateSecretKey();
  }

  /**
   * Encrypt a credential value for storage.
   *
   * @param plaintext - The credential value to encrypt
   * @returns An EncryptedCredential blob ready for storage
   */
  static encrypt(plaintext: string): EncryptedCredential {
    return {
      encrypted: doEncrypt(plaintext),
      encryptedAt: new Date().toISOString(),
    };
  }

  /**
   * Decrypt a stored credential blob.
   *
   * @param encryptedCredential - The encrypted credential blob
   * @returns The decrypted plaintext credential
   * @throws Error if decryption fails or auth tag verification fails
   */
  static decrypt(encryptedCredential: EncryptedCredential | string | object): string {
    const parsed = typeof encryptedCredential === 'string'
      ? parseEncryptedSecret(encryptedCredential)
      : 'encrypted' in encryptedCredential
        ? encryptedCredential.encrypted
        : parseEncryptedSecret(encryptedCredential);

    return doDecrypt(parsed);
  }

  /**
   * Encrypt and store credentials in a connection config.
   *
   * Takes a credentials object and returns an encrypted blob that can be
   * stored in the connection table's encrypted_credentials field.
   *
   * @param credentials - The credentials to encrypt
   * @returns An encrypted blob with metadata
   */
  static encryptCredentials(credentials: Record<string, string>): EncryptedCredential {
    const json = JSON.stringify(credentials);
    return this.encrypt(json);
  }

  /**
   * Decrypt credentials from a stored blob.
   *
   * @param encryptedCredential - The encrypted credential blob
   * @returns The decrypted credentials as an object
   */
  static decryptCredentials(encryptedCredential: EncryptedCredential | string | object): Record<string, string> {
    const plaintext = this.decrypt(encryptedCredential);
    try {
      return JSON.parse(plaintext);
    } catch (error) {
      throw new Error(`Failed to parse decrypted credentials: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Initialize the secret store at application startup.
 *
 * This should be called once when the application starts to validate
 * that the encryption key is properly configured.
 *
 * @throws Error if the encryption key is missing or invalid
 */
export function initSecretStore(): void {
  SecretStore.validate();
}
