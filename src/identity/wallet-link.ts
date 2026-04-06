/**
 * Wallet Link — Challenge-response wallet linking for ATProto DIDs.
 *
 * Enables users to cryptographically prove ownership of a blockchain
 * wallet (Ethereum, Solana) and bind it to their ATProto DID.
 */

import { randomUUID, randomBytes } from 'crypto';
import { query } from '../db/client.js';
import { verifyEthereumSignature } from './adapters/ethereum-verifier.js';
import { verifySolanaSignature } from './adapters/solana-verifier.js';

// ── Supported chains ────────────────────────────────────────────

const SUPPORTED_CHAINS = ['ethereum', 'solana'] as const;
export type SupportedChain = (typeof SUPPORTED_CHAINS)[number];

export function isSupportedChain(chain: string): chain is SupportedChain {
  return SUPPORTED_CHAINS.includes(chain as SupportedChain);
}

// ── Challenge generation ────────────────────────────────────────

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function createChallenge(
  userDid: string,
  chain: string,
  walletAddress: string
): Promise<{ challenge: string; expiresAt: string }> {
  const id = randomUUID();
  const nonce = randomBytes(32).toString('hex');
  const timestamp = new Date().toISOString();
  const challenge = `OpenFederation Wallet Link\n\nDID: ${userDid}\nChain: ${chain}\nWallet: ${walletAddress}\nNonce: ${nonce}\nTimestamp: ${timestamp}`;
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);

  await query(
    `INSERT INTO wallet_link_challenges (id, user_did, chain, wallet_address, challenge, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, userDid, chain, walletAddress, challenge, expiresAt.toISOString()]
  );

  return { challenge, expiresAt: expiresAt.toISOString() };
}

// ── Signature verification + linking ────────────────────────────

export interface LinkResult {
  success: boolean;
  error?: string;
}

export async function verifyAndLink(
  userDid: string,
  chain: string,
  walletAddress: string,
  challenge: string,
  signature: string,
  label?: string
): Promise<LinkResult> {
  // 1. Find the matching challenge
  const challengeResult = await query<{
    id: string;
    expires_at: Date;
  }>(
    `SELECT id, expires_at FROM wallet_link_challenges
     WHERE user_did = $1 AND chain = $2 AND wallet_address = $3 AND challenge = $4`,
    [userDid, chain, walletAddress, challenge]
  );

  if (challengeResult.rows.length === 0) {
    return { success: false, error: 'Challenge not found or does not match' };
  }

  const row = challengeResult.rows[0];
  if (new Date(row.expires_at) < new Date()) {
    // Clean up expired challenge
    await query('DELETE FROM wallet_link_challenges WHERE id = $1', [row.id]);
    return { success: false, error: 'Challenge has expired' };
  }

  // 2. Verify the signature
  let valid = false;
  if (chain === 'ethereum') {
    valid = await verifyEthereumSignature(challenge, signature, walletAddress);
  } else if (chain === 'solana') {
    valid = await verifySolanaSignature(challenge, signature, walletAddress);
  }

  if (!valid) {
    return { success: false, error: 'Signature verification failed' };
  }

  // 3. Check wallet is not already linked to a different DID
  const existingLink = await query<{ user_did: string }>(
    `SELECT user_did FROM wallet_links WHERE chain = $1 AND wallet_address = $2`,
    [chain, walletAddress]
  );

  if (existingLink.rows.length > 0 && existingLink.rows[0].user_did !== userDid) {
    return { success: false, error: 'Wallet is already linked to a different identity' };
  }

  // 4. Check label uniqueness for this user (if label provided)
  if (label) {
    const existingLabel = await query<{ id: string }>(
      `SELECT id FROM wallet_links WHERE user_did = $1 AND label = $2`,
      [userDid, label]
    );
    if (existingLabel.rows.length > 0) {
      return { success: false, error: 'Label already in use for this identity' };
    }
  }

  // 5. Create the link (upsert by chain+wallet_address)
  const id = randomUUID();
  await query(
    `INSERT INTO wallet_links (id, user_did, chain, wallet_address, label, challenge, signature)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (chain, wallet_address) DO UPDATE SET
       user_did = EXCLUDED.user_did,
       label = EXCLUDED.label,
       challenge = EXCLUDED.challenge,
       signature = EXCLUDED.signature,
       linked_at = CURRENT_TIMESTAMP`,
    [id, userDid, chain, walletAddress, label || null, challenge, signature]
  );

  // 6. Clean up the challenge
  await query('DELETE FROM wallet_link_challenges WHERE id = $1', [row.id]);

  return { success: true };
}

// ── Unlink ──────────────────────────────────────────────────────

export async function unlinkWallet(
  userDid: string,
  label: string
): Promise<boolean> {
  const result = await query(
    'DELETE FROM wallet_links WHERE user_did = $1 AND label = $2',
    [userDid, label]
  );
  return (result.rowCount ?? 0) > 0;
}

// ── Query ───────────────────────────────────────────────────────

export interface WalletLink {
  chain: string;
  walletAddress: string;
  label: string | null;
  linkedAt: string;
}

export async function getWalletLinks(userDid: string): Promise<WalletLink[]> {
  const result = await query<{
    chain: string;
    wallet_address: string;
    label: string | null;
    linked_at: Date;
  }>(
    'SELECT chain, wallet_address, label, linked_at FROM wallet_links WHERE user_did = $1 ORDER BY linked_at DESC',
    [userDid]
  );

  return result.rows.map((row) => ({
    chain: row.chain,
    walletAddress: row.wallet_address,
    label: row.label,
    linkedAt: new Date(row.linked_at).toISOString(),
  }));
}

export interface WalletResolution {
  did: string;
  handle: string;
}

export async function resolveWallet(
  chain: string,
  walletAddress: string
): Promise<WalletResolution | null> {
  const result = await query<{ user_did: string; handle: string }>(
    `SELECT wl.user_did, u.handle
     FROM wallet_links wl
     JOIN users u ON u.did = wl.user_did
     WHERE wl.chain = $1 AND wl.wallet_address = $2`,
    [chain, walletAddress]
  );

  if (result.rows.length === 0) return null;

  return {
    did: result.rows[0].user_did,
    handle: result.rows[0].handle,
  };
}
