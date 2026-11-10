/**
 * Client-side tier-upgrade orchestration.
 *
 * Takes a password + optional new passphrase, walks the retrieve / re-wrap /
 * finalize dance, and returns what the user needs to keep (a mnemonic for
 * Tier 3, nothing extra for Tier 2). Wallet address is preserved across
 * transitions — same on-chain identity, stricter custody.
 *
 * Tier 2 → Tier 3 deletes the only copy of the wrapped secret the server
 * holds. Before asking for that, this module unwraps it with the user's
 * passphrase and returns the secret: if the passphrase is wrong or missing,
 * nothing is deleted, and when it succeeds the caller is holding the key.
 */

import { wrapMnemonic } from './wrap.js';
import { unwrapSecret, type WrappedSecretKind } from './unlock.js';

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
  /** Reads this wallet's wrapped secret. Needed for Tier 2 → Tier 3. */
  getCustodialSecret?: (opts: {
    chain: 'ethereum' | 'solana';
    walletAddress: string;
  }) => Promise<{ encryptedBlob: string; walletAddress: string }>;
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
  /**
   * Present only for user_encrypted → self_custody: the unwrapped secret the
   * server copy protected. From here on this is the only copy; the caller
   * must hand it to the user to keep.
   */
  exportedSecret?: string;
  /** What `exportedSecret` is: a BIP-39 mnemonic, or a base64 raw private key. */
  exportedSecretKind?: WrappedSecretKind;
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

      // A Tier 1 wallet never had a mnemonic: the PDS generated a raw key.
      // That key is wrapped as it is, and the blob is tagged so `unlockTier2`
      // builds a signing session from a key instead of trying to read a
      // mnemonic out of it (untagged, the wallet could not be unlocked at all).
      const rawWrapped = { ...(await wrapMnemonic(privateKeyBase64, opts.newPassphrase)), kind: 'raw-private-key' as const };

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
    // This step deletes the server's copy of the wrapped secret, which for a
    // Tier 2 wallet is the only copy there is. So first prove the user can
    // still open it, and get the secret into the caller's hands.
    if (!opts.tier2Passphrase) {
      throw new Error('tier2Passphrase is required for Tier 2 → Tier 3: the wallet\'s secret is unwrapped and returned before the server copy is deleted');
    }
    if (!deps.getCustodialSecret) {
      throw new Error('getCustodialSecret is required for Tier 2 → Tier 3');
    }
    const stored = await deps.getCustodialSecret({ chain, walletAddress });
    // Throws if the passphrase does not open the blob; nothing has been deleted yet.
    const { secret, kind } = await unwrapSecret(stored.encryptedBlob, opts.tier2Passphrase);

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
      exportedSecret: secret,
      exportedSecretKind: kind,
    };
  }

  throw new Error(
    `Unsupported tier transition ${currentTier} → ${newTier}. Supported: custodial→user_encrypted, custodial→self_custody, user_encrypted→self_custody.`
  );
}
