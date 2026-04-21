/**
 * Turn a user's linked wallets into W3C DID-document verificationMethod /
 * assertionMethod entries.
 *
 * Used in two places:
 *   1. /.well-known/did.json — for did:web identities, we inject these entries
 *      into the DID document we serve so any standards-compliant W3C DID
 *      resolver discovers the user's wallets.
 *   2. net.openfederation.identity.getDidAugmentation — an unauthenticated
 *      XRPC endpoint returning the same entries for did:plc users (we can't
 *      rewrite the PLC doc so this is the sidecar path).
 *
 * Shape follows W3C DID Core 1.0 + the "Blockchain Vocabulary" (BlockchainAccountId).
 * EVM wallets use EcdsaSecp256k1VerificationKey2019 with blockchainAccountId
 * in CAIP-10 form ("eip155:1:0xabc..."). Solana uses Ed25519VerificationKey2020
 * with blockchainAccountId in CAIP-10 form ("solana:mainnet:9xSol...").
 */

export interface LinkedWalletInput {
  chain: 'ethereum' | 'solana';
  walletAddress: string;
  chainIdCaip2?: string;
  isPrimary: boolean;
}

export interface VerificationMethodEntry {
  id: string;
  type: 'EcdsaSecp256k1VerificationKey2019' | 'Ed25519VerificationKey2020';
  controller: string;
  blockchainAccountId: string;
}

export interface DidAugmentation {
  verificationMethod: VerificationMethodEntry[];
  assertionMethod: string[];
  authentication: string[];
}

function defaultCaip2(chain: 'ethereum' | 'solana'): string {
  if (chain === 'ethereum') return 'eip155:1';
  return 'solana:mainnet';
}

function verificationMethodType(
  chain: 'ethereum' | 'solana'
): 'EcdsaSecp256k1VerificationKey2019' | 'Ed25519VerificationKey2020' {
  return chain === 'ethereum' ? 'EcdsaSecp256k1VerificationKey2019' : 'Ed25519VerificationKey2020';
}

/**
 * Stable ID fragment for a wallet verification method. Primary wallets get a
 * short `#wallet-<chain>` fragment so dApps can resolve "the" Ethereum wallet.
 * Non-primary wallets get `#wallet-<chain>-<first 8 chars of address>` to keep
 * ids unique and non-colliding.
 */
function makeFragment(did: string, chain: string, address: string, isPrimary: boolean): string {
  const short = address.replace(/^0x/, '').slice(0, 8).toLowerCase();
  return `${did}#wallet-${chain}${isPrimary ? '' : `-${short}`}`;
}

/**
 * Build the DID augmentation from a set of active wallet links. Callers are
 * expected to filter out inactive / exported / superseded wallets before
 * passing them in.
 */
export function buildDidAugmentation(did: string, wallets: LinkedWalletInput[]): DidAugmentation {
  const verificationMethod: VerificationMethodEntry[] = [];
  const assertionMethod: string[] = [];
  const authentication: string[] = [];

  for (const w of wallets) {
    const caip2 = w.chainIdCaip2 ?? defaultCaip2(w.chain);
    const id = makeFragment(did, w.chain, w.walletAddress, w.isPrimary);
    verificationMethod.push({
      id,
      type: verificationMethodType(w.chain),
      controller: did,
      blockchainAccountId: `${caip2}:${w.walletAddress}`,
    });
    assertionMethod.push(id);
    authentication.push(id);
  }

  return { verificationMethod, assertionMethod, authentication };
}
