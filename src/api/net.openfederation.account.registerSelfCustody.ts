import crypto from 'crypto';
import { Request, Response } from 'express';
import { config } from '../config.js';
import { fullHandle } from '../auth/utils.js';
import { runtimeSettings } from '../settings/runtime-settings.js';
import { query, withTransaction } from '../db/client.js';
import { hashPassword } from '../auth/password.js';
import { claimInvite, assertInviteUsable, InviteError } from '../auth/invites.js';
import { issueEmailVerification } from '../email/verification.js';
import { getPlcLog } from '../identity/plc-client.js';
import { checkCustodyGenesis } from '../identity/custody-genesis.js';
import { storeRotationKeyShares } from '../identity/custody-change.js';
import { logVaultAudit } from '../vault/vault-store.js';
import { consumeReservedSigningKey } from './com.atproto.server.reserveSigningKey.js';
import { consumeReservedRotationKey } from './net.openfederation.account.reserveCustodyKey.js';
import {
  RegistrationValidationError, normalizeAndValidateCredentials, ensureHandleEmailAvailable,
  insertUserWithRole, initializeUserRepoAsync, newAccountStatus, auditAutomaticApproval,
} from '../auth/account-creation.js';

/**
 * net.openfederation.account.registerSelfCustody (ADR-003, decision 4)
 *
 * Sign-up for an `assisted` or `self` account. The client made the keys from
 * a phrase on the device, put the genesis operation in PLC (the user's
 * rotation key first; for `assisted`, the key from reserveCustodyKey second;
 * the signing key from reserveSigningKey as `atproto`; the owner key as
 * `openfederation_owner`), and now registers it here with the same rules as
 * account.register: invite, email, password, approval. Login stays
 * password-based; the phrase never reaches this server.
 */
export default async function registerSelfCustody(req: Request, res: Response): Promise<void> {
  const did = typeof req.body?.did === 'string' ? req.body.did : '';
  const mode = req.body?.mode;
  const inviteCode = typeof req.body?.inviteCode === 'string' ? req.body.inviteCode : undefined;
  try {
    if (!/^did:plc:[a-z2-7]{24}$/.test(did)) throw new RegistrationValidationError(400, 'InvalidRequest', 'did must be a did:plc');
    if (mode !== 'assisted' && mode !== 'self') throw new RegistrationValidationError(400, 'InvalidRequest', 'mode must be "assisted" or "self"');
    const { handle, email, password } = normalizeAndValidateCredentials(req.body ?? {});
    // One reading for the whole request: a change made meanwhile applies to the next one.
    const settings = runtimeSettings();
    const status = newAccountStatus(settings);
    if (!settings.identity.custodyAllowed.includes(mode)) {
      throw new RegistrationValidationError(403, 'CustodyModeNotAllowed', `This server does not allow ${mode} accounts`);
    }
    if (settings.inviteRequired && !inviteCode) throw new RegistrationValidationError(403, 'InviteRequired', 'An invite code is required to register');

    // Checks that refuse the request anyway run before the slow work.
    await ensureHandleEmailAvailable({ query }, handle, email);
    if (settings.inviteRequired) {
      try { await assertInviteUsable({ query }, inviteCode!, email); } catch (err) {
        if (err instanceof InviteError) throw new RegistrationValidationError(err.status, err.code, err.message);
        throw err;
      }
    }

    const log = await getPlcLog(did);
    if (!log || log.length !== 1) throw new RegistrationValidationError(400, 'InvalidGenesis', 'The DID must exist in PLC with exactly its genesis operation');
    const check = await checkCustodyGenesis(did, log[0], mode, { serviceUrl: config.pds.serviceUrl, handle: `${handle}${config.handleSuffix}` });
    if (!check.ok) throw new RegistrationValidationError(400, 'InvalidGenesis', check.reason);

    const passwordHash = await hashPassword(password);
    const userId = crypto.randomUUID();
    const signingKeyBytes = await withTransaction(async (client) => {
      await ensureHandleEmailAvailable(client, handle, email);
      const taken = await client.query('SELECT 1 FROM users WHERE did = $1 UNION ALL SELECT 1 FROM communities WHERE did = $1', [did]);
      if (taken.rows.length > 0) throw new RegistrationValidationError(409, 'AccountExists', 'This DID already has an account here');

      const signingKey = await consumeReservedSigningKey(client, check.signingKey);
      if (!signingKey) throw new RegistrationValidationError(400, 'SigningKeyNotReserved', 'The atproto signing key was not reserved here (com.atproto.server.reserveSigningKey)');

      if (check.pdsRotationKey) {
        const pdsKey = await consumeReservedRotationKey(client, check.pdsRotationKey);
        if (!pdsKey) throw new RegistrationValidationError(400, 'PdsKeyNotReserved', 'The second rotation key was not reserved here (net.openfederation.account.reserveCustodyKey)');
        // Kept like a custodial key: shares 2 and 3, encrypted; the key itself is not stored.
        await storeRotationKeyShares(client, did, pdsKey);
        pdsKey.fill(0);
      }

      await insertUserWithRole(client, { userId, handle, email, passwordHash, did, status, custodyMode: mode });
      if (settings.inviteRequired) {
        try { await claimInvite(client, inviteCode!, email, userId); } catch (err) {
          if (err instanceof InviteError) throw new RegistrationValidationError(err.status, err.code, err.message);
          throw err;
        }
      }
      return signingKey;
    });

    if (check.pdsRotationKey) {
      await logVaultAudit(did, 'shares.created', did, undefined, { numShares: 3, threshold: 2, holders: { 2: 'vault', 3: 'vault' }, custodyMode: mode });
    }
    await initializeUserRepoAsync(did, handle, signingKeyBytes.toString('base64'));
    signingKeyBytes.fill(0);
    if (status === 'approved') await auditAutomaticApproval(userId, handle);

    if (settings.emailVerificationPolicy !== 'off') {
      void issueEmailVerification({ id: userId, handle, email }).catch((err) => console.error('[email] verification send failed:', err));
    }
    res.status(201).json({ id: userId, handle: fullHandle(handle), did, email, status, custodyMode: mode });
  } catch (err) {
    if (err instanceof RegistrationValidationError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    console.error('Error in registerSelfCustody:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to register account' });
  }
}
