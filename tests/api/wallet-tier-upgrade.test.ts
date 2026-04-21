import { describe, it, expect, beforeAll } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Wallet as EthWallet } from 'ethers';
import {
  xrpcAuthGet, xrpcAuthPost, xrpcPost,
  getAdminToken, uniqueHandle,
} from './helpers.js';
import { query } from '../../src/db/client.js';
import {
  wrapMnemonic, unwrapMnemonic,
} from '../../packages/openfederation-sdk/src/wallet/index.js';

// End-to-end tier upgrade flow for all three supported transitions:
//   Tier 1 → Tier 2 (re-wrap under passphrase)
//   Tier 1 → Tier 3 (self-custody export)
//   Tier 2 → Tier 3 (drop server-held blob)

async function isPlcReachable(): Promise<boolean> {
  try {
    const url = process.env.PLC_DIRECTORY_URL || 'http://localhost:2582';
    const res = await fetch(`${url}/_health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}

const PW = 'UpgradePassword123!';

async function registerUser(handle: string) {
  const adminToken = await getAdminToken();
  const inviteRes = await xrpcAuthPost('net.openfederation.invite.create', adminToken, { maxUses: 1 });
  if (inviteRes.status !== 201) throw new Error(`invite: ${inviteRes.status}`);
  const regRes = await xrpcPost('net.openfederation.account.register', {
    handle, email: `${handle}@test.local`, password: PW, inviteCode: inviteRes.body.code,
  });
  if (regRes.status >= 400) throw new Error(`register: ${regRes.status}`);
  const userId = regRes.body.id || regRes.body.userId;
  await xrpcAuthPost('net.openfederation.account.approve', adminToken, { userId });
  const loginRes = await xrpcPost('com.atproto.server.createSession', { identifier: handle, password: PW });
  if (loginRes.status !== 200) throw new Error(`login: ${loginRes.status}`);
  return { accessJwt: loginRes.body.accessJwt as string, did: loginRes.body.did as string };
}

describe('Tier upgrades', () => {
  let plcAvailable = false;
  let user: { accessJwt: string; did: string };
  let ethAddress1: string;  // will be upgraded 1→2
  let ethAddress2: string;  // will be upgraded 1→3
  let solAddress: string;    // provisioned at Tier 2 initially via the Tier-2 flow? No — via SDK wrap path elsewhere; here we just use it for consent-revoke check

  beforeAll(async () => {
    plcAvailable = await isPlcReachable();
    if (!plcAvailable) return;
    user = await registerUser(uniqueHandle('upgrade'));

    // Provision three Tier 1 wallets. Two ETH for the two 1→x tests; one Solana
    // for a consent-revocation sanity check.
    const e1 = await xrpcAuthPost('net.openfederation.wallet.provision', user.accessJwt, { chain: 'ethereum', label: 'eth-a' });
    ethAddress1 = e1.body.walletAddress;
    const e2 = await xrpcAuthPost('net.openfederation.wallet.provision', user.accessJwt, { chain: 'ethereum', label: 'eth-b' });
    ethAddress2 = e2.body.walletAddress;
    const s1 = await xrpcAuthPost('net.openfederation.wallet.provision', user.accessJwt, { chain: 'solana', label: 'sol-a' });
    solAddress = s1.body.walletAddress;
  });

  describe('retrieveForUpgrade', () => {
    it('rejects wrong password', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.wallet.retrieveForUpgrade', user.accessJwt, {
        chain: 'ethereum', walletAddress: ethAddress1, currentPassword: 'wrong-pw',
      });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('InvalidPassword');
    });

    it('rejects for non-Tier-1 wallets', async () => {
      if (!plcAvailable) return;
      // A BYOW-linked wallet defaults to self_custody, so retrieveForUpgrade refuses.
      const kp = nacl.sign.keyPair();
      const addr = bs58.encode(kp.publicKey);
      const ch = await xrpcAuthGet('net.openfederation.identity.getWalletLinkChallenge', user.accessJwt, {
        chain: 'solana', walletAddress: addr,
      });
      const sig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(ch.body.challenge), kp.secretKey));
      const link = await xrpcAuthPost('net.openfederation.identity.linkWallet', user.accessJwt, {
        chain: 'solana', walletAddress: addr, challenge: ch.body.challenge, signature: sig, label: 'byow',
      });
      expect(link.status).toBe(200);

      const res = await xrpcAuthPost('net.openfederation.wallet.retrieveForUpgrade', user.accessJwt, {
        chain: 'solana', walletAddress: addr, currentPassword: PW,
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('UnsupportedTier');
    });

    it('returns the base64-encoded plaintext key for a Tier 1 wallet', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.wallet.retrieveForUpgrade', user.accessJwt, {
        chain: 'ethereum', walletAddress: ethAddress1, currentPassword: PW,
      });
      expect(res.status).toBe(200);
      expect(res.body.exportFormat).toBe('raw-secp256k1-32-bytes');
      const key = Buffer.from(res.body.privateKeyBase64, 'base64');
      expect(key.length).toBe(32);
      // Cryptographic sanity: recompute the address from the returned key via ethers.
      const wallet = new EthWallet('0x' + key.toString('hex'));
      expect(wallet.address.toLowerCase()).toBe(ethAddress1);
    });
  });

  describe('Tier 1 → Tier 2', () => {
    it('re-wraps the key under the user passphrase and drops the server plaintext', async () => {
      if (!plcAvailable) return;

      // 1. Caller sets up a consent grant so we can verify it's revoked on upgrade.
      await xrpcAuthPost('net.openfederation.wallet.grantConsent', user.accessJwt, {
        dappOrigin: 'https://upgrade-dapp.example.com',
        chain: 'ethereum', walletAddress: ethAddress1,
      });

      // 2. Retrieve plaintext.
      const ret = await xrpcAuthPost('net.openfederation.wallet.retrieveForUpgrade', user.accessJwt, {
        chain: 'ethereum', walletAddress: ethAddress1, currentPassword: PW,
      });
      expect(ret.status).toBe(200);

      // 3. Client wraps plaintext under the new passphrase.
      const passphrase = 'my-tier2-passphrase';
      const wrapped = await wrapMnemonic(ret.body.privateKeyBase64, passphrase);

      // 4. Finalize the tier swap.
      const fin = await xrpcAuthPost('net.openfederation.wallet.finalizeTierChange', user.accessJwt, {
        chain: 'ethereum', walletAddress: ethAddress1,
        newTier: 'user_encrypted',
        newEncryptedBlob: JSON.stringify(wrapped),
        currentPassword: PW,
      });
      expect(fin.status).toBe(200);
      expect(fin.body.previousTier).toBe('custodial');
      expect(fin.body.newTier).toBe('user_encrypted');

      // 5. DB invariants:
      //    - wallet_links now at tier 'user_encrypted'
      //    - wallet_custody row for this wallet is GONE
      //    - custodial_secrets has the new blob
      //    - consent was revoked
      const tier = await query<{ custody_tier: string }>(
        `SELECT custody_tier FROM wallet_links WHERE user_did = $1 AND wallet_address = $2`,
        [user.did, ethAddress1]
      );
      expect(tier.rows[0].custody_tier).toBe('user_encrypted');

      const custody = await query(
        `SELECT id FROM wallet_custody WHERE user_did = $1 AND wallet_address = $2`,
        [user.did, ethAddress1]
      );
      expect(custody.rows.length).toBe(0);

      const secret = await query<{ encrypted_blob: string }>(
        `SELECT encrypted_blob FROM custodial_secrets WHERE user_did = $1 AND chain = 'ethereum'`,
        [user.did]
      );
      expect(secret.rows.length).toBe(1);
      // The client-encrypted blob round-trips under the passphrase.
      const recovered = await unwrapMnemonic(JSON.parse(secret.rows[0].encrypted_blob), passphrase);
      expect(recovered).toBe(ret.body.privateKeyBase64);

      const consent = await query(
        `SELECT id FROM wallet_dapp_consents
         WHERE user_did = $1 AND wallet_address = $2 AND revoked_at IS NULL`,
        [user.did, ethAddress1]
      );
      expect(consent.rows.length).toBe(0);

      // 6. The Tier 1 sign endpoint now refuses — wallet is Tier 2.
      await xrpcAuthPost('net.openfederation.wallet.grantConsent', user.accessJwt, {
        dappOrigin: 'https://upgrade-dapp.example.com',
        chain: 'ethereum', walletAddress: ethAddress1,
      });
      const signRes = await xrpcAuthPost('net.openfederation.wallet.sign', user.accessJwt, {
        chain: 'ethereum', walletAddress: ethAddress1, message: 'hi', dappOrigin: 'https://upgrade-dapp.example.com',
      });
      expect(signRes.status).toBe(409);
      expect(signRes.body.error).toBe('UnsupportedTier');
    });

    it('rejects Tier 1 → 2 without newEncryptedBlob', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.wallet.finalizeTierChange', user.accessJwt, {
        chain: 'ethereum', walletAddress: ethAddress2,
        newTier: 'user_encrypted',
        currentPassword: PW,
      });
      expect(res.status).toBe(400);
    });
  });

  describe('Tier 1 → Tier 3', () => {
    it('exports plaintext and leaves no server custody material', async () => {
      if (!plcAvailable) return;
      const ret = await xrpcAuthPost('net.openfederation.wallet.retrieveForUpgrade', user.accessJwt, {
        chain: 'ethereum', walletAddress: ethAddress2, currentPassword: PW,
      });
      expect(ret.status).toBe(200);

      const fin = await xrpcAuthPost('net.openfederation.wallet.finalizeTierChange', user.accessJwt, {
        chain: 'ethereum', walletAddress: ethAddress2,
        newTier: 'self_custody',
        currentPassword: PW,
      });
      expect(fin.status).toBe(200);
      expect(fin.body.previousTier).toBe('custodial');
      expect(fin.body.newTier).toBe('self_custody');

      const tier = await query<{ custody_tier: string }>(
        `SELECT custody_tier FROM wallet_links WHERE user_did = $1 AND wallet_address = $2`,
        [user.did, ethAddress2]
      );
      expect(tier.rows[0].custody_tier).toBe('self_custody');

      const custody = await query(
        `SELECT id FROM wallet_custody WHERE user_did = $1 AND wallet_address = $2`,
        [user.did, ethAddress2]
      );
      expect(custody.rows.length).toBe(0);
    });
  });

  describe('Tier 2 → Tier 3', () => {
    it('drops the server-held encrypted blob without needing retrieveForUpgrade', async () => {
      if (!plcAvailable) return;

      // ethAddress1 is already Tier 2 from the first transition.
      const fin = await xrpcAuthPost('net.openfederation.wallet.finalizeTierChange', user.accessJwt, {
        chain: 'ethereum', walletAddress: ethAddress1,
        newTier: 'self_custody',
        currentPassword: PW,
      });
      expect(fin.status).toBe(200);
      expect(fin.body.previousTier).toBe('user_encrypted');
      expect(fin.body.newTier).toBe('self_custody');

      const tier = await query<{ custody_tier: string }>(
        `SELECT custody_tier FROM wallet_links WHERE user_did = $1 AND wallet_address = $2`,
        [user.did, ethAddress1]
      );
      expect(tier.rows[0].custody_tier).toBe('self_custody');

      const secret = await query(
        `SELECT id FROM custodial_secrets WHERE user_did = $1 AND chain = 'ethereum'`,
        [user.did]
      );
      expect(secret.rows.length).toBe(0);
    });

    it('verifies the wallet address never changed across tier transitions', async () => {
      if (!plcAvailable) return;
      const row = await query<{ wallet_address: string; custody_tier: string }>(
        `SELECT wallet_address, custody_tier FROM wallet_links
         WHERE user_did = $1 AND label = 'eth-a'`,
        [user.did]
      );
      expect(row.rows.length).toBe(1);
      expect(row.rows[0].wallet_address).toBe(ethAddress1);  // same address!
      expect(row.rows[0].custody_tier).toBe('self_custody');  // climbed all the way
    });
  });

  describe('Unsupported transitions', () => {
    it('refuses downgrade to custodial', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.wallet.finalizeTierChange', user.accessJwt, {
        chain: 'solana', walletAddress: solAddress,
        newTier: 'custodial',
        currentPassword: PW,
      });
      expect(res.status).toBe(400);
    });

    it('rejects with wrong password at finalize', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.wallet.finalizeTierChange', user.accessJwt, {
        chain: 'solana', walletAddress: solAddress,
        newTier: 'self_custody',
        currentPassword: 'wrong',
      });
      expect(res.status).toBe(401);
    });
  });
});
