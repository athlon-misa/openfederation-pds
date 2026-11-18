import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRole } from '../auth/guards.js';
import { auditLog } from '../db/audit.js';
import { getClient, rotateClientSecret } from '../oidc/clients.js';
import { APP_PRESETS, presetConfiguration, type AppPreset } from '../oidc/app-presets.js';
import { oidcIssuer } from '../oidc/routes.js';

/** net.openfederation.oidc.rotateClientSecret — new secret, the old one stops working (ADR-005). */
export default async function rotateOidcClientSecret(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireRole(req, res, ['admin'])) return;
    const clientId = typeof req.body?.clientId === 'string' ? req.body.clientId : '';
    if (!clientId) {
      res.status(400).json({ error: 'InvalidRequest', message: 'clientId is required' });
      return;
    }
    const secret = await rotateClientSecret(clientId);
    const client = secret ? await getClient(clientId) : null;
    if (!secret || !client) {
      res.status(404).json({ error: 'NotFound', message: 'No such client' });
      return;
    }
    await auditLog('oidc.client.rotateSecret', req.auth!.userId, clientId, {});
    const preset = (APP_PRESETS as readonly string[]).includes(client.preset ?? '') ? (client.preset as AppPreset) : 'generic';
    res.json({
      clientId,
      clientSecret: secret,
      configuration: presetConfiguration({
        preset, appUrl: client.appUrl ?? client.redirectUris[0], issuer: oidcIssuer(),
        clientId, clientSecret: secret, displayName: client.name,
      }),
    });
  } catch (err) {
    console.error('Error rotating OIDC client secret:', err);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to rotate the secret' });
  }
}
