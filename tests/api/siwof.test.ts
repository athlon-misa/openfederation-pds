import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcAuthGet,
  xrpcAuthPost,
  xrpcPost,
  getAdminToken,
  uniqueHandle,
} from './helpers.js';
import { verifySignInAssertion } from '../../packages/openfederation-sdk/src/siwof/verify.js';
import { query } from '../../src/db/client.js';
import { decryptKeyBytes } from '../../src/auth/encryption.js';
import { Secp256k1Keypair } from '@atproto/crypto';

// End-to-end SIWOF: user signs a CAIP-122 message with their Tier 1
// custodial wallet; dApp gets didToken + walletProof and verifies both
// offline using the SDK's verifier (which pulls the DID doc and checks
// signatures cryptographically — zero calls to OF's signInAssert path).

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
  };
}

describe('Sign-In With OpenFederation', () => {
  let plcAvailable = false;
  let user: { accessJwt: string; did: string };
  let ethAddress: string;
  let solAddress: string;
  /** Override resolver: fetch user's signing key directly from our DB. */
  let resolveSigningKey: (did: string) => Promise<string>;

  beforeAll(async () => {
    plcAvailable = await isPlcReachable();
    if (!plcAvailable) return;
    user = await registerAndApproveUser(uniqueHandle('siwof'));

    // Build a custom resolver that reads the user's atproto signing key from
    // our DB and returns it as a did:key (so the verifier doesn't need a
    // public PLC directory). This isolates the SIWOF verification logic
    // from the PLC network dependency and matches what a dApp would get
    // from a standard DID resolver.
    resolveSigningKey = async (did) => {
      const keyRes = await query<{ signing_key_bytes: Buffer }>(
        `SELECT signing_key_bytes FROM user_signing_keys WHERE user_did = $1`,
        [did]
      );
      if (keyRes.rows.length === 0) throw new Error(`no signing key for ${did}`);
      const decrypted = await decryptKeyBytes(keyRes.rows[0].signing_key_bytes);
      const kp = await Secp256k1Keypair.import(decrypted);
      return kp.did(); // did:key:zQ3sh...
    };

    // Provision Tier 1 wallets on each chain + grant consent.
    const ethRes = await xrpcAuthPost('net.openfederation.wallet.provision', user.accessJwt, { chain: 'ethereum' });
    expect(ethRes.status).toBe(200);
    ethAddress = ethRes.body.walletAddress;
    const solRes = await xrpcAuthPost('net.openfederation.wallet.provision', user.accessJwt, { chain: 'solana' });
    expect(solRes.status).toBe(200);
    solAddress = solRes.body.walletAddress;

    await xrpcAuthPost('net.openfederation.wallet.grantConsent', user.accessJwt, {
      dappOrigin: 'https://siwof-test.example.com',
      chain: 'ethereum',
      walletAddress: ethAddress,
    });
    await xrpcAuthPost('net.openfederation.wallet.grantConsent', user.accessJwt, {
      dappOrigin: 'https://siwof-test.example.com',
      chain: 'solana',
      walletAddress: solAddress,
    });
  });

  describe('Ethereum', () => {
    it('issues a SIWOF challenge + canonical message', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.identity.signInChallenge', user.accessJwt, {
        chain: 'ethereum',
        walletAddress: ethAddress,
        audience: 'https://siwof-test.example.com',
        statement: 'Sign in to continue',
      });
      expect(res.status).toBe(200);
      expect(res.body.message).toContain('siwof-test.example.com wants you to sign in with your Ethereum account');
      expect(res.body.message).toContain(ethAddress);
      expect(res.body.chainIdCaip2).toBe('eip155:1');
      expect(res.body.nonce).toMatch(/^[0-9a-f]{32}$/);
    });

    it('full round-trip: challenge → sign (server) → assert → offline verify', async () => {
      if (!plcAvailable) return;
      const ch = await xrpcAuthPost('net.openfederation.identity.signInChallenge', user.accessJwt, {
        chain: 'ethereum',
        walletAddress: ethAddress,
        audience: 'https://siwof-test.example.com/login',
        statement: 'Welcome back',
      });
      expect(ch.status).toBe(200);

      // Tier 1: the PDS signs via wallet.sign (consent already granted).
      const signed = await xrpcAuthPost('net.openfederation.wallet.sign', user.accessJwt, {
        chain: 'ethereum',
        walletAddress: ethAddress,
        message: ch.body.message,
        dappOrigin: 'https://siwof-test.example.com/login',
      });
      expect(signed.status).toBe(200);

      const assertRes = await xrpcAuthPost('net.openfederation.identity.signInAssert', user.accessJwt, {
        chain: 'ethereum',
        walletAddress: ethAddress,
        message: ch.body.message,
        walletSignature: signed.body.signature,
      });
      expect(assertRes.status).toBe(200);
      expect(assertRes.body.did).toBe(user.did);
      expect(assertRes.body.audience).toBe('https://siwof-test.example.com/login');
      expect(assertRes.body.didToken.split('.').length).toBe(3);

      // Offline verification: the dApp resolves the user's DID and checks
      // both signatures without calling OpenFederation.
      const verified = await verifySignInAssertion(
        assertRes.body.didToken,
        assertRes.body.walletProof,
        {
          expectedAudience: 'https://siwof-test.example.com/login',
          resolveSigningKey,
        }
      );
      expect(verified.did).toBe(user.did);
      expect(verified.chain).toBe('ethereum');
      expect(verified.walletAddress).toBe(ethAddress);
      expect(verified.chainIdCaip2).toBe('eip155:1');
      expect(verified.audience).toBe('https://siwof-test.example.com/login');
    });

    it('rejects replay of a consumed challenge', async () => {
      if (!plcAvailable) return;
      const ch = await xrpcAuthPost('net.openfederation.identity.signInChallenge', user.accessJwt, {
        chain: 'ethereum',
        walletAddress: ethAddress,
        audience: 'https://siwof-test.example.com/login',
      });
      const signed = await xrpcAuthPost('net.openfederation.wallet.sign', user.accessJwt, {
        chain: 'ethereum',
        walletAddress: ethAddress,
        message: ch.body.message,
        dappOrigin: 'https://siwof-test.example.com/login',
      });
      const a1 = await xrpcAuthPost('net.openfederation.identity.signInAssert', user.accessJwt, {
        chain: 'ethereum',
        walletAddress: ethAddress,
        message: ch.body.message,
        walletSignature: signed.body.signature,
      });
      expect(a1.status).toBe(200);
      const a2 = await xrpcAuthPost('net.openfederation.identity.signInAssert', user.accessJwt, {
        chain: 'ethereum',
        walletAddress: ethAddress,
        message: ch.body.message,
        walletSignature: signed.body.signature,
      });
      expect(a2.status).toBe(404);
      expect(a2.body.error).toBe('ChallengeNotFound');
    });

    it('rejects assert for a wallet the caller does not own', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.identity.signInChallenge', user.accessJwt, {
        chain: 'ethereum',
        walletAddress: '0x1111111111111111111111111111111111111111',
        audience: 'https://siwof-test.example.com',
      });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('WalletNotFound');
    });

    it('rejects malformed audience', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.identity.signInChallenge', user.accessJwt, {
        chain: 'ethereum',
        walletAddress: ethAddress,
        audience: 'not a url',
      });
      expect(res.status).toBe(400);
    });
  });

  describe('Solana', () => {
    it('full round-trip: challenge → sign → assert → offline verify', async () => {
      if (!plcAvailable) return;
      const ch = await xrpcAuthPost('net.openfederation.identity.signInChallenge', user.accessJwt, {
        chain: 'solana',
        walletAddress: solAddress,
        audience: 'https://siwof-test.example.com/login',
      });
      expect(ch.status).toBe(200);
      expect(ch.body.chainIdCaip2).toBe('solana:mainnet');

      const signed = await xrpcAuthPost('net.openfederation.wallet.sign', user.accessJwt, {
        chain: 'solana',
        walletAddress: solAddress,
        message: ch.body.message,
        dappOrigin: 'https://siwof-test.example.com/login',
      });
      expect(signed.status).toBe(200);

      const assertRes = await xrpcAuthPost('net.openfederation.identity.signInAssert', user.accessJwt, {
        chain: 'solana',
        walletAddress: solAddress,
        message: ch.body.message,
        walletSignature: signed.body.signature,
      });
      expect(assertRes.status).toBe(200);

      const verified = await verifySignInAssertion(
        assertRes.body.didToken,
        assertRes.body.walletProof,
        { expectedAudience: 'https://siwof-test.example.com/login', resolveSigningKey }
      );
      expect(verified.chain).toBe('solana');
      expect(verified.walletAddress).toBe(solAddress);
      expect(verified.chainIdCaip2).toBe('solana:mainnet');
    });
  });

  describe('offline verifier rejections', () => {
    it('rejects a didToken with wrong expected audience', async () => {
      if (!plcAvailable) return;
      const ch = await xrpcAuthPost('net.openfederation.identity.signInChallenge', user.accessJwt, {
        chain: 'ethereum',
        walletAddress: ethAddress,
        audience: 'https://siwof-test.example.com/login',
      });
      const signed = await xrpcAuthPost('net.openfederation.wallet.sign', user.accessJwt, {
        chain: 'ethereum',
        walletAddress: ethAddress,
        message: ch.body.message,
        dappOrigin: 'https://siwof-test.example.com/login',
      });
      const assertRes = await xrpcAuthPost('net.openfederation.identity.signInAssert', user.accessJwt, {
        chain: 'ethereum',
        walletAddress: ethAddress,
        message: ch.body.message,
        walletSignature: signed.body.signature,
      });
      await expect(
        verifySignInAssertion(assertRes.body.didToken, assertRes.body.walletProof, {
          expectedAudience: 'https://evil.example.com',
          resolveSigningKey,
        })
      ).rejects.toMatchObject({ code: 'BadAudience' });
    });

    it('rejects a tampered wallet proof', async () => {
      if (!plcAvailable) return;
      const ch = await xrpcAuthPost('net.openfederation.identity.signInChallenge', user.accessJwt, {
        chain: 'ethereum',
        walletAddress: ethAddress,
        audience: 'https://siwof-test.example.com/login',
      });
      const signed = await xrpcAuthPost('net.openfederation.wallet.sign', user.accessJwt, {
        chain: 'ethereum',
        walletAddress: ethAddress,
        message: ch.body.message,
        dappOrigin: 'https://siwof-test.example.com/login',
      });
      const assertRes = await xrpcAuthPost('net.openfederation.identity.signInAssert', user.accessJwt, {
        chain: 'ethereum',
        walletAddress: ethAddress,
        message: ch.body.message,
        walletSignature: signed.body.signature,
      });
      const badProof = { ...assertRes.body.walletProof, walletAddress: '0x0000000000000000000000000000000000000000' };
      await expect(
        verifySignInAssertion(assertRes.body.didToken, badProof, { resolveSigningKey })
      ).rejects.toMatchObject({ code: 'ProofMismatch' });
    });
  });
});
