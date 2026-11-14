import crypto from 'crypto';
import { Response } from 'express';
import { Secp256k1Keypair } from '@atproto/crypto';
import type { AuthRequest } from '../auth/types.js';
import { withTransaction } from '../db/client.js';
import { config } from '../config.js';
import { runtimeSettings } from '../settings/runtime-settings.js';
import { insertUserWithRole } from '../auth/account-creation.js';
import { encryptKeyBytes } from '../auth/encryption.js';
import { isValidHandle, isStrongPassword, normalizeEmail, passwordValidationMessage } from '../auth/utils.js';
import { hashPassword } from '../auth/password.js';
import { claimInvite, InviteError } from '../auth/invites.js';
import { splitSecret } from '../vault/shamir.js';
import { storeShare } from '../vault/vault-store.js';
import { auditLog } from '../db/audit.js';
import { issueSession } from '../auth/session-issue.js';
import { ServiceAuthError, verifyServiceAuthJwt } from '../auth/service-auth.js';
import { currentPlcState, pseudonymOwnerKeyOf } from '../identity/account-migration.js';
import { redeemToken } from '../identity/pseudonym/tokens.js';
import { consumeReservedSigningKeyForDid } from './com.atproto.server.reserveSigningKey.js';
import { RepoEngine } from '../repo/repo-engine.js';

const NSID = 'com.atproto.server.createAccount';
const MAX_PROOF_TTL_SECONDS = 300;

class Refusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/**
 * AT Protocol createAccount, for an account arriving from another PDS (the
 * first step of account migration, #261). New accounts are created with
 * net.openfederation.account.register; this endpoint only imports a DID.
 *
 * Proof of control is a service-auth-shaped JWT (iss = did, aud = this
 * PDS's service DID, lxm = this method) signed by one of the DID's current
 * PLC rotation keys. A pseudonym's owner key is its only rotation key, so
 * the owner can move without help from the old PDS. A user account moves
 * with service auth from its old PDS (#266) and becomes custodial here; or,
 * if its DID publishes `openfederation_owner` (an `assisted` or `self`
 * account), with the same kind of JWT signed by its top rotation key, and
 * becomes `self` here (ADR-004, #382).
 *
 * The account starts deactivated, with an empty repo signed by the key
 * reserved here for this DID. Pseudonyms are not audited, as everywhere else.
 */
export default async function createAccount(req: AuthRequest, res: Response): Promise<void> {
  const did = typeof req.body?.did === 'string' ? req.body.did : '';
  const handle = typeof req.body?.handle === 'string' ? req.body.handle.trim().toLowerCase() : '';
  const token = req.body?.token;
  const email = typeof req.body?.email === 'string' ? normalizeEmail(req.body.email) : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const inviteCode = typeof req.body?.inviteCode === 'string' ? req.body.inviteCode.trim() : '';
  try {
    if (!did) {
      throw new Refusal(400, 'InvalidRequest', 'This PDS creates new accounts with net.openfederation.account.register; createAccount only imports an existing did');
    }
    if (!/^did:plc:[a-z2-7]{24}$/.test(did)) throw new Refusal(400, 'UnresolvableDid', 'did must be a did:plc');
    if (!handle.endsWith(config.handleSuffix)) {
      throw new Refusal(400, 'UnsupportedDomain', `Handle must end with ${config.handleSuffix}`);
    }
    const label = handle.slice(0, -config.handleSuffix.length);
    if (!isValidHandle(label)) throw new Refusal(400, 'InvalidHandle', 'Handle is not valid here');

    const state = await currentPlcState(did);
    if (!state) throw new Refusal(400, 'UnresolvableDid', 'DID is not in the PLC directory');
    const ownerKey = pseudonymOwnerKeyOf(state);
    // A user account arrives with service auth from its old PDS (#266): the
    // middleware verified the token against the DID's current atproto key.
    const custodial = req.auth?.authMethod === 'service-auth';
    if (custodial && req.auth!.did !== did) throw new Refusal(401, 'InvalidToken', 'Service auth token was issued for another DID');
    if (custodial && ownerKey) throw new Refusal(400, 'IncompatibleDidDoc', 'A pseudonym moves with its own key, not with service auth from a PDS');
    // ADR-004: an `assisted` or `self` account (its DID publishes the owner
    // key) may instead prove control with its top rotation key, and arrives
    // as `self`: this server holds none of its keys.
    const selfMove = !custodial && !ownerKey && typeof state.verificationMethods.openfederation_owner === 'string';
    if (!custodial && !ownerKey && !selfMove) {
      throw new Refusal(400, 'IncompatibleDidDoc', 'A user account moves with service auth from its old PDS (com.atproto.server.getServiceAuth)');
    }
    const local = custodial || selfMove; // a user account: email, password, invite
    // The gate (#265): refused here, nothing has changed anywhere.
    const policy = ownerKey ? runtimeSettings().migration.pseudonyms : runtimeSettings().migration.accounts;
    if (policy === 'closed') throw new Refusal(403, 'MigrationNotAllowed', 'This PDS does not accept accounts moving in');
    // ADR-003: a user account moving in with service auth becomes custodial
    // here; a pseudonym is new to this server, which may have switched
    // pseudonyms off.
    if (custodial && !runtimeSettings().identity.custodyAllowed.includes('custodial')) {
      throw new Refusal(403, 'CustodyModeNotAllowed', 'This server does not allow custodial accounts');
    }
    if (selfMove && !runtimeSettings().identity.custodyAllowed.includes('self')) {
      throw new Refusal(403, 'CustodyModeNotAllowed', 'This server does not allow self accounts');
    }
    if (ownerKey && !runtimeSettings().identity.pseudonymsEnabled) {
      throw new Refusal(403, 'MigrationNotAllowed', 'This server does not accept pseudonyms');
    }
    if (local) {
      if (!email || !password) throw new Refusal(400, 'InvalidRequest', 'email and password are required for a user account');
      if (!isStrongPassword(password)) throw new Refusal(400, 'InvalidPassword', passwordValidationMessage());
      if (policy === 'invite' && !inviteCode) throw new Refusal(400, 'InvalidInviteCode', 'An invite code is required to move an account here');
    }

    const header = req.headers.authorization;
    const jwt = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (!custodial && !jwt) throw new Refusal(401, 'AuthRequired', 'A JWT signed by the DID\'s rotation key is required');
    if (!custodial) try {
      const claims = await verifyServiceAuthJwt(jwt, {
        expectedLxm: NSID,
        // A pseudonym has one rotation key. For an ADR-003 account only the
        // top one counts: in `assisted` the old PDS holds a lower key, and a
        // recovery key ranks below the phrase key too.
        resolveVerificationKeys: async () => (selfMove ? state.rotationKeys.slice(0, 1) : state.rotationKeys),
      });
      if (claims.iss !== did) throw new Refusal(401, 'InvalidToken', 'Token was issued for another DID');
      if (claims.lxm !== NSID) throw new Refusal(401, 'InvalidToken', `Token must be scoped to ${NSID}`);
      // The replay cache only remembers a token until it expires, so a proof
      // must be short-lived.
      if (claims.exp > Math.floor(Date.now() / 1000) + MAX_PROOF_TTL_SECONDS) {
        throw new Refusal(401, 'InvalidToken', `Token must expire within ${MAX_PROOF_TTL_SECONDS} seconds`);
      }
    } catch (err) {
      if (err instanceof ServiceAuthError) throw new Refusal(401, 'InvalidToken', err.message);
      throw err;
    }

    const userId = crypto.randomUUID();
    const passwordHash = local ? await hashPassword(password) : null;
    // A user account gets a rotation key made here, split 2-of-3 like at
    // sign-up: shares 2 and 3 stay in the vault, share 1 goes to the user.
    // Only its public half is kept whole, to recommend for the PLC update.
    const rotation = custodial ? await Secp256k1Keypair.create({ exportable: true }) : null;
    const keyBytes = await withTransaction(async (client) => {
      const existing = await client.query(
        `SELECT 1 FROM users WHERE did = $1 OR ($2::text IS NOT NULL AND pseudonym_owner_key = $2)
         UNION ALL SELECT 1 FROM communities WHERE did = $1`, [did, ownerKey]);
      // Checked first: a pseudonym moving back to a copy it left here needs
      // no token (the mover signs in to that copy instead, on AlreadyExists).
      if (existing.rows.length > 0) throw new Refusal(409, 'AlreadyExists', 'This DID already has an account here');
      if (policy === 'token' && (!token || typeof token !== 'object')) {
        throw new Refusal(400, 'InvalidToken', 'This PDS asks for a creation token to accept a pseudonym');
      }
      const taken = await client.query(
        'SELECT 1 FROM users WHERE handle = $1 UNION ALL SELECT 1 FROM communities WHERE handle = $1', [label]);
      if (taken.rows.length > 0) throw new Refusal(400, 'HandleNotAvailable', 'Handle is already taken');
      if (local) {
        const emailTaken = await client.query('SELECT 1 FROM users WHERE email = $1', [email]);
        if (emailTaken.rows.length > 0) throw new Refusal(400, 'InvalidRequest', 'Email is already in use');
      }

      // Token mode spends a blind token in the same transaction: the PDS learns
      // only that a pass from some account was used, not whose.
      if (policy === 'token') {
        const redeemed = await redeemToken(client, token);
        if (redeemed === 'invalid') throw new Refusal(400, 'InvalidToken', 'Creation token is not valid');
        if (redeemed === 'spent') throw new Refusal(400, 'TokenSpent', 'Creation token was already used');
      }
      const reserved = await consumeReservedSigningKeyForDid(client, did);
      // After leavePds the DID already names this server: it must name the
      // key reserved here, or the account could never be activated.
      if (selfMove && state.services.atproto_pds?.endpoint === config.pds.serviceUrl
        && reserved?.signingKey !== state.verificationMethods.atproto) {
        throw new Refusal(400, 'SigningKeyNotReserved', 'The DID names a signing key this PDS did not reserve for it (com.atproto.server.reserveSigningKey before leavePds)');
      }
      const bytes = reserved?.keyBytes
        ?? Buffer.from(await (await Secp256k1Keypair.create({ exportable: true })).export());
      await insertUserWithRole(client, local ? {
        userId, handle: label, email, passwordHash, did, status: 'deactivated', authType: 'local', migratingIn: true,
        custodyMode: selfMove ? 'self' : 'custodial',
      } : {
        userId, handle: label, email: null, passwordHash: null, did,
        status: 'deactivated', authType: 'pseudonym', pseudonymOwnerKey: ownerKey!, migratingIn: true,
      });
      if (rotation) await client.query('UPDATE users SET rotation_did_key = $2 WHERE id = $1', [userId, rotation.did()]);
      if (local && policy === 'invite') {
        try {
          await claimInvite(client, inviteCode, email, userId); // after the row: invites.used_by references it
        } catch (err) {
          if (err instanceof InviteError) throw new Refusal(err.status, err.code, err.message);
          throw err;
        }
      }
      const encrypted = await encryptKeyBytes(bytes, 'identity.signing-key');
      await client.query('INSERT INTO user_signing_keys (user_did, signing_key_bytes) VALUES ($1, $2)', [did, encrypted]);
      return bytes;
    });

    let rotationDeviceShare: string | undefined;
    if (rotation) {
      const secret = Buffer.from(await rotation.export());
      const shares = splitSecret(secret, 3, 2);
      secret.fill(0);
      await storeShare(did, 2, shares[1], 'vault');
      await storeShare(did, 3, shares[2], 'vault');
      rotationDeviceShare = shares[0];
      await auditLog('account.migrateIn', userId, userId, { did, handle: label });
    }
    if (selfMove) await auditLog('account.moveIn', userId, userId, { did, handle: label, method: 'rotation-key' });

    // An empty repo signed by this PDS's key, as the reference PDS does;
    // importRepo replaces it with the account's own.
    try {
      const keypair = await Secp256k1Keypair.import(keyBytes, { exportable: false });
      await new RepoEngine(did).createRepo(keypair, []);
    } catch (err) {
      // Without a repo the account can't import or activate; remove it so the
      // owner can simply try again.
      await withTransaction(async (client) => {
        await client.query('DELETE FROM repo_roots WHERE did = $1', [did]);
        await client.query('DELETE FROM repo_blocks WHERE community_did = $1', [did]);
        await client.query('DELETE FROM user_signing_keys WHERE user_did = $1', [did]);
        await client.query('DELETE FROM users WHERE id = $1', [userId]);
      }).catch(() => undefined);
      throw err;
    }

    const session = await issueSession(
      { id: userId, handle: label, email: local ? email : null, did, status: 'deactivated', token_version: 0 },
      { pseudonym: !local },
    );
    res.status(200).json({
      did, handle, accessJwt: session.accessJwt, refreshJwt: session.refreshJwt,
      ...(rotationDeviceShare ? { rotationDeviceShare } : {}),
    });
  } catch (error) {
    if (error instanceof Refusal) {
      res.status(error.status).json({ error: error.code, message: error.message });
      return;
    }
    console.error('Error in createAccount (migration):', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to create account' });
  }
}
