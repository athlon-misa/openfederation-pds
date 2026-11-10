/**
 * An unlocked Tier 2 wallet: mnemonic + per-chain derived keys in memory.
 * Never persisted. Caller should release references when done.
 */

import { mnemonicToSeed } from './mnemonic.js';
import { deriveWallet, walletFromPrivateKey, type DerivedWallet } from './derive.js';
import { signMessage as signRaw } from './sign.js';
import {
  signEthereumTransaction as signEvmTx,
  signSolanaTransactionMessage as signSolMsg,
  type EvmTransactionRequest,
} from './tx.js';

export type SupportedChain = 'ethereum' | 'solana';

/** Internal marker for the raw-key constructor path; never a valid mnemonic. */
const RAW_KEY_SESSION = '\u0000raw-key-session';

export class WalletSession {
  /** Null for a session built from a single raw key: there is nothing to derive from. */
  private readonly seed: Uint8Array | null;
  private readonly derived = new Map<SupportedChain, DerivedWallet>();

  constructor(mnemonic: string, passphrase: string = '') {
    this.seed = mnemonic === RAW_KEY_SESSION ? null : mnemonicToSeed(mnemonic, passphrase);
  }

  /**
   * A session for one wallet that is a bare private key, not a mnemonic: a
   * wallet the server generated (Tier 1) and the user later took into Tier 2.
   * It signs for that one chain only.
   */
  static fromPrivateKey(chain: SupportedChain, privateKey: Uint8Array): WalletSession {
    const session = new WalletSession(RAW_KEY_SESSION);
    session.derived.set(chain, walletFromPrivateKey(chain, privateKey));
    return session;
  }

  private keyFor(chain: SupportedChain): DerivedWallet {
    let w = this.derived.get(chain);
    if (!w && !this.seed) {
      throw new Error(`This wallet session holds a single ${[...this.derived.keys()][0] ?? ''} key and cannot sign for ${chain}`);
    }
    if (!w && this.seed) {
      w = deriveWallet(chain, this.seed);
      this.derived.set(chain, w);
    }
    return w as DerivedWallet;
  }

  getAddress(chain: SupportedChain): string {
    return this.keyFor(chain).address;
  }

  /** Sign text (as its UTF-8 bytes) or raw bytes (as given). */
  signMessage(message: string | Uint8Array, chain: SupportedChain): string {
    const w = this.keyFor(chain);
    return signRaw(chain, message, w.privateKey);
  }

  /**
   * Sign an Ethereum transaction using the derived EVM key. Returns
   * 0x-prefixed signed RLP. Requires `ethers@^6` installed as a peer dep.
   */
  async signEthereumTransaction(tx: EvmTransactionRequest): Promise<string> {
    const w = this.keyFor('ethereum');
    return signEvmTx(w.privateKey, tx);
  }

  /**
   * Sign the message bytes of a Solana transaction. Returns a base58
   * Ed25519 signature the caller attaches to their Transaction.
   */
  signSolanaTransactionMessage(messageBytes: Uint8Array): string {
    const w = this.keyFor('solana');
    return signSolMsg(w.privateKey, messageBytes);
  }

  /** Zero out the cached seed + per-chain private keys. Best effort. */
  destroy(): void {
    try {
      this.seed?.fill(0);
      for (const [, w] of this.derived) {
        if (w.privateKey instanceof Uint8Array) w.privateKey.fill(0);
      }
    } catch {
      /* ignore */
    }
    this.derived.clear();
  }
}
