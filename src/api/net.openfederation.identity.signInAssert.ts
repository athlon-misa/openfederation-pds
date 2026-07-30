import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireApprovedUser } from '../auth/guards.js';
import { query, withTransaction } from '../db/client.js';
import { XrpcError, renderXrpcError } from '../xrpc/errors.js';

const NSID = 'net.openfederation.identity.signInAssert';
import { auditLog } from '../db/audit.js';
import { parseSiwofMessage, normalizeSiwofAudience } from '../identity/siwof.js';
import { verifyEthereumSignature } from '../identity/adapters/ethereum-verifier.js';
import { verifySolanaSignature } from '../identity/adapters/solana-verifier.js';
import { signServiceAuthJwt } from '../auth/service-auth.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { isWalletChain } from '../wallet/index.js';

const DID_TOKEN_TTL_SEC = 5 * 60; // 5 minutes — long enough for a dApp backend to verify without pressure

/**
 * POST net.openfederation.identity.signInAssert
 *
 * Verify a wallet signature over a SIWOF message and mint two offline-
 * verifiable artifacts:
 *
 *   1. didToken — a service-auth JWT signed by the user's atproto signing
 *      key (via signServiceAuthJwt). A dApp backend resolves the user's DID
 *      via standard W3C methods, pulls the atproto verificationMethod, and
 *      verifies this JWT without ever calling OpenFederation.
 *
 *   2. walletProof — the original CAIP-122 message and the wallet signature.
 *      The dApp independently verifies that signature against the wallet
 *      address in the CAIP-10 claim. Combined with the didToken, this is a
 *      cryptographic proof of "this DID controls this wallet."
 */
export default async function signInAssert(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireApprovedUser(req, res)) return;

    const { chain, walletAddress, message, walletSignature } = req.body ?? {};

    if (!chain || !isWalletChain(chain)) {
      res.status(400).json({ error: 'UnsupportedChain', message: 'chain must be "ethereum" or "solana"' });
      return;
    }
    if (!walletAddress || typeof walletAddress !== 'string') {
      res.status(400).json({ error: 'InvalidRequest', message: 'walletAddress is required' });
      return;
    }
    if (typeof message !== 'string' || message.length === 0) {
      res.status(400).json({ error: 'InvalidRequest', message: 'message is required' });
      return;
    }
    if (typeof walletSignature !== 'string' || walletSignature.length === 0) {
      res.status(400).json({ error: 'InvalidRequest', message: 'walletSignature is required' });
      return;
    }

    // Parse the message first — fail fast on tampered messages before we
    // spend CPU on signature verification.
    let parsed;
    try {
      parsed = parseSiwofMessage(message);
    } catch (err) {
      res.status(400).json({ error: 'InvalidRequest', message: `SIWOF message malformed: ${(err as Error).message}` });
      return;
    }

    const userDid = req.auth!.did;
    const addr = chain === 'ethereum' ? walletAddress.toLowerCase() : walletAddress;

    // CAIP-10 account address in the message must match the walletAddress argument.
    const parsedAddress = parsed.accountCaip10.split(':').slice(-1)[0];
    const parsedAddressNormalized = chain === 'ethereum' ? parsedAddress.toLowerCase() : parsedAddress;
    if (parsedAddressNormalized !== addr) {
      res.status(400).json({ error: 'InvalidRequest', message: 'walletAddress does not match the CAIP-10 account in the message' });
      return;
    }

    // Verify the wallet signature over the exact message bytes.
    let valid = false;
    try {
      if (chain === 'ethereum') {
        valid = await verifyEthereumSignature(message, walletSignature, addr);
      } else if (chain === 'solana') {
        valid = await verifySolanaSignature(message, walletSignature, addr);
      }
    } catch {
      valid = false;
    }
    if (!valid) {
      res.status(401).json({ error: 'InvalidSignature', message: 'Wallet signature did not verify against the provided address' });
      return;
    }

    // Look up + atomically consume the server-issued challenge. We match on
    // the exact message text so a dApp-tampered message (e.g. swapped audience
    // or nonce) won't find a row. Both the "valid" and "expired" branches
    // commit the DELETE — only the "not found" branch can roll back, so we
    // throw before any mutation runs.
    const consume = await withTransaction<
      { outcome: 'valid'; audience: string | null } | { outcome: 'expired' }
    >(async (client) => {
      const ch = await client.query<{ id: string; expired: boolean; audience: string | null }>(
        `SELECT id, (expires_at < NOW()) AS expired, audience
         FROM wallet_link_challenges
         WHERE user_did = $1 AND chain = $2 AND wallet_address = $3
           AND challenge = $4 AND purpose = 'signin'
         FOR UPDATE`,
        [userDid, chain, addr, message]
      );
      if (ch.rows.length === 0) {
        throw new XrpcError(NSID, 'ChallengeNotFound', 404, 'No matching SIWOF challenge for this DID + wallet + message');
      }
      // One-shot use: consume the challenge whether or not it's expired.
      await client.query('DELETE FROM wallet_link_challenges WHERE id = $1', [ch.rows[0].id]);
      if (ch.rows[0].expired) {
        return { outcome: 'expired' };
      }
      return { outcome: 'valid', audience: ch.rows[0].audience };
    });

    if (consume.outcome === 'expired') {
      res.status(401).json({ error: 'ChallengeExpired', message: 'SIWOF challenge has expired' });
      return;
    }
    const audienceFromDb = consume.audience;

    // Defense in depth: message URI must agree with the audience the challenge
    // was issued against.
    const messageAudience = normalizeSiwofAudience(parsed.uri);
    if (audienceFromDb && audienceFromDb !== messageAudience.uri) {
      res.status(400).json({ error: 'InvalidRequest', message: 'message URI disagrees with the issued audience' });
      return;
    }

    // Mint the didToken. The user's atproto signing key is what establishes
    // "this DID said so," and any dApp can verify this offline.
    let keypair;
    try {
      keypair = await getKeypairForDid(userDid);
    } catch {
      res.status(500).json({ error: 'NoSigningKey', message: 'No atproto signing key for this DID' });
      return;
    }
    const messageExpiry = parsed.expirationTime ? Math.floor(Date.parse(parsed.expirationTime) / 1000) : NaN;
    if (!Number.isFinite(messageExpiry)) {
      res.status(400).json({ error: 'InvalidRequest', message: 'SIWOF message expiration is required' });
      return;
    }
    const exp = messageExpiry;
    const didToken = await signServiceAuthJwt({
      keypair,
      iss: userDid,
      aud: messageAudience.uri,
      exp,
      lxm: 'net.openfederation.identity.signInAssert',
      extraClaims: {
        sub: parsed.accountCaip10,
        nonce: parsed.nonce,
        chain,
        walletAddress: addr,
        chainIdCaip2: parsed.chainIdCaip2,
      },
    });

    await auditLog('identity.signInAssert', req.auth!.userId, userDid, {
      chain,
      walletAddress: addr,
      audience: messageAudience.uri,
      chainIdCaip2: parsed.chainIdCaip2,
    });

    res.status(200).json({
      didToken,
      walletProof: {
        message,
        signature: walletSignature,
        chain,
        walletAddress: addr,
        chainIdCaip2: parsed.chainIdCaip2,
      },
      did: userDid,
      audience: messageAudience.uri,
    });
  } catch (err) {
    if (res.headersSent) return;
    renderXrpcError(NSID, res, err);
  }
}
