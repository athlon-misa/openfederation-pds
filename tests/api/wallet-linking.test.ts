import { describe, it, expect, beforeAll } from 'vitest';
import { Wallet } from 'ethers';
import {
  xrpcPost,
  xrpcGet,
  xrpcAuthPost,
  xrpcAuthGet,
  createTestUser,
  isPLCAvailable,
  uniqueHandle,
} from './helpers.js';

describe('Wallet Linking', () => {
  let plcAvailable: boolean;
  let user: { accessJwt: string; did: string; handle: string };
  let user2: { accessJwt: string; did: string; handle: string };

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;
    user = await createTestUser(uniqueHandle('wallet'));
    user2 = await createTestUser(uniqueHandle('wallet2'));
  });

  describe('getWalletLinkChallenge', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await xrpcGet('net.openfederation.identity.getWalletLinkChallenge', {
        chain: 'ethereum',
        walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
      });
      expect(res.status).toBe(401);
    });

    it('should reject unsupported chain', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthGet(
        'net.openfederation.identity.getWalletLinkChallenge',
        user.accessJwt,
        { chain: 'bitcoin', walletAddress: 'bc1qtest' }
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('UnsupportedChain');
    });

    it('should reject missing params', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthGet(
        'net.openfederation.identity.getWalletLinkChallenge',
        user.accessJwt,
        { chain: 'ethereum' }
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('InvalidRequest');
    });

    it('should generate a challenge', async () => {
      if (!plcAvailable) return;
      const wallet = Wallet.createRandom();
      const res = await xrpcAuthGet(
        'net.openfederation.identity.getWalletLinkChallenge',
        user.accessJwt,
        { chain: 'ethereum', walletAddress: wallet.address }
      );
      expect(res.status).toBe(200);
      expect(res.body.challenge).toContain('OpenFederation Wallet Link');
      expect(res.body.challenge).toContain(user.did);
      expect(res.body.challenge).toContain(wallet.address);
      expect(res.body.expiresAt).toBeTruthy();
    });
  });

  describe('linkWallet', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await xrpcPost('net.openfederation.identity.linkWallet', {
        chain: 'ethereum',
        walletAddress: '0x123',
        challenge: 'test',
        signature: '0x123',
      });
      expect(res.status).toBe(401);
    });

    it('should reject missing fields', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost(
        'net.openfederation.identity.linkWallet',
        user.accessJwt,
        { chain: 'ethereum' }
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('InvalidRequest');
    });

    it('should reject unsupported chain', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost(
        'net.openfederation.identity.linkWallet',
        user.accessJwt,
        {
          chain: 'bitcoin',
          walletAddress: 'bc1q',
          challenge: 'test',
          signature: 'sig',
        }
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('UnsupportedChain');
    });

    it('should reject invalid challenge', async () => {
      if (!plcAvailable) return;
      const wallet = Wallet.createRandom();
      const res = await xrpcAuthPost(
        'net.openfederation.identity.linkWallet',
        user.accessJwt,
        {
          chain: 'ethereum',
          walletAddress: wallet.address,
          challenge: 'not-a-real-challenge',
          signature: '0x1234',
        }
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('LinkFailed');
    });

    it('should complete full Ethereum link flow', async () => {
      if (!plcAvailable) return;
      const wallet = Wallet.createRandom();

      // 1. Get challenge
      const challengeRes = await xrpcAuthGet(
        'net.openfederation.identity.getWalletLinkChallenge',
        user.accessJwt,
        { chain: 'ethereum', walletAddress: wallet.address }
      );
      expect(challengeRes.status).toBe(200);

      // 2. Sign challenge with wallet
      const signature = await wallet.signMessage(challengeRes.body.challenge);

      // 3. Link wallet
      const linkRes = await xrpcAuthPost(
        'net.openfederation.identity.linkWallet',
        user.accessJwt,
        {
          chain: 'ethereum',
          walletAddress: wallet.address,
          challenge: challengeRes.body.challenge,
          signature,
          label: 'my-eth-wallet',
        }
      );
      expect(linkRes.status).toBe(200);
      expect(linkRes.body.success).toBe(true);
      expect(linkRes.body.chain).toBe('ethereum');
      expect(linkRes.body.walletAddress).toBe(wallet.address);
      expect(linkRes.body.label).toBe('my-eth-wallet');
    });

    it('should reject linking the same wallet to a different DID', async () => {
      if (!plcAvailable) return;
      // The wallet from the previous test is linked to user.did
      // We need the same wallet address — use a fresh wallet and link it first,
      // then try to link it to user2
      const wallet = Wallet.createRandom();

      // Link to user1 first
      const c1 = await xrpcAuthGet(
        'net.openfederation.identity.getWalletLinkChallenge',
        user.accessJwt,
        { chain: 'ethereum', walletAddress: wallet.address }
      );
      const sig1 = await wallet.signMessage(c1.body.challenge);
      const link1 = await xrpcAuthPost(
        'net.openfederation.identity.linkWallet',
        user.accessJwt,
        {
          chain: 'ethereum',
          walletAddress: wallet.address,
          challenge: c1.body.challenge,
          signature: sig1,
          label: 'conflict-test',
        }
      );
      expect(link1.status).toBe(200);

      // Try to link same wallet to user2
      const c2 = await xrpcAuthGet(
        'net.openfederation.identity.getWalletLinkChallenge',
        user2.accessJwt,
        { chain: 'ethereum', walletAddress: wallet.address }
      );
      const sig2 = await wallet.signMessage(c2.body.challenge);
      const link2 = await xrpcAuthPost(
        'net.openfederation.identity.linkWallet',
        user2.accessJwt,
        {
          chain: 'ethereum',
          walletAddress: wallet.address,
          challenge: c2.body.challenge,
          signature: sig2,
          label: 'stolen-wallet',
        }
      );
      expect(link2.status).toBe(400);
      expect(link2.body.error).toBe('LinkFailed');
      expect(link2.body.message).toContain('already linked');
    });

    it('should reject label longer than 64 characters', async () => {
      if (!plcAvailable) return;
      const wallet = Wallet.createRandom();
      const c = await xrpcAuthGet(
        'net.openfederation.identity.getWalletLinkChallenge',
        user.accessJwt,
        { chain: 'ethereum', walletAddress: wallet.address }
      );
      const sig = await wallet.signMessage(c.body.challenge);
      const res = await xrpcAuthPost(
        'net.openfederation.identity.linkWallet',
        user.accessJwt,
        {
          chain: 'ethereum',
          walletAddress: wallet.address,
          challenge: c.body.challenge,
          signature: sig,
          label: 'x'.repeat(65),
        }
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('InvalidRequest');
    });
  });

  describe('resolveWallet', () => {
    it('should resolve a linked wallet to its DID', async () => {
      if (!plcAvailable) return;
      // The first test linked a wallet with label 'my-eth-wallet'
      // We need the address — let's link a new known wallet and resolve it
      const wallet = Wallet.createRandom();
      const c = await xrpcAuthGet(
        'net.openfederation.identity.getWalletLinkChallenge',
        user.accessJwt,
        { chain: 'ethereum', walletAddress: wallet.address }
      );
      const sig = await wallet.signMessage(c.body.challenge);
      await xrpcAuthPost(
        'net.openfederation.identity.linkWallet',
        user.accessJwt,
        {
          chain: 'ethereum',
          walletAddress: wallet.address,
          challenge: c.body.challenge,
          signature: sig,
          label: 'resolve-test',
        }
      );

      // Resolve (no auth required)
      const res = await xrpcGet('net.openfederation.identity.resolveWallet', {
        chain: 'ethereum',
        walletAddress: wallet.address,
      });
      expect(res.status).toBe(200);
      expect(res.body.did).toBe(user.did);
      expect(res.body.handle).toBeTruthy();
    });

    it('should return 404 for an unlinked wallet', async () => {
      const res = await xrpcGet('net.openfederation.identity.resolveWallet', {
        chain: 'ethereum',
        walletAddress: '0x0000000000000000000000000000000000000000',
      });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('WalletNotFound');
    });

    it('should reject missing parameters', async () => {
      const res = await xrpcGet('net.openfederation.identity.resolveWallet', {
        chain: 'ethereum',
      });
      expect(res.status).toBe(400);
    });

    it('should reject unsupported chain', async () => {
      const res = await xrpcGet('net.openfederation.identity.resolveWallet', {
        chain: 'bitcoin',
        walletAddress: 'bc1q',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('UnsupportedChain');
    });
  });

  describe('unlinkWallet', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await xrpcPost('net.openfederation.identity.unlinkWallet', {
        label: 'test',
      });
      expect(res.status).toBe(401);
    });

    it('should reject missing label', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost(
        'net.openfederation.identity.unlinkWallet',
        user.accessJwt,
        {}
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('InvalidRequest');
    });

    it('should return 404 for non-existent label', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost(
        'net.openfederation.identity.unlinkWallet',
        user.accessJwt,
        { label: 'nonexistent-wallet-label' }
      );
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NotFound');
    });

    it('should unlink a wallet', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost(
        'net.openfederation.identity.unlinkWallet',
        user.accessJwt,
        { label: 'my-eth-wallet' }
      );
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});
