/**
 * A lightweight Solana signer compatible with common `@solana/web3.js`
 * transaction-signing call-sites.
 *
 * We deliberately avoid importing `@solana/web3.js` here — we duck-type on
 * Transaction-like objects that expose `serializeMessage()` /
 * `compileMessage()` so the adapter works with `Transaction` and
 * `VersionedTransaction` alike. Callers that want the full
 * `@solana/wallet-adapter-base` WalletAdapter interface can wrap this
 * object themselves, or use the dedicated `@openfederation/solana-adapter`
 * package (planned for M5).
 */

import type { OpenFederationClient } from '../client.js';
import type { WalletSession } from './wallet-session.js';

export interface SolanaTransactionLike {
  serializeMessage?(): Uint8Array;
  compileMessage?(): { serialize(): Uint8Array };
  /** VersionedTransaction.message.serialize() */
  message?: { serialize(): Uint8Array };
  addSignature?(publicKey: unknown, signature: Uint8Array): void;
}

export interface OFSolanaSigner {
  readonly walletAddress: string;
  readonly tier: 'custodial' | 'user_encrypted' | 'self_custody';
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  /**
   * Sign a Solana transaction. Returns a base58-encoded Ed25519 signature
   * over the transaction's message bytes. The caller is responsible for
   * attaching the signature back onto the transaction
   * (`tx.addSignature(publicKey, sigBytes)`).
   */
  signTransactionMessage(tx: SolanaTransactionLike): Promise<string>;
}

function extractMessageBytes(tx: SolanaTransactionLike): Uint8Array {
  if (typeof tx.serializeMessage === 'function') return tx.serializeMessage();
  if (typeof tx.compileMessage === 'function') return tx.compileMessage().serialize();
  if (tx.message && typeof tx.message.serialize === 'function') return tx.message.serialize();
  throw new Error('Unsupported Solana transaction type — pass a Transaction or VersionedTransaction');
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/**
 * Build a Solana signer. If `session` is provided (Tier 2 unlock or Tier 3
 * local mnemonic), signing happens client-side. Otherwise (Tier 1), each
 * call routes through the PDS with the active dApp consent grant.
 */
export function createSolanaSigner(
  client: OpenFederationClient,
  walletAddress: string,
  session?: WalletSession
): OFSolanaSigner {
  const tier: 'custodial' | 'user_encrypted' | 'self_custody' = session ? 'user_encrypted' : 'custodial';

  async function signMessageLocal(msg: Uint8Array): Promise<Uint8Array> {
    if (!session) throw new Error('Tier 1 Solana signing uses signTransactionMessage only (via PDS)');
    const sigB58 = session.signMessage(new TextDecoder().decode(msg), 'solana');
    const { default: bs58 } = await import('bs58');
    return bs58.decode(sigB58);
  }

  async function signMessageRemote(msg: Uint8Array): Promise<Uint8Array> {
    const messageStr = new TextDecoder().decode(msg);
    const res = await client.wallet.sign({ chain: 'solana', walletAddress, message: messageStr });
    const { default: bs58 } = await import('bs58');
    return bs58.decode(res.signature);
  }

  return {
    walletAddress,
    tier,
    signMessage: session ? signMessageLocal : signMessageRemote,

    async signTransactionMessage(tx: SolanaTransactionLike): Promise<string> {
      const bytes = extractMessageBytes(tx);
      if (session) {
        return session.signSolanaTransactionMessage(bytes);
      }
      const res = await client.wallet.signTransaction({
        chain: 'solana',
        walletAddress,
        messageBase64: bytesToBase64(bytes),
      });
      if ('signature' in res) return res.signature;
      throw new Error('Unexpected signTransaction response shape for Solana');
    },
  };
}
