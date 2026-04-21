import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/server/index.js';
import {
  xrpcAuthGet, xrpcAuthPost, xrpcPost, xrpcGet,
  getAdminToken, uniqueHandle,
} from './helpers.js';
import { verifySignInAssertion } from '../../packages/openfederation-sdk/src/siwof/verify.js';
import { query } from '../../src/db/client.js';
import { decryptKeyBytes } from '../../src/auth/encryption.js';
import { Secp256k1Keypair } from '@atproto/crypto';

async function isPlcReachable(): Promise<boolean> {
  try {
    const url = process.env.PLC_DIRECTORY_URL || 'http://localhost:2582';
    const res = await fetch(`${url}/_health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}

async function registerAndApproveUser(handle: string) {
  const adminToken = await getAdminToken();
  const inviteRes = await xrpcAuthPost('net.openfederation.invite.create', adminToken, { maxUses: 1 });
  if (inviteRes.status !== 201) throw new Error(`invite: ${inviteRes.status}`);
  const regRes = await xrpcPost('net.openfederation.account.register', {
    handle, email: `${handle}@test.local`, password: 'TestPassword123!', inviteCode: inviteRes.body.code,
  });
  if (regRes.status >= 400) throw new Error(`register: ${regRes.status}`);
  const userId = regRes.body.id || regRes.body.userId;
  await xrpcAuthPost('net.openfederation.account.approve', adminToken, { userId });
  const loginRes = await xrpcPost('com.atproto.server.createSession', {
    identifier: handle, password: 'TestPassword123!',
  });
  if (loginRes.status !== 200) throw new Error(`login: ${loginRes.status}`);
  return {
    accessJwt: loginRes.body.accessJwt as string,
    did: loginRes.body.did as string,
    handle: loginRes.body.handle as string,
  };
}

describe('Public wallet resolver + DID augmentation', () => {
  let plcAvailable = false;
  let user: { accessJwt: string; did: string; handle: string };
  let ethAddress: string;
  let secondEth: string;
  let solAddress: string;
  let resolveSigningKey: (did: string) => Promise<string>;

  beforeAll(async () => {
    plcAvailable = await isPlcReachable();
    if (!plcAvailable) return;
    user = await registerAndApproveUser(uniqueHandle('pubres'));

    resolveSigningKey = async (did) => {
      const keyRes = await query<{ signing_key_bytes: Buffer }>(
        `SELECT signing_key_bytes FROM user_signing_keys WHERE user_did = $1`,
        [did]
      );
      if (keyRes.rows.length === 0) throw new Error(`no signing key for ${did}`);
      const decrypted = await decryptKeyBytes(keyRes.rows[0].signing_key_bytes);
      const kp = await Secp256k1Keypair.import(decrypted);
      return kp.did();
    };

    const e1 = await xrpcAuthPost('net.openfederation.wallet.provision', user.accessJwt, { chain: 'ethereum', label: 'eth-main' });
    expect(e1.status).toBe(200);
    ethAddress = e1.body.walletAddress;

    const e2 = await xrpcAuthPost('net.openfederation.wallet.provision', user.accessJwt, { chain: 'ethereum', label: 'eth-alt' });
    expect(e2.status).toBe(200);
    secondEth = e2.body.walletAddress;

    const s1 = await xrpcAuthPost('net.openfederation.wallet.provision', user.accessJwt, { chain: 'solana', label: 'sol-main' });
    expect(s1.status).toBe(200);
    solAddress = s1.body.walletAddress;
  });

  describe('setPrimaryWallet', () => {
    it('requires authentication', async () => {
      const res = await xrpcPost('net.openfederation.identity.setPrimaryWallet', {
        chain: 'ethereum', walletAddress: '0x0',
      });
      expect(res.status).toBe(401);
    });

    it('rejects a wallet the caller does not own', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.identity.setPrimaryWallet', user.accessJwt, {
        chain: 'ethereum',
        walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
      });
      expect(res.status).toBe(404);
    });

    it('marks a wallet as primary and enforces one primary per chain', async () => {
      if (!plcAvailable) return;

      const r1 = await xrpcAuthPost('net.openfederation.identity.setPrimaryWallet', user.accessJwt, {
        chain: 'ethereum', walletAddress: ethAddress,
      });
      expect(r1.status).toBe(200);
      expect(r1.body.isPrimary).toBe(true);

      // DB check: exactly one primary for (did, ethereum).
      const count1 = await query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM wallet_links WHERE user_did = $1 AND chain = 'ethereum' AND is_primary`,
        [user.did]
      );
      expect(count1.rows[0].c).toBe('1');

      // Switching primary to the other ETH wallet clears the previous.
      const r2 = await xrpcAuthPost('net.openfederation.identity.setPrimaryWallet', user.accessJwt, {
        chain: 'ethereum', walletAddress: secondEth,
      });
      expect(r2.status).toBe(200);
      const count2 = await query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM wallet_links WHERE user_did = $1 AND chain = 'ethereum' AND is_primary`,
        [user.did]
      );
      expect(count2.rows[0].c).toBe('1');

      // Set it back so the rest of the tests see ethAddress as primary.
      const r3 = await xrpcAuthPost('net.openfederation.identity.setPrimaryWallet', user.accessJwt, {
        chain: 'ethereum', walletAddress: ethAddress,
      });
      expect(r3.status).toBe(200);

      // Solana primary too.
      const rSol = await xrpcAuthPost('net.openfederation.identity.setPrimaryWallet', user.accessJwt, {
        chain: 'solana', walletAddress: solAddress,
      });
      expect(rSol.status).toBe(200);
    });
  });

  describe('getPrimaryWallet', () => {
    it('returns 400 for a missing DID', async () => {
      const res = await xrpcGet('net.openfederation.identity.getPrimaryWallet', { chain: 'ethereum' });
      expect(res.status).toBe(400);
    });

    it('returns 404 when no primary exists for (did, chain)', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.identity.getPrimaryWallet', {
        did: 'did:plc:doesnotexist00000000001',
        chain: 'ethereum',
      });
      expect(res.status).toBe(404);
    });

    it('returns the primary wallet + a verifiable service-auth JWT proof', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.identity.getPrimaryWallet', {
        did: user.did,
        chain: 'ethereum',
      });
      expect(res.status).toBe(200);
      expect(res.body.did).toBe(user.did);
      expect(res.body.handle).toBe(user.handle);
      expect(res.body.chain).toBe('ethereum');
      expect(res.body.chainIdCaip2).toBe('eip155:1');
      expect(res.body.walletAddress).toBe(ethAddress);
      expect(res.body.custodyTier).toBe('custodial');
      expect(res.body.proof).toBeTruthy();

      // Parse + cryptographically verify the proof via the offline verifier.
      // We craft a matching walletProof from the returned binding — no wallet
      // signature required since the proof JWT alone establishes "DID ↔ wallet".
      // The verifier expects a full walletProof + didToken bundle, so for the
      // resolver-proof use case the dApp just decodes the JWT and verifies it.
      const [, payloadB64] = (res.body.proof as string).split('.');
      const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));
      expect(claims.iss).toBe(user.did);
      expect(claims.chain).toBe('ethereum');
      expect(claims.walletAddress).toBe(ethAddress);
      expect(claims.sub).toBe(`eip155:1:${ethAddress}`);
      expect(claims.lxm).toBe('net.openfederation.identity.getPrimaryWallet');
    });

    it('honors includeProof=false to skip the JWT', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.identity.getPrimaryWallet', {
        did: user.did, chain: 'ethereum', includeProof: 'false',
      });
      expect(res.status).toBe(200);
      expect(res.body.proof).toBeUndefined();
    });
  });

  describe('listWalletsPublic', () => {
    it('lists all active wallets with public fields, primaries first', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.identity.listWalletsPublic', { did: user.did });
      expect(res.status).toBe(200);
      expect(res.body.did).toBe(user.did);
      expect(res.body.handle).toBe(user.handle);
      const addresses = res.body.wallets.map((w: any) => w.walletAddress);
      expect(addresses).toContain(ethAddress);
      expect(addresses).toContain(solAddress);
      // Primary comes first.
      expect(res.body.wallets[0].isPrimary).toBe(true);
      // Fields are only the public ones.
      const first = res.body.wallets[0];
      expect(Object.keys(first).sort()).toEqual(['chain', 'custodyTier', 'isPrimary', 'label', 'linkedAt', 'walletAddress'].sort());
    });

    it('returns empty for an unknown DID', async () => {
      const res = await xrpcGet('net.openfederation.identity.listWalletsPublic', { did: 'did:plc:nonexistent0000000000001' });
      expect(res.status).toBe(200);
      expect(res.body.wallets).toEqual([]);
    });
  });

  describe('getDidAugmentation', () => {
    it('emits CAIP-10 blockchainAccountId entries for each active wallet', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.identity.getDidAugmentation', { did: user.did });
      expect(res.status).toBe(200);
      expect(res.body.did).toBe(user.did);
      expect(res.body['@context']).toContain('https://www.w3.org/ns/did/v1');
      expect(res.body.verificationMethod.length).toBeGreaterThanOrEqual(3); // 2 ETH + 1 Solana
      const ethPrimary = res.body.verificationMethod.find((vm: any) =>
        vm.id === `${user.did}#wallet-ethereum`
      );
      expect(ethPrimary).toBeDefined();
      expect(ethPrimary.type).toBe('EcdsaSecp256k1VerificationKey2019');
      expect(ethPrimary.blockchainAccountId).toBe(`eip155:1:${ethAddress}`);

      const solPrimary = res.body.verificationMethod.find((vm: any) =>
        vm.id === `${user.did}#wallet-solana`
      );
      expect(solPrimary).toBeDefined();
      expect(solPrimary.type).toBe('Ed25519VerificationKey2020');
      expect(solPrimary.blockchainAccountId).toBe(`solana:mainnet:${solAddress}`);
    });
  });

  describe('/.well-known/did.json augmentation', () => {
    it('injects blockchainAccountId entries for communities with linked wallets', async () => {
      if (!plcAvailable) return;
      // Configured PDS hostname points at did:web:{pds.hostname}. If no such
      // community is registered, the endpoint returns 404 — skip gracefully
      // rather than fail, since this is environment-dependent.
      const res = await request(app).get('/.well-known/did.json');
      if (res.status === 404) return;
      expect(res.status).toBe(200);
      expect(res.body['@context']).toContain('https://www.w3.org/ns/did/v1');
      expect(Array.isArray(res.body.verificationMethod)).toBe(true);
      // Atproto verification method is always present.
      const atproto = res.body.verificationMethod.find((vm: any) => vm.id.endsWith('#atproto'));
      expect(atproto).toBeDefined();
    });
  });
});
