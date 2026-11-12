import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { JsonRpcProvider, Wallet, parseEther, Transaction as EthersTransaction } from 'ethers';
import { createClient } from '../../packages/openfederation-sdk/src/index.js';
import type { OpenFederationClient } from '../../packages/openfederation-sdk/src/client.js';
import { config } from '../../src/config.js';
import {
  createTestUser,
  grantWalletConsent,
  isPLCAvailable,
  uniqueHandle,
} from './helpers.js';
import { ANVIL_DEV_PRIVATE_KEY, findAnvil, startAnvil, type AnvilNode } from './anvil.js';

// Issue #78: `asEthersSigner()` signs EIP-1559 transactions that a real
// Ethereum node accepts and mines — not only signatures checked offline.
//
// The wallets are made the way an application makes them, through the SDK
// against this PDS: Tier 2 via createTier2 + unlockTier2, Tier 1 via
// createTier1 + an approved consent. Each is funded from an anvil dev account,
// sends a transfer through `signer.sendTransaction`, and the mined receipt and
// balances are checked on the chain.
//
// Needs Foundry's `anvil` (skipped without it) and the PLC directory.

const anvilBin = findAnvil();
const PASSWORD = 'TestPassword123!';
const DAPP_ORIGIN = 'https://anvil-dapp.example.com';
const RECIPIENT = '0x00000000000000000000000000000000000a11ce';

describe.skipIf(!anvilBin)('asEthersSigner against a local Ethereum node (anvil)', () => {
  let anvil: AnvilNode;
  let provider: JsonRpcProvider;
  let funder: Wallet;
  let plcAvailable = false;
  let user: { accessJwt: string; handle: string };
  let client: OpenFederationClient;

  beforeAll(async () => {
    anvil = await startAnvil(anvilBin!);
    provider = new JsonRpcProvider(anvil.rpcUrl, anvil.chainId, { staticNetwork: true, pollingInterval: 100, cacheTimeout: -1 });
    funder = new Wallet(ANVIL_DEV_PRIVATE_KEY, provider);

    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;
    user = await createTestUser(uniqueHandle('anvil-wallet'));
    client = createClient({ serverUrl: config.pds.serviceUrl, partnerKey: 'ofp_unused', storage: 'memory', autoRefresh: false });
    await client.login({ identifier: user.handle, password: PASSWORD });
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    provider?.destroy();
    await anvil?.stop();
  });

  async function fund(address: string, amount: bigint): Promise<void> {
    const tx = await funder.sendTransaction({ to: address, value: amount });
    await tx.wait();
  }

  it('anvil reports the dev chain id the tests rely on', () => {
    expect(anvil.chainId).toBe(31337);
  });

  it('Tier 2: a wallet created and unlocked through the SDK sends an EIP-1559 transfer that is mined', async () => {
    if (!plcAvailable) return;
    const created = await client.wallet.createTier2({ chain: 'ethereum', passphrase: 'anvil-tier2-pass' });
    expect(created.custodyTier).toBe('user_encrypted');

    const session = await client.wallet.unlockTier2({
      chain: 'ethereum',
      passphrase: 'anvil-tier2-pass',
      walletAddress: created.walletAddress,
    });
    try {
      await fund(created.walletAddress, parseEther('1'));

      const signer = (await client.wallet.asEthersSigner({ walletAddress: created.walletAddress, session })).connect(provider);
      const before = await provider.getBalance(RECIPIENT);
      const value = parseEther('0.25');

      const sent = await signer.sendTransaction({ to: RECIPIENT, value });
      const receipt = await sent.wait();

      expect(receipt).not.toBeNull();
      expect(receipt!.status).toBe(1);
      expect(receipt!.from.toLowerCase()).toBe(created.walletAddress.toLowerCase());
      expect(receipt!.to!.toLowerCase()).toBe(RECIPIENT);
      // The node mined what was signed: an EIP-1559 (type 2) transaction on this chain.
      const mined = await provider.getTransaction(receipt!.hash);
      expect(mined!.type).toBe(2);
      expect(mined!.chainId).toBe(31337n);
      expect(mined!.value).toBe(value);
      expect(await provider.getBalance(RECIPIENT)).toBe(before + value);
      // eslint-disable-next-line no-console
      console.log(`[#78] Tier 2 EIP-1559 tx mined on anvil: ${receipt!.hash} (block ${receipt!.blockNumber})`);
    } finally {
      session.destroy();
    }
  });

  it('Tier 2: a raw signTransaction without a provider broadcasts and mines', async () => {
    if (!plcAvailable) return;
    const created = await client.wallet.createTier2({ chain: 'ethereum', passphrase: 'anvil-tier2-raw' });
    const session = await client.wallet.unlockTier2({ chain: 'ethereum', passphrase: 'anvil-tier2-raw', walletAddress: created.walletAddress });
    try {
      await fund(created.walletAddress, parseEther('1'));
      const signer = await client.wallet.asEthersSigner({ walletAddress: created.walletAddress, session });
      const fee = await provider.getFeeData();
      const signed = await signer.signTransaction({
        type: 2,
        chainId: anvil.chainId,
        nonce: 0,
        to: RECIPIENT,
        value: 12345n,
        gasLimit: 21000n,
        maxFeePerGas: fee.maxFeePerGas!,
        maxPriorityFeePerGas: fee.maxPriorityFeePerGas!,
      });
      expect(EthersTransaction.from(signed).type).toBe(2);

      const sent = await provider.broadcastTransaction(signed);
      const receipt = await sent.wait();
      expect(receipt!.status).toBe(1);
      expect(receipt!.from.toLowerCase()).toBe(created.walletAddress.toLowerCase());
    } finally {
      session.destroy();
    }
  });

  it('Tier 1: the PDS signs through asEthersSigner under an approved consent, and the node mines it', async () => {
    if (!plcAvailable) return;
    const created = await client.wallet.createTier1({ chain: 'ethereum' });
    expect(created.custodyTier).toBe('custodial');

    const consent = await grantWalletConsent(user.accessJwt, DAPP_ORIGIN, {
      dappOrigin: DAPP_ORIGIN,
      chain: 'ethereum',
      walletAddress: created.walletAddress,
      allowedContracts: [RECIPIENT],
      maxValuePerTx: parseEther('0.5').toString(),
    });
    expect(consent.status).toBe(200);

    // Custodial signing is bound to the browser's Origin (#101). The SDK runs
    // in a browser, where `location` and the Origin header come for free; in
    // Node both are supplied here, the way the browser would.
    vi.stubGlobal('location', { origin: DAPP_ORIGIN });
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (String(input).startsWith(config.pds.serviceUrl)) headers.set('Origin', DAPP_ORIGIN);
      return realFetch(input, { ...init, headers });
    });
    try {
      await fund(created.walletAddress, parseEther('1'));
      const signer = (await client.wallet.asEthersSigner({ walletAddress: created.walletAddress })).connect(provider);
      const value = parseEther('0.1');
      const before = await provider.getBalance(RECIPIENT);

      const sent = await signer.sendTransaction({ to: RECIPIENT, value });
      const receipt = await sent.wait();

      expect(receipt!.status).toBe(1);
      expect(receipt!.from.toLowerCase()).toBe(created.walletAddress.toLowerCase());
      expect(receipt!.to!.toLowerCase()).toBe(RECIPIENT);
      const mined = await provider.getTransaction(receipt!.hash);
      expect(mined!.type).toBe(2);
      expect(mined!.value).toBe(value);
      expect(await provider.getBalance(RECIPIENT)).toBe(before + value);
      // eslint-disable-next-line no-console
      console.log(`[#78] Tier 1 EIP-1559 tx mined on anvil: ${receipt!.hash} (block ${receipt!.blockNumber})`);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
