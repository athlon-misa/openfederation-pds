/**
 * Owner signatures, checked on the server (ADR-003, decision 7). The person's
 * owner key, published as `openfederation_owner` in their DID document, signs
 * person-level statements the PDS cannot make for them.
 *
 *  - raw:      secp256k1 or P-256, low-S, compact 64 bytes, over sha256(utf8(text)).
 *  - webauthn: a passkey assertion; clientDataJSON.type "webauthn.get", challenge
 *              base64url(sha256(utf8(text))), user-present flag set; ECDSA P-256
 *              (DER) over authenticatorData ‖ sha256(clientDataJSON).
 * Origin and rpId are reported, not enforced.
 *
 * Kept independent of @open-federation/sdk/custody on purpose: the tests sign
 * with the SDK and verify here, so a mistake in one shows up as a mismatch.
 */
import { createHash } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { p256 } from '@noble/curves/p256';
import bs58 from 'bs58';

export type OwnerSignature =
  | { format: 'raw'; sig: string }
  | { format: 'webauthn'; authenticatorData: string; clientDataJSON: string; signature: string; credentialId?: string };

export type OwnerVerdict =
  | { ok: true; format: 'raw' | 'webauthn'; origin?: string; rpIdHash?: string }
  | { ok: false; reason: string };

const sha256 = (data: Uint8Array | string) => new Uint8Array(createHash('sha256').update(data).digest());
const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const fromB64u = (text: string) => new Uint8Array(Buffer.from(text, 'base64url'));

function ownerKey(didKey: string): { curve: 'secp256k1' | 'p256'; publicKey: Uint8Array } {
  if (!didKey.startsWith('did:key:z')) throw new Error('owner key is not a did:key');
  const bytes = bs58.decode(didKey.slice('did:key:z'.length));
  if (bytes[0] === 0xe7 && bytes[1] === 0x01) return { curve: 'secp256k1', publicKey: bytes.slice(2) };
  if (bytes[0] === 0x80 && bytes[1] === 0x24) return { curve: 'p256', publicKey: bytes.slice(2) };
  throw new Error('owner key must be secp256k1 or P-256');
}

export function verifyOwnerSignature(text: string, signature: OwnerSignature, ownerDidKey: string): OwnerVerdict {
  let key;
  try { key = ownerKey(ownerDidKey); } catch (e) { return { ok: false, reason: (e as Error).message }; }
  const digest = sha256(text);
  try {
    if (signature?.format === 'raw') {
      const sig = fromB64u(signature.sig);
      if (sig.length !== 64) return { ok: false, reason: 'raw signature must be 64 bytes' };
      const curve = key.curve === 'secp256k1' ? secp256k1 : p256;
      return curve.verify(sig, digest, key.publicKey, { lowS: true })
        ? { ok: true, format: 'raw' } : { ok: false, reason: 'signature does not verify' };
    }
    if (signature?.format === 'webauthn') {
      if (key.curve !== 'p256') return { ok: false, reason: 'a passkey signature needs a P-256 owner key' };
      const authData = fromB64u(signature.authenticatorData);
      const clientDataBytes = fromB64u(signature.clientDataJSON);
      const clientData = JSON.parse(Buffer.from(clientDataBytes).toString('utf8')) as { type?: string; challenge?: string; origin?: string };
      if (clientData.type !== 'webauthn.get') return { ok: false, reason: 'clientDataJSON.type is not webauthn.get' };
      if (clientData.challenge !== b64u(digest)) return { ok: false, reason: 'challenge is not this text' };
      if (authData.length < 37 || (authData[32] & 0x01) === 0) return { ok: false, reason: 'user-present flag not set' };
      const signed = Buffer.concat([authData, sha256(clientDataBytes)]);
      return p256.verify(fromB64u(signature.signature), sha256(signed), key.publicKey, { format: 'der', lowS: false })
        ? { ok: true, format: 'webauthn', origin: clientData.origin, rpIdHash: b64u(authData.slice(0, 32)) }
        : { ok: false, reason: 'signature does not verify' };
    }
    return { ok: false, reason: 'unknown signature format' };
  } catch (e) {
    return { ok: false, reason: `malformed signature: ${(e as Error).message}` };
  }
}
