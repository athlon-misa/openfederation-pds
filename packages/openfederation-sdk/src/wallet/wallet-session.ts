/**
 * An unlocked Tier 2 wallet: mnemonic + per-chain derived keys in memory.
 * Never persisted. Caller should release references when done.
 */

import { mnemonicToSeed } from './mnemonic.js';
import { deriveWallet, type DerivedWallet } from './derive.js';
import { signMessage as signRaw } from './sign.js';

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
