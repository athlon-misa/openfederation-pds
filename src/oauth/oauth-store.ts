/**
 * PostgreSQL-backed store for @atproto/oauth-provider.
 *
 * Implements AccountStore, RequestStore, DeviceStore, and TokenStore
 * using the existing users/user_roles tables plus new OAuth tables
 * from migrate-003-oauth.sql.
 */

import type {
  Account,
  AccountStore,
  AuthenticateAccountData,
  AuthorizedClientData,
  AuthorizedClients,
  CreateAccountData,
  DeviceAccount,
  ResetPasswordRequestInput,
  ResetPasswordConfirmInput,
  RequestStore,
  UpdateRequestData,
  FoundRequestResult,
  RequestData,
  RequestId,
  Code,
  DeviceStore,
  DeviceData,
  DeviceId,
  TokenStore,
  TokenInfo,
  CreateTokenData,
  NewTokenData,
  TokenId,
  RefreshToken,
  Sub,
  ClientId,
} from '@atproto/oauth-provider';

import { query, getClient } from '../db/client.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { normalizeHandle } from '../auth/utils.js';
import { createUserIdentity } from '../identity/user-identity.js';
import {
  normalizeAndValidateCredentials,
  ensureHandleEmailAvailable,
  insertUserWithRole,
  initializeUserRepoAsync,
} from '../auth/account-creation.js';
import { config } from '../config.js';
import crypto from 'crypto';

// ---------- AccountStore ----------

export class PgAccountStore implements AccountStore {
  async createAccount(data: CreateAccountData): Promise<Account> {
    const { handle, email, password } = normalizeAndValidateCredentials(data);

    // Invite check BEFORE starting any IO. Bug-fix: previously this was
    // gated on `data.inviteCode` being present, which meant OAuth callers
    // could skip the invite gate just by omitting the code.
    if (config.auth.inviteRequired) {
      if (!data.inviteCode) {
        throw new Error('An invite code is required to register');
      }
      const invite = await query(
        'SELECT code, max_uses, uses_count, expires_at FROM invites WHERE code = $1',
        [data.inviteCode]
      );
      if (invite.rows.length === 0) throw new Error('Invalid invite code');
      const inv = invite.rows[0];
      if (inv.uses_count >= inv.max_uses) throw new Error('Invite code already used');
      if (inv.expires_at && new Date(inv.expires_at) < new Date()) throw new Error('Invite code expired');
    }

    const client = await getClient();
    let identity: Awaited<ReturnType<typeof createUserIdentity>>;
    const userId = crypto.randomUUID();
    try {
      await client.query('BEGIN');

      await ensureHandleEmailAvailable(client, handle, email);

      const [createdIdentity, passwordHash] = await Promise.all([
        createUserIdentity(handle),
        hashPassword(password),
      ]);
      identity = createdIdentity;

      await insertUserWithRole(client, {
        userId,
        handle,
        email,
        passwordHash,
        did: identity.did,
        status: 'pending',
      });

      if (config.auth.inviteRequired && data.inviteCode) {
        await client.query(
          'UPDATE invites SET uses_count = uses_count + 1, used_by = $1, used_at = CURRENT_TIMESTAMP WHERE code = $2',
          [userId, data.inviteCode]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Initialize signing key + repo outside the user-insert transaction.
    // Previously the OAuth path only stored the signing key and skipped
    // repo initialization entirely — now aligned with the other two flows.
    await initializeUserRepoAsync(identity.did, handle, identity.signingKeyBase64);

    return {
      sub: identity.did,
      aud: config.pds.serviceUrl,
      email,
      name: handle,
      preferred_username: handle,
    };
  }

  async authenticateAccount(data: AuthenticateAccountData): Promise<Account> {
    const identifier = data.username.trim().toLowerCase();

    const result = await query<{
      id: string;
      handle: string;
      email: string;
      password_hash: string | null;
      status: string;
      did: string;
      auth_type: string;
    }>(
      'SELECT id, handle, email, password_hash, status, did, auth_type FROM users WHERE handle = $1 OR email = $1',
      [identifier]
    );

    if (result.rows.length === 0) {
      throw new Error('Invalid credentials');
    }

    const user = result.rows[0];

    if (user.auth_type === 'external') {
      throw new Error('This account uses ATProto OAuth. Please sign in via your home PDS.');
    }

    if (!user.password_hash) {
      throw new Error('Invalid credentials');
    }

    const valid = await verifyPassword(data.password, user.password_hash);
    if (!valid) {
      throw new Error('Invalid credentials');
    }

    if (user.status !== 'approved') {
      throw new Error('Account is not approved');
    }

    return {
      sub: user.did,
      aud: config.pds.serviceUrl,
      email: user.email,
      name: user.handle,
      preferred_username: user.handle,
    };
  }

  async setAuthorizedClient(sub: Sub, clientId: ClientId, data: AuthorizedClientData): Promise<void> {
    await query(
      `INSERT INTO oauth_authorized_clients (account_sub, client_id, authorized_scopes, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (account_sub, client_id)
       DO UPDATE SET authorized_scopes = $3, updated_at = CURRENT_TIMESTAMP`,
      [sub, clientId, JSON.stringify(data.authorizedScopes)]
    );
  }

  async getAccount(sub: Sub): Promise<{ account: Account; authorizedClients: AuthorizedClients }> {
    const userResult = await query<{
      handle: string;
      email: string;
      did: string;
      status: string;
    }>(
      'SELECT handle, email, did, status FROM users WHERE did = $1',
      [sub]
    );

    if (userResult.rows.length === 0) {
      throw new Error('Account not found');
    }

    const user = userResult.rows[0];
    const account: Account = {
      sub: user.did,
      aud: config.pds.serviceUrl,
      email: user.email,
      name: user.handle,
      preferred_username: user.handle,
    };

    const clientsResult = await query<{
      client_id: string;
      authorized_scopes: string[];
    }>(
      'SELECT client_id, authorized_scopes FROM oauth_authorized_clients WHERE account_sub = $1',
      [sub]
    );

    const authorizedClients: AuthorizedClients = new Map();
    for (const row of clientsResult.rows) {
      authorizedClients.set(row.client_id as ClientId, {
        authorizedScopes: row.authorized_scopes,
      });
    }

    return { account, authorizedClients };
  }

  async upsertDeviceAccount(deviceId: DeviceId, sub: Sub): Promise<void> {
    // Delete unbound device accounts for same device + sub
    await query(
      'DELETE FROM oauth_device_accounts WHERE device_id = $1 AND account_sub = $2 AND request_id IS NULL',
      [deviceId, sub]
    );

    await query(
      `INSERT INTO oauth_device_accounts (device_id, account_sub, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (device_id, account_sub)
       DO UPDATE SET updated_at = CURRENT_TIMESTAMP`,
      [deviceId, sub]
    );
  }

  async getDeviceAccount(deviceId: DeviceId, sub: Sub): Promise<DeviceAccount | null> {
    const result = await query<{
      device_id: string;
      account_sub: string;
      request_id: string | null;
      da_created_at: string;
      da_updated_at: string;
      device_data: DeviceData;
    }>(
      `SELECT da.device_id, da.account_sub, da.request_id,
              da.created_at as da_created_at, da.updated_at as da_updated_at,
              d.data as device_data
       FROM oauth_device_accounts da
       JOIN oauth_devices d ON d.id = da.device_id
       WHERE da.device_id = $1 AND da.account_sub = $2`,
      [deviceId, sub]
    );

    if (result.rows.length === 0) return null;
    const row = result.rows[0];

    const { account, authorizedClients } = await this.getAccount(sub);

    return {
      deviceId: row.device_id as DeviceId,
      deviceData: row.device_data,
      account,
      authorizedClients,
      createdAt: new Date(row.da_created_at),
      updatedAt: new Date(row.da_updated_at),
    };
  }

  async removeDeviceAccount(deviceId: DeviceId, sub: Sub): Promise<void> {
    await query(
      'DELETE FROM oauth_device_accounts WHERE device_id = $1 AND account_sub = $2 AND request_id IS NULL',
      [deviceId, sub]
    );
  }

  async listDeviceAccounts(filter: { sub: Sub } | { deviceId: DeviceId }): Promise<DeviceAccount[]> {
    let rows: Array<{
      device_id: string;
      account_sub: string;
      da_created_at: string;
      da_updated_at: string;
      device_data: DeviceData;
    }>;

    if ('sub' in filter) {
      const result = await query(
        `SELECT da.device_id, da.account_sub,
                da.created_at as da_created_at, da.updated_at as da_updated_at,
                d.data as device_data
         FROM oauth_device_accounts da
         JOIN oauth_devices d ON d.id = da.device_id
         WHERE da.account_sub = $1`,
        [filter.sub]
      );
      rows = result.rows;
    } else {
      const result = await query(
        `SELECT da.device_id, da.account_sub,
                da.created_at as da_created_at, da.updated_at as da_updated_at,
                d.data as device_data
         FROM oauth_device_accounts da
         JOIN oauth_devices d ON d.id = da.device_id
         WHERE da.device_id = $1`,
        [filter.deviceId]
      );
      rows = result.rows;
    }

    const accounts: DeviceAccount[] = [];
    for (const row of rows) {
      try {
        const { account, authorizedClients } = await this.getAccount(row.account_sub as Sub);
        accounts.push({
          deviceId: row.device_id as DeviceId,
          deviceData: row.device_data,
          account,
          authorizedClients,
          createdAt: new Date(row.da_created_at),
          updatedAt: new Date(row.da_updated_at),
        });
      } catch {
        // Account may have been deleted; skip
      }
    }

    return accounts;
  }

  async resetPasswordRequest(_data: ResetPasswordRequestInput): Promise<null | Account> {
    // Email verification not yet implemented
    return null;
  }

  async resetPasswordConfirm(_data: ResetPasswordConfirmInput): Promise<null | Account> {
    // Email verification not yet implemented
    return null;
  }

  async verifyHandleAvailability(handle: string): Promise<void> {
    const normalized = normalizeHandle(handle);
    const result = await query('SELECT id FROM users WHERE handle = $1', [normalized]);
    if (result.rows.length > 0) {
      throw new Error('Handle is already taken');
    }
  }
}

// ---------- RequestStore ----------

export class PgRequestStore implements RequestStore {
  async createRequest(requestId: RequestId, data: RequestData): Promise<void> {
    await query(
      `INSERT INTO oauth_requests (id, data, expires_at)
       VALUES ($1, $2, $3)`,
      [requestId, JSON.stringify(data), data.expiresAt.toISOString()]
    );
  }

  async readRequest(requestId: RequestId): Promise<RequestData | null> {
    const result = await query<{ data: RequestData }>(
      'SELECT data FROM oauth_requests WHERE id = $1',
      [requestId]
    );
    if (result.rows.length === 0) return null;
    return deserializeRequestData(result.rows[0].data);
  }

  async updateRequest(requestId: RequestId, data: UpdateRequestData): Promise<void> {
    const existing = await this.readRequest(requestId);
    if (!existing) throw new Error('Request not found');

    const merged = { ...existing, ...data };
    await query(
      `UPDATE oauth_requests SET data = $1, expires_at = $2 WHERE id = $3`,
      [JSON.stringify(merged), (merged.expiresAt || existing.expiresAt).toISOString(), requestId]
    );
  }

  async deleteRequest(requestId: RequestId): Promise<void> {
    // Delete bound device accounts first
    await query(
      'DELETE FROM oauth_device_accounts WHERE request_id = $1',
      [requestId]
    );
    await query('DELETE FROM oauth_requests WHERE id = $1', [requestId]);
  }

  async consumeRequestCode(code: Code): Promise<FoundRequestResult | null> {
    // Atomic: SELECT FOR UPDATE SKIP LOCKED to prevent concurrent consumption
    const client = await getClient();
    try {
      await client.query('BEGIN');

      const result = await client.query<{ id: string; data: RequestData }>(
        `SELECT id, data FROM oauth_requests
         WHERE data->>'code' = $1
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [code]
      );

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }

      const row = result.rows[0];

      // Delete the request (consumed)
      await client.query('DELETE FROM oauth_requests WHERE id = $1', [row.id]);
      // Delete bound device accounts
      await client.query('DELETE FROM oauth_device_accounts WHERE request_id = $1', [row.id]);

      await client.query('COMMIT');

      return {
        requestId: row.id as RequestId,
        data: deserializeRequestData(row.data),
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

// ---------- DeviceStore ----------

export class PgDeviceStore implements DeviceStore {
  async createDevice(deviceId: DeviceId, data: DeviceData): Promise<void> {
    await query(
      `INSERT INTO oauth_devices (id, data)
       VALUES ($1, $2)`,
      [deviceId, JSON.stringify(data)]
    );
  }

  async readDevice(deviceId: DeviceId): Promise<DeviceData | null> {
    const result = await query<{ data: DeviceData }>(
      'SELECT data FROM oauth_devices WHERE id = $1',
      [deviceId]
    );
    if (result.rows.length === 0) return null;
    return result.rows[0].data;
  }

  async updateDevice(deviceId: DeviceId, data: Partial<DeviceData>): Promise<void> {
    const existing = await this.readDevice(deviceId);
    if (!existing) throw new Error('Device not found');

    const merged = { ...existing, ...data };
    await query(
      `UPDATE oauth_devices SET data = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [JSON.stringify(merged), deviceId]
    );
  }

  async deleteDevice(deviceId: DeviceId): Promise<void> {
    await query('DELETE FROM oauth_devices WHERE id = $1', [deviceId]);
  }
}

// ---------- TokenStore ----------

export class PgTokenStore implements TokenStore {
  async createToken(tokenId: TokenId, data: CreateTokenData, refreshToken?: RefreshToken): Promise<void> {
    await query(
      `INSERT INTO oauth_tokens (id, data, current_refresh_token)
       VALUES ($1, $2, $3)`,
      [tokenId, JSON.stringify(serializeTokenData(data)), refreshToken || null]
    );
  }

  async readToken(tokenId: TokenId): Promise<null | TokenInfo> {
    const result = await query<{
      id: string;
      data: any;
      current_refresh_token: string | null;
    }>(
      'SELECT id, data, current_refresh_token FROM oauth_tokens WHERE id = $1',
      [tokenId]
    );

    if (result.rows.length === 0) return null;
    return this.buildTokenInfo(result.rows[0]);
  }

  async deleteToken(tokenId: TokenId): Promise<void> {
    await query('DELETE FROM oauth_tokens WHERE id = $1', [tokenId]);
  }

  async rotateToken(
    tokenId: TokenId,
    newTokenId: TokenId,
    newRefreshToken: RefreshToken,
    newData: NewTokenData
  ): Promise<void> {
    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Get current token
      const current = await client.query<{ data: any; current_refresh_token: string | null }>(
        'SELECT data, current_refresh_token FROM oauth_tokens WHERE id = $1 FOR UPDATE',
        [tokenId]
      );

      if (current.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new Error('Token not found');
      }

      const oldRefreshToken = current.rows[0].current_refresh_token;
      const oldData = current.rows[0].data;

      // Store old refresh token for replay detection
      if (oldRefreshToken) {
        const tokenHash = crypto.createHash('sha256').update(oldRefreshToken).digest('hex');
        await client.query(
          `INSERT INTO oauth_used_refresh_tokens (token_hash, token_id)
           VALUES ($1, $2)
           ON CONFLICT (token_hash) DO NOTHING`,
          [tokenHash, tokenId]
        );
      }

      // Update token with new data
      const mergedData = { ...oldData, ...serializeTokenData(newData) };
      await client.query(
        `UPDATE oauth_tokens SET id = $1, data = $2, current_refresh_token = $3 WHERE id = $4`,
        [newTokenId, JSON.stringify(mergedData), newRefreshToken, tokenId]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async findTokenByRefreshToken(refreshToken: RefreshToken): Promise<null | TokenInfo> {
    // Check current refresh token
    let result = await query<{
      id: string;
      data: any;
      current_refresh_token: string | null;
    }>(
      'SELECT id, data, current_refresh_token FROM oauth_tokens WHERE current_refresh_token = $1',
      [refreshToken]
    );

    if (result.rows.length > 0) {
      return this.buildTokenInfo(result.rows[0]);
    }

    // Check used refresh tokens (previous tokens)
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const usedResult = await query<{ token_id: string }>(
      'SELECT token_id FROM oauth_used_refresh_tokens WHERE token_hash = $1',
      [tokenHash]
    );

    if (usedResult.rows.length > 0) {
      return this.readToken(usedResult.rows[0].token_id as TokenId);
    }

    return null;
  }

  async findTokenByCode(code: Code): Promise<null | TokenInfo> {
    const result = await query<{
      id: string;
      data: any;
      current_refresh_token: string | null;
    }>(
      `SELECT id, data, current_refresh_token FROM oauth_tokens WHERE data->>'code' = $1`,
      [code]
    );

    if (result.rows.length === 0) return null;
    return this.buildTokenInfo(result.rows[0]);
  }

  async listAccountTokens(sub: Sub): Promise<TokenInfo[]> {
    const result = await query<{
      id: string;
      data: any;
      current_refresh_token: string | null;
    }>(
      `SELECT id, data, current_refresh_token FROM oauth_tokens WHERE data->>'sub' = $1`,
      [sub]
    );

    const tokens: TokenInfo[] = [];
    for (const row of result.rows) {
      try {
        tokens.push(await this.buildTokenInfo(row));
      } catch {
        // Account may have been deleted; skip
      }
    }
    return tokens;
  }

  private async buildTokenInfo(row: {
    id: string;
    data: any;
    current_refresh_token: string | null;
  }): Promise<TokenInfo> {
    const data = deserializeTokenData(row.data);
    const sub = data.sub as Sub;

    // Look up account
    const userResult = await query<{
      handle: string;
      email: string;
      did: string;
    }>(
      'SELECT handle, email, did FROM users WHERE did = $1',
      [sub]
    );

    if (userResult.rows.length === 0) {
      throw new Error(`Account not found for sub: ${sub}`);
    }

    const user = userResult.rows[0];
    const account: Account = {
      sub: user.did,
      aud: config.pds.serviceUrl,
      email: user.email,
      name: user.handle,
      preferred_username: user.handle,
    };

    return {
      id: row.id as TokenId,
      data,
      account,
      currentRefreshToken: (row.current_refresh_token as RefreshToken) || null,
    };
  }
}

// ---------- Helpers ----------

function serializeTokenData(data: any): any {
  const serialized = { ...data };
  if (data.createdAt instanceof Date) serialized.createdAt = data.createdAt.toISOString();
  if (data.updatedAt instanceof Date) serialized.updatedAt = data.updatedAt.toISOString();
  if (data.expiresAt instanceof Date) serialized.expiresAt = data.expiresAt.toISOString();
  return serialized;
}

function deserializeTokenData(data: any): any {
  const deserialized = { ...data };
  if (typeof data.createdAt === 'string') deserialized.createdAt = new Date(data.createdAt);
  if (typeof data.updatedAt === 'string') deserialized.updatedAt = new Date(data.updatedAt);
  if (typeof data.expiresAt === 'string') deserialized.expiresAt = new Date(data.expiresAt);
  return deserialized;
}

function deserializeRequestData(data: any): RequestData {
  const deserialized = { ...data };
  if (typeof data.expiresAt === 'string') deserialized.expiresAt = new Date(data.expiresAt);
  return deserialized as RequestData;
}
