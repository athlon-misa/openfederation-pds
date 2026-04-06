import { Response, Request } from 'express';
import { query } from '../db/client.js';

/**
 * Verify a private attestation's commitment hash without revealing content.
 * No authentication required -- this is a public verification endpoint.
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
      schema_hash: string | null;
      visibility: string;
      created_at: string;
    }>(
      'SELECT commitment_hash, schema_hash, visibility, created_at FROM attestation_encryption WHERE community_did = $1 AND rkey = $2',
      [communityDid, rkey]
    );

    if (encResult.rows.length === 0) {
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

    res.status(200).json({
      commitment,
      issuerDid: communityDid,
      visibility: row.visibility,
      issuedAt: row.created_at,
      revoked,
    });
  } catch (error) {
    console.error('Error in verifyCommitment:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to verify commitment' });
  }
}
