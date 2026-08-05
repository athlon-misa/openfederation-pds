import { describe, it, expect, beforeAll } from 'vitest';
import nacl from 'tweetnacl';
import { base58btc } from 'multiformats/bases/base58';
import {
  xrpcPost,
  xrpcGet,
  xrpcAuthPost,
  createTestUser,
  isPLCAvailable,
  uniqueHandle,
} from './helpers.js';

const EXTERNAL_KEY_PROOF_DOMAIN = 'OpenFederation External Key Claim v1';
const ed25519Keypair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(1));
const ed25519Keypair2 = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(2));
const ed25519Keypair3 = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));

function publicKeyFor(keypair: nacl.SignKeyPair): string {
  return base58btc.encode(new Uint8Array([0xed, 0x01, ...keypair.publicKey]));
}

function proofFor(
  did: string,
  rkey: string,
  type: string,
  purpose: string,
  publicKey: string,
  keypair: nacl.SignKeyPair,
): string {
  const message = [EXTERNAL_KEY_PROOF_DOMAIN, did, rkey, type, purpose, publicKey].join('\n');
  return Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), keypair.secretKey)).toString('base64url');
}

const VALID_ED25519_KEY = publicKeyFor(ed25519Keypair);
const VALID_ED25519_KEY_2 = publicKeyFor(ed25519Keypair2);

describe('External Identity Keys', () => {
  let plcAvailable: boolean;
  let user: { accessJwt: string; did: string; handle: string };
  let otherUser: { accessJwt: string; did: string; handle: string };

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;
    user = await createTestUser(uniqueHandle('extkey'));
    otherUser = await createTestUser(uniqueHandle('extkeyother'));
  });

  describe('setExternalKey', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await xrpcPost('net.openfederation.identity.setExternalKey', {
        rkey: 'test-key',
        type: 'ed25519',
        purpose: 'meshtastic',
        publicKey: VALID_ED25519_KEY,
        proof: 'invalid',
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

    it('should reject an external-key claim without proof of possession', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost(
        'net.openfederation.identity.setExternalKey',
        user.accessJwt,
        { rkey: 'unproven-claim', type: 'ed25519', purpose: 'meshtastic', publicKey: VALID_ED25519_KEY }
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('InvalidRequest');
    });

    it('should reject a proof signed by a different key', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost(
        'net.openfederation.identity.setExternalKey',
        user.accessJwt,
        {
          rkey: 'forged-proof', type: 'ed25519', purpose: 'meshtastic', publicKey: VALID_ED25519_KEY,
          proof: proofFor(user.did, 'forged-proof', 'ed25519', 'meshtastic', VALID_ED25519_KEY, ed25519Keypair2),
        }
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('InvalidProof');
    });

    it('should reject invalid key type', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost(
        'net.openfederation.identity.setExternalKey',
        user.accessJwt,
        { rkey: 'test-key', type: 'rsa', purpose: 'meshtastic', publicKey: VALID_ED25519_KEY, proof: 'invalid' }
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('InvalidPublicKey');
    });

    it('should reject mismatched type and multicodec prefix', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost(
        'net.openfederation.identity.setExternalKey',
        user.accessJwt,
        { rkey: 'test-key', type: 'secp256k1', purpose: 'nostr', publicKey: VALID_ED25519_KEY, proof: 'invalid' }
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
        {
          rkey: 'mesh-relay-1', type: 'ed25519', purpose: 'meshtastic', publicKey: VALID_ED25519_KEY,
          proof: proofFor(user.did, 'mesh-relay-1', 'ed25519', 'meshtastic', VALID_ED25519_KEY, ed25519Keypair),
          label: 'My relay node',
        }
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
        {
          rkey: 'mesh-mobile', type: 'ed25519', purpose: 'meshtastic', publicKey: VALID_ED25519_KEY_2,
          proof: proofFor(user.did, 'mesh-mobile', 'ed25519', 'meshtastic', VALID_ED25519_KEY_2, ed25519Keypair2),
        }
      );
      expect(res.status).toBe(200);
    });

    it('should reject claiming a public key already claimed by another identity', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost(
        'net.openfederation.identity.setExternalKey',
        otherUser.accessJwt,
        {
          rkey: 'duplicate-key', type: 'ed25519', purpose: 'meshtastic', publicKey: VALID_ED25519_KEY,
          proof: proofFor(otherUser.did, 'duplicate-key', 'ed25519', 'meshtastic', VALID_ED25519_KEY, ed25519Keypair),
        }
      );
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('KeyAlreadyClaimed');
    });

    it('should overwrite an existing key (rotation)', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost(
        'net.openfederation.identity.setExternalKey',
        user.accessJwt,
        {
          rkey: 'mesh-relay-1', type: 'ed25519', purpose: 'meshtastic', publicKey: publicKeyFor(ed25519Keypair3),
          proof: proofFor(user.did, 'mesh-relay-1', 'ed25519', 'meshtastic', publicKeyFor(ed25519Keypair3), ed25519Keypair3),
          label: 'Rotated key',
        }
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
      expect(res.body.publicKey).toBe(publicKeyFor(ed25519Keypair3)); // rotated
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
      const res = await xrpcGet('net.openfederation.identity.resolveByKey', { publicKey: publicKeyFor(ed25519Keypair3) });
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
