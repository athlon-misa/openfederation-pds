/**
 * E2E: Wallet Linking
 *
 * Tests the full wallet linking lifecycle: challenge generation,
 * signature verification, linking, resolution, and unlinking.
 * Requires PLC directory.
 */
import { Wallet } from 'ethers';
import {
  isPLCAvailable, createTestUser, uniqueHandle,
  xrpcAuthGet, xrpcAuthPost, xrpcGet,
} from './helpers.js';

let plcAvailable = false;
let user: { accessJwt: string; did: string; handle: string };
let wallet: Wallet;
let challenge: string;

beforeAll(async () => {
  plcAvailable = await isPLCAvailable();
  if (!plcAvailable) return;

  user = await createTestUser(uniqueHandle('wl-user'));
  wallet = Wallet.createRandom();
});

describe('Wallet Linking', () => {
  it('step 1: get challenge for Ethereum wallet', async () => {
    if (!plcAvailable) return;

    const res = await xrpcAuthGet(
      'net.openfederation.identity.getWalletLinkChallenge',
      user.accessJwt,
      { chain: 'ethereum', walletAddress: wallet.address },
    );

    expect(res.status).toBe(200);
    expect(res.body.challenge).toBeDefined();
    expect(typeof res.body.challenge).toBe('string');
    challenge = res.body.challenge;
  });

  it('step 2: sign challenge and link wallet', async () => {
    if (!plcAvailable) return;

    const signature = await wallet.signMessage(challenge);

    const res = await xrpcAuthPost(
      'net.openfederation.identity.linkWallet',
      user.accessJwt,
      {
        chain: 'ethereum',
        walletAddress: wallet.address,
        challenge,
        signature,
        label: 'e2e-eth-main',
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.chain).toBe('ethereum');
    expect(res.body.walletAddress).toBe(wallet.address);
  });

  it('step 3: listWalletLinks shows the linked wallet', async () => {
    if (!plcAvailable) return;

    const res = await xrpcAuthGet(
      'net.openfederation.identity.listWalletLinks',
      user.accessJwt,
    );

    expect(res.status).toBe(200);
    expect(res.body.walletLinks).toBeDefined();
    expect(Array.isArray(res.body.walletLinks)).toBe(true);

    const link = res.body.walletLinks.find(
      (l: { walletAddress: string }) => l.walletAddress.toLowerCase() === wallet.address.toLowerCase(),
    );
    expect(link).toBeDefined();
    expect(link.chain).toBe('ethereum');
    expect(link.label).toBe('e2e-eth-main');
  });

  it('step 4: resolveWallet returns user DID', async () => {
    if (!plcAvailable) return;

    const res = await xrpcGet(
      'net.openfederation.identity.resolveWallet',
      { chain: 'ethereum', walletAddress: wallet.address },
    );

    expect(res.status).toBe(200);
    expect(res.body.did).toBe(user.did);
  });

  it('step 5: unlink wallet', async () => {
    if (!plcAvailable) return;

    const res = await xrpcAuthPost(
      'net.openfederation.identity.unlinkWallet',
      user.accessJwt,
      { label: 'e2e-eth-main' },
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('step 6: resolveWallet returns 404 after unlink', async () => {
    if (!plcAvailable) return;

    const res = await xrpcGet(
      'net.openfederation.identity.resolveWallet',
      { chain: 'ethereum', walletAddress: wallet.address },
    );

    expect(res.status).toBe(404);
  });
});
