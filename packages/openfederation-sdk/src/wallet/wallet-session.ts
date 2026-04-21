/**
 * An unlocked Tier 2 wallet: mnemonic + per-chain derived keys in memory.
 * Never persisted. Caller should release references when done.
 */

import { mnemonicToSeed } from './mnemonic.js';
import { deriveWallet, type DerivedWallet } from './derive.js';
import { signMessage as signRaw } from './sign.js';
import {
  signEthereumTransaction as signEvmTx,
  signSolanaTransactionMessage as signSolMsg,
  type EvmTransactionRequest,
} from './tx.js';

export type SupportedChain = 'ethereum' | 'solana';

export class WalletSession {
  private readonly seed: Uint8Array;
  private readonly derived = new Map<SupportedChain, DerivedWallet>();

  constructor(mnemonic: string, passphrase: string = '') {
    this.seed = mnemonicToSeed(mnemonic, passphrase);
  }

  private keyFor(chain: SupportedChain): DerivedWallet {
    let w = this.derived.get(chain);
    if (!w) {
      w = deriveWallet(chain, this.seed);
      this.derived.set(chain, w);
    }
    return w;
  }

  getAddress(chain: SupportedChain): string {
    return this.keyFor(chain).address;
  }

  signMessage(message: string, chain: SupportedChain): string {
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
      this.seed.fill(0);
      for (const [, w] of this.derived) {
        if (w.privateKey instanceof Uint8Array) w.privateKey.fill(0);
      }
    } catch {
      /* ignore */
    }
    this.derived.clear();
  }
}
