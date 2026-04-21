/**
 * Wallet Link — Challenge-response wallet linking for ATProto DIDs.
 *
 * Enables users to cryptographically prove ownership of a blockchain
 * wallet (Ethereum, Solana) and bind it to their ATProto DID.
 */

import { randomUUID, randomBytes } from 'crypto';
import { query, getClient } from '../db/client.js';
import { verifyEthereumSignature } from './adapters/ethereum-verifier.js';
import { verifySolanaSignature } from './adapters/solana-verifier.js';

/**
 * Normalize a wallet address for consistent storage and comparison.
 * Ethereum: lowercase (EIP-55 mixed-case is display-only).
 * Solana: case-sensitive base58 (no transformation).
 */
function normalizeAddress(chain: string, address: string): string {
  if (chain === 'ethereum') return address.toLowerCase();
  return address;
}

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
  const normalizedAddress = normalizeAddress(chain, walletAddress);
  const id = randomUUID();
  const nonce = randomBytes(32).toString('hex');
  const timestamp = new Date().toISOString();
  const challenge = `OpenFederation Wallet Link\n\nDID: ${userDid}\nChain: ${chain}\nWallet: ${normalizedAddress}\nNonce: ${nonce}\nTimestamp: ${timestamp}`;

  // Compute expiry in SQL so the stored value aligns with the NOW()
  // comparison used during verification — avoids TZ drift on plain TIMESTAMP.
  const result = await query<{ expires_at: Date }>(
    `INSERT INTO wallet_link_challenges (id, user_did, chain, wallet_address, challenge, expires_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' milliseconds')::interval)
     RETURNING expires_at`,
    [id, userDid, chain, normalizedAddress, challenge, CHALLENGE_TTL_MS.toString()]
  );

  return { challenge, expiresAt: new Date(result.rows[0].expires_at).toISOString() };
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
  const normalizedAddress = normalizeAddress(chain, walletAddress);

  // 1. Verify the signature first (no DB transaction needed for this)
  let valid = false;
  if (chain === 'ethereum') {
    valid = await verifyEthereumSignature(challenge, signature, normalizedAddress);
  } else if (chain === 'solana') {
    valid = await verifySolanaSignature(challenge, signature, normalizedAddress);
  }

  if (!valid) {
    return { success: false, error: 'Signature verification failed' };
  }

  // 2. Use a transaction for all DB operations to prevent TOCTOU races
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Lock the challenge row to serialize concurrent attempts.
    // Compare expires_at to server-side NOW() to avoid JS/pg TZ drift on
    // plain TIMESTAMP columns (client-side `new Date(row.expires_at)`
    // silently reinterprets a naive timestamp as local time).
    const challengeResult = await client.query<{
      id: string;
      expired: boolean;
    }>(
      `SELECT id, (expires_at < NOW()) AS expired FROM wallet_link_challenges
       WHERE user_did = $1 AND chain = $2 AND wallet_address = $3 AND challenge = $4
       FOR UPDATE`,
      [userDid, chain, normalizedAddress, challenge]
    );

    if (challengeResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Challenge not found or does not match' };
    }

    const row = challengeResult.rows[0];
    if (row.expired) {
      await client.query('DELETE FROM wallet_link_challenges WHERE id = $1', [row.id]);
      await client.query('COMMIT');
      return { success: false, error: 'Challenge has expired' };
    }

    // Check wallet is not already linked to a different DID
    const existingLink = await client.query<{ user_did: string }>(
      `SELECT user_did FROM wallet_links WHERE chain = $1 AND wallet_address = $2 FOR UPDATE`,
      [chain, normalizedAddress]
    );

    if (existingLink.rows.length > 0 && existingLink.rows[0].user_did !== userDid) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Wallet is already linked to a different identity' };
    }

    // Check label uniqueness for this user (if label provided)
    if (label) {
      const existingLabel = await client.query<{ id: string; chain: string; wallet_address: string }>(
        `SELECT id, chain, wallet_address FROM wallet_links WHERE user_did = $1 AND label = $2`,
        [userDid, label]
      );
      // Allow re-linking the same wallet with same label, reject different wallet with same label
      if (existingLabel.rows.length > 0) {
        const existing = existingLabel.rows[0];
        if (existing.chain !== chain || existing.wallet_address !== normalizedAddress) {
          await client.query('ROLLBACK');
          return { success: false, error: 'Label already in use for a different wallet' };
        }
      }
    }

    // Create the link (upsert by chain+wallet_address)
    const id = randomUUID();
    await client.query(
      `INSERT INTO wallet_links (id, user_did, chain, wallet_address, label, challenge, signature)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (chain, wallet_address) DO UPDATE SET
         label = EXCLUDED.label,
         challenge = EXCLUDED.challenge,
         signature = EXCLUDED.signature,
         linked_at = CURRENT_TIMESTAMP`,
      [id, userDid, chain, normalizedAddress, label || null, challenge, signature]
    );

    // Clean up the challenge
    await client.query('DELETE FROM wallet_link_challenges WHERE id = $1', [row.id]);

    await client.query('COMMIT');
    return { success: true };
  } catch (err) {
    await client.query('ROLLBACK');
    // Handle unique constraint violations gracefully
    if ((err as any)?.code === '23505') {
      return { success: false, error: 'Wallet link conflict — please retry' };
    }
    throw err;
  } finally {
    client.release();
  }
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
  const normalizedAddress = normalizeAddress(chain, walletAddress);
  const result = await query<{ user_did: string; handle: string }>(
    `SELECT wl.user_did, u.handle
     FROM wallet_links wl
     JOIN users u ON u.did = wl.user_did
     WHERE wl.chain = $1 AND wl.wallet_address = $2`,
    [chain, normalizedAddress]
  );

  if (result.rows.length === 0) return null;

  return {
    did: result.rows[0].user_did,
    handle: result.rows[0].handle,
  };
}
