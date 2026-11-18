import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRole } from '../auth/guards.js';
import { auditLog } from '../db/audit.js';
import { createClient, clientView, OidcClientError } from '../oidc/clients.js';
import { APP_PRESETS, presetConfiguration, presetRedirectUri, presetScopes, type AppPreset } from '../oidc/app-presets.js';
import { oidcIssuer } from '../oidc/routes.js';

/**
 * net.openfederation.oidc.createClient
 *
 * Register an app to sign people in through this server (ADR-005). With a
 * preset and the app's address, the redirect URI and scopes are filled in and
 * the configuration to paste into the app comes back with the secret.
 */
export default async function createOidcClient(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireRole(req, res, ['admin'])) return;
    const body = req.body ?? {};
    const preset = body.preset as string | undefined;
    if (preset !== undefined && !(APP_PRESETS as readonly string[]).includes(preset)) {
      res.status(400).json({ error: 'InvalidRequest', message: `preset must be one of: ${APP_PRESETS.join(', ')}` });
      return;
    }
    const redirectUris: string[] = Array.isArray(body.redirectUris) ? body.redirectUris.filter((u: unknown) => typeof u === 'string') : [];
    let appUrl: string | null = null;
    if (preset && preset !== 'generic') {
      if (typeof body.appUrl !== 'string' || !body.appUrl) {
        res.status(400).json({ error: 'InvalidRequest', message: 'appUrl is required with this preset' });
        return;
      }
      try {
        appUrl = new URL(body.appUrl).origin;
        redirectUris.unshift(presetRedirectUri(preset as AppPreset, appUrl)!);
      } catch {
        res.status(400).json({ error: 'InvalidRequest', message: 'appUrl must be a URL' });
        return;
      }
    } else if (typeof body.appUrl === 'string' && body.appUrl) {
      try { appUrl = new URL(body.appUrl).origin; } catch { /* ignored for generic */ }
    }
    const scopes = Array.isArray(body.scopes) && body.scopes.length > 0
      ? body.scopes
      : preset ? presetScopes(preset as AppPreset) : undefined;

    const { client, clientSecret } = await createClient({
      clientId: typeof body.clientId === 'string' ? body.clientId : undefined,
      name: typeof body.name === 'string' ? body.name : '',
      redirectUris,
      scopes,
      communityDid: typeof body.communityDid === 'string' && body.communityDid ? body.communityDid : null,
      preset: preset ?? null,
      appUrl,
      createdBy: req.auth!.did ?? null,
    });
    await auditLog('oidc.client.create', req.auth!.userId, client.clientId, {
      name: client.name, redirectUris: client.redirectUris, scopes: client.scopes, communityDid: client.communityDid,
    });
    const issuer = oidcIssuer();
    res.status(201).json({
      client: clientView(client),
      clientSecret,
      issuer,
      configuration: presetConfiguration({
        preset: (preset as AppPreset) ?? 'generic',
        appUrl: appUrl ?? client.redirectUris[0],
        issuer,
        clientId: client.clientId,
        clientSecret,
        displayName: client.name,
      }),
    });
  } catch (err) {
    if (err instanceof OidcClientError) {
      res.status(err.code === 'Conflict' ? 409 : err.code === 'NotFound' ? 404 : 400).json({ error: err.code, message: err.message });
      return;
    }
    console.error('Error creating OIDC client:', err);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to create the client' });
  }
}
