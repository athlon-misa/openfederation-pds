import { Request, Response } from 'express';
import { query } from '../db/client.js';

/**
 * net.openfederation.community.verifyMembership
 *
 * Check if a DID is a member of a community.
 * Public endpoint — enables external apps (Mastodon, Matrix) to verify
 * that a user belongs to a community before granting access.
 */
export default async function verifyMembership(req: Request, res: Response): Promise<void> {
  try {
    const communityDid = req.query.communityDid as string;
    const memberDid = req.query.memberDid as string;

    if (!communityDid || !memberDid) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required query parameters: communityDid, memberDid',
      });
      return;
    }

    // Check membership via members_unique table
    const memberResult = await query<{ record_rkey: string }>(
      'SELECT record_rkey FROM members_unique WHERE community_did = $1 AND member_did = $2',
      [communityDid, memberDid],
    );

    if (memberResult.rows.length === 0) {
      res.status(200).json({ isMember: false });
      return;
    }

    // Load member record for role info
    const recordResult = await query<{ record: { role?: string } }>(
      `SELECT record FROM records_index
       WHERE community_did = $1 AND collection = 'net.openfederation.community.member' AND rkey = $2`,
      [communityDid, memberResult.rows[0].record_rkey],
    );

    const role = recordResult.rows[0]?.record?.role || 'member';

    res.status(200).json({
      isMember: true,
      role,
    });
  } catch (error) {
    console.error('Error verifying membership:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to verify membership' });
  }
}
