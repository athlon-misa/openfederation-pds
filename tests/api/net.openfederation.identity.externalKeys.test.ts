import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcPost,
  xrpcGet,
  xrpcAuthPost,
  createTestUser,
  isPLCAvailable,
  uniqueHandle,
} from './helpers.js';

// Real Ed25519 public keys in multibase (base58btc) format.
// Multicodec prefix 0xed01 + 32 bytes of key material.
const VALID_ED25519_KEY = 'z6MkiF7EfQ925hgDUcvn9xmvRtquqApfwMNH6TxopBpaBPZs';
const VALID_ED25519_KEY_2 = 'z6Mks5ttwyifzoSaw8EBeZb9qqTmnwFnn4Ub9pkxcUhmFskN';

describe('External Identity Keys', () => {
  let plcAvailable: boolean;
  let user: { accessJwt: string; did: string; handle: string };

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;
    user = await createTestUser(uniqueHandle('extkey'));
  });

  describe('setExternalKey', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await xrpcPost('net.openfederation.identity.setExternalKey', {
        rkey: 'test-key',
        type: 'ed25519',
        purpose: 'meshtastic',
        publicKey: VALID_ED25519_KEY,
      });
      expect(res.status).toBe(401);
    });

    it('should reject missing required fields', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost(
        'net.openfederation.identity.setExternalKey',
        user.accessJwt,
        { rkey: 'test-key' }
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('InvalidRequest');
    });

    it('should reject invalid key type', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost(
        'net.openfederation.identity.setExternalKey',
        user.accessJwt,
        { rkey: 'test-key', type: 'rsa', purpose: 'meshtastic', publicKey: VALID_ED25519_KEY }
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('InvalidPublicKey');
    });

    it('should reject mismatched type and multicodec prefix', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost(
        'net.openfederation.identity.setExternalKey',
        user.accessJwt,
        { rkey: 'test-key', type: 'secp256k1', purpose: 'nostr', publicKey: VALID_ED25519_KEY }
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('InvalidPublicKey');
    });

    it('should reject invalid rkey format', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost(
        'net.openfederation.identity.setExternalKey',
        user.accessJwt,
        { rkey: '-invalid-', type: 'ed25519', purpose: 'meshtastic', publicKey: VALID_ED25519_KEY }
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('InvalidRequest');
    });

    it('should reject purpose longer than 64 chars', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost(
        'net.openfederation.identity.setExternalKey',
        user.accessJwt,
        { rkey: 'test-key', type: 'ed25519', purpose: 'a'.repeat(65), publicKey: VALID_ED25519_KEY }
      );
      expect(res.status).toBe(400);
    });

    it('should reject label longer than 100 chars', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost(
        'net.openfederation.identity.setExternalKey',
        user.accessJwt,
        { rkey: 'test-key', type: 'ed25519', purpose: 'meshtastic', publicKey: VALID_ED25519_KEY, label: 'x'.repeat(101) }
      );
      expect(res.status).toBe(400);
    });

    it('should create an external key record', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost(
        'net.openfederation.identity.setExternalKey',
        user.accessJwt,
        { rkey: 'mesh-relay-1', type: 'ed25519', purpose: 'meshtastic', publicKey: VALID_ED25519_KEY, label: 'My relay node' }
      );
      expect(res.status).toBe(200);
      expect(res.body.uri).toContain('net.openfederation.identity.externalKey');
      expect(res.body.cid).toBeTruthy();
    });

    it('should create a second key with different rkey', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost(
        'net.openfederation.identity.setExternalKey',
        user.accessJwt,
        { rkey: 'mesh-mobile', type: 'ed25519', purpose: 'meshtastic', publicKey: VALID_ED25519_KEY_2 }
      );
      expect(res.status).toBe(200);
    });

    it('should overwrite an existing key (rotation)', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost(
        'net.openfederation.identity.setExternalKey',
        user.accessJwt,
        { rkey: 'mesh-relay-1', type: 'ed25519', purpose: 'meshtastic', publicKey: VALID_ED25519_KEY_2, label: 'Rotated key' }
      );
      expect(res.status).toBe(200);
    });
  });

  describe('getExternalKey', () => {
    it('should return a specific key', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.identity.getExternalKey', {
        did: user.did,
        rkey: 'mesh-relay-1',
      });
      expect(res.status).toBe(200);
      expect(res.body.type).toBe('ed25519');
      expect(res.body.purpose).toBe('meshtastic');
      expect(res.body.publicKey).toBe(VALID_ED25519_KEY_2); // rotated
      expect(res.body.label).toBe('Rotated key');
      expect(res.body.createdAt).toBeTruthy();
    });

    it('should return 404 for non-existent key', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.identity.getExternalKey', {
        did: user.did,
        rkey: 'nonexistent',
      });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('KeyNotFound');
    });

    it('should reject missing did', async () => {
      const res = await xrpcGet('net.openfederation.identity.getExternalKey', { rkey: 'test' });
      expect(res.status).toBe(400);
    });
  });

  describe('listExternalKeys', () => {
    it('should list all keys for a DID', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.identity.listExternalKeys', { did: user.did });
      expect(res.status).toBe(200);
      expect(res.body.keys.length).toBe(2);
    });

    it('should filter by purpose', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.identity.listExternalKeys', {
        did: user.did,
        purpose: 'meshtastic',
      });
      expect(res.status).toBe(200);
      expect(res.body.keys.length).toBe(2);
      expect(res.body.keys.every((k: any) => k.purpose === 'meshtastic')).toBe(true);
    });

    it('should return empty for unknown DID', async () => {
      const res = await xrpcGet('net.openfederation.identity.listExternalKeys', { did: 'did:plc:nonexistent' });
      expect(res.status).toBe(200);
      expect(res.body.keys.length).toBe(0);
    });

    it('should reject missing did', async () => {
      const res = await xrpcGet('net.openfederation.identity.listExternalKeys', {});
      expect(res.status).toBe(400);
    });
  });

  describe('resolveByKey', () => {
    it('should resolve a public key to its DID', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.identity.resolveByKey', { publicKey: VALID_ED25519_KEY_2 });
      expect(res.status).toBe(200);
      expect(res.body.did).toBe(user.did);
      expect(res.body.handle).toBeTruthy();
      expect(res.body.type).toBe('ed25519');
    });

    it('should return 404 for unknown key', async () => {
      const res = await xrpcGet('net.openfederation.identity.resolveByKey', {
        publicKey: 'z6MkrCD1cSyzsKR3xFKhYV1xczJ3LqEcSQVdZpvpuRNpMpwi',
      });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('KeyNotFound');
    });

    it('should reject missing publicKey', async () => {
      const res = await xrpcGet('net.openfederation.identity.resolveByKey', {});
      expect(res.status).toBe(400);
    });
  });

  describe('deleteExternalKey', () => {
    it('should reject unauthenticated', async () => {
      const res = await xrpcPost('net.openfederation.identity.deleteExternalKey', { rkey: 'mesh-mobile' });
      expect(res.status).toBe(401);
    });

    it('should reject missing rkey', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.identity.deleteExternalKey', user.accessJwt, {});
      expect(res.status).toBe(400);
    });

    it('should return 404 for non-existent key', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.identity.deleteExternalKey', user.accessJwt, { rkey: 'nonexistent' });
      expect(res.status).toBe(404);
    });

    it('should delete a key', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.identity.deleteExternalKey', user.accessJwt, { rkey: 'mesh-mobile' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify it's gone
      const getRes = await xrpcGet('net.openfederation.identity.getExternalKey', { did: user.did, rkey: 'mesh-mobile' });
      expect(getRes.status).toBe(404);
    });

    it('should show one fewer key after deletion', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.identity.listExternalKeys', { did: user.did });
      expect(res.status).toBe(200);
      expect(res.body.keys.length).toBe(1);
    });
  });
});
