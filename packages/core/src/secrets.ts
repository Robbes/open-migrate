/**
 * Secret encryption/decryption for multi-tenant credential storage.
 *
 * Uses AES-256-GCM authenticated encryption to protect sensitive credentials
 * (OAuth2 tokens, passwords, API keys) stored in the database.
 *
 * ## Threat Model
 *
 * **Protects against:**
 * - Database-at-rest exposure (DB dump, backup theft)
 * - Accidental SELECT queries revealing plaintext credentials
 * - Log leakage of credential values
 * - Tampering with stored credentials (GCM auth tag verification)
 *
 * **Does NOT protect against:**
 * - Fully compromised host that can read SECRET_ENCRYPTION_KEY
 * - Memory dumps of the running application
 * - Social engineering / insider threats with key access
 *
 * The SECRET_ENCRYPTION_KEY must be provided by the operator via environment
 * variable and MUST NOT be committed to version control.
 *
 * ## Key Rotation
 *
 * The version byte (currently v1) enables future key rotation:
 * 1. Generate new encryption key
 * 2. Iterate through all encrypted secrets
 * 3. Decrypt with old key (version 1)
 * 4. Re-encrypt with new key (version 2)
 * 5. Update SECRET_ENCRYPTION_KEY env var
 *
 * The version byte in the blob format enables this migration path.
 *
 * ## Storage Format
 *
 * Encrypted secrets are stored as a JSON object with base64-encoded fields:
 * ```json
 * {
 *   "v": 1,           // Version byte
 *   "n": "<nonce>",   // 12-byte nonce (base64)
 *   "t": "<tag>",     // 16-byte auth tag (base64)
 *   "c": "<ciphertext>" // Encrypted data (base64)
 * }
 * ```
 *
 * @module secrets
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const NONCE_LENGTH = 12; // 96 bits (recommended for GCM)
const AUTH_TAG_LENGTH = 16; // 128 bits
const VERSION = 1;

/**
 * Encrypted secret blob structure.
 */
export interface EncryptedSecret {
  v: number; // Version
  n: string; // Nonce (base64)
  t: string; // Auth tag (base64)
  c: string; // Ciphertext (base64)
}

/**
 * Get and validate the encryption key from environment.
 *
 * @returns The 32-byte encryption key
 * @throws Error if key is missing or wrong length
 */
function getEncryptionKey(): Buffer {
  const keyEnv = process.env.SECRET_ENCRYPTION_KEY;

  if (!keyEnv) {
    throw new Error(
      'SECRET_ENCRYPTION_KEY environment variable is required. ' +
      'Generate a 32-byte (256-bit) key using: crypto.randomBytes(32).toString("hex")'
    );
  }

  let keyBuffer: Buffer;

  // Support both hex and base64 encoding
  if (keyEnv.length === 64) {
    // Hex encoding (32 bytes = 64 hex chars)
    keyBuffer = Buffer.from(keyEnv, 'hex');
  } else if (keyEnv.length === 44) {
    // Base64 encoding (32 bytes = 44 base64 chars)
    keyBuffer = Buffer.from(keyEnv, 'base64');
  } else {
    throw new Error(
      `SECRET_ENCRYPTION_KEY must be 32 bytes (64 hex chars or 44 base64 chars). ` +
      `Got ${keyEnv.length} characters. ` +
      `Generate a key using: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
    );
  }

  if (keyBuffer.length !== KEY_LENGTH) {
    throw new Error(
      `SECRET_ENCRYPTION_KEY must be exactly 32 bytes (256 bits). ` +
      `Got ${keyBuffer.length} bytes. ` +
      `Generate a key using: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
    );
  }

  return keyBuffer;
}

/**
 * Encrypt a plaintext secret using AES-256-GCM.
 *
 * Generates a fresh random nonce for each encryption call.
 * The nonce, auth tag, and ciphertext are combined into a versioned blob.
 *
 * @param plaintext - The secret value to encrypt
 * @returns An EncryptedSecret blob with nonce, tag, and ciphertext
 * @throws Error if encryption fails
 */
export function encryptSecret(plaintext: string): EncryptedSecret {
  const key = getEncryptionKey();

  // Generate fresh random nonce for THIS encryption
  const nonce = randomBytes(NONCE_LENGTH);

  // Create cipher
  const cipher = createCipheriv(ALGORITHM, key, nonce);

  // Encrypt the plaintext
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  // Get the authentication tag (16 bytes for GCM)
  const authTag = cipher.getAuthTag();

  // Return versioned blob with base64-encoded components
  return {
    v: VERSION,
    n: nonce.toString('base64'),
    t: authTag.toString('base64'),
    c: ciphertext.toString('base64'),
  };
}

/**
 * Decrypt an encrypted secret blob.
 *
 * Verifies the GCM authentication tag and throws if tampering is detected.
 *
 * @param encrypted - The encrypted secret blob
 * @returns The decrypted plaintext
 * @throws Error if decryption fails or auth tag verification fails
 */
export function decryptSecret(encrypted: EncryptedSecret): string {
  // Validate structure
  if (!encrypted || typeof encrypted.v !== 'number') {
    throw new Error('Invalid encrypted secret: missing version');
  }

  if (encrypted.v !== VERSION) {
    throw new Error(
      `Unsupported encryption version: ${encrypted.v}. ` +
      `Current supported version: ${VERSION}. ` +
      `Key rotation may be required.`
    );
  }

  if (!encrypted.n || !encrypted.t || !encrypted.c) {
    throw new Error('Invalid encrypted secret: missing nonce, tag, or ciphertext');
  }

  const key = getEncryptionKey();

  try {
    // Decode base64 components
    const nonce = Buffer.from(encrypted.n, 'base64');
    const authTag = Buffer.from(encrypted.t, 'base64');
    const ciphertext = Buffer.from(encrypted.c, 'base64');

    // Validate lengths
    if (nonce.length !== NONCE_LENGTH) {
      throw new Error(`Invalid nonce length: ${nonce.length} (expected ${NONCE_LENGTH})`);
    }

    if (authTag.length !== AUTH_TAG_LENGTH) {
      throw new Error(`Invalid auth tag length: ${authTag.length} (expected ${AUTH_TAG_LENGTH})`);
    }

    // Create decipher
    const decipher = createDecipheriv(ALGORITHM, key, nonce);

    // Set the auth tag for verification
    decipher.setAuthTag(authTag);

    // Decrypt
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');

    return plaintext;
  } catch (error) {
    // GCM authentication failure - likely tampering or wrong key
    if (error instanceof Error && error.message.includes('Unsupported state')) {
      throw new Error(
        'Authentication failed: encrypted secret may be tampered or encrypted with different key',
        { cause: error }
      );
    }
    // Re-throw with context
    throw new Error(`Decryption failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/**
 * Validate that the encryption key is properly configured.
 *
 * Call this at application startup to fail fast if secrets won't work.
 *
 * @throws Error if key is missing or invalid
 */
export function validateSecretKey(): void {
  getEncryptionKey(); // Will throw if invalid
}

/**
 * Parse an encrypted secret from a JSON string or object.
 *
 * Helper for deserializing encrypted secrets from database storage.
 *
 * @param data - JSON string or object containing encrypted secret
 * @returns The parsed EncryptedSecret
 * @throws Error if parsing fails or structure is invalid
 */
export function parseEncryptedSecret(data: string | object): EncryptedSecret {
  let parsed: unknown;

  if (typeof data === 'string') {
    try {
      parsed = JSON.parse(data);
    } catch (error) {
      throw new Error(`Failed to parse encrypted secret JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  } else {
    parsed = data;
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Encrypted secret must be an object');
  }

  const enc = parsed as EncryptedSecret;

  if (typeof enc.v !== 'number' || typeof enc.n !== 'string' || typeof enc.t !== 'string' || typeof enc.c !== 'string') {
    throw new Error('Invalid encrypted secret structure: missing or invalid fields');
  }

  return enc;
}

/**
 * Serialize an encrypted secret to a JSON string for storage.
 *
 * @param encrypted - The encrypted secret
 * @returns JSON string representation
 */
export function serializeEncryptedSecret(encrypted: EncryptedSecret): string {
  return JSON.stringify(encrypted);
}
