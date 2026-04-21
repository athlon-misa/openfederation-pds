import { Response } from 'express';
import { randomUUID, randomBytes } from 'crypto';
import type { AuthRequest } from '../auth/types.js';
import { requireApprovedUser } from '../auth/guards.js';
import { query } from '../db/client.js';
import {
  buildSiwofMessage,
  normalizeSiwofAudience,
  resolveChainIdCaip2,
  toCaip10,
  type SiwofMessageFields,
} from '../identity/siwof.js';
import { isWalletChain } from '../wallet/index.js';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_STATEMENT = 1000;
const MAX_RESOURCES = 32;
const MAX_RESOURCE_LEN = 512;

/**
 * POST net.openfederation.identity.signInChallenge
 *
 * Issue a canonical CAIP-122 / SIWOF message for the caller to sign with a
 * wallet they own. The message is scoped to a specific dApp `audience` and
 * expires in 5 minutes. Works with any wallet linked to the caller's DID at
 * any custody tier — SIWOF only cares that the signature is produced, not
 * where the key lives.
 */
export default async function signInChallenge(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireApprovedUser(req, res)) return;

    const { chain, walletAddress, audience, chainId, statement, resources } = req.body ?? {};

    if (!chain || !isWalletChain(chain)) {
      res.status(400).json({ error: 'UnsupportedChain', message: 'chain must be "ethereum" or "solana"' });
      return;
    }
    if (!walletAddress || typeof walletAddress !== 'string') {
      res.status(400).json({ error: 'InvalidRequest', message: 'walletAddress is required' });
      return;
    }
    if (!audience || typeof audience !== 'string') {
      res.status(400).json({ error: 'InvalidRequest', message: 'audience (dApp URL) is required' });
      return;
    }
    if (statement !== undefined && (typeof statement !== 'string' || statement.length > MAX_STATEMENT)) {
      res.status(400).json({ error: 'InvalidRequest', message: `statement must be a string no longer than ${MAX_STATEMENT} chars` });
      return;
    }
    if (resources !== undefined) {
      if (!Array.isArray(resources) || resources.length > MAX_RESOURCES) {
        res.status(400).json({ error: 'InvalidRequest', message: `resources must be an array of at most ${MAX_RESOURCES} URIs` });
        return;
      }
      for (const r of resources) {
        if (typeof r !== 'string' || r.length > MAX_RESOURCE_LEN) {
          res.status(400).json({ error: 'InvalidRequest', message: 'each resource must be a string URI' });
          return;
        }
      }
    }

    let normalized;
    try {
      normalized = normalizeSiwofAudience(audience);
    } catch (err) {
      res.status(400).json({ error: 'InvalidRequest', message: (err as Error).message });
      return;
    }

    const userDid = req.auth!.did;
    const addr = chain === 'ethereum' ? walletAddress.toLowerCase() : walletAddress;

    // Confirm the caller owns the wallet (active + any tier).
    const owns = await query(
      `SELECT id FROM wallet_links
       WHERE user_did = $1 AND chain = $2 AND wallet_address = $3 AND custody_status = 'active'`,
      [userDid, chain, addr]
    );
    if (owns.rows.length === 0) {
      res.status(404).json({ error: 'WalletNotFound', message: 'No active wallet with that address for this DID' });
      return;
    }

    // CAIP-2 chain-id override is allowed (e.g. "eip155:137" for Polygon).
    if (chainId !== undefined && typeof chainId !== 'string') {
      res.status(400).json({ error: 'InvalidRequest', message: 'chainId, if provided, must be a CAIP-2 string' });
      return;
    }
    const caip2 = resolveChainIdCaip2(chain, chainId);

    const nowIso = new Date().toISOString();
    const expiresIso = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();

    const fields: SiwofMessageFields = {
      domain: normalized.domain,
      accountCaip10: toCaip10(caip2, addr),
      chainIdCaip2: caip2,
      uri: normalized.uri,
      nonce: randomBytes(16).toString('hex'),
      issuedAt: nowIso,
      expirationTime: expiresIso,
      statement,
      resources,
      version: '1',
    };
    const message = buildSiwofMessage(fields);

    const id = randomUUID();
    await query(
      `INSERT INTO wallet_link_challenges
         (id, user_did, chain, wallet_address, challenge, expires_at, purpose, audience)
       VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' milliseconds')::interval, 'signin', $7)`,
      [id, userDid, chain, addr, message, CHALLENGE_TTL_MS.toString(), normalized.uri]
    );

    res.status(200).json({
      message,
      nonce: fields.nonce,
      issuedAt: nowIso,
      expirationTime: expiresIso,
      audience: normalized.uri,
      chainIdCaip2: caip2,
    });
  } catch (err) {
    console.error('Error in signInChallenge:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'InternalServerError', message: 'Failed to issue sign-in challenge' });
    }
  }
}
