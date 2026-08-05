import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { watermarkJSON, extractWatermark } from '../../src/disclosure/watermark.js';

describe('Watermark', () => {
  const requesterDid = 'did:plc:test-requester-123';
  const watermarkId = 'wm-abc-456';
  const disclosedAt = '2026-04-06T12:00:00.000Z';

  describe('watermarkJSON', () => {
    it('should embed a watermark that can be extracted', () => {
      const data = { role: 'athlete', team: 'Alpha' };
      const result = watermarkJSON(data, requesterDid, watermarkId, disclosedAt);

      expect(result._watermark).toBeDefined();
      expect(result._watermark.requesterDid).toBe(requesterDid);
      expect(result._watermark.watermarkId).toBe(watermarkId);
      expect(result._watermark.disclosedAt).toBe(disclosedAt);
      expect(result._watermark.version).toBe(2);
      expect(result._watermark.mac).toMatch(/^[0-9a-f]{64}$/);

      const extracted = extractWatermark(result);
      expect(extracted).not.toBeNull();
      expect(extracted!.requesterDid).toBe(requesterDid);
      expect(extracted!.watermarkId).toBe(watermarkId);
    });

    it('should preserve original data fields', () => {
      const data = { name: 'Alice', score: 99, nested: { a: 1 } };
      const result = watermarkJSON(data, requesterDid, watermarkId, disclosedAt);

      expect(result.name).toBe('Alice');
      expect(result.score).toBe(99);
      expect(result.nested).toEqual({ a: 1 });
    });
  });

  describe('extractWatermark', () => {
    it('should verify HMAC integrity', () => {
      const data = { role: 'moderator' };
      const watermarked = watermarkJSON(data, requesterDid, watermarkId, disclosedAt);
      const extracted = extractWatermark(watermarked);

      expect(extracted).not.toBeNull();
      expect(extracted!.mac).toBe(watermarked._watermark.mac);
    });

    it('should return null for tampered watermark', () => {
      const data = { role: 'moderator' };
      const watermarked = watermarkJSON(data, requesterDid, watermarkId, disclosedAt);

      // Tamper with the requester DID
      watermarked._watermark.requesterDid = 'did:plc:tampered';
      const extracted = extractWatermark(watermarked);
      expect(extracted).toBeNull();
    });

    it('should return null for a tampered payload', () => {
      const watermarked = watermarkJSON({ role: 'athlete', score: 10 }, requesterDid, watermarkId, disclosedAt);
      watermarked.score = 99;
      expect(extractWatermark(watermarked)).toBeNull();
    });

    it('should return null for a forged public hash', () => {
      const data = { role: 'athlete' };
      const watermarked = watermarkJSON(data, requesterDid, watermarkId, disclosedAt);

      // A recipient can calculate this old public format, but not the HMAC.
      watermarked._watermark.mac = crypto.createHash('sha256')
        .update(`${requesterDid}:${watermarkId}:${disclosedAt}`)
        .digest('hex');
      const extracted = extractWatermark(watermarked);
      expect(extracted).toBeNull();
    });

    it('should return null, rather than throw, for a malformed MAC', () => {
      const watermarked = watermarkJSON({ role: 'athlete' }, requesterDid, watermarkId, disclosedAt);
      watermarked._watermark.mac = 'not-hex';
      expect(extractWatermark(watermarked)).toBeNull();
    });

    it('should return null for missing watermark', () => {
      const data = { role: 'athlete' };
      expect(extractWatermark(data)).toBeNull();
    });

    it('should return null for incomplete watermark', () => {
      const data = { _watermark: { requesterDid: 'did:plc:test' } } as any;
      expect(extractWatermark(data)).toBeNull();
    });
  });
});
