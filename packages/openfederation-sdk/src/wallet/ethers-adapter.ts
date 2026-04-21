/**
 * ethers v6 `Signer` adapter. Tier-dispatched:
 *
 *   Tier 1 (no session) — each sign call routes through the PDS with the
 *                          active dApp consent grant.
 *   Tier 2/3 (session)  — signing happens locally using the in-memory key.
 *
 * Dynamic import of ethers keeps it an OPTIONAL peerDependency for the SDK
 * itself; dApps that call this function must have `ethers@^6` installed.
 */

import type { OpenFederationClient } from '../client.js';
import type { WalletSession } from './wallet-session.js';

/**
 * Build an ethers v6 Signer.
 * Returns `Promise<AbstractSigner>` — the caller awaits it.
 */
export async function createEthersSigner(
  client: OpenFederationClient,
  walletAddress: string,
  session?: WalletSession
): Promise<import('ethers').AbstractSigner> {
  let ethers: typeof import('ethers');
  try {
    ethers = await import('ethers');
  } catch {
    throw new Error("ethers is required — install it: `npm install ethers@^6`");
  }

  const normalized = walletAddress.toLowerCase();

  class OFEthersSigner extends ethers.AbstractSigner {
    constructor(provider?: ethers.Provider | null) {
      super(provider ?? null);
    }

    async getAddress(): Promise<string> {
      return normalized;
    }

    connect(provider: ethers.Provider | null): ethers.Signer {
      return new OFEthersSigner(provider);
    }

    async signMessage(message: string | Uint8Array): Promise<string> {
      const msgStr = typeof message === 'string' ? message : new TextDecoder().decode(message);
      if (session) {
        return session.signMessage(msgStr, 'ethereum');
      }
      const res = await client.wallet.sign({
        chain: 'ethereum',
        walletAddress: normalized,
        message: msgStr,
      });
      return res.signature;
    }

    async signTransaction(tx: ethers.TransactionRequest): Promise<string> {
      // If a provider is attached, let ethers fill in nonce / gas estimates
      // via populateTransaction. Otherwise, trust the caller-supplied fields
      // (this is how hardware-wallet signers and offline signers behave).
      let txToSign: ethers.TransactionRequest;
      if (this.provider) {
        txToSign = await this.populateTransaction(tx);
      } else {
        if (tx.chainId === undefined || tx.chainId === null) {
          throw new Error(
            'chainId is required on the TransactionRequest when signing without a provider'
          );
        }
        txToSign = tx;
      }
      if (session) {
        return session.signEthereumTransaction(txToSign as unknown as Record<string, unknown> & { chainId: number | bigint | string });
      }
      const res = await client.wallet.signTransaction({
        chain: 'ethereum',
        walletAddress: normalized,
        tx: txToSign as unknown as Record<string, unknown> & { chainId: number | bigint | string },
      });
      if ('signedTx' in res) return res.signedTx;
      throw new Error('Unexpected signTransaction response shape for Ethereum');
    }

    async signTypedData(
      _domain: ethers.TypedDataDomain,
      _types: Record<string, ethers.TypedDataField[]>,
      _value: Record<string, unknown>
    ): Promise<string> {
      throw new Error('signTypedData (EIP-712) is not yet supported by the OpenFederation signer (coming in a follow-up milestone)');
    }
  }

  return new OFEthersSigner();
}
