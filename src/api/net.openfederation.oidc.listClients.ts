import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRole } from '../auth/guards.js';
import { listClients, clientView } from '../oidc/clients.js';
import { oidcIssuer } from '../oidc/routes.js';
import { runtimeSettings } from '../settings/runtime-settings.js';

/** net.openfederation.oidc.listClients — the registered apps (ADR-005). */
export default async function listOidcClients(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireRole(req, res, ['admin'])) return;
    res.json({ enabled: runtimeSettings().oidcProviderEnabled, issuer: oidcIssuer(), clients: (await listClients()).map(clientView) });
  } catch (err) {
    console.error('Error listing OIDC clients:', err);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to list clients' });
  }
}
