import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';
import { config } from '../config.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';

/**
 * AT Protocol getRecommendedDidCredentials (#263): what an account moving
 * here should put in its DID: this PDS as `atproto_pds`, this PDS's repo
 * signing key as `atproto`, and the handle it has here. No rotation key is
 * recommended: accounts that move here so far (pseudonyms) keep their own.
 */
export default async function getRecommendedDidCredentials(req: AuthRequest, res: Response): Promise<void> {
  if (!requireAuth(req, res)) return;
  const did = req.auth.did;
  try {
    const user = (await query<{ handle: string }>('SELECT handle FROM users WHERE did = $1', [did])).rows[0];
    if (!user) {
      res.status(404).json({ error: 'InvalidRequest', message: 'Account not found' });
      return;
    }
    const keypair = await getKeypairForDid(did);
    res.status(200).json({
      alsoKnownAs: [`at://${user.handle}${config.handleSuffix}`],
      verificationMethods: { atproto: keypair.did() },
      services: { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: config.pds.serviceUrl } },
    });
  } catch {
    console.error('Error in getRecommendedDidCredentials');
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to get recommended DID credentials' });
  }
}
