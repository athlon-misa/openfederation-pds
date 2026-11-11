import { Response, Request } from 'express';
import { query } from '../db/client.js';
import type { AuthRequest } from '../auth/types.js';
import { mayVerifyAttestation } from '../attestation/verify-access.js';

/**
 * Verify a private attestation's commitment hash without revealing content.
 * Only for those who may verify the attestation (src/attestation/verify-access.ts):
 * community members, the subject, viewing-grant holders and admins.
 */
export default async function verifyCommitment(req: Request, res: Response): Promise<void> {
  try {
    const communityDid = req.query.communityDid as string;
    const rkey = req.query.rkey as string;

    if (!communityDid || !rkey) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required parameters: communityDid, rkey',
      });
      return;
    }

    // Look up encryption metadata
    const encResult = await query<{
      commitment_hash: string;
      commitment_salt: string | null;
      schema_hash: string | null;
      visibility: string;
      created_at: string;
    }>(
      'SELECT commitment_hash, commitment_salt, schema_hash, visibility, created_at FROM attestation_encryption WHERE community_did = $1 AND rkey = $2',
      [communityDid, rkey]
    );

    // A private attestation, or one in a private community, answers only
    // members, the subject, viewing-grant holders and admins; anyone else gets
    // the answer for an attestation that does not exist.
    if (encResult.rows.length === 0 || !(await mayVerifyAttestation((req as AuthRequest).auth, communityDid, rkey))) {
      res.status(404).json({
        error: 'NotFound',
        message: 'No encryption metadata found for this attestation',
      });
      return;
    }

    const row = encResult.rows[0];

    // Check if the attestation record still exists (not revoked)
    const recordResult = await query(
      `SELECT 1 FROM records_index
       WHERE community_did = $1 AND collection = 'net.openfederation.community.attestation' AND rkey = $2`,
      [communityDid, rkey]
    );

    const revoked = recordResult.rows.length === 0;

    const commitment: Record<string, string> = {
      hash: row.commitment_hash,
    };
    if (row.schema_hash) {
      commitment.schemaHash = row.schema_hash;
    }
    // The salt is deliberately not returned. It is what keeps a guessable claim
    // (a yes/no, an age band, a tier) from being confirmed by hashing each
    // possibility against this commitment, and this endpoint is public. The
    // salt reaches a verifier with the claim itself, through a viewing grant
    // (`disclosure.redeemGrant`).
    if (row.commitment_salt) {
      commitment.version = '2';
    }

    res.status(200).json({
      commitment,
      issuerDid: communityDid,
      visibility: row.visibility,
      issuedAt: new Date(row.created_at).toISOString(),
      revoked,
    });
  } catch (error) {
    console.error('Error in verifyCommitment:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to verify commitment' });
  }
}
