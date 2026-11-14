import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRole } from '../auth/guards.js';
import { describeRuntimeSettings } from '../settings/runtime-settings.js';

/**
 * net.openfederation.admin.getServerSettings
 *
 * The settings an admin can change at runtime (#410): each one's value in
 * effect, where it comes from (the environment, an admin, the setup wizard or
 * the default), and whether the environment fixes it. Admin only.
 */
export default async function getServerSettings(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireRole(req, res, ['admin'])) return;
    res.status(200).json(await describeRuntimeSettings());
  } catch (error) {
    console.error('Error in admin.getServerSettings:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to read the server settings' });
  }
}
