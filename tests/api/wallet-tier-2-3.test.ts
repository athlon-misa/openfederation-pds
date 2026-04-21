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
import {
  generateMnemonic,
  deriveWallet,
  wrapMnemonic,
  unwrapMnemonic,
  signMessage,
} from '../../packages/openfederation-sdk/src/wallet/index.js';
import { mnemonicToSeed } from '../../packages/openfederation-sdk/src/wallet/mnemonic.js';
import { query } from '../../src/db/client.js';

// End-to-end tests for Tier 2 (user-encrypted, client-side crypto) and Tier 3
// (self-custody, client keeps mnemonic). Requires PLC directory running.

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
  if (inviteRes.status !== 201) throw new Error(`invite: ${inviteRes.status}`);
  const regRes = await xrpcPost('net.openfederation.account.register', {
    handle,
    email: `${handle}@test.local`,
    password: 'TestPassword123!',
    inviteCode: inviteRes.body.code,
  });
  if (regRes.status >= 400) throw new Error(`register: ${regRes.status}`);
  const userId = regRes.body.id || regRes.body.userId;
  await xrpcAuthPost('net.openfederation.account.approve', adminToken, { userId });
  const loginRes = await xrpcPost('com.atproto.server.createSession', {
    identifier: handle,
    password: 'TestPassword123!',
  });
  if (loginRes.status !== 200) throw new Error(`login: ${loginRes.status}`);
  return {
    accessJwt: loginRes.body.accessJwt as string,
    did: loginRes.body.did as string,
    handle: loginRes.body.handle as string,
  };
}

async function linkClientSide(
  token: string,
  chain: 'ethereum' | 'solana',
  walletAddress: string,
  privateKey: Uint8Array,
  label?: string
) {
  const ch = await xrpcAuthGet('net.openfederation.identity.getWalletLinkChallenge', token, {
    chain,
    walletAddress,
  });
  expect(ch.status).toBe(200);
  const sig = signMessage(chain, ch.body.challenge, privateKey);
  const link = await xrpcAuthPost('net.openfederation.identity.linkWallet', token, {
    chain,
    walletAddress,
    challenge: ch.body.challenge,
    signature: sig,
    ...(label ? { label } : {}),
  });
  if (link.status !== 200) {
    // Surface the failure reason to make debugging tractable.
    // eslint-disable-next-line no-console
    console.error('linkWallet failed:', link.status, JSON.stringify(link.body), 'sig:', sig.slice(0, 20), 'addr:', walletAddress);
  }
  expect(link.status).toBe(200);
  return link.body;
}

describe('Tier 2 wallets (user-encrypted, client-side crypto)', () => {
  let plcAvailable = false;
  let user: { accessJwt: string; did: string; handle: string };

  beforeAll(async () => {
    plcAvailable = await isPlcReachable();
    if (!plcAvailable) return;
    user = await registerAndApproveUser(uniqueHandle('t2-wallet'));
  });

  it('generates + links a Tier 2 Ethereum wallet and the stored blob round-trips', async () => {
    if (!plcAvailable) return;
    const mnemonic = generateMnemonic();
    const seed = mnemonicToSeed(mnemonic);
    const w = deriveWallet('ethereum', seed);

    // 1. Wrap and upload via custodial_secrets.
    const passphrase = 'test-pass-123';
    const wrapped = await wrapMnemonic(mnemonic, passphrase);
    const store = await xrpcAuthPost('net.openfederation.vault.storeCustodialSecret', user.accessJwt, {
      secretType: 'bip39-mnemonic-wrapped',
      chain: 'ethereum',
      encryptedBlob: JSON.stringify(wrapped),
      walletAddress: w.address,
    });
    expect(store.status).toBe(200);

    // 2. Link the derived address client-side (proves private-key control).
    await linkClientSide(user.accessJwt, 'ethereum', w.address, w.privateKey, 'eth-t2');

    // 3. Retrieve the blob and unwrap: must yield the original mnemonic.
    const get = await xrpcAuthGet('net.openfederation.vault.getCustodialSecret', user.accessJwt, {
      chain: 'ethereum',
    });
    expect(get.status).toBe(200);
    const blob = JSON.parse(get.body.encryptedBlob);
    const recovered = await unwrapMnemonic(blob, passphrase);
    expect(recovered).toBe(mnemonic);

    // 4. Verify the link is present.
    const list = await xrpcAuthGet('net.openfederation.identity.listWalletLinks', user.accessJwt);
    const match = list.body.walletLinks.find((l: any) =>
      l.chain === 'ethereum' && l.walletAddress === w.address
    );
    expect(match).toBeDefined();
  });

  it('unwrap with wrong passphrase fails', async () => {
    if (!plcAvailable) return;
    const mnemonic = generateMnemonic();
    const wrapped = await wrapMnemonic(mnemonic, 'correct');
    await expect(unwrapMnemonic(wrapped, 'wrong')).rejects.toThrow();
  });

  it('Tier 1 sign endpoint refuses to sign a Tier 2 wallet', async () => {
    if (!plcAvailable) return;
    const mnemonic = generateMnemonic();
    const seed = mnemonicToSeed(mnemonic);
    const w = deriveWallet('solana', seed);
    const passphrase = 'test-pass-456';
    const wrapped = await wrapMnemonic(mnemonic, passphrase);
    await xrpcAuthPost('net.openfederation.vault.storeCustodialSecret', user.accessJwt, {
      secretType: 'bip39-mnemonic-wrapped',
      chain: 'solana',
      encryptedBlob: JSON.stringify(wrapped),
      walletAddress: w.address,
    });
    await linkClientSide(user.accessJwt, 'solana', w.address, w.privateKey, 'sol-t2');

    // Grant consent so we pass the consent gate and exercise the tier check.
    await xrpcAuthPost('net.openfederation.wallet.grantConsent', user.accessJwt, {
      dappOrigin: 'https://t2-test.example.com',
      chain: 'solana',
      walletAddress: w.address,
    });

    const res = await xrpcAuthPost('net.openfederation.wallet.sign', user.accessJwt, {
      chain: 'solana',
      walletAddress: w.address,
      message: 'should fail — server has no key',
      dappOrigin: 'https://t2-test.example.com',
    });
    // Tier 2 wallets have custody_tier='self_custody' by default in wallet_links
    // (since server-side linkWallet doesn't know it was Tier 2). Either way,
    // the sign endpoint must refuse.
    expect([409]).toContain(res.status);
    expect(['UnsupportedTier']).toContain(res.body.error);
  });

  it('client-side signature is verifiable by chain-native verifiers', () => {
    const mnemonic = generateMnemonic();
    const seed = mnemonicToSeed(mnemonic);

    const eth = deriveWallet('ethereum', seed);
    const ethSig = signMessage('ethereum', 'hello ethereum', eth.privateKey);
    expect(verifyEthMessage('hello ethereum', ethSig).toLowerCase()).toBe(eth.address);

    const sol = deriveWallet('solana', seed);
    const solSig = signMessage('solana', 'hello solana', sol.privateKey);
    const msg = new TextEncoder().encode('hello solana');
    const sigBytes = bs58.decode(solSig);
    const pkBytes = bs58.decode(sol.address);
    expect(nacl.sign.detached.verify(msg, sigBytes, pkBytes)).toBe(true);
  });
});

describe('Tier 3 wallets (self-custody)', () => {
  let plcAvailable = false;
  let user: { accessJwt: string; did: string; handle: string };

  beforeAll(async () => {
    plcAvailable = await isPlcReachable();
    if (!plcAvailable) return;
    user = await registerAndApproveUser(uniqueHandle('t3-wallet'));
  });

  it('client generates keypair, links it, and the PDS stores NO decryptable material', async () => {
    if (!plcAvailable) return;
    const mnemonic = generateMnemonic();
    const seed = mnemonicToSeed(mnemonic);
    const w = deriveWallet('ethereum', seed);

    await linkClientSide(user.accessJwt, 'ethereum', w.address, w.privateKey, 'eth-t3');

    // Confirm wallet_links has the row at self_custody (the default).
    const tierRow = await query<{ custody_tier: string }>(
      `SELECT custody_tier FROM wallet_links
       WHERE user_did = $1 AND chain = $2 AND wallet_address = $3`,
      [user.did, 'ethereum', w.address]
    );
    expect(tierRow.rows[0]?.custody_tier).toBe('self_custody');

    // Confirm no wallet_custody row.
    const custRow = await query(
      `SELECT id FROM wallet_custody
       WHERE user_did = $1 AND chain = $2 AND wallet_address = $3`,
      [user.did, 'ethereum', w.address]
    );
    expect(custRow.rows.length).toBe(0);

    // Confirm no custodial_secrets row (Tier 3 stores nothing).
    const secretRow = await query(
      `SELECT id FROM custodial_secrets
       WHERE user_did = $1 AND chain = $2`,
      [user.did, 'ethereum']
    );
    expect(secretRow.rows.length).toBe(0);
  });

  it('the Tier 1 sign endpoint refuses to sign a Tier 3 wallet', async () => {
    if (!plcAvailable) return;
    const mnemonic = generateMnemonic();
    const seed = mnemonicToSeed(mnemonic);
    const w = deriveWallet('solana', seed);
    await linkClientSide(user.accessJwt, 'solana', w.address, w.privateKey, 'sol-t3');

    // Grant consent to get past the consent gate; the tier check should fire first.
    await xrpcAuthPost('net.openfederation.wallet.grantConsent', user.accessJwt, {
      dappOrigin: 'https://t3-test.example.com',
      chain: 'solana',
      walletAddress: w.address,
    });

    const res = await xrpcAuthPost('net.openfederation.wallet.sign', user.accessJwt, {
      chain: 'solana',
      walletAddress: w.address,
      message: 'should refuse — self-custody',
      dappOrigin: 'https://t3-test.example.com',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('UnsupportedTier');
    expect(res.body.message).toMatch(/self-custod/i);
  });
});
