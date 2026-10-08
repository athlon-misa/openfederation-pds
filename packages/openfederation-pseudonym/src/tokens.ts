/**
 * Blind creation tokens (RFC 9474, RSABSSA-SHA384-PSS-Randomized). The PDS
 * signs tokens it cannot see, so it can never tell which account a spent
 * token came from. Every finalized token is checked against the anonymously
 * fetched epoch key: a server that tagged a user with a private key fails.
 */
import { RSABSSA } from '@cloudflare/blindrsa-ts';
import { base64UrlDecode, base64UrlEncode } from './formats.js';

const suite = RSABSSA.SHA384.PSS.Randomized();

export interface CreationToken { epoch: string; prepared: string; signature: string }
export interface PendingTokens { epoch: string; prepared: Uint8Array[]; inv: Uint8Array[]; blinded: string[] }

export async function importTokenPublicKey(spkiB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('spki', base64UrlDecode(spkiB64), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify']);
}

export async function blindTokens(publicKey: CryptoKey, epoch: string, count: number): Promise<PendingTokens> {
  const pending: PendingTokens = { epoch, prepared: [], inv: [], blinded: [] };
  for (let i = 0; i < count; i++) {
    const prepared = suite.prepare(crypto.getRandomValues(new Uint8Array(32)));
    const { blindedMsg, inv } = await suite.blind(publicKey, prepared);
    pending.prepared.push(prepared);
    pending.inv.push(inv);
    pending.blinded.push(base64UrlEncode(blindedMsg));
  }
  return pending;
}

export async function finalizeTokens(publicKey: CryptoKey, pending: PendingTokens, blindSignatures: string[]): Promise<CreationToken[]> {
  if (blindSignatures.length !== pending.blinded.length) throw new Error('KeyMismatch');
  const out: CreationToken[] = [];
  for (let i = 0; i < blindSignatures.length; i++) {
    let sig: Uint8Array;
    try {
      sig = await suite.finalize(publicKey, pending.prepared[i], base64UrlDecode(blindSignatures[i]), pending.inv[i]);
    } catch {
      throw new Error('KeyMismatch');
    }
    if (!(await suite.verify(publicKey, sig, pending.prepared[i]))) throw new Error('KeyMismatch');
    out.push({ epoch: pending.epoch, prepared: base64UrlEncode(pending.prepared[i]), signature: base64UrlEncode(sig) });
  }
  return out;
}
