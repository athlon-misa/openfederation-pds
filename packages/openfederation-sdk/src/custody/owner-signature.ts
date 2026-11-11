/**
 * Owner signatures (ADR-003, decision 7): what the person, not the PDS, signs.
 *
 *  - raw:      secp256k1 or P-256, low-S, compact 64 bytes, over sha256(utf8(text)).
 *  - webauthn: a passkey assertion. clientDataJSON.type is "webauthn.get" and
 *              its challenge is base64url(sha256(utf8(text))); the user-present
 *              flag is set; ECDSA P-256 (DER) over
 *              authenticatorData ‖ sha256(clientDataJSON).
 * Origin and rpId are reported, not enforced: a verifier decides what to trust.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha2';
import { utf8ToBytes } from '@noble/hashes/utils';
import { base64UrlDecode, base64UrlEncode, didKeyFor, parseDidKey } from './encoding.js';

export type OwnerSignature =
  | { format: 'raw'; sig: string }
  | { format: 'webauthn'; authenticatorData: string; clientDataJSON: string; signature: string; credentialId?: string };

export type OwnerVerdict =
  | { ok: true; format: 'raw' | 'webauthn'; origin?: string; rpIdHash?: string }
  | { ok: false; reason: string };

/** The WebAuthn challenge for a text: base64url(sha256(utf8(text))). */
export function ownerChallenge(text: string): string {
  return base64UrlEncode(sha256(utf8ToBytes(text)));
}

export function signOwnerRaw(ownerPrivateKey: Uint8Array, text: string): OwnerSignature {
  const sig = secp256k1.sign(sha256(utf8ToBytes(text)), ownerPrivateKey, { lowS: true }).toCompactRawBytes();
  return { format: 'raw', sig: base64UrlEncode(sig) };
}

type Credentials = Pick<CredentialsContainer, 'create' | 'get'>;
function credentialsOf(c?: Credentials): Credentials {
  const found = c ?? (globalThis.navigator?.credentials as Credentials | undefined);
  if (!found) throw new Error('PasskeyUnsupported');
  return found;
}

/** Uncompressed P-256 point (65 bytes) out of an SPKI public key. */
function p256FromSpki(spki: Uint8Array): Uint8Array {
  const point = spki.slice(spki.length - 65);
  if (point[0] !== 0x04) throw new Error('PasskeyNotP256');
  return p256.ProjectivePoint.fromHex(point).toRawBytes(true);
}

/** Create a passkey whose P-256 key becomes the account's owner key. */
export async function createOwnerPasskey(p: { rpName: string; userName: string; rpId?: string; credentials?: Credentials }): Promise<{ credentialId: string; ownerDidKey: string }> {
  const created = await credentialsOf(p.credentials).create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)) as BufferSource,
      rp: { name: p.rpName, ...(p.rpId ? { id: p.rpId } : {}) },
      user: { id: crypto.getRandomValues(new Uint8Array(16)) as BufferSource, name: p.userName, displayName: p.userName },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }], // ES256 only: the owner key must be P-256
      authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
    },
  }) as PublicKeyCredential | null;
  if (!created) throw new Error('PasskeyCancelled');
  const response = created.response as AuthenticatorAttestationResponse;
  const spki = response.getPublicKey?.();
  if (!spki) throw new Error('PasskeyPublicKeyUnavailable');
  return { credentialId: base64UrlEncode(new Uint8Array(created.rawId)), ownerDidKey: didKeyFor('p256', p256FromSpki(new Uint8Array(spki))) };
}

export async function signOwnerWithPasskey(p: { credentialId: string; text: string; rpId?: string; credentials?: Credentials }): Promise<OwnerSignature> {
  const cred = await credentialsOf(p.credentials).get({
    publicKey: {
      challenge: base64UrlDecode(ownerChallenge(p.text)) as BufferSource,
      rpId: p.rpId,
      allowCredentials: [{ type: 'public-key', id: base64UrlDecode(p.credentialId) as BufferSource }],
      userVerification: 'required',
    },
  }) as PublicKeyCredential | null;
  if (!cred) throw new Error('PasskeyCancelled');
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    format: 'webauthn',
    authenticatorData: base64UrlEncode(new Uint8Array(r.authenticatorData)),
    clientDataJSON: base64UrlEncode(new Uint8Array(r.clientDataJSON)),
    signature: base64UrlEncode(new Uint8Array(r.signature)),
    credentialId: p.credentialId,
  };
}

/** Check an owner signature over `text` against an owner did:key (secp256k1 or P-256). */
export function verifyOwnerSignature(text: string, signature: OwnerSignature, ownerDidKey: string): OwnerVerdict {
  let key;
  try { key = parseDidKey(ownerDidKey); } catch (e) { return { ok: false, reason: (e as Error).message }; }
  const digest = sha256(utf8ToBytes(text));
  try {
    if (signature.format === 'raw') {
      const sig = base64UrlDecode(signature.sig);
      if (sig.length !== 64) return { ok: false, reason: 'raw signature must be 64 bytes' };
      const curve = key.curve === 'secp256k1' ? secp256k1 : p256;
      return curve.verify(sig, digest, key.publicKey, { lowS: true }) ? { ok: true, format: 'raw' } : { ok: false, reason: 'signature does not verify' };
    }
    if (signature.format === 'webauthn') {
      if (key.curve !== 'p256') return { ok: false, reason: 'a passkey signature needs a P-256 owner key' };
      const authData = base64UrlDecode(signature.authenticatorData);
      const clientDataBytes = base64UrlDecode(signature.clientDataJSON);
      const clientData = JSON.parse(new TextDecoder().decode(clientDataBytes)) as { type?: string; challenge?: string; origin?: string };
      if (clientData.type !== 'webauthn.get') return { ok: false, reason: 'clientDataJSON.type is not webauthn.get' };
      if (clientData.challenge !== base64UrlEncode(digest)) return { ok: false, reason: 'challenge is not this text' };
      if (authData.length < 37 || (authData[32] & 0x01) === 0) return { ok: false, reason: 'user-present flag not set' };
      const signed = new Uint8Array(authData.length + 32);
      signed.set(authData); signed.set(sha256(clientDataBytes), authData.length);
      const ok = p256.verify(base64UrlDecode(signature.signature), sha256(signed), key.publicKey, { format: 'der', lowS: false });
      return ok
        ? { ok: true, format: 'webauthn', origin: clientData.origin, rpIdHash: base64UrlEncode(authData.slice(0, 32)) }
        : { ok: false, reason: 'signature does not verify' };
    }
    return { ok: false, reason: 'unknown signature format' };
  } catch (e) {
    return { ok: false, reason: `malformed signature: ${(e as Error).message}` };
  }
}
