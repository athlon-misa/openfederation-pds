import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { config } from '../config.js';
import { query } from '../db/client.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { currentPlcState, pointsHere } from '../identity/account-migration.js';
import { communityBlobCounts, missingAttestationKeys, recommendedCommunityCredentials } from '../community/migration.js';

/** How far a community's move here has come (#267). Public: nothing here is secret. */
export default async function checkMigration(req: AuthRequest, res: Response): Promise<void> {
  const did = String(req.query.did || '');
  try {
    const c = (await query<{ status: string }>('SELECT status FROM communities WHERE did = $1', [did])).rows[0];
    const root = (await query<{ root_cid: string; rev: string }>('SELECT root_cid, rev FROM repo_roots WHERE did = $1', [did])).rows[0];
    if (!c || !root) {
      res.status(404).json({ error: 'NotFound', message: 'No copy of this community here' });
      return;
    }
    const [records, members, attestations, blobs, missingKeys] = await Promise.all([
      query<{ n: string }>('SELECT COUNT(*) AS n FROM records_index WHERE community_did = $1', [did]),
      query<{ n: string }>('SELECT COUNT(*) AS n FROM members_unique WHERE community_did = $1', [did]),
      query<{ n: string }>('SELECT COUNT(*) AS n FROM community_attestation_index WHERE community_did = $1', [did]),
      communityBlobCounts(did),
      missingAttestationKeys(did),
    ]);
    let validDid = false;
    let recommended: Record<string, unknown> | undefined;
    try {
      const state = await currentPlcState(did);
      const keypair = await getKeypairForDid(did);
      validDid = !!state && pointsHere(state, config.pds.serviceUrl, keypair.did());
      if (state) recommended = await recommendedCommunityCredentials(did, state);
    } catch {
      validDid = false;
    }
    res.status(200).json({
      status: c.status, validDid, repoCommit: root.root_cid, repoRev: root.rev,
      indexedRecords: Number(records.rows[0].n), members: Number(members.rows[0].n), attestations: Number(attestations.rows[0].n),
      expectedBlobs: blobs.expected, importedBlobs: blobs.imported, missingAttestationKeys: missingKeys,
      ...(recommended ? { recommended } : {}),
    });
  } catch (error) {
    console.error('Error in community.checkMigration:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to check the migration' });
  }
}
