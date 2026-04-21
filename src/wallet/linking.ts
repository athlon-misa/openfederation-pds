/**
 * Internal linking for Tier 1 custodial wallets.
 *
 * For BYOW (Tier 3) the existing getWalletLinkChallenge → linkWallet round
 * trip forces the *user* to sign a challenge. For Tier 1 we want the same
 * cryptographic guarantee ("this wallet really corresponds to this DID") but
 * the user doesn't hold the key — the PDS does. So the PDS signs the
 * challenge on the user's behalf, with the freshly-generated key, and runs
 * the verification path as if a client had submitted it. The resulting
 * `wallet_links` row is tagged `custody_tier='custodial'`.
 */

import { randomUUID } from 'crypto';
import { query, getClient } from '../db/client.js';
import { Wallet } from 'ethers';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import type { WalletChain } from './types.js';

export interface LinkCustodialResult {
  success: boolean;
  error?: string;
}

/**
 * Build the canonical challenge string, sign it with the freshly-generated
 * key, and insert the `wallet_links` row atomically with `custody_tier`.
 *
 * The challenge format matches `createChallenge` in `src/identity/wallet-link.ts`
 * so the verification path stays identical whether the link originated from
 * Tier 1 or Tier 3.
 */
export async function linkCustodialWallet(opts: {
  userDid: string;
  chain: WalletChain;
  walletAddress: string;
  privateKey: Buffer;
  label?: string;
}): Promise<LinkCustodialResult> {
  const { userDid, chain, walletAddress, privateKey, label } = opts;

  // Identical challenge shape as BYOW link flow.
  const challenge =
    `OpenFederation Wallet Link (custodial)\n\n` +
    `DID: ${userDid}\n` +
    `Chain: ${chain}\n` +
    `Wallet: ${walletAddress}\n` +
    `Nonce: ${randomUUID().replace(/-/g, '')}\n` +
    `Timestamp: ${new Date().toISOString()}`;

  let signature: string;
  try {
    if (chain === 'ethereum') {
      const wallet = new Wallet('0x' + privateKey.toString('hex'));
      signature = await wallet.signMessage(challenge);
    } else if (chain === 'solana') {
      const sig = nacl.sign.detached(new TextEncoder().encode(challenge), new Uint8Array(privateKey));
      signature = bs58.encode(sig);
    } else {
      return { success: false, error: `Unsupported chain: ${chain}` };
    }
  } catch (err) {
    return { success: false, error: `Failed to sign link challenge: ${(err as Error).message}` };
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Ensure the address isn't already bound to a different DID.
    const existing = await client.query<{ user_did: string }>(
      `SELECT user_did FROM wallet_links
       WHERE chain = $1 AND wallet_address = $2
       FOR UPDATE`,
      [chain, walletAddress]
    );
    if (existing.rows.length > 0 && existing.rows[0].user_did !== userDid) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Wallet address already linked to a different identity' };
    }

    if (label) {
      const labelConflict = await client.query<{ chain: string; wallet_address: string }>(
        `SELECT chain, wallet_address FROM wallet_links
         WHERE user_did = $1 AND label = $2`,
        [userDid, label]
      );
      if (labelConflict.rows.length > 0) {
        const prev = labelConflict.rows[0];
        if (prev.chain !== chain || prev.wallet_address !== walletAddress) {
          await client.query('ROLLBACK');
          return { success: false, error: 'Label already in use for a different wallet' };
        }
      }
    }

    const id = randomUUID();
    await client.query(
      `INSERT INTO wallet_links
         (id, user_did, chain, wallet_address, label, challenge, signature, custody_tier, custody_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'custodial', 'active')
       ON CONFLICT (chain, wallet_address) DO UPDATE SET
         label = EXCLUDED.label,
         challenge = EXCLUDED.challenge,
         signature = EXCLUDED.signature,
         custody_tier = EXCLUDED.custody_tier,
         custody_status = 'active',
         linked_at = CURRENT_TIMESTAMP`,
      [id, userDid, chain, walletAddress, label ?? null, challenge, signature]
    );

    await client.query('COMMIT');
    return { success: true };
  } catch (err) {
    await client.query('ROLLBACK');
    return { success: false, error: (err as Error).message };
  } finally {
    client.release();
  }
}

/**
 * Look up the custody tier for a given (user, chain, address) tuple. Returns
 * `null` if the wallet isn't linked at all.
 */
export async function getWalletTier(
  userDid: string,
  chain: WalletChain,
  walletAddress: string
): Promise<{ tier: string; status: string } | null> {
  const result = await query<{ custody_tier: string; custody_status: string }>(
    `SELECT custody_tier, custody_status FROM wallet_links
     WHERE user_did = $1 AND chain = $2 AND wallet_address = $3`,
    [userDid, chain, walletAddress]
  );
  if (result.rows.length === 0) return null;
  return { tier: result.rows[0].custody_tier, status: result.rows[0].custody_status };
}
