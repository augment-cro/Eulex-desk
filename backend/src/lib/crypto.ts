/**
 * AES-256-GCM encryption for API keys stored in the database.
 *
 * Env var: API_KEY_ENCRYPTION_KEY — 64-char hex string (32 bytes).
 * If not set, falls back to a deterministic derivation from
 * EULEX_MCP_JWT_SECRET (still secure, but a dedicated key is better).
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey(): Buffer {
  const explicit = process.env.API_KEY_ENCRYPTION_KEY?.trim();
  if (explicit && explicit.length === 64) {
    return Buffer.from(explicit, 'hex');
  }
  // Derive from JWT secret as fallback. Fail closed instead of using a
  // hardcoded default: EULEX_MCP_JWT_SECRET is always set in prod, and existing
  // integration_accounts ciphertext was encrypted with this derivation — so we
  // must keep deriving from it (never silently switch to a default key, which
  // would render stored tokens undecryptable).
  const secret = process.env.EULEX_MCP_JWT_SECRET;
  if (!secret) {
    throw new Error(
      'API_KEY_ENCRYPTION_KEY (or EULEX_MCP_JWT_SECRET) not configured',
    );
  }
  return createHash('sha256').update(secret).digest();
}

/**
 * Encrypt a plaintext API key.
 * Returns a base64 string containing iv + ciphertext + authTag.
 */
export function encryptApiKey(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // iv (12) + encrypted (N) + tag (16)
  const combined = Buffer.concat([iv, encrypted, tag]);
  return combined.toString('base64');
}

/**
 * Decrypt a base64-encoded encrypted API key.
 */
export function decryptApiKey(encoded: string): string {
  const key = getKey();
  const combined = Buffer.from(encoded, 'base64');
  const iv = combined.subarray(0, IV_LENGTH);
  const tag = combined.subarray(combined.length - TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH, combined.length - TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

/**
 * Mask an API key for display — shows only the last 4 characters.
 * e.g. "sk-abc123XYZ" → "••••••••XYZ"
 */
export function maskApiKey(key: string | null | undefined): string | null {
  if (!key || key.length < 5) return key ? '••••' : null;
  return '•'.repeat(key.length - 4) + key.slice(-4);
}
