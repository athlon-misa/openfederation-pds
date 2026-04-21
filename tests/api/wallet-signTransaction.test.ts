import { describe, it, expect, beforeAll } from 'vitest';
import { Transaction as EthersTransaction } from 'ethers';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  xrpcAuthGet,
  xrpcAuthPost,
  xrpcPost,
  getAdminToken,
  uniqueHandle,
} from './helpers.js';

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
  };
}

describe('net.openfederation.wallet.signTransaction', () => {
  let plcAvailable = false;
  let user: { accessJwt: string; did: string };
  let ethAddress: string;
  let solAddress: string;

  beforeAll(async () => {
    plcAvailable = await isPlcReachable();
    if (!plcAvailable) return;
    user = await registerAndApproveUser(uniqueHandle('t1-tx'));

    // Provision a Tier 1 wallet on each chain + grant consent to one origin.
    const t1eth = await xrpcAuthPost('net.openfederation.wallet.provision', user.accessJwt, {
      chain: 'ethereum',
    });
    expect(t1eth.status).toBe(200);
    ethAddress = t1eth.body.walletAddress;

    const t1sol = await xrpcAuthPost('net.openfederation.wallet.provision', user.accessJwt, {
      chain: 'solana',
    });
    expect(t1sol.status).toBe(200);
    solAddress = t1sol.body.walletAddress;

    // Grant consents for both (separate grants; per-wallet scope).
    await xrpcAuthPost('net.openfederation.wallet.grantConsent', user.accessJwt, {
      dappOrigin: 'https://tx-demo.example.com',
      chain: 'ethereum',
      walletAddress: ethAddress,
    });
    await xrpcAuthPost('net.openfederation.wallet.grantConsent', user.accessJwt, {
      dappOrigin: 'https://tx-demo.example.com',
      chain: 'solana',
      walletAddress: solAddress,
    });
  });

  describe('Ethereum', () => {
    it('signs an EIP-1559 transaction; signed RLP recovers to the wallet address', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.wallet.signTransaction', user.accessJwt, {
        chain: 'ethereum',
        walletAddress: ethAddress,
        dappOrigin: 'https://tx-demo.example.com',
        tx: {
          to: '0x0000000000000000000000000000000000000123',
          value: '1000000000000000',
          gasLimit: '21000',
          maxFeePerGas: '30000000000',
          maxPriorityFeePerGas: '1000000000',
          nonce: 0,
          chainId: 1,
        },
      });
      expect(res.status).toBe(200);
      expect(res.body.signedTx).toMatch(/^0x[0-9a-f]+$/);
      const parsed = EthersTransaction.from(res.body.signedTx);
      expect(parsed.from?.toLowerCase()).toBe(ethAddress);
      expect(parsed.chainId).toBe(1n);
      expect(parsed.value).toBe(1_000_000_000_000_000n);
    });

    it('rejects a transaction missing chainId', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.wallet.signTransaction', user.accessJwt, {
        chain: 'ethereum',
        walletAddress: ethAddress,
        dappOrigin: 'https://tx-demo.example.com',
        tx: {
          to: '0x0',
          value: '1',
          gasLimit: '21000',
        },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('InvalidRequest');
    });

    it('rejects when no consent grants this origin', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.wallet.signTransaction', user.accessJwt, {
        chain: 'ethereum',
        walletAddress: ethAddress,
        dappOrigin: 'https://no-consent.example.com',
        tx: { to: '0x0', value: '1', gasLimit: '21000', chainId: 1 },
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('ConsentRequired');
    });

    it('rejects when wallet is not owned by caller', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.wallet.signTransaction', user.accessJwt, {
        chain: 'ethereum',
        walletAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        dappOrigin: 'https://tx-demo.example.com',
        tx: { to: '0x0', value: '1', gasLimit: '21000', chainId: 1 },
      });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('WalletNotFound');
    });
  });

  describe('Solana', () => {
    it('signs Solana message bytes; sig verifies against the wallet pubkey', async () => {
      if (!plcAvailable) return;
      const messageBytes = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
      const messageBase64 = Buffer.from(messageBytes).toString('base64');

      const res = await xrpcAuthPost('net.openfederation.wallet.signTransaction', user.accessJwt, {
        chain: 'solana',
        walletAddress: solAddress,
        dappOrigin: 'https://tx-demo.example.com',
        messageBase64,
      });
      expect(res.status).toBe(200);
      expect(res.body.signature).toBeTruthy();
      const sigBytes = bs58.decode(res.body.signature);
      const pkBytes = bs58.decode(solAddress);
      expect(nacl.sign.detached.verify(messageBytes, sigBytes, pkBytes)).toBe(true);
    });

    it('rejects empty messageBase64', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.wallet.signTransaction', user.accessJwt, {
        chain: 'solana',
        walletAddress: solAddress,
        dappOrigin: 'https://tx-demo.example.com',
        messageBase64: '',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('InvalidRequest');
    });
  });

  describe('Tier gating', () => {
    it('refuses to sign a Tier 2/3 wallet (existing BYOW-style link)', async () => {
      if (!plcAvailable) return;
      // Import a derived wallet via the existing BYOW flow — it'll be tagged
      // as self_custody by default and the endpoint must refuse.
      const { generateMnemonic, deriveWallet, signMessage } = await import(
        '../../packages/openfederation-sdk/src/wallet/index.js'
      );
      const { mnemonicToSeed } = await import(
        '../../packages/openfederation-sdk/src/wallet/mnemonic.js'
      );
      const w = deriveWallet('ethereum', mnemonicToSeed(generateMnemonic()));
      const ch = await xrpcAuthGet('net.openfederation.identity.getWalletLinkChallenge', user.accessJwt, {
        chain: 'ethereum',
        walletAddress: w.address,
      });
      const sig = signMessage('ethereum', ch.body.challenge, w.privateKey);
      const link = await xrpcAuthPost('net.openfederation.identity.linkWallet', user.accessJwt, {
        chain: 'ethereum',
        walletAddress: w.address,
        challenge: ch.body.challenge,
        signature: sig,
        label: 'byow-eth',
      });
      expect(link.status).toBe(200);

      // Grant consent (to pass the consent check and hit the tier check).
      await xrpcAuthPost('net.openfederation.wallet.grantConsent', user.accessJwt, {
        dappOrigin: 'https://tx-demo.example.com',
        chain: 'ethereum',
        walletAddress: w.address,
      });

      const res = await xrpcAuthPost('net.openfederation.wallet.signTransaction', user.accessJwt, {
        chain: 'ethereum',
        walletAddress: w.address,
        dappOrigin: 'https://tx-demo.example.com',
        tx: { to: '0x0', value: '1', gasLimit: '21000', chainId: 1 },
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('UnsupportedTier');
    });
  });
});
