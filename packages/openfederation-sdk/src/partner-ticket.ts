/**
 * Registration tickets, for partners with a backend.
 *
 * A partner key (`ofp_…`) is shipped to browsers, so it identifies the partner
 * but cannot prove a request really comes from them. A ticket can: the
 * partner's own server signs a short-lived, single-use statement naming the
 * account being registered, with a private key that never leaves that server.
 * The PDS checks it against the public key registered for the partner key.
 *
 * Use on your server, never in browser code:
 *
 * ```ts
 * // once: generate a key pair, register `publicKey` with the PDS
 * // (partner.createKey { ticketPublicKey }), keep `privateKeyHex` secret
 * const { privateKeyHex, publicKey } = generatePartnerTicketKey();
 *
 * // per sign-up: mint a ticket for this handle and email, hand it to the browser
 * const ticket = createPartnerTicket({ partnerKeyId, privateKeyHex, audience: pdsServiceDid, handle, email });
 * // browser: client.register({ handle, email, password, ticket })
 * ```
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import bs58 from 'bs58';

/** multicodec prefix for a secp256k1 public key in a did:key */
const SECP256K1_DID_KEY_PREFIX = new Uint8Array([0xe7, 0x01]);
const DEFAULT_TTL_SECONDS = 120;

function base64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('privateKeyHex must be 32 bytes of hex');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** The did:key form of the public key belonging to a ticket private key. */
export function partnerTicketPublicKey(privateKeyHex: string): string {
  const compressed = secp256k1.getPublicKey(hexToBytes(privateKeyHex), true);
  const prefixed = new Uint8Array(SECP256K1_DID_KEY_PREFIX.length + compressed.length);
  prefixed.set(SECP256K1_DID_KEY_PREFIX, 0);
  prefixed.set(compressed, SECP256K1_DID_KEY_PREFIX.length);
  return `did:key:z${bs58.encode(prefixed)}`;
}

/** A fresh ticket key pair. Register `publicKey` with the PDS; keep `privateKeyHex` on your server. */
export function generatePartnerTicketKey(): { privateKeyHex: string; publicKey: string } {
  const privateKeyHex = bytesToHex(secp256k1.utils.randomPrivateKey());
  return { privateKeyHex, publicKey: partnerTicketPublicKey(privateKeyHex) };
}

export interface PartnerTicketOptions {
  /** The partner key's id, as returned by `partner.createKey` (not the `ofp_…` secret). */
  partnerKeyId: string;
  /** The ticket private key, 32 bytes of hex. */
  privateKeyHex: string;
  /** The PDS's service DID, e.g. `did:web:pds.example.com`. */
  audience: string;
  /** The handle being registered, exactly as the sign-up form will send it. */
  handle: string;
  /** The email being registered. */
  email: string;
  /** How long the ticket is good for. Default 120 seconds; the PDS refuses more than 300. */
  ttlSeconds?: number;
}

/** Mint a single-use registration ticket (an ES256K JWT) for one account. */
export function createPartnerTicket(opts: PartnerTicketOptions): string {
  const now = Math.floor(Date.now() / 1000);
  const jti = new Uint8Array(16);
  globalThis.crypto.getRandomValues(jti);
  const header = { typ: 'JWT', alg: 'ES256K' };
  const payload = {
    iss: opts.partnerKeyId,
    aud: opts.audience,
    iat: now,
    exp: now + (opts.ttlSeconds ?? DEFAULT_TTL_SECONDS),
    jti: bytesToHex(jti),
    handle: opts.handle.trim().toLowerCase(),
    email: opts.email.trim().toLowerCase(),
  };
  const encode = (o: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = secp256k1.sign(sha256(new TextEncoder().encode(signingInput)), hexToBytes(opts.privateKeyHex), { lowS: true });
  return `${signingInput}.${base64Url(signature.toCompactRawBytes())}`;
}
