/**
 * E2E: Identity + Wallet + Recovery (Cross-Cutting)
 *
 * Tests the integration across vault shares, wallet linking, and
 * recovery tier progression. Verifies that registration creates
 * vault shares, wallet linking works, and escrow upgrades the tier.
 * Requires PLC directory.
 */
import { Wallet } from 'ethers';
import {
  isPLCAvailable, createTestUser, uniqueHandle,
  xrpcAuthGet, xrpcAuthPost,
} from './helpers.js';

let plcAvailable = false;
let user: { accessJwt: string; did: string; handle: string };
let wallet: Wallet;
let challenge: string;

beforeAll(async () => {
  plcAvailable = await isPLCAvailable();
  if (!plcAvailable) return;

  user = await createTestUser(uniqueHandle('iwr-user'));
  wallet = Wallet.createRandom();
});

describe('Identity + Wallet + Recovery', () => {
  it('step 1: vault shares created during registration (audit log check)', async () => {
    if (!plcAvailable) return;

    const res = await xrpcAuthGet(
      'net.openfederation.vault.auditLog',
      user.accessJwt,
    );

    expect(res.status).toBe(200);
    const sharesCreated = res.body.entries.find(
      (e: { action: string }) => e.action === 'shares.created',
    );
    expect(sharesCreated, 'Expected shares.created entry in vault audit log').toBeDefined();
  });

  it('step 2: link Ethereum wallet (challenge -> sign -> link)', async () => {
    if (!plcAvailable) return;

    // Get challenge
    const challengeRes = await xrpcAuthGet(
      'net.openfederation.identity.getWalletLinkChallenge',
      user.accessJwt,
      { chain: 'ethereum', walletAddress: wallet.address },
    );
    expect(challengeRes.status).toBe(200);
    challenge = challengeRes.body.challenge;

    // Sign and link
    const signature = await wallet.signMessage(challenge);
    const linkRes = await xrpcAuthPost(
      'net.openfederation.identity.linkWallet',
      user.accessJwt,
      {
        chain: 'ethereum',
        walletAddress: wallet.address,
        challenge,
        signature,
        label: 'iwr-eth',
      },
    );
    expect(linkRes.status).toBe(200);
    expect(linkRes.body.success).toBe(true);
  });

  it('step 3: wallet in listWalletLinks', async () => {
    if (!plcAvailable) return;

    const res = await xrpcAuthGet(
      'net.openfederation.identity.listWalletLinks',
      user.accessJwt,
    );

    expect(res.status).toBe(200);
    const link = res.body.walletLinks.find(
      (l: { label: string }) => l.label === 'iwr-eth',
    );
    expect(link).toBeDefined();
    expect(link.chain).toBe('ethereum');
  });

  it('step 4: security level Tier 1, vaultShares: true', async () => {
    if (!plcAvailable) return;

    const res = await xrpcAuthGet(
      'net.openfederation.account.getSecurityLevel',
      user.accessJwt,
    );

    expect(res.status).toBe(200);
    expect(res.body.recoveryTier).toBe(1);
    expect(res.body.checklist.vaultShares).toBe(true);
    expect(res.body.checklist.escrowRegistered).toBe(false);
  });

  it('step 5: register escrow -> Tier 2', async () => {
    if (!plcAvailable) return;

    const res = await xrpcAuthPost(
      'net.openfederation.vault.registerEscrow',
      user.accessJwt,
      {
        escrowProviderDid: 'did:web:escrow-iwr.example.com',
        escrowProviderName: 'IWR E2E Escrow',
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.recoveryTier).toBe(2);
  });

  it('step 6: security level Tier 2, enhanced, escrowRegistered: true', async () => {
    if (!plcAvailable) return;

    const res = await xrpcAuthGet(
      'net.openfederation.account.getSecurityLevel',
      user.accessJwt,
    );

    expect(res.status).toBe(200);
    expect(res.body.recoveryTier).toBe(2);
    expect(res.body.tierName).toBe('enhanced');
    expect(res.body.checklist.escrowRegistered).toBe(true);
  });

  it('step 7: export requires verification (403)', async () => {
    if (!plcAvailable) return;

    const res = await xrpcAuthPost(
      'net.openfederation.vault.exportRecoveryKey',
      user.accessJwt,
      {},
    );

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('VerificationRequired');
  });
});
