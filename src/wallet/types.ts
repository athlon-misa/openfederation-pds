/**
 * Shared types for the progressive-custody wallet system.
 *
 * A wallet belongs to a DID, is on exactly one chain, has one on-chain address,
 * and sits at one of three custody tiers that determine who can produce a
 * signature for it:
 *
 *   Tier 1  `custodial`       — PDS holds the private key (encrypted at rest);
 *                                signs server-side with per-dApp consent.
 *   Tier 2  `user_encrypted`  — PDS holds a passphrase-wrapped blob; user holds
 *                                the passphrase and signs client-side.
 *   Tier 3  `self_custody`    — PDS holds nothing beyond the public link; user
 *                                signs in their own wallet software.
 */

export const CUSTODY_TIERS = ['custodial', 'user_encrypted', 'self_custody'] as const;
export type CustodyTier = typeof CUSTODY_TIERS[number];

export const CUSTODY_STATUSES = ['active', 'exported', 'superseded'] as const;
export type CustodyStatus = typeof CUSTODY_STATUSES[number];

export const WALLET_CHAINS = ['ethereum', 'solana'] as const;
export type WalletChain = typeof WALLET_CHAINS[number];

export function isCustodyTier(value: unknown): value is CustodyTier {
  return typeof value === 'string' && (CUSTODY_TIERS as readonly string[]).includes(value);
}

export function isWalletChain(value: unknown): value is WalletChain {
  return typeof value === 'string' && (WALLET_CHAINS as readonly string[]).includes(value);
}
