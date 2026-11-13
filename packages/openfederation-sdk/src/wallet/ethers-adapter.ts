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

// Types only: erased at runtime, so ethers stays an optional peer dependency.
import type * as EthersTypes from 'ethers';
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
    constructor(provider?: EthersTypes.Provider | null) {
      super(provider ?? null);
    }

    async getAddress(): Promise<string> {
      return normalized;
    }

    connect(provider: EthersTypes.Provider | null): EthersTypes.Signer {
      return new OFEthersSigner(provider);
    }

    async signMessage(message: string | Uint8Array): Promise<string> {
      // With an unlocked session the key is here, so bytes are signed as bytes.
      if (session) {
        return session.signMessage(message, 'ethereum');
      }
      // Otherwise the PDS signs, and it signs text. Bytes that are text go
      // through as that text. Bytes that are not (a hash, say) cannot be
      // carried that way without being changed, and a signature over changed
      // bytes verifies against nothing, so that is refused outright.
      let msgStr: string;
      if (typeof message === 'string') {
        msgStr = message;
      } else {
        try {
          msgStr = new TextDecoder('utf-8', { fatal: true }).decode(message);
        } catch {
          throw new Error(
            'This wallet signs through the PDS, which signs text only: these bytes are not valid UTF-8 and cannot be signed as given. '
            + 'Unlock the wallet (Tier 2) and pass the session to sign raw bytes.',
          );
        }
      }
      const res = await client.wallet.sign({
        chain: 'ethereum',
        walletAddress: normalized,
        message: msgStr,
      });
      return res.signature;
    }

    async signTransaction(tx: EthersTypes.TransactionRequest): Promise<string> {
      // If a provider is attached, let ethers fill in nonce / gas estimates
      // via populateTransaction. Otherwise, trust the caller-supplied fields
      // (this is how hardware-wallet signers and offline signers behave).
      let txToSign: EthersTypes.TransactionRequest;
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
      _domain: EthersTypes.TypedDataDomain,
      _types: Record<string, EthersTypes.TypedDataField[]>,
      _value: Record<string, unknown>
    ): Promise<string> {
      throw new Error('signTypedData (EIP-712) is not yet supported by the OpenFederation signer (coming in a follow-up milestone)');
    }
  }

  return new OFEthersSigner();
}
