import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireApprovedUser } from '../auth/guards.js';
import { auditLog } from '../db/audit.js';
import {
  assertCustodialSigningEligible,
  isWalletChain,
  normalizeDappOrigin,
  assertDappOriginBinding,
  DappOriginBindingRejection,
  signTransactionWithCustodialKey,
  WalletEligibilityRejection,
  type EvmTransactionRequest,
} from '../wallet/index.js';

const NSID = 'net.openfederation.wallet.signTransaction';

const MAX_EVM_DATA_HEX = 2 * 128 * 1024 + 2; // 128KB of bytes, plus 0x-prefix
const MAX_SOL_MESSAGE_B64 = Math.ceil((128 * 1024 * 4) / 3); // 128KB of bytes

/**
 * POST net.openfederation.wallet.signTransaction
 *
 * Transaction-signing counterpart of `wallet.sign`. Same Tier 1 + consent
 * requirements. Payload shape is chain-specific:
 *
 * - Ethereum: `tx` is a TransactionRequest object (ethers v6 compatible).
 *   Server returns `{ signedTx }` — the 0x-prefixed signed RLP hex.
 * - Solana: `messageBase64` is the caller's serialized transaction *message*
 *   bytes (from `tx.compileMessage().serialize()`). Server returns
 *   `{ signature }` — the base58-encoded Ed25519 signature. The client is
 *   responsible for attaching the signature back onto the transaction.
 */
export default async function walletSignTransaction(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireApprovedUser(req, res)) return;

    const { chain, walletAddress, dappOrigin } = req.body ?? {};
    const rawOrigin = dappOrigin ?? req.headers['x-dapp-origin'] ?? req.headers['x-dApp-origin'];

    if (!chain || !isWalletChain(chain)) {
      res.status(400).json({ error: 'UnsupportedChain', message: 'chain must be "ethereum" or "solana"' });
      return;
    }
    if (!walletAddress || typeof walletAddress !== 'string') {
      res.status(400).json({ error: 'InvalidRequest', message: 'walletAddress is required' });
      return;
    }
    if (!rawOrigin || typeof rawOrigin !== 'string') {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'dappOrigin is required (body field or X-dApp-Origin header)',
      });
      return;
    }

    let origin: string;
    try {
      origin = normalizeDappOrigin(rawOrigin);
    } catch (err) {
      res.status(400).json({ error: 'InvalidRequest', message: (err as Error).message });
      return;
    }

    // Same binding as wallet.sign: the consent that unlocks the key must belong
    // to the origin the request actually came from. See src/wallet/origin-binding.ts.
    try {
      origin = assertDappOriginBinding(req.headers.origin as string | undefined, origin);
    } catch (err) {
      if (err instanceof DappOriginBindingRejection) {
        await auditLog('wallet.signTransaction.originRejected', req.auth!.userId, req.auth!.did, {
          declaredOrigin: origin,
          requestOrigin: (req.headers.origin as string | undefined) ?? null,
          reason: err.code,
          chain,
          walletAddress,
        });
        res.status(err.status).json({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }

    // Chain-specific payload validation.
    let evmTx: EvmTransactionRequest | null = null;
    let solMessageBytes: Uint8Array | null = null;
    if (chain === 'ethereum') {
      const tx = req.body?.tx;
      if (!tx || typeof tx !== 'object') {
        res.status(400).json({ error: 'InvalidRequest', message: 'tx (TransactionRequest) is required for ethereum' });
        return;
      }
      if (tx.chainId === undefined || tx.chainId === null) {
        res.status(400).json({ error: 'InvalidRequest', message: 'tx.chainId is required — we refuse to sign replay-vulnerable transactions' });
        return;
      }
      if (typeof tx.data === 'string' && tx.data.length > MAX_EVM_DATA_HEX) {
        res.status(400).json({ error: 'InvalidRequest', message: 'tx.data exceeds the 128KB limit' });
        return;
      }
      evmTx = tx as EvmTransactionRequest;
    } else {
      const mb = req.body?.messageBase64;
      if (typeof mb !== 'string' || mb.length === 0) {
        res.status(400).json({ error: 'InvalidRequest', message: 'messageBase64 is required for solana' });
        return;
      }
      if (mb.length > MAX_SOL_MESSAGE_B64) {
        res.status(400).json({ error: 'InvalidRequest', message: 'messageBase64 exceeds the 128KB limit' });
        return;
      }
      try {
        solMessageBytes = new Uint8Array(Buffer.from(mb, 'base64'));
      } catch {
        res.status(400).json({ error: 'InvalidRequest', message: 'messageBase64 is not valid base64' });
        return;
      }
    }

    const userDid = req.auth!.did;
    const userId = req.auth!.userId;
    const normalizedAddress = chain === 'ethereum' ? walletAddress.toLowerCase() : walletAddress;

    try {
      await assertCustodialSigningEligible({
        userDid,
        chain,
        walletAddress: normalizedAddress,
        dappOrigin: origin,
      });
    } catch (err) {
      if (err instanceof WalletEligibilityRejection) {
        res.status(err.status).json({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }

    // Sign.
    let result: string | null;
    if (chain === 'ethereum') {
      result = await signTransactionWithCustodialKey({
        userDid, chain: 'ethereum', walletAddress: normalizedAddress, tx: evmTx!,
      });
    } else {
      result = await signTransactionWithCustodialKey({
        userDid, chain: 'solana', walletAddress: normalizedAddress, messageBytes: solMessageBytes!,
      });
    }
    if (!result) {
      res.status(500).json({ error: 'SigningFailed', message: 'Custodial key material is missing' });
      return;
    }

    await auditLog('wallet.signTransaction', userId, userDid, {
      chain,
      walletAddress: normalizedAddress,
      dappOrigin: origin,
      chainId: chain === 'ethereum' ? String(evmTx!.chainId) : null,
      messageLength: chain === 'solana' ? (solMessageBytes?.length ?? 0) : null,
    });

    if (chain === 'ethereum') {
      res.status(200).json({ chain, walletAddress: normalizedAddress, signedTx: result, dappOrigin: origin });
    } else {
      res.status(200).json({ chain, walletAddress: normalizedAddress, signature: result, dappOrigin: origin });
    }
  } catch (err) {
    console.error(`Error in ${NSID}:`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'InternalServerError', message: 'Failed to sign transaction' });
    }
  }
}
