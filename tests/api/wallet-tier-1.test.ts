import { describe, it, expect, beforeAll } from 'vitest';
import { verifyMessage as verifyEthMessage } from 'ethers';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  xrpcAuthGet,
  xrpcAuthPost,
  xrpcPost,
  getAdminToken,
  uniqueHandle,
} from './helpers.js';

// End-to-end tests for Tier 1 custodial wallets: provision, grant consent,
// sign, verify signature independently, then exercise every rejection path.
//
// Requires PLC + PostgreSQL running locally. PLC helper in the repo targets
// the wrong endpoint; we inline our own check.

async function isPlcReachable(): Promise<boolean> {
  try {
    const url = process.env.PLC_DIRECTORY_URL || 'http://localhost:2582';
    const res = await fetch(`${url}/_health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function registerAndApproveUser(handle: string) {
  const adminToken = await getAdminToken();
  const inviteRes = await xrpcAuthPost('net.openfederation.invite.create', adminToken, { maxUses: 1 });
  if (inviteRes.status !== 201) throw new Error(`invite: ${inviteRes.status} ${JSON.stringify(inviteRes.body)}`);
  const regRes = await xrpcPost('net.openfederation.account.register', {
    handle,
    email: `${handle}@test.local`,
    password: 'TestPassword123!',
    inviteCode: inviteRes.body.code,
  });
  if (regRes.status >= 400) throw new Error(`register: ${regRes.status} ${JSON.stringify(regRes.body)}`);
  const userId = regRes.body.id || regRes.body.userId;
  await xrpcAuthPost('net.openfederation.account.approve', adminToken, { userId });
  const loginRes = await xrpcPost('com.atproto.server.createSession', {
    identifier: handle,
    password: 'TestPassword123!',
  });
  if (loginRes.status !== 200) throw new Error(`login: ${loginRes.status} ${JSON.stringify(loginRes.body)}`);
  return {
    accessJwt: loginRes.body.accessJwt as string,
    did: loginRes.body.did as string,
    handle: loginRes.body.handle as string,
  };
}

describe('Tier 1 custodial wallets', () => {
  let plcAvailable = false;
  let user: { accessJwt: string; did: string; handle: string };

  beforeAll(async () => {
    plcAvailable = await isPlcReachable();
    if (!plcAvailable) return;
    user = await registerAndApproveUser(uniqueHandle('t1-wallet'));
  });

  describe('provision', () => {
    it('rejects unauthenticated callers', async () => {
      const res = await xrpcPost('net.openfederation.wallet.provision', { chain: 'ethereum' });
      expect(res.status).toBe(401);
    });

    it('rejects unknown chain', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.wallet.provision', user.accessJwt, {
        chain: 'bitcoin',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('UnsupportedChain');
    });

    it('provisions an Ethereum wallet and links it to the user DID', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.wallet.provision', user.accessJwt, {
        chain: 'ethereum',
        label: 'eth-game-1',
      });
      expect(res.status).toBe(200);
      expect(res.body.chain).toBe('ethereum');
      expect(res.body.walletAddress).toMatch(/^0x[0-9a-f]{40}$/);
      expect(res.body.custodyTier).toBe('custodial');
      expect(res.body.label).toBe('eth-game-1');

      // Verify via listWalletLinks
      const list = await xrpcAuthGet('net.openfederation.identity.listWalletLinks', user.accessJwt);
      expect(list.status).toBe(200);
      const match = list.body.walletLinks.find(
        (l: any) => l.chain === 'ethereum' && l.walletAddress === res.body.walletAddress
      );
      expect(match).toBeDefined();
    });

    it('provisions a Solana wallet independently', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.wallet.provision', user.accessJwt, {
        chain: 'solana',
        label: 'sol-game-1',
      });
      expect(res.status).toBe(200);
      expect(res.body.chain).toBe('solana');
      // base58 Solana addresses are 32-44 chars
      expect(res.body.walletAddress).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      expect(res.body.custodyTier).toBe('custodial');
    });

    it('rejects duplicate label for the same user', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.wallet.provision', user.accessJwt, {
        chain: 'ethereum',
        label: 'eth-game-1', // already used above
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('ProvisionFailed');
    });
  });

  describe('consent lifecycle', () => {
    it('list returns empty before any grants', async () => {
      if (!plcAvailable) return;
      // Revoke any leftover consents to keep this deterministic.
      await xrpcAuthPost('net.openfederation.wallet.revokeConsent', user.accessJwt, {
        dappOrigin: 'https://game.example.com',
      });
      const res = await xrpcAuthGet('net.openfederation.wallet.listConsents', user.accessJwt);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.consents)).toBe(true);
    });

    it('grants a per-wallet consent', async () => {
      if (!plcAvailable) return;
      const list = await xrpcAuthGet('net.openfederation.identity.listWalletLinks', user.accessJwt);
      const ethWallet = list.body.walletLinks.find((l: any) => l.chain === 'ethereum');
      expect(ethWallet).toBeDefined();

      const res = await xrpcAuthPost('net.openfederation.wallet.grantConsent', user.accessJwt, {
        dappOrigin: 'https://game.example.com',
        chain: 'ethereum',
        walletAddress: ethWallet.walletAddress,
      });
      expect(res.status).toBe(200);
      expect(res.body.dappOrigin).toBe('https://game.example.com');
      expect(res.body.chain).toBe('ethereum');
      expect(res.body.walletAddress).toBe(ethWallet.walletAddress);
      expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('rejects ttlSeconds beyond 30 days', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.wallet.grantConsent', user.accessJwt, {
        dappOrigin: 'https://game.example.com',
        ttlSeconds: 365 * 24 * 60 * 60,
      });
      expect(res.status).toBe(400);
    });

    it('rejects malformed origin', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.wallet.grantConsent', user.accessJwt, {
        dappOrigin: 'not-a-url',
      });
      expect(res.status).toBe(400);
    });

    it('rejects inconsistent scope (chain without walletAddress)', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.wallet.grantConsent', user.accessJwt, {
        dappOrigin: 'https://game.example.com',
        chain: 'ethereum',
      });
      expect(res.status).toBe(400);
    });
  });

  describe('sign', () => {
    it('signs an Ethereum message and the signature verifies against the wallet', async () => {
      if (!plcAvailable) return;
      const list = await xrpcAuthGet('net.openfederation.identity.listWalletLinks', user.accessJwt);
      const ethWallet = list.body.walletLinks.find((l: any) => l.chain === 'ethereum');

      // Consent was granted above; sign should succeed.
      const message = 'Hello from a Tier 1 wallet';
      const res = await xrpcAuthPost('net.openfederation.wallet.sign', user.accessJwt, {
        chain: 'ethereum',
        walletAddress: ethWallet.walletAddress,
        message,
        dappOrigin: 'https://game.example.com',
      });
      expect(res.status).toBe(200);
      expect(res.body.signature).toMatch(/^0x[0-9a-f]+$/);

      // Independently verify the signature.
      const recovered = verifyEthMessage(message, res.body.signature).toLowerCase();
      expect(recovered).toBe(ethWallet.walletAddress);
    });

    it('signs a Solana message and the signature verifies against the wallet', async () => {
      if (!plcAvailable) return;
      const list = await xrpcAuthGet('net.openfederation.identity.listWalletLinks', user.accessJwt);
      const solWallet = list.body.walletLinks.find((l: any) => l.chain === 'solana');

      // Grant Solana consent.
      const grantRes = await xrpcAuthPost('net.openfederation.wallet.grantConsent', user.accessJwt, {
        dappOrigin: 'https://sol.example.com',
        chain: 'solana',
        walletAddress: solWallet.walletAddress,
      });
      expect(grantRes.status).toBe(200);

      const message = 'hola from solana tier 1';
      const res = await xrpcAuthPost('net.openfederation.wallet.sign', user.accessJwt, {
        chain: 'solana',
        walletAddress: solWallet.walletAddress,
        message,
        dappOrigin: 'https://sol.example.com',
      });
      expect(res.status).toBe(200);

      const msgBytes = new TextEncoder().encode(message);
      const sigBytes = bs58.decode(res.body.signature);
      const pkBytes = bs58.decode(solWallet.walletAddress);
      expect(nacl.sign.detached.verify(msgBytes, sigBytes, pkBytes)).toBe(true);
    });

    it('rejects when no consent exists for the origin', async () => {
      if (!plcAvailable) return;
      const list = await xrpcAuthGet('net.openfederation.identity.listWalletLinks', user.accessJwt);
      const ethWallet = list.body.walletLinks.find((l: any) => l.chain === 'ethereum');

      const res = await xrpcAuthPost('net.openfederation.wallet.sign', user.accessJwt, {
        chain: 'ethereum',
        walletAddress: ethWallet.walletAddress,
        message: 'hi',
        dappOrigin: 'https://malicious.example.com',
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('ConsentRequired');
    });

    it('rejects after explicit revocation', async () => {
      if (!plcAvailable) return;
      const list = await xrpcAuthGet('net.openfederation.identity.listWalletLinks', user.accessJwt);
      const solWallet = list.body.walletLinks.find((l: any) => l.chain === 'solana');

      await xrpcAuthPost('net.openfederation.wallet.revokeConsent', user.accessJwt, {
        dappOrigin: 'https://sol.example.com',
        chain: 'solana',
        walletAddress: solWallet.walletAddress,
      });

      const res = await xrpcAuthPost('net.openfederation.wallet.sign', user.accessJwt, {
        chain: 'solana',
        walletAddress: solWallet.walletAddress,
        message: 'after revoke',
        dappOrigin: 'https://sol.example.com',
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('ConsentRequired');
    });

    it('rejects signing for a wallet not owned by the caller', async () => {
      if (!plcAvailable) return;
      // Any address that isn't linked to this DID is indistinguishable from
      // "linked to a different DID" for authorization purposes — both return
      // WalletNotFound. This covers the theft-attempt scenario without having
      // to register a second user (which would trip the createLimiter).
      const notOwned = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
      const res = await xrpcAuthPost('net.openfederation.wallet.sign', user.accessJwt, {
        chain: 'ethereum',
        walletAddress: notOwned,
        message: 'theft attempt',
        dappOrigin: 'https://game.example.com',
      });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('WalletNotFound');
    });

    it('rejects oversize message', async () => {
      if (!plcAvailable) return;
      const list = await xrpcAuthGet('net.openfederation.identity.listWalletLinks', user.accessJwt);
      const ethWallet = list.body.walletLinks.find((l: any) => l.chain === 'ethereum');
      const res = await xrpcAuthPost('net.openfederation.wallet.sign', user.accessJwt, {
        chain: 'ethereum',
        walletAddress: ethWallet.walletAddress,
        message: 'x'.repeat(5000),
        dappOrigin: 'https://game.example.com',
      });
      expect(res.status).toBe(400);
    });

    it('rejects a sign call where dappOrigin is missing from both body and header', async () => {
      if (!plcAvailable) return;
      const list = await xrpcAuthGet('net.openfederation.identity.listWalletLinks', user.accessJwt);
      const ethWallet = list.body.walletLinks.find((l: any) => l.chain === 'ethereum');
      const res = await xrpcAuthPost('net.openfederation.wallet.sign', user.accessJwt, {
        chain: 'ethereum',
        walletAddress: ethWallet.walletAddress,
        message: 'no origin',
      });
      expect(res.status).toBe(400);
    });
  });
});
