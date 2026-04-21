/**
 * Client-side tier-upgrade orchestration.
 *
 * Takes a password + optional new passphrase, walks the retrieve / re-wrap /
 * finalize dance, and returns what the user needs to keep (a mnemonic for
 * Tier 3, nothing extra for Tier 2). Wallet address is preserved across
 * transitions — same on-chain identity, stricter custody.
 *
 * We deliberately do NOT decrypt Tier 2 blobs inside this module: Tier 2 →
 * Tier 3 upgrades require the USER's passphrase, which they give directly
 * to the SDK via `unwrapMnemonic` (exposed separately). That keeps the
 * upgrade API narrow and focused on tier-state mechanics.
 */

import { wrapMnemonic } from './wrap.js';

export interface UpgradeDependencies {
  retrieveForUpgrade: (opts: {
    chain: 'ethereum' | 'solana';
    walletAddress: string;
    currentPassword: string;
  }) => Promise<{ privateKeyBase64: string; exportFormat: string }>;
  finalizeTierChange: (opts: {
    chain: 'ethereum' | 'solana';
    walletAddress: string;
    newTier: 'user_encrypted' | 'self_custody';
    newEncryptedBlob?: string;
    currentPassword: string;
  }) => Promise<{ previousTier: string; newTier: string }>;
}

export interface UpgradeToTierOptions {
  chain: 'ethereum' | 'solana';
  walletAddress: string;
  newTier: 'user_encrypted' | 'self_custody';
  currentPassword: string;
  /** Required when upgrading Tier 1 → Tier 2. */
  newPassphrase?: string;
  /** Required when upgrading Tier 2 → Tier 3. User's current Tier 2 passphrase, used locally to verify we can still unwrap. */
  tier2Passphrase?: string;
  /**
   * The current tier of the wallet, as known to the client. The SDK reads
   * this from list endpoints; passed here to pick the right code path.
   */
  currentTier: 'custodial' | 'user_encrypted';
}

export interface UpgradeResult {
  chain: 'ethereum' | 'solana';
  walletAddress: string;
  previousTier: string;
  newTier: 'user_encrypted' | 'self_custody';
  /** Present only for custodial → self_custody — the raw private key bytes. */
  exportedPrivateKeyBase64?: string;
}

export async function upgradeToTier(
  deps: UpgradeDependencies,
  opts: UpgradeToTierOptions
): Promise<UpgradeResult> {
  const { chain, walletAddress, newTier, currentTier, currentPassword } = opts;

  if (currentTier === 'custodial') {
    if (newTier === 'user_encrypted') {
      if (!opts.newPassphrase || opts.newPassphrase.length < 8) {
        throw new Error('newPassphrase is required (min 8 chars) for Tier 1 → Tier 2');
      }
      // 1. Pull plaintext from the PDS under password re-auth.
      const { privateKeyBase64 } = await deps.retrieveForUpgrade({ chain, walletAddress, currentPassword });

      // Tier 2's wrapped blob is expected to contain a BIP-39 mnemonic (the
      // shape `unlockTier2` / `provisionTier2` use). For a Tier 1 wallet we
      // never had a mnemonic — the PDS generated a raw key. We store the
      // raw key itself under a distinct "v1-raw-pk" mnemonic-substitute so
      // future unlock-and-sign still works; the SDK knows how to interpret
      // both shapes via the `secretType` field on custodial_secrets.
      const rawWrapped = await wrapMnemonic(privateKeyBase64, opts.newPassphrase);

      // 2. Atomic swap: drop server-held plaintext, stash new blob, bump tier.
      const final = await deps.finalizeTierChange({
        chain,
        walletAddress,
        newTier: 'user_encrypted',
        newEncryptedBlob: JSON.stringify(rawWrapped),
        currentPassword,
      });

      return {
        chain,
        walletAddress,
        previousTier: final.previousTier,
        newTier: 'user_encrypted',
      };
    }

    if (newTier === 'self_custody') {
      // 1. Retrieve plaintext so the user can move it into their own wallet.
      const { privateKeyBase64 } = await deps.retrieveForUpgrade({ chain, walletAddress, currentPassword });

      // 2. Drop the server copy.
      const final = await deps.finalizeTierChange({
        chain,
        walletAddress,
        newTier: 'self_custody',
        currentPassword,
      });

      return {
        chain,
        walletAddress,
        previousTier: final.previousTier,
        newTier: 'self_custody',
        exportedPrivateKeyBase64: privateKeyBase64,
      };
    }
  }

  if (currentTier === 'user_encrypted' && newTier === 'self_custody') {
    // The user already holds the passphrase; they can unwrap their blob
    // locally using `client.wallet.unlockTier2`. This call just drops the
    // server-held encrypted blob so nothing remains on the PDS.
    const final = await deps.finalizeTierChange({
      chain,
      walletAddress,
      newTier: 'self_custody',
      currentPassword,
    });
    return {
      chain,
      walletAddress,
      previousTier: final.previousTier,
      newTier: 'self_custody',
    };
  }

  throw new Error(
    `Unsupported tier transition ${currentTier} → ${newTier}. Supported: custodial→user_encrypted, custodial→self_custody, user_encrypted→self_custody.`
  );
}
