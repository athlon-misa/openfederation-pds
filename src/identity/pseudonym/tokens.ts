/**
 * Server side of blind creation tokens. One RSA-PSS key per UTC month.
 * Tokens from the current and previous epoch are accepted. Older keys are
 * deleted together with their spent markers, which also bounds the spent
 * table. Nothing here records time or which account a token went to.
 */
import type { PoolClient } from 'pg';
import { createHash } from 'crypto';
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

export async function getEpochKey(epoch: string, opts: { create?: boolean } = {}) {
  if (!EPOCH.test(epoch)) return null;
  let row = (await query<{ public_spki: Buffer; private_pkcs8: Buffer }>(
    'SELECT public_spki, private_pkcs8 FROM pseudonym_token_keys WHERE epoch = $1', [epoch])).rows[0];
  if (!row && opts.create) {
    row = await withAdvisoryLock(`pseudonym-token-key:${epoch}`, async () => {
      const again = (await query<{ public_spki: Buffer; private_pkcs8: Buffer }>(
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
  if (!row) return null;
  const publicKey = await crypto.subtle.importKey('spki', new Uint8Array(row.public_spki), ALG, true, ['verify']);
  const privateKey = await crypto.subtle.importKey('pkcs8', new Uint8Array(await decryptKeyBytes(row.private_pkcs8, 'pseudonym.token-key')), ALG, true, ['sign']);
  return { publicKey, privateKey, publicSpkiB64: base64UrlEncode(new Uint8Array(row.public_spki)) };
}

export async function publishedEpochs(now = new Date()): Promise<{ epoch: string; publicKey: string }[]> {
  const [cur, prev] = acceptedEpochs(now);
  const out: { epoch: string; publicKey: string }[] = [];
  const curKey = await getEpochKey(cur, { create: true });
  if (curKey) out.push({ epoch: cur, publicKey: curKey.publicSpkiB64 });
  const prevKey = await getEpochKey(prev);
  if (prevKey) out.push({ epoch: prev, publicKey: prevKey.publicSpkiB64 });
  return out;
}

export async function blindSignBatch(epoch: string, blinded: string[]): Promise<string[]> {
  const key = await getEpochKey(epoch, { create: true });
  if (!key) throw new Error('UnknownEpoch');
  return Promise.all(blinded.map(async (b) => base64UrlEncode(await suite.blindSign(key.privateKey, base64UrlDecode(b)))));
}

export async function redeemToken(client: PoolClient, token: CreationToken): Promise<'ok' | 'invalid' | 'spent'> {
  if (!token || typeof token.prepared !== 'string' || typeof token.signature !== 'string' || !acceptedEpochs().includes(token.epoch)) {
    return 'invalid';
  }
  const key = await getEpochKey(token.epoch);
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
