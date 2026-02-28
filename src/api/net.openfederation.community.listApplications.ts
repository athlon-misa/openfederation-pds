import { Request, Response } from 'express';
import { query } from '../db/client.js';

const COLLECTION = 'net.openfederation.community.application';

/**
 * net.openfederation.community.listApplications
 *
 * List linked applications for a community.
 * Public endpoint — applications are discoverable.
 */
export default async function listApplications(req: Request, res: Response): Promise<void> {
  try {
    const did = req.query.did as string;

    if (!did) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required query parameter: did',
      });
      return;
    }

    // Verify community exists
    const communityResult = await query<{ status: string }>(
      'SELECT status FROM communities WHERE did = $1',
      [did],
    );

    if (communityResult.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'Community not found' });
      return;
    }

    if (communityResult.rows[0].status !== 'active') {
      res.status(404).json({ error: 'NotFound', message: 'Community not found' });
      return;
    }

    // Load application records from records_index
    const appResult = await query<{
      rkey: string;
      cid: string;
      record: {
        appType: string;
        instanceUrl: string;
        displayName?: string;
        linkedAt: string;
        linkedBy: string;
      };
    }>(
      `SELECT rkey, cid, record FROM records_index
       WHERE community_did = $1 AND collection = $2
       ORDER BY rkey ASC`,
      [did, COLLECTION],
    );

    const applications = appResult.rows.map((row) => ({
      uri: `at://${did}/${COLLECTION}/${row.rkey}`,
      rkey: row.rkey,
      cid: row.cid,
      appType: row.record.appType,
      instanceUrl: row.record.instanceUrl,
      displayName: row.record.displayName || null,
      linkedAt: row.record.linkedAt,
      linkedBy: row.record.linkedBy,
    }));

    res.status(200).json({ applications });
  } catch (error) {
    console.error('Error listing applications:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to list applications' });
  }
}
