import { Request, Response } from 'express';
import { config } from '../config.js';
import { runtimeSettings } from '../settings/runtime-settings.js';

/**
 * com.atproto.server.describeServer (AT Protocol standard)
 *
 * What a client needs before creating or moving an account here: the
 * service DID (the `aud` of service-auth tokens addressed to this PDS), the
 * handle domain, and whether sign-up needs an invite.
 */
export default async function describeServer(_req: Request, res: Response): Promise<void> {
  res.status(200).json({
    did: config.pds.serviceDid,
    availableUserDomains: [config.handleSuffix],
    inviteCodeRequired: runtimeSettings().inviteRequired,
    phoneVerificationRequired: false,
    links: {},
  });
}
