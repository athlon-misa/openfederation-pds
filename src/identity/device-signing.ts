/**
 * Device signing (#240, ADR-003 decision 14): which key the DID names for its
 * repo, read from PLC every time it matters.
 *
 * The guarantee comes from PLC, not from this server: once the DID's
 * `atproto` verification method names the device's key, every relay and app
 * rejects commits this server signs. So whether a device signature counts is
 * decided by the DID's *current* `atproto` key, read from the PLC directory
 * on each use (no cache, never a key the caller supplies).
 */
import { parseDidKey } from '@atproto/crypto';
import { getPlcLog } from './plc-client.js';
import { getUserSigningKey } from './user-identity.js';
import { Secp256k1Keypair } from '@atproto/crypto';

export class DeviceSigningError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'DeviceSigningError';
  }
}

/**
 * The `atproto` key the DID's latest PLC operation names, or null when the
 * DID is not in PLC, is tombstoned or names none. Throws when PLC cannot be
 * read (callers answer 502, never "allowed").
 */
export async function currentAtprotoKey(did: string): Promise<string | null> {
  if (!did.startsWith('did:plc:')) return null;
  const log = await getPlcLog(did);
  const last = log?.[log.length - 1] as { type?: string; verificationMethods?: Record<string, unknown>; signingKey?: unknown } | undefined;
  if (!last) return null;
  if (last.type === 'plc_operation') {
    const key = last.verificationMethods?.atproto;
    return typeof key === 'string' ? key : null;
  }
  if (last.type === 'create' && typeof last.signingKey === 'string') return last.signingKey; // legacy genesis
  return null;
}

/** The did:key of the repo signing key this server holds for a user, or null. */
export async function serverAtprotoKey(did: string): Promise<string | null> {
  const stored = await getUserSigningKey(did);
  if (!stored) return null;
  const keypair = await Secp256k1Keypair.import(Buffer.from(stored, 'base64'));
  return keypair.did();
}

/** A secp256k1 or P-256 did:key, the two kinds AT Protocol accepts for `atproto`. */
export function isRepoSigningDidKey(key: string): boolean {
  try {
    const parsed = parseDidKey(key);
    return parsed.jwtAlg === 'ES256K' || parsed.jwtAlg === 'ES256';
  } catch {
    return false;
  }
}
