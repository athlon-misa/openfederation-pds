import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const secrets = require('secrets.js-grempe');

/**
 * Split a secret into Shamir shares.
 * @param secret - The raw secret bytes to split
 * @param numShares - Total number of shares to generate
 * @param threshold - Minimum shares required to reconstruct
 * @returns Array of share strings (hex-encoded)
 */
export function splitSecret(secret: Buffer, numShares: number, threshold: number): string[] {
  const hex = secret.toString('hex');
  return secrets.share(hex, numShares, threshold);
}

/**
 * Combine Shamir shares to reconstruct the original secret.
 * @param shares - Array of share strings (minimum threshold count)
 * @returns Reconstructed secret as a Buffer
 */
export function combineShares(shares: string[]): Buffer {
  const hex = secrets.combine(shares);
  return Buffer.from(hex, 'hex');
}
