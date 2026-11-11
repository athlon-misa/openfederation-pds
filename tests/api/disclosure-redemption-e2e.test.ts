/**
 * The disclosure proxy, validated end to end (#81).
 *
 * issuer issues a private attestation → subject grants a viewer time-limited
 * access → viewer redeems → viewer decrypts the session-encrypted payload and
 * finds the claim, watermarked to them. Alongside: the `disclosure_sessions`
 * row, the `disclosure_audit_log` row, expiry, and the watermark format.
 *
 * Request-level edge cases (auth, wrong grantee, revocation, grantStatus) are
 * in disclosure-proxy.test.ts; field filtering and the commitment salt in
 * viewing-grant-fields.security.test.ts and commitment-salt.security.test.ts.
 *
 * Watermark format (version 2), as embedded under `_watermark`:
 *   { version: 2, requesterDid, watermarkId, disclosedAt, mac }
 *   key = HMAC-SHA256(KEY_ENCRYPTION_SECRET, "openfederation:disclosure-watermark:v2")
 *   mac = hex HMAC-SHA256(key, JSON.stringify({
 *           metadata: { version, requesterDid, watermarkId, disclosedAt },
 *           payload:  JSON.stringify(<the disclosed object without _watermark, keys sorted recursively>),
 *         }))
 * The MAC is keyed by a PDS secret, so a leaked copy is attributed by the PDS
 * operator, not verified by third parties offline.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import {
  xrpcAuthPost, xrpcAuthGet, createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { query } from '../../src/db/client.js';
import { config } from '../../src/config.js';
import { decryptWithSessionKey } from '../../src/disclosure/session-keys.js';
import { extractWatermark } from '../../src/disclosure/watermark.js';

type User = { accessJwt: string; did: string; handle: string };

const CLAIM = { certification: 'Level 5', department: 'Engineering', scores: { b: 2, a: 1 } };

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as any)[k])]));
  }
  return v;
}

/** Independent re-implementation of the documented watermark MAC. */
function expectedMac(disclosed: Record<string, any>): string {
  const { _watermark, ...payload } = disclosed;
  const { mac: _mac, ...metadata } = _watermark;
  const key = crypto.createHmac('sha256', config.keyEncryptionSecret!)
    .update('openfederation:disclosure-watermark:v2').digest();
  const envelope = JSON.stringify({
    metadata: {
      version: metadata.version,
      requesterDid: metadata.requesterDid,
      watermarkId: metadata.watermarkId,
      disclosedAt: metadata.disclosedAt,
    },
    payload: JSON.stringify(sortKeys(payload)),
  });
  return crypto.createHmac('sha256', key).update(envelope).digest('hex');
}

function openPayload(body: any): Record<string, any> {
  const key = Buffer.from(body.sessionKey, 'base64');
  const p = body.sessionEncryptedPayload;
  return JSON.parse(decryptWithSessionKey(p.ciphertext, key, p.iv, p.authTag));
}

describe('disclosure proxy end to end (#81)', () => {
  let plc: boolean;
  let issuer: User;
  let subject: User;
  let viewer: User;
  let communityDid: string;
  let rkey: string;

  async function grant(minutes: unknown = 60, extra: Record<string, unknown> = {}) {
    const res = await xrpcAuthPost('net.openfederation.attestation.createViewingGrant', subject.accessJwt, {
      communityDid, rkey, grantedToDid: viewer.did, expiresInMinutes: minutes, ...extra,
    });
    expect(res.status).toBe(200);
    return res.body as { grantId: string; expiresAt: string };
  }

  async function redeem(grantId: string, who: User = viewer) {
    return xrpcAuthPost('net.openfederation.disclosure.redeemGrant', who.accessJwt, { grantId });
  }

  beforeAll(async () => {
    plc = await isPLCAvailable();
    if (!plc) return;
    issuer = await createTestUser(uniqueHandle('dx-issuer'));
    subject = await createTestUser(uniqueHandle('dx-subject'));
    viewer = await createTestUser(uniqueHandle('dx-viewer'));

    const created = await xrpcAuthPost('net.openfederation.community.create', issuer.accessJwt, {
      handle: uniqueHandle('dx-comm'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    expect(created.status).toBe(201);
    communityDid = created.body.did;
    await xrpcAuthPost('net.openfederation.community.join', subject.accessJwt, { did: communityDid });

    const issued = await xrpcAuthPost('net.openfederation.community.issueAttestation', issuer.accessJwt, {
      communityDid, subjectDid: subject.did, subjectHandle: subject.handle, type: 'credential',
      claim: CLAIM, visibility: 'private', accessPolicy: { type: 'community-member', communityDid },
    });
    expect(issued.status).toBe(200);
    rkey = issued.body.rkey;
  });

  describe('happy path', () => {
    let grantId: string;
    let body: any;
    let disclosed: Record<string, any>;

    beforeAll(async () => {
      if (!plc) return;
      grantId = (await grant(60)).grantId;
      const res = await redeem(grantId);
      expect(res.status).toBe(200);
      body = res.body;
      disclosed = openPayload(body);
    });

    it('the stored claim is encrypted; the redeemed payload decrypts to it', async () => {
      if (!plc) return;
      const stored = await query<{ record: any }>(
        `SELECT record FROM records_index WHERE community_did = $1 AND collection = 'net.openfederation.community.attestation' AND rkey = $2`,
        [communityDid, rkey],
      );
      expect(JSON.stringify(stored.rows[0].record)).not.toContain('Engineering');
      expect(stored.rows[0].record.claim.ciphertext).toBeTruthy();

      const { _watermark, ...claim } = disclosed;
      expect(claim).toEqual(CLAIM);
      expect(_watermark).toBeDefined();
    });

    it('the payload carries a watermark naming the viewer, matching the response', async () => {
      if (!plc) return;
      const wm = disclosed._watermark;
      expect(Object.keys(wm).sort()).toEqual(['disclosedAt', 'mac', 'requesterDid', 'version', 'watermarkId']);
      expect(wm.version).toBe(2);
      expect(wm.requesterDid).toBe(viewer.did);
      expect(wm.watermarkId).toBe(body.watermarkId);
      expect(Math.abs(Date.parse(wm.disclosedAt) - Date.now())).toBeLessThan(60_000);
      expect(wm.mac).toMatch(/^[0-9a-f]{64}$/);
    });

    it('the watermark verifies, and matches an independent computation of the documented MAC', async () => {
      if (!plc) return;
      expect(extractWatermark(disclosed)).toEqual(disclosed._watermark);
      expect(disclosed._watermark.mac).toBe(expectedMac(disclosed));
    });

    it('altering the disclosed data or re-attributing it breaks the watermark', async () => {
      if (!plc) return;
      expect(extractWatermark({ ...disclosed, certification: 'Level 6' })).toBeNull();
      expect(extractWatermark({ ...disclosed, _watermark: { ...disclosed._watermark, requesterDid: subject.did } })).toBeNull();
      // Key order in the payload does not matter: the MAC covers a canonical form.
      const reordered = { _watermark: disclosed._watermark, scores: { a: 1, b: 2 }, department: 'Engineering', certification: 'Level 5' };
      expect(extractWatermark(reordered)).not.toBeNull();
    });

    it('writes one disclosure_sessions row holding only a hash of the session key', async () => {
      if (!plc) return;
      const rows = await query<any>('SELECT * FROM disclosure_sessions WHERE grant_id = $1', [grantId]);
      expect(rows.rows).toHaveLength(1);
      const s = rows.rows[0];
      expect(s.requester_did).toBe(viewer.did);
      expect(s.watermark_id).toBe(body.watermarkId);
      expect(s.access_count).toBe(1);
      expect(s.session_key_hash).toBe(crypto.createHash('sha256').update(Buffer.from(body.sessionKey, 'base64')).digest('hex'));
      expect(s.session_key_hash).not.toContain(body.sessionKey);
      expect(new Date(s.expires_at).toISOString()).toBe(body.expiresAt);
      // Session lives 30 minutes from redemption.
      const ttl = Date.parse(body.expiresAt) - new Date(s.created_at).getTime();
      expect(ttl).toBeGreaterThan(29 * 60_000);
      expect(ttl).toBeLessThanOrEqual(30 * 60_000 + 1000);
      expect(s.last_accessed_at).not.toBeNull();
    });

    it('writes one disclosure_audit_log row tied to the session and watermark', async () => {
      if (!plc) return;
      const session = (await query<{ id: string }>('SELECT id FROM disclosure_sessions WHERE grant_id = $1', [grantId])).rows[0];
      const rows = await query<any>(
        `SELECT * FROM disclosure_audit_log WHERE grant_id = $1 AND action = 'redeem'`, [grantId],
      );
      expect(rows.rows).toHaveLength(1);
      const a = rows.rows[0];
      expect(a.attestation_community_did).toBe(communityDid);
      expect(a.attestation_rkey).toBe(rkey);
      expect(a.requester_did).toBe(viewer.did);
      expect(a.watermark_id).toBe(body.watermarkId);
      expect(a.ip_address).toBeTruthy();
      expect(a.metadata).toEqual({ sessionId: session.id, grantedFields: null });
    });

    it('the subject reads that row through disclosure.auditLog; the viewer cannot', async () => {
      if (!plc) return;
      const res = await xrpcAuthGet('net.openfederation.disclosure.auditLog', subject.accessJwt, { communityDid, rkey });
      expect(res.status).toBe(200);
      const entry = res.body.entries.find((e: any) => e.grantId === grantId && e.action === 'redeem');
      expect(entry).toMatchObject({ requesterDid: viewer.did, watermarkId: body.watermarkId, communityDid, rkey });

      const viewerRes = await xrpcAuthGet('net.openfederation.disclosure.auditLog', viewer.accessJwt, { communityDid, rkey });
      expect(viewerRes.status).toBe(403);
    });

    it('every redemption gets its own session, key, watermark and audit row', async () => {
      if (!plc) return;
      const second = await redeem(grantId);
      expect(second.status).toBe(200);
      expect(second.body.watermarkId).not.toBe(body.watermarkId);
      expect(second.body.sessionKey).not.toBe(body.sessionKey);
      expect(openPayload(second.body)._watermark.watermarkId).toBe(second.body.watermarkId);
      // The first session key does not open the second payload.
      expect(() => openPayload({ ...second.body, sessionKey: body.sessionKey })).toThrow();

      const sessions = await query('SELECT 1 FROM disclosure_sessions WHERE grant_id = $1', [grantId]);
      expect(sessions.rows).toHaveLength(2);
      const audits = await query(`SELECT 1 FROM disclosure_audit_log WHERE grant_id = $1 AND action = 'redeem'`, [grantId]);
      expect(audits.rows).toHaveLength(2);

      const status = await xrpcAuthGet('net.openfederation.disclosure.grantStatus', subject.accessJwt, { grantId });
      expect(status.body.accessCount).toBe(2);
    });
  });

  describe('expiry', () => {
    it('a grant past its expiry cannot be redeemed, and leaves no session or audit row', async () => {
      if (!plc) return;
      const { grantId } = await grant(5);
      // Let the grant lapse without waiting five minutes.
      await query(`UPDATE viewing_grants SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [grantId]);

      const res = await redeem(grantId);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('GrantExpired');

      expect((await query('SELECT 1 FROM disclosure_sessions WHERE grant_id = $1', [grantId])).rows).toHaveLength(0);
      expect((await query('SELECT 1 FROM disclosure_audit_log WHERE grant_id = $1', [grantId])).rows).toHaveLength(0);

      const status = await xrpcAuthGet('net.openfederation.disclosure.grantStatus', viewer.accessJwt, { grantId });
      expect(status.body.active).toBe(false);
    });

    it('a grant redeemed once stops working when it expires', async () => {
      if (!plc) return;
      const { grantId } = await grant(5);
      expect((await redeem(grantId)).status).toBe(200);
      await query(`UPDATE viewing_grants SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [grantId]);
      const again = await redeem(grantId);
      expect(again.status).toBe(403);
      expect(again.body.error).toBe('GrantExpired');
    });

    it('expiresInMinutes is clamped to between 1 minute and 24 hours', async () => {
      if (!plc) return;
      const within = (iso: string, minutes: number) =>
        Math.abs(Date.parse(iso) - (Date.now() + minutes * 60_000)) < 30_000;

      expect(within((await grant(10)).expiresAt, 10)).toBe(true);
      expect(within((await grant(-5)).expiresAt, 1)).toBe(true);
      expect(within((await grant(100_000)).expiresAt, 1440)).toBe(true);
      // Missing: the default hour. Not a number: refused by the lexicon.
      expect(within((await grant(undefined)).expiresAt, 60)).toBe(true);
      const bad = await xrpcAuthPost('net.openfederation.attestation.createViewingGrant', subject.accessJwt, {
        communityDid, rkey, grantedToDid: viewer.did, expiresInMinutes: 'soon',
      });
      expect(bad.status).toBe(400);
    });
  });

  describe('a public attestation in a private community', () => {
    it('redeems to its plain claim, watermarked the same way', async () => {
      if (!plc) return;
      const created = await xrpcAuthPost('net.openfederation.community.create', issuer.accessJwt, {
        handle: uniqueHandle('dx-priv'), didMethod: 'plc', visibility: 'private', joinPolicy: 'approval',
      });
      expect(created.status).toBe(201);
      const privDid = created.body.did;
      // The subject of an attestation must be a member: into the private community by approval.
      await xrpcAuthPost('net.openfederation.community.join', subject.accessJwt, { did: privDid });
      const pending = await xrpcAuthGet('net.openfederation.community.listJoinRequests', issuer.accessJwt, { did: privDid });
      expect((await xrpcAuthPost('net.openfederation.community.resolveJoinRequest', issuer.accessJwt, {
        requestId: pending.body.requests[0].id, action: 'approve',
      })).status).toBe(200);
      const plain = { badge: 'gold' };
      const issued = await xrpcAuthPost('net.openfederation.community.issueAttestation', issuer.accessJwt, {
        communityDid: privDid, subjectDid: subject.did, subjectHandle: subject.handle, type: 'credential', claim: plain,
      });
      expect(issued.status).toBe(200);

      const g = await xrpcAuthPost('net.openfederation.attestation.createViewingGrant', subject.accessJwt, {
        communityDid: privDid, rkey: issued.body.rkey, grantedToDid: viewer.did, expiresInMinutes: 10,
      });
      expect(g.status).toBe(200);
      const res = await redeem(g.body.grantId);
      expect(res.status).toBe(200);
      const disclosed = openPayload(res.body);
      const { _watermark, ...claim } = disclosed;
      expect(claim).toEqual(plain);
      expect(extractWatermark(disclosed)?.requesterDid).toBe(viewer.did);
      expect(_watermark.mac).toBe(expectedMac(disclosed));

      const audit = await query(`SELECT 1 FROM disclosure_audit_log WHERE grant_id = $1 AND action = 'redeem'`, [g.body.grantId]);
      expect(audit.rows).toHaveLength(1);
    });
  });
});
