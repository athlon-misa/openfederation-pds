import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRole } from '../auth/guards.js';
import { auditLog } from '../db/audit.js';
import { SettingsError, updateRuntimeSettings, describeRuntimeSettings } from '../settings/runtime-settings.js';

/**
 * net.openfederation.admin.updateServerSettings
 *
 * Change settings at runtime, without a restart (#410). `changes` maps a
 * setting to its new value, or to null to drop the admin's change (back to
 * the setup wizard's choice or the default). All or nothing: one invalid
 * value or combination refuses the whole request. A setting the environment
 * fixes is refused. Each change is audited with its value before and after.
 * Admin only.
 */
export default async function updateServerSettings(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireRole(req, res, ['admin'])) return;
    const changes = req.body?.changes;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      res.status(400).json({ error: 'InvalidRequest', message: 'changes must be an object of setting: value' });
      return;
    }
    const applied = await updateRuntimeSettings(changes as Record<string, unknown>, req.auth!.userId);
    for (const change of applied) {
      await auditLog('server.settings.update', req.auth!.userId, change.envVar, {
        setting: change.id,
        envVar: change.envVar,
        before: change.before,
        after: change.after,
        reset: change.reset,
      });
    }
    res.status(200).json({ ...(await describeRuntimeSettings()), changed: applied });
  } catch (error) {
    if (error instanceof SettingsError) {
      res.status(error.status).json({ error: error.code, message: error.message, ...(error.setting ? { setting: error.setting } : {}) });
      return;
    }
    console.error('Error in admin.updateServerSettings:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to change the server settings' });
  }
}
