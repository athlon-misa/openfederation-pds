import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';
import { checkPasswordWithLockout } from '../auth/password-check.js';
import { ServiceAuthError, verifyServiceAuthJwt } from '../auth/service-auth.js';
import { currentPlcState } from '../identity/account-migration.js';
import { DeleteRefusal, assertDeletable, deleteOwnAccount, findAccount, hashDeleteCode } from '../identity/owner-delete.js';

const NSID = 'com.atproto.server.deleteAccount';
const MAX_PROOF_TTL_SECONDS = 300;

/**
 * com.atproto.server.deleteAccount
 *
 * The owner deletes their account here (#269); rules in src/identity/owner-delete.ts.
 * A user account proves it with its password and the code from
 * requestAccountDelete; a pseudonym with a short-lived JWT signed by its owner
 * key (a current PLC rotation key), `lxm` = this method. The DID itself stays
 * in the PLC directory. No audit for pseudonyms.
 */
export default async function deleteAccount(req: AuthRequest, res: Response): Promise<void> {
  const did = typeof req.body?.did === 'string' ? req.body.did : '';
  try {
    if (!did.startsWith('did:')) throw new DeleteRefusal(400, 'InvalidRequest', 'did is required');
    const account = await findAccount(did);

    if (account?.pseudonymOwnerKey) {
      const header = req.headers.authorization;
      const jwt = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
      if (!jwt) throw new DeleteRefusal(401, 'AuthRequired', 'A JWT signed by the pseudonym\'s owner key is required');
      try {
        const state = await currentPlcState(did);
        if (!state) throw new DeleteRefusal(401, 'InvalidToken', 'DID is not in the PLC directory');
        const claims = await verifyServiceAuthJwt(jwt, { expectedLxm: NSID, resolveVerificationKeys: async () => state.rotationKeys });
        if (claims.iss !== did) throw new DeleteRefusal(401, 'InvalidToken', 'Token was issued for another DID');
        if (claims.exp > Math.floor(Date.now() / 1000) + MAX_PROOF_TTL_SECONDS) {
          throw new DeleteRefusal(401, 'InvalidToken', `Token must expire within ${MAX_PROOF_TTL_SECONDS} seconds`);
        }
      } catch (err) {
        if (err instanceof ServiceAuthError) throw new DeleteRefusal(401, 'InvalidToken', err.message);
        throw err;
      }
      await assertDeletable(account);
      await deleteOwnAccount(account);
      res.status(200).json({});
      return;
    }

    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    if (!password || !token) throw new DeleteRefusal(400, 'InvalidRequest', 'password and token are required');
    // The same answer for an unknown DID and a wrong code.
    if (!account?.passwordHash) throw new DeleteRefusal(400, 'InvalidToken', 'Token is invalid, expired, or already used');
    const pending = (await query<{ id: string }>(
      `SELECT id FROM password_reset_tokens
       WHERE user_id = $1 AND token_hash = $2 AND purpose = 'account-delete' AND used_at IS NULL AND expires_at > NOW()`,
      [account.id, hashDeleteCode(token)])).rows[0];
    if (!pending) throw new DeleteRefusal(400, 'InvalidToken', 'Token is invalid, expired, or already used');

    const check = await checkPasswordWithLockout(account.id, account.passwordHash, password);
    if (!check.ok) {
      if (check.reason === 'locked') throw new DeleteRefusal(429, 'AccountLocked', `Too many failed attempts. Try again in ${check.retryAfterSeconds} seconds.`);
      throw new DeleteRefusal(401, 'InvalidPassword', 'Password is incorrect');
    }
    await assertDeletable(account);
    // Claim the code: of two concurrent requests, only one deletes.
    const claimed = await query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1 AND used_at IS NULL RETURNING id', [pending.id]);
    if (claimed.rows.length === 0) throw new DeleteRefusal(400, 'InvalidToken', 'Token is invalid, expired, or already used');

    await auditLog('account.delete', account.id, account.id, { did, by: 'owner', status: account.status });
    await deleteOwnAccount(account);
    res.status(200).json({});
  } catch (error) {
    if (error instanceof DeleteRefusal) {
      res.status(error.status).json({ error: error.code, message: error.message });
      return;
    }
    console.error('Error in deleteAccount:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to delete account' });
  }
}
