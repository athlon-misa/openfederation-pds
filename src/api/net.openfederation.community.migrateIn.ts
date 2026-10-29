import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { config } from '../config.js';
import { query, withTransaction } from '../db/client.js';
import { auditLog } from '../db/audit.js';
import { isValidHandle } from '../auth/utils.js';
import { claimInvite, InviteError } from '../auth/invites.js';
import { ServiceAuthError, verifyServiceAuthJwt } from '../auth/service-auth.js';
import { currentPlcState } from '../identity/account-migration.js';
import {
  CommunityMoveError, homeOf, provisionCommunityKeys, pullCommunityRepo, pullCommunityBlobs, recommendedCommunityCredentials,
} from '../community/migration.js';

const NSID = 'net.openfederation.community.migrateIn';
const MAX_PROOF_TTL_SECONDS = 300;

/**
 * A community arrives here (#267): the owner proves control with a JWT
 * signed by one of the community's PLC rotation keys, and this PDS pulls
 * the repository and blobs from wherever the DID currently points. The
 * community sits in `importing` until the DID points here and the owner
 * activates it. Repeatable: a second call refreshes the copy.
 */
export default async function migrateIn(req: AuthRequest, res: Response): Promise<void> {
  const did = typeof req.body?.did === 'string' ? req.body.did : '';
  const handle = typeof req.body?.handle === 'string' ? req.body.handle.trim().toLowerCase() : '';
  const inviteCode = typeof req.body?.inviteCode === 'string' ? req.body.inviteCode.trim() : '';
  try {
    if (!/^did:plc:[a-z2-7]{24}$/.test(did)) throw new CommunityMoveError(400, 'UnresolvableDid', 'did must be a did:plc');
    if (!isValidHandle(handle)) throw new CommunityMoveError(400, 'InvalidHandle', 'Handle is not valid here');

    const state = await currentPlcState(did);
    if (!state) throw new CommunityMoveError(400, 'UnresolvableDid', 'DID is not in the PLC directory');
    const policy = config.migration.communities;
    if (policy === 'closed') throw new CommunityMoveError(403, 'MigrationNotAllowed', 'This PDS does not accept communities moving in');
    if (policy === 'invite' && !inviteCode) throw new CommunityMoveError(400, 'InvalidInviteCode', 'An invite code is required to move a community here');

    const header = req.headers.authorization;
    const jwt = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (!jwt) throw new CommunityMoveError(401, 'AuthRequired', 'A JWT signed by one of the community\'s rotation keys is required');
    let ownerDid: string;
    try {
      const claims = await verifyServiceAuthJwt(jwt, { expectedLxm: NSID, resolveVerificationKeys: async () => state.rotationKeys });
      if (claims.iss !== did) throw new CommunityMoveError(401, 'InvalidToken', 'Token was issued for another DID');
      if (claims.lxm !== NSID) throw new CommunityMoveError(401, 'InvalidToken', `Token must be scoped to ${NSID}`);
      if (claims.exp > Math.floor(Date.now() / 1000) + MAX_PROOF_TTL_SECONDS) {
        throw new CommunityMoveError(401, 'InvalidToken', `Token must expire within ${MAX_PROOF_TTL_SECONDS} seconds`);
      }
      // The owner names their own DID in the proof; it becomes owner_did here.
      const sub = (claims as { sub?: unknown }).sub;
      if (typeof sub !== 'string' || !sub.startsWith('did:')) throw new CommunityMoveError(400, 'InvalidRequest', 'The proof must carry the owner\'s DID as sub');
      ownerDid = sub;
    } catch (err) {
      if (err instanceof ServiceAuthError) throw new CommunityMoveError(401, 'InvalidToken', err.message);
      throw err;
    }

    const fromPds = homeOf(state);
    if (!fromPds) throw new CommunityMoveError(400, 'IncompatibleDidDoc', 'The DID already points to this PDS');

    const existing = (await query<{ status: string; owner_did: string | null }>('SELECT status, owner_did FROM communities WHERE did = $1', [did])).rows[0];
    if (existing && existing.status !== 'importing' && existing.status !== 'moved') {
      throw new CommunityMoveError(409, 'AlreadyExists', 'This community already lives here');
    }
    if (existing && existing.owner_did && existing.owner_did !== ownerDid) {
      throw new CommunityMoveError(403, 'Forbidden', 'This community\'s copy here is owned by another DID');
    }

    await withTransaction(async (client) => {
      if (!existing) {
        const taken = await client.query(
          'SELECT 1 FROM users WHERE handle = $1 UNION ALL SELECT 1 FROM communities WHERE handle = $1 AND did <> $2', [handle, did]);
        if (taken.rows.length > 0) throw new CommunityMoveError(400, 'HandleNotAvailable', 'Handle is already taken');
        await client.query(
          `INSERT INTO communities (did, handle, did_method, created_by, owner_did, status, from_pds)
           VALUES ($1, $2, 'plc', NULL, $3, 'importing', $4)`, [did, handle, ownerDid, fromPds]);
        if (policy === 'invite') {
          try {
            await claimInvite(client, inviteCode, null, null);
          } catch (err) {
            if (err instanceof InviteError) throw new CommunityMoveError(err.status, err.code, err.message);
            throw err;
          }
        }
        const keys = await provisionCommunityKeys(client, did);
        await client.query('UPDATE communities SET recovery_did_key = $2 WHERE did = $1', [did, keys.recoveryDidKey]);
      } else {
        await client.query(`UPDATE communities SET status = 'importing', from_pds = $2, handle = $3 WHERE did = $1`, [did, fromPds, handle]);
      }
    });

    const repo = await pullCommunityRepo(did, fromPds);
    const blobs = await pullCommunityBlobs(did, fromPds);
    await auditLog('community.migrateIn', null, did, { ownerDid, fromPds, records: repo.records, members: repo.members, attestations: repo.attestations, blobs: blobs.copied });
    res.status(200).json({
      did, handle: `${handle}${config.handleSuffix}`, status: 'importing', fromPds,
      repoCommit: repo.root, indexedRecords: repo.records, members: repo.members, attestations: repo.attestations,
      expectedBlobs: blobs.expected, importedBlobs: blobs.expected,
      recommended: await recommendedCommunityCredentials(did, state),
    });
  } catch (error) {
    if (error instanceof CommunityMoveError) {
      res.status(error.status).json({ error: error.code, message: error.message });
      return;
    }
    console.error('Error in community.migrateIn:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to bring the community here' });
  }
}
