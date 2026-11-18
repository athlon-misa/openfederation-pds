import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRole } from '../auth/guards.js';
import { getClient, clientView } from '../oidc/clients.js';
import { APP_PRESETS, presetConfiguration, type AppPreset } from '../oidc/app-presets.js';
import { oidcIssuer } from '../oidc/routes.js';

/** net.openfederation.oidc.getClientSetup — the app's configuration, secret left out (ADR-005). */
export default async function getOidcClientSetup(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireRole(req, res, ['admin'])) return;
    const clientId = typeof req.query.clientId === 'string' ? req.query.clientId : '';
    if (!clientId) {
      res.status(400).json({ error: 'InvalidRequest', message: 'clientId is required' });
      return;
    }
    const client = await getClient(clientId);
    if (!client) {
      res.status(404).json({ error: 'NotFound', message: 'No such client' });
      return;
    }
    const preset = (APP_PRESETS as readonly string[]).includes(client.preset ?? '') ? (client.preset as AppPreset) : 'generic';
    const issuer = oidcIssuer();
    res.json({
      client: clientView(client),
      issuer,
      configuration: presetConfiguration({
        preset, appUrl: client.appUrl ?? client.redirectUris[0], issuer,
        clientId: client.clientId, clientSecret: null, displayName: client.name,
      }),
    });
  } catch (err) {
    console.error('Error reading OIDC client setup:', err);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to read the client' });
  }
}
