import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { Secp256k1Keypair } from '@atproto/crypto';
import {
  xrpcAuthGet,
  xrpcAuthPost,
  xrpcPost,
  getAdminToken,
  uniqueHandle,
} from './helpers.js';
import {
  signServiceAuthJwt,
  getServiceDid,
  _clearReplayCache,
  _resetServiceAuthRateLimiter,
} from '../../src/auth/service-auth.js';
import { query } from '../../src/db/client.js';
import { decryptKeyBytes } from '../../src/auth/encryption.js';

// End-to-end tests covering:
// 1. com.atproto.server.getServiceAuth — local user mints outbound token.
// 2. Inbound service-auth JWT accepted in place of a session token.
// 3. Rejection paths for expired / wrong-aud / replayed / bad-sig tokens.
//
// Requires PLC directory; checked locally here (the shared helper's probe
// targets the wrong endpoint, but we don't want to touch it from this PR).

async function isPlcReachable(): Promise<boolean> {
  try {
    const url = process.env.PLC_DIRECTORY_URL || 'http://localhost:2582';
    const res = await fetch(`${url}/_health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

// A local copy of createTestUser that correctly reads the `id` field returned
// by net.openfederation.account.register when approving. Isolates this PR
// from dormant bugs in the shared helper.
async function registerAndApproveUser(handle: string): Promise<{
  accessJwt: string;
  refreshJwt: string;
  did: string;
  handle: string;
}> {
  const adminToken = await getAdminToken();
  const inviteRes = await xrpcAuthPost('net.openfederation.invite.create', adminToken, { maxUses: 1 });
  if (inviteRes.status !== 201) {
    throw new Error(`invite failed: ${inviteRes.status} ${JSON.stringify(inviteRes.body)}`);
  }
  const registerRes = await xrpcPost('net.openfederation.account.register', {
    handle,
    email: `${handle}@test.local`,
    password: 'TestPassword123!',
    inviteCode: inviteRes.body.code,
  });
  if (registerRes.status !== 201 && registerRes.status !== 200) {
    throw new Error(`register failed: ${registerRes.status} ${JSON.stringify(registerRes.body)}`);
  }
  const newUserId = registerRes.body.id || registerRes.body.userId;
  if (!newUserId) throw new Error(`register response missing id: ${JSON.stringify(registerRes.body)}`);
  const approveRes = await xrpcAuthPost('net.openfederation.account.approve', adminToken, {
    userId: newUserId,
  });
  if (approveRes.status >= 400) {
    throw new Error(`approve failed: ${approveRes.status} ${JSON.stringify(approveRes.body)}`);
  }
  const loginRes = await xrpcPost('com.atproto.server.createSession', {
    identifier: handle,
    password: 'TestPassword123!',
  });
  if (loginRes.status !== 200) {
    throw new Error(`login failed: ${loginRes.status} ${JSON.stringify(loginRes.body)}`);
  }
  return {
    accessJwt: loginRes.body.accessJwt,
    refreshJwt: loginRes.body.refreshJwt,
    did: loginRes.body.did,
    handle: loginRes.body.handle,
  };
}

describe('service-auth (cross-PDS identity proofs)', () => {
  let plcAvailable = false;
  let user: { accessJwt: string; refreshJwt: string; did: string; handle: string };
  let userKeypair: Secp256k1Keypair;

  beforeAll(async () => {
    plcAvailable = await isPlcReachable();
    if (!plcAvailable) return;

    user = await registerAndApproveUser(uniqueHandle('svc-auth'));

    // Load the user's actual signing key from the DB so tests can craft
    // JWTs that verify against their published did:plc key.
    const keyRes = await query<{ signing_key_bytes: Buffer }>(
      'SELECT signing_key_bytes FROM user_signing_keys WHERE user_did = $1',
      [user.did]
    );
    expect(keyRes.rows.length).toBe(1);
    const decrypted = await decryptKeyBytes(keyRes.rows[0].signing_key_bytes);
    userKeypair = await Secp256k1Keypair.import(decrypted, { exportable: true });
  });

  beforeEach(() => {
    _clearReplayCache();
    _resetServiceAuthRateLimiter();
  });

  describe('com.atproto.server.getServiceAuth', () => {
    it('rejects unauthenticated callers', async () => {
      const res = await xrpcPost('com.atproto.server.getServiceAuth');
      expect(res.status).toBe(401);
    });

    it('requires an aud parameter', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthGet('com.atproto.server.getServiceAuth', user.accessJwt);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('InvalidRequest');
    });

    it('rejects a non-DID aud', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthGet('com.atproto.server.getServiceAuth', user.accessJwt, {
        aud: 'https://pds.example.com',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('InvalidRequest');
    });

    it('returns a signed JWT for the authenticated user', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthGet('com.atproto.server.getServiceAuth', user.accessJwt, {
        aud: 'did:web:peer-pds.example.com',
      });
      expect(res.status).toBe(200);
      expect(typeof res.body.token).toBe('string');
      const parts = res.body.token.split('.');
      expect(parts).toHaveLength(3);
      const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf-8'));
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
      expect(header.alg).toBe('ES256K');
      expect(payload.iss).toBe(user.did);
      expect(payload.aud).toBe('did:web:peer-pds.example.com');
      expect(typeof payload.exp).toBe('number');
      expect(typeof payload.iat).toBe('number');
    });

    it('rejects exp in the past', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthGet('com.atproto.server.getServiceAuth', user.accessJwt, {
        aud: 'did:web:peer-pds.example.com',
        exp: String(Math.floor(Date.now() / 1000) - 10),
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('BadExpiration');
    });

    it('rejects exp beyond the ceiling', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthGet('com.atproto.server.getServiceAuth', user.accessJwt, {
        aud: 'did:web:peer-pds.example.com',
        exp: String(Math.floor(Date.now() / 1000) + 3600 * 24), // 1 day — way beyond cap
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('BadExpiration');
    });
  });

  describe('inbound service-auth JWT', () => {
    // We use net.openfederation.community.listMine as our target endpoint:
    // requires requireAuth, doesn't need community membership, and has a deterministic
    // success shape (200 + array).

    it('is accepted in place of a session token when signed by the user', async () => {
      if (!plcAvailable) return;
      const nowSec = Math.floor(Date.now() / 1000);
      const jwt = await signServiceAuthJwt({
        keypair: userKeypair,
        iss: user.did,
        aud: getServiceDid(),
        exp: nowSec + 60,
      });

      const res = await xrpcAuthGet('net.openfederation.community.listMine', jwt);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.communities)).toBe(true);
    });

    it('rejects an expired JWT with ExpiredToken', async () => {
      if (!plcAvailable) return;
      const nowSec = Math.floor(Date.now() / 1000);
      const jwt = await signServiceAuthJwt({
        keypair: userKeypair,
        iss: user.did,
        aud: getServiceDid(),
        exp: nowSec - 120,
      });

      const res = await xrpcAuthGet('net.openfederation.community.listMine', jwt);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('ExpiredToken');
    });

    it('rejects a JWT with wrong audience with BadAudience', async () => {
      if (!plcAvailable) return;
      const nowSec = Math.floor(Date.now() / 1000);
      const jwt = await signServiceAuthJwt({
        keypair: userKeypair,
        iss: user.did,
        aud: 'did:web:some-other-service.example.com',
        exp: nowSec + 60,
      });

      const res = await xrpcAuthGet('net.openfederation.community.listMine', jwt);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('BadAudience');
    });

    it('rejects replay of a previously-accepted JWT with ReplayedToken', async () => {
      if (!plcAvailable) return;
      const nowSec = Math.floor(Date.now() / 1000);
      const jwt = await signServiceAuthJwt({
        keypair: userKeypair,
        iss: user.did,
        aud: getServiceDid(),
        exp: nowSec + 60,
      });

      const first = await xrpcAuthGet('net.openfederation.community.listMine', jwt);
      expect(first.status).toBe(200);

      const replay = await xrpcAuthGet('net.openfederation.community.listMine', jwt);
      expect(replay.status).toBe(401);
      expect(replay.body.error).toBe('ReplayedToken');
    });

    it('rejects a JWT whose payload has been tampered (InvalidSignature)', async () => {
      if (!plcAvailable) return;
      const nowSec = Math.floor(Date.now() / 1000);
      const jwt = await signServiceAuthJwt({
        keypair: userKeypair,
        iss: user.did,
        aud: getServiceDid(),
        exp: nowSec + 60,
      });

      const [h, , s] = jwt.split('.');
      const forged = Buffer.from(
        JSON.stringify({ iss: user.did, aud: getServiceDid(), exp: nowSec + 60, evil: true })
      ).toString('base64url');
      const badJwt = `${h}.${forged}.${s}`;

      const res = await xrpcAuthGet('net.openfederation.community.listMine', badJwt);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('InvalidSignature');
    });

    it('rejects a JWT signed by a different key than the issuer advertises (InvalidSignature)', async () => {
      if (!plcAvailable) return;
      const nowSec = Math.floor(Date.now() / 1000);
      const otherKey = await Secp256k1Keypair.create({ exportable: true });
      const jwt = await signServiceAuthJwt({
        keypair: otherKey, // not the user's real key
        iss: user.did,
        aud: getServiceDid(),
        exp: nowSec + 60,
      });

      const res = await xrpcAuthGet('net.openfederation.community.listMine', jwt);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('InvalidSignature');
    });

    it('rejects a JWT with lxm scoped to a different method (BadLexiconMethod)', async () => {
      if (!plcAvailable) return;
      const nowSec = Math.floor(Date.now() / 1000);
      const jwt = await signServiceAuthJwt({
        keypair: userKeypair,
        iss: user.did,
        aud: getServiceDid(),
        exp: nowSec + 60,
        lxm: 'com.atproto.repo.createRecord',
      });

      const res = await xrpcAuthGet('net.openfederation.community.listMine', jwt);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('BadLexiconMethod');
    });
  });
});
