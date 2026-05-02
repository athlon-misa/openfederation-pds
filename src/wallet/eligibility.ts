/**
 * Custodial signing eligibility — the single check that gates every
 * server-side wallet signing operation.
 *
 * Both `wallet.sign` (arbitrary-message signing) and `wallet.signTransaction`
 * need the exact same answer to: "is the PDS allowed to sign with this
 * wallet for this dApp right now?" The answer is yes iff
 *
 *   - the wallet is linked to this DID (otherwise: WalletNotFound)
 *   - the wallet's custody is active (otherwise: WalletInactive)
 *   - the wallet is Tier 1 custodial (otherwise: UnsupportedTier — Tier 2/3
 *     wallets sign client-side, the PDS holds no key to use)
 *   - an unrevoked consent grant exists for this dApp + wallet
 *     (otherwise: ConsentRequired)
 *
 * The result is a typed `WalletEligibilityRejection`; handlers translate
 * it into an `XrpcError` against their NSID. Both NSIDs declare the same
 * four error codes used here.
 */

import { hasActiveConsent } from './consent.js';
import { getWalletTier } from './linking.js';
import type { WalletChain } from './types.js';

export type WalletEligibilityRejectionCode =
  | 'WalletNotFound'
  | 'WalletInactive'
  | 'UnsupportedTier'
  | 'ConsentRequired';

export class WalletEligibilityRejection extends Error {
  constructor(
    public readonly code: WalletEligibilityRejectionCode,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'WalletEligibilityRejection';
  }
}

export interface SigningEligibilityInput {
  userDid: string;
  chain: WalletChain;
  walletAddress: string;   // Already normalized (lowercase for ethereum)
  dappOrigin: string;      // Already normalized
}

/**
 * Throws `WalletEligibilityRejection` if the caller is not allowed to
 * trigger a custodial signing operation. Returns void on success.
 */
export async function assertCustodialSigningEligible(
  opts: SigningEligibilityInput,
): Promise<void> {
  const tierInfo = await getWalletTier(opts.userDid, opts.chain, opts.walletAddress);
  if (!tierInfo) {
    throw new WalletEligibilityRejection('WalletNotFound', 404, 'No such wallet for this DID');
  }
  if (tierInfo.status !== 'active') {
    throw new WalletEligibilityRejection(
      'WalletInactive',
      409,
      `Wallet is ${tierInfo.status} and cannot be signed with`,
    );
  }
  if (tierInfo.tier !== 'custodial') {
    throw new WalletEligibilityRejection(
      'UnsupportedTier',
      409,
      tierInfo.tier === 'user_encrypted'
        ? 'Tier 2 wallets must sign client-side via the SDK (unlock + signMessage)'
        : 'Tier 3 wallets are self-custodial — use your own wallet software to sign',
    );
  }
  const consented = await hasActiveConsent({
    userDid: opts.userDid,
    dappOrigin: opts.dappOrigin,
    chain: opts.chain,
    walletAddress: opts.walletAddress,
  });
  if (!consented) {
    throw new WalletEligibilityRejection(
      'ConsentRequired',
      403,
      'No active consent grants this dApp permission to sign with this wallet',
    );
  }
}
