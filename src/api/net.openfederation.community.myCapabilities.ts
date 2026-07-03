import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { getCallerCommunityCapabilities } from '../community/visibility.js';

/**
 * net.openfederation.community.myCapabilities
 *
 * Report the authenticated caller's own capabilities in a community.
 * Unlike the public verifyMembership (which only exposes isMember/role
 * about arbitrary DIDs), this returns the caller's effective permission
 * strings — used by clients to gate moderation UI.
 */
export default async function myCapabilities(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    const communityDid = String(req.query.communityDid || '');
    if (!communityDid) {
      res.status(400).json({ error: 'InvalidRequest', message: 'communityDid is required' });
      return;
    }

    const caps = await getCallerCommunityCapabilities({ communityDid, caller: req.auth! });
    if (!caps.exists) {
      res.status(404).json({ error: 'NotFound', message: 'Community not found' });
      return;
    }

    res.status(200).json({
      isMember: caps.membership?.status === 'member',
      isOwner: caps.isOwner,
      isAdmin: caps.isAdmin,
      role: caps.membership?.role,
      permissions: caps.permissions,
    });
  } catch (error) {
    console.error('Error in community.myCapabilities:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to load capabilities' });
  }
}
