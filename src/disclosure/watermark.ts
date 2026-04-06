import crypto from 'crypto';

interface Watermark {
  requesterDid: string;
  watermarkId: string;
  disclosedAt: string;
  hash: string;
}

/**
 * Embed a forensic watermark into a JSON object.
 * The watermark contains the requester DID, a unique watermark ID,
 * the disclosure timestamp, and a SHA-256 integrity hash.
 */
export function watermarkJSON(
  data: Record<string, unknown>,
  requesterDid: string,
  watermarkId: string,
  disclosedAt: string,
): Record<string, unknown> & { _watermark: Watermark } {
  const hash = crypto.createHash('sha256')
    .update(`${requesterDid}:${watermarkId}:${disclosedAt}`)
    .digest('hex');
  return { ...data, _watermark: { requesterDid, watermarkId, disclosedAt, hash } };
}

/**
 * Extract and verify a watermark from a JSON object.
 * Returns null if the watermark is missing, incomplete, or has been tampered with.
 */
export function extractWatermark(data: Record<string, unknown>): Watermark | null {
  const wm = data._watermark as Watermark | undefined;
  if (!wm || !wm.requesterDid || !wm.watermarkId) return null;
  const expectedHash = crypto.createHash('sha256')
    .update(`${wm.requesterDid}:${wm.watermarkId}:${wm.disclosedAt}`)
    .digest('hex');
  if (wm.hash !== expectedHash) return null;
  return wm;
}
