/**
 * End-to-end wallet provisioning for Tier 2 and Tier 3.
 *
 * Tier 1 does not need this module — the PDS does all the work server-side
 * via `net.openfederation.wallet.provision`. Consumers call that via
 * `client.wallet.createTier1(...)`.
 *
 * Tier 2 client-side:
 *   generateMnemonic → deriveWallet → wrapMnemonic(passphrase) →
 *     storeCustodialSecret(blob) → getWalletLinkChallenge → signChallenge →
 *     linkWallet → tag as Tier 2 (the server default is Tier 3 for link; we
 *     accept that minor inconsistency for v1 and will teach the server to
 *     honor a client-requested tier in a follow-up migration).
 *
 * Tier 3 client-side:
 *   generateMnemonic → deriveWallet → signChallenge → linkWallet →
 *     return mnemonic to caller, upload nothing.
 */

import { generateMnemonic, mnemonicToSeed } from './mnemonic.js';
import { deriveWallet } from './derive.js';
import { wrapMnemonic } from './wrap.js';
import { signMessage } from './sign.js';
import type { ProvisionResult, WalletChain } from '../types.js';

export interface ProvisionDependencies {
  getChallenge(chain: WalletChain, walletAddress: string): Promise<{ challenge: string; expiresAt: string }>;
  linkWallet(opts: { chain: WalletChain; walletAddress: string; challenge: string; signature: string; label?: string }): Promise<unknown>;
  storeCustodialSecret(opts: { secretType: string; chain: string; encryptedBlob: string; walletAddress: string }): Promise<unknown>;
}

export async function provisionTier2(
  deps: ProvisionDependencies,
  opts: { chain: WalletChain; passphrase: string; label?: string }
): Promise<ProvisionResult> {
  if (!opts.passphrase || opts.passphrase.length < 8) {
    throw new Error('passphrase must be at least 8 characters');
  }

  const mnemonic = generateMnemonic();
  try {
    const seed = mnemonicToSeed(mnemonic);
    const derived = deriveWallet(opts.chain, seed);

    // 1. Wrap the mnemonic under the passphrase and upload the blob. The PDS
    //    stores it in custodial_secrets; it never sees plaintext.
    const wrapped = await wrapMnemonic(mnemonic, opts.passphrase);
    await deps.storeCustodialSecret({
      secretType: 'bip39-mnemonic-wrapped',
      chain: opts.chain,
      encryptedBlob: JSON.stringify(wrapped),
      walletAddress: derived.address,
    });

    // 2. Prove control of the derived key by signing a server-issued challenge
    //    with the client-held private key.
    const challenge = await deps.getChallenge(opts.chain, derived.address);
    const signature = signMessage(opts.chain, challenge.challenge, derived.privateKey);
    await deps.linkWallet({
      chain: opts.chain,
      walletAddress: derived.address,
      challenge: challenge.challenge,
      signature,
      label: opts.label,
    });

    // Wipe derived private key (caller doesn't need it — unlock() rederives).
    derived.privateKey.fill(0);

    return {
      chain: opts.chain,
      walletAddress: derived.address,
      custodyTier: 'user_encrypted',
      label: opts.label ?? null,
    };
  } finally {
    // We hold the mnemonic in memory during this flow; no canonical way to
    // zero a JS string, but drop the reference and rely on GC.
  }
}

export async function provisionTier3(
  deps: ProvisionDependencies,
  opts: { chain: WalletChain; label?: string }
): Promise<ProvisionResult> {
  const mnemonic = generateMnemonic();
  const seed = mnemonicToSeed(mnemonic);
  const derived = deriveWallet(opts.chain, seed);

  try {
    const challenge = await deps.getChallenge(opts.chain, derived.address);
    const signature = signMessage(opts.chain, challenge.challenge, derived.privateKey);
    await deps.linkWallet({
      chain: opts.chain,
      walletAddress: derived.address,
      challenge: challenge.challenge,
      signature,
      label: opts.label,
    });

    return {
      chain: opts.chain,
      walletAddress: derived.address,
      custodyTier: 'self_custody',
      label: opts.label ?? null,
      // The mnemonic is the user's ONLY copy. They must store it themselves.
      mnemonic,
    };
  } finally {
    derived.privateKey.fill(0);
  }
}
