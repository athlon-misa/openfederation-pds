import { Request, Response } from 'express';
import { query } from '../db/client.js';
import { config } from '../config.js';
import { runtimeSettings } from '../settings/runtime-settings.js';
import { SERVER_VERSION } from '../server/server-version.js';

/**
 * net.openfederation.server.getPublicConfig
 *
 * GET, no auth required.
 * Returns basic server info and public stats for peer discovery.
 */
export default async function getPublicConfig(_req: Request, res: Response): Promise<void> {
  try {
    const [activeCommunitiesResult, totalUsersResult] = await Promise.all([
      query<{ count: string }>("SELECT COUNT(*) as count FROM communities WHERE status = 'active'"),
      query<{ count: string }>("SELECT COUNT(*) as count FROM users WHERE status = 'approved'"),
    ]);

    res.status(200).json({
      service: 'OpenFederation PDS',
      version: SERVER_VERSION,
      hostname: config.pds.hostname,
      serviceUrl: config.pds.serviceUrl,
      webUrl: config.federation.webUiUrl || null,
      // Whether accounts from other PDSes can move here (#265).
      migration: { accounts: runtimeSettings().migration.accounts, pseudonyms: runtimeSettings().migration.pseudonyms, communities: runtimeSettings().migration.communities },
      // Custody policy (ADR-003): which modes accounts may have, the default
      // applications should offer, whether new pseudonyms are accepted, and
      // whether device signing is offered.
      identity: {
        custodyAllowed: runtimeSettings().identity.custodyAllowed,
        custodyDefault: runtimeSettings().identity.custodyDefault,
        pseudonymsEnabled: runtimeSettings().identity.pseudonymsEnabled,
        // Whether self and assisted accounts may have their device sign their repo (#240).
        deviceSigningAllowed: runtimeSettings().identity.deviceSigningAllowed,
      },
      // What the dashboard looks like until a person chooses their own.
      appearance: { defaultPreset: runtimeSettings().appearance.defaultPreset },
      // The PLC directory this PDS registers and resolves DIDs with.
      plcDirectoryUrl: config.plc.directoryUrl,
      stats: {
        activeCommunities: parseInt(activeCommunitiesResult.rows[0].count, 10),
        totalUsers: parseInt(totalUsersResult.rows[0].count, 10),
      },
    });
  } catch (error) {
    console.error('Error getting public config:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to get server info' });
  }
}
