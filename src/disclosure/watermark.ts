import crypto from 'crypto';
import { config } from '../config.js';

interface Watermark {
  version: 2;
  requesterDid: string;
  watermarkId: string;
  disclosedAt: string;
  mac: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = canonicalize((value as Record<string, unknown>)[key]);
        return result;
      }, {});
  }
  return value;
}

function canonicalPayload(data: Record<string, unknown>): string {
  const { _watermark: _ignored, ...payload } = data;
  return JSON.stringify(canonicalize(payload));
}

function watermarkMac(data: Record<string, unknown>, metadata: Omit<Watermark, 'mac'>): string {
  if (!config.keyEncryptionSecret) {
    throw new Error('KEY_ENCRYPTION_SECRET must be set to create or verify disclosure watermarks');
  }
  const key = crypto.createHmac('sha256', config.keyEncryptionSecret)
    .update('openfederation:disclosure-watermark:v2')
    .digest();
  const envelope = JSON.stringify({ metadata, payload: canonicalPayload(data) });
  return crypto.createHmac('sha256', key).update(envelope).digest('hex');
}

/**
 * Embed a forensic watermark into a JSON object.
 * The watermark contains the requester DID, a unique watermark ID,
 * the disclosure timestamp, and an HMAC covering both metadata and payload.
 */
export function watermarkJSON(
  data: Record<string, unknown>,
  requesterDid: string,
  watermarkId: string,
  disclosedAt: string,
): Record<string, unknown> & { _watermark: Watermark } {
  const metadata: Omit<Watermark, 'mac'> = { version: 2, requesterDid, watermarkId, disclosedAt };
  const mac = watermarkMac(data, metadata);
  return { ...data, _watermark: { ...metadata, mac } };
}

/**
 * Extract and verify a watermark from a JSON object.
 * Returns null if the watermark is missing, incomplete, or has been tampered with.
 */
export function extractWatermark(data: Record<string, unknown>): Watermark | null {
  const wm = data._watermark as Watermark | undefined;
  if (!wm || wm.version !== 2 || !wm.requesterDid || !wm.watermarkId || !wm.disclosedAt || !/^[0-9a-f]{64}$/i.test(wm.mac)) return null;
  const { mac, ...metadata } = wm;
  const expectedMac = watermarkMac(data, metadata);
  const valid = mac.length === expectedMac.length
    && crypto.timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expectedMac, 'hex'));
  if (!valid) return null;
  return wm;
}
