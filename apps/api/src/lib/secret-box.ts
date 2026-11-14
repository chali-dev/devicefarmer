import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { config } from '../config.js';

/**
 * Encryption at rest for secrets stored in the database (AES-256-GCM).
 * The key is derived from JWT_SECRET with HKDF and a fixed context string, so
 * rotating JWT_SECRET makes stored secrets unreadable (they must be re-entered).
 * Format: "v1:" + base64(iv[12] | tag[16] | ciphertext).
 */
const CONTEXT = 'cloudphone/settings-secret/v1';
const key = Buffer.from(hkdfSync('sha256', config.JWT_SECRET, 'cloudphone-settings', CONTEXT, 32));

export function sealSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')}`;
}

export function openSecret(sealed: string): string {
  if (!sealed.startsWith('v1:')) throw new Error('unsupported secret format');
  const raw = Buffer.from(sealed.slice(3), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  try {
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('stored secret cannot be decrypted (was JWT_SECRET changed?); re-enter it in storage settings');
  }
}
