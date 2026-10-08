/**
 * Server side of blind creation tokens. One RSA-PSS key per UTC month.
 * Tokens from the current and previous epoch are accepted. Older keys are
 * deleted together with their spent markers, which also bounds the spent
 * table. Nothing here records time or which account a token went to.
 */
import type { PoolClient } from 'pg';
import {
  createHash, createPrivateKey, createPublicKey, privateDecrypt, publicEncrypt, timingSafeEqual, constants,
  type KeyObject,
} from 'crypto';
import { RSABSSA } from '@cloudflare/blindrsa-ts';
import { query, withAdvisoryLock } from '../../db/client.js';
import { encryptKeyBytes, decryptKeyBytes } from '../../auth/encryption.js';
import {
  currentEpoch, previousEpoch, base64UrlDecode, base64UrlEncode,
} from '../../../packages/openfederation-pseudonym/src/formats.js';

const suite = RSABSSA.SHA384.PSS.Randomized();
const ALG = { name: 'RSA-PSS', hash: 'SHA-384' } as const;
const EPOCH = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface CreationToken { epoch: string; prepared: string; signature: string }

function acceptedEpochs(now = new Date()): string[] {
  const cur = currentEpoch(now);
  return [cur, previousEpoch(cur)];
}

type KeyRow = { public_spki: Buffer; private_pkcs8: Buffer };

async function createEpochRow(epoch: string): Promise<KeyRow> {
  return withAdvisoryLock(`pseudonym-token-key:${epoch}`, async () => {
    const again = (await query<KeyRow>(
      'SELECT public_spki, private_pkcs8 FROM pseudonym_token_keys WHERE epoch = $1', [epoch])).rows[0];
    if (again) return again;
    const { publicKey, privateKey } = await suite.generateKey({ modulusLength: 2048, publicExponent: Uint8Array.from([1, 0, 1]) });
    const spki = Buffer.from(await crypto.subtle.exportKey('spki', publicKey));
    const pkcs8 = await encryptKeyBytes(Buffer.from(await crypto.subtle.exportKey('pkcs8', privateKey)), 'pseudonym.token-key');
    await query('INSERT INTO pseudonym_token_keys (epoch, public_spki, private_pkcs8) VALUES ($1, $2, $3)', [epoch, spki, pkcs8]);
    // Retire everything older than the accepted window, keys and spent markers alike.
    const keep = acceptedEpochs();
    await query('DELETE FROM pseudonym_tokens_spent WHERE NOT (epoch = ANY($1))', [keep]);
    await query('DELETE FROM pseudonym_token_batches WHERE NOT (epoch = ANY($1))', [keep]);
    await query('DELETE FROM pseudonym_token_keys WHERE NOT (epoch = ANY($1)) AND epoch <> $2', [keep, epoch]);
    return { public_spki: spki, private_pkcs8: pkcs8 };
  });
}

// In-process caches keyed by epoch. Epoch keys are immutable once created,
// and retired epochs simply stop being asked for.
const publicCache = new Map<string, { publicKey: CryptoKey; spki: Buffer; publicSpkiB64: string }>();
const signerCache = new Map<string, { priv: KeyObject; pub: KeyObject }>();

/** Public half only: never touches the encrypted private key. */
export async function getEpochPublicKey(epoch: string, opts: { create?: boolean } = {}) {
  if (!EPOCH.test(epoch)) return null;
  const hit = publicCache.get(epoch);
  if (hit) return hit;
  let row = (await query<{ public_spki: Buffer }>(
    'SELECT public_spki FROM pseudonym_token_keys WHERE epoch = $1', [epoch])).rows[0];
  if (!row && opts.create) row = await createEpochRow(epoch);
  if (!row) return null;
  const spki = Buffer.from(row.public_spki);
  const entry = {
    publicKey: await crypto.subtle.importKey('spki', new Uint8Array(spki), ALG, true, ['verify']),
    spki,
    publicSpkiB64: base64UrlEncode(new Uint8Array(spki)),
  };
  publicCache.set(epoch, entry);
  return entry;
}

async function getEpochSigner(epoch: string, create: boolean) {
  const hit = signerCache.get(epoch);
  if (hit) return hit;
  const pub = await getEpochPublicKey(epoch, { create });
  if (!pub) return null;
  const row = (await query<KeyRow>(
    'SELECT public_spki, private_pkcs8 FROM pseudonym_token_keys WHERE epoch = $1', [epoch])).rows[0];
  if (!row) return null;
  const pkcs8 = await decryptKeyBytes(row.private_pkcs8, 'pseudonym.token-key');
  const signer = {
    priv: createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }),
    pub: createPublicKey({ key: pub.spki, format: 'der', type: 'spki' }),
  };
  signerCache.set(epoch, signer);
  return signer;
}

/** Kept for callers wanting the full WebCrypto pair; prefer the narrower functions. */
export async function getEpochKey(epoch: string, opts: { create?: boolean } = {}) {
  if (!EPOCH.test(epoch)) return null;
  const pub = await getEpochPublicKey(epoch, opts);
  if (!pub) return null;
  const row = (await query<KeyRow>(
    'SELECT public_spki, private_pkcs8 FROM pseudonym_token_keys WHERE epoch = $1', [epoch])).rows[0];
  if (!row) return null;
  const privateKey = await crypto.subtle.importKey('pkcs8', new Uint8Array(await decryptKeyBytes(row.private_pkcs8, 'pseudonym.token-key')), ALG, true, ['sign']);
  return { publicKey: pub.publicKey, privateKey, publicSpkiB64: pub.publicSpkiB64 };
}

export async function publishedEpochs(now = new Date()): Promise<{ epoch: string; publicKey: string }[]> {
  const [cur, prev] = acceptedEpochs(now);
  const out: { epoch: string; publicKey: string }[] = [];
  const curKey = await getEpochPublicKey(cur, { create: true });
  if (curKey) out.push({ epoch: cur, publicKey: curKey.publicSpkiB64 });
  const prevKey = await getEpochPublicKey(prev);
  if (prevKey) out.push({ epoch: prev, publicKey: prevKey.publicSpkiB64 });
  return out;
}

export class InvalidBlindedMessageError extends Error {
  constructor() { super('InvalidBlindedMessage'); this.name = 'InvalidBlindedMessageError'; }
}

const MODULUS_BYTES = 256;

/**
 * RFC 9474 BlindSign: s = RSASP1(sk, m), then check RSAVP1(pk, s) == m.
 * Done through OpenSSL (CRT, about a millisecond) instead of the library's
 * pure-JS non-CRT path, which blocks the event loop for ~250 ms per message.
 * The key is a plain rsaEncryption key, so NO_PADDING is accepted.
 */
function rawBlindSign(signer: { priv: KeyObject; pub: KeyObject }, blindedMsg: Uint8Array): Uint8Array {
  if (blindedMsg.length !== MODULUS_BYTES) throw new InvalidBlindedMessageError();
  let sig: Buffer;
  try {
    sig = privateDecrypt({ key: signer.priv, padding: constants.RSA_NO_PADDING }, blindedMsg);
  } catch {
    throw new InvalidBlindedMessageError(); // m >= n
  }
  const check = publicEncrypt({ key: signer.pub, padding: constants.RSA_NO_PADDING }, sig);
  if (check.length !== blindedMsg.length || !timingSafeEqual(check, blindedMsg)) {
    throw new Error('BlindSignVerificationFailed');
  }
  return new Uint8Array(sig);
}

export async function blindSignBatch(epoch: string, blinded: string[]): Promise<string[]> {
  const signer = await getEpochSigner(epoch, true);
  if (!signer) throw new Error('UnknownEpoch');
  return blinded.map((b) => {
    let bytes: Uint8Array;
    try { bytes = base64UrlDecode(b); } catch { throw new InvalidBlindedMessageError(); }
    return base64UrlEncode(rawBlindSign(signer, bytes));
  });
}

export async function redeemToken(client: PoolClient, token: CreationToken): Promise<'ok' | 'invalid' | 'spent'> {
  if (!token || typeof token.prepared !== 'string' || typeof token.signature !== 'string' || !acceptedEpochs().includes(token.epoch)) {
    return 'invalid';
  }
  const key = await getEpochPublicKey(token.epoch);
  if (!key) return 'invalid';
  let ok = false;
  try {
    ok = await suite.verify(key.publicKey, base64UrlDecode(token.signature), base64UrlDecode(token.prepared));
  } catch { ok = false; }
  if (!ok) return 'invalid';
  const hash = createHash('sha256').update(base64UrlDecode(token.prepared)).digest('hex');
  const inserted = await client.query(
    'INSERT INTO pseudonym_tokens_spent (epoch, token_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING', [token.epoch, hash]);
  return inserted.rowCount === 1 ? 'ok' : 'spent';
}
