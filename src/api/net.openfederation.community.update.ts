import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';
import { SimpleRepoEngine } from '../repo/simple-engine.js';

/**
 * net.openfederation.community.update
 *
 * Update community settings and profile. Owner only.
 */
export default async function updateCommunity(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) {
      return;
    }

    const { did, displayName, description, visibility, joinPolicy } = req.body;

    if (!did) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing required field: did' });
      return;
    }

    // Verify ownership
    const communityResult = await query<{ created_by: string }>(
      'SELECT created_by FROM communities WHERE did = $1',
      [did]
    );

    if (communityResult.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'Community not found' });
      return;
    }

    if (communityResult.rows[0].created_by !== req.auth.userId) {
      res.status(403).json({ error: 'Forbidden', message: 'Only the community owner can update settings' });
      return;
    }

    // Validate inputs
    if (visibility !== undefined && !['public', 'private'].includes(visibility)) {
      res.status(400).json({ error: 'InvalidRequest', message: 'visibility must be "public" or "private"' });
      return;
    }
    if (joinPolicy !== undefined && !['open', 'approval'].includes(joinPolicy)) {
      res.status(400).json({ error: 'InvalidRequest', message: 'joinPolicy must be "open" or "approval"' });
      return;
    }

    const engine = new SimpleRepoEngine(did);
    const signingKey = ''; // SimpleRepoEngine doesn't use the key for writes in MVP

    // Update profile if displayName or description changed
    if (displayName !== undefined || description !== undefined) {
      const existing = await engine.getRecord('net.openfederation.community.profile', 'self');
      const profile = existing?.record || {};
      await engine.putRecord(signingKey, 'net.openfederation.community.profile', 'self', {
        ...profile,
        ...(displayName !== undefined ? { displayName } : {}),
        ...(description !== undefined ? { description } : {}),
      });
    }

    // Update settings if visibility or joinPolicy changed
    if (visibility !== undefined || joinPolicy !== undefined) {
      const existing = await engine.getRecord('net.openfederation.community.settings', 'self');
      const settings = existing?.record || {};
      await engine.putRecord(signingKey, 'net.openfederation.community.settings', 'self', {
        ...settings,
        ...(visibility !== undefined ? { visibility } : {}),
        ...(joinPolicy !== undefined ? { joinPolicy } : {}),
      });
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error updating community:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to update community' });
  }
}
