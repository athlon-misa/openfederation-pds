import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '../../src/db/client.js';
import {
  createTestUser,
  isPLCAvailable,
  uniqueHandle,
  xrpcAuthGet,
  xrpcPost,
} from './helpers.js';

describe('net.openfederation.account.export authorization', () => {
  let plc: boolean;

  beforeAll(async () => {
    plc = await isPLCAvailable();
  });

  it('does not allow a moderator to export another account or satisfy its takedown prerequisite', async () => {
    if (!plc) return;

    const target = await createTestUser(uniqueHandle('export-target'));
    const moderator = await createTestUser(uniqueHandle('export-moderator'), { role: 'moderator' });
    const refreshedModeratorSession = await xrpcPost('com.atproto.server.createSession', {
      identifier: moderator.handle,
      password: 'TestPassword123!',
    });
    expect(refreshedModeratorSession.status).toBe(200);

    const response = await xrpcAuthGet(
      'net.openfederation.account.export',
      refreshedModeratorSession.body.accessJwt,
      { did: target.did },
    );

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: 'Forbidden' });

    const targetAccount = await query<{ exported_at: string | null }>(
      'SELECT exported_at FROM users WHERE did = $1',
      [target.did],
    );
    expect(targetAccount.rows).toHaveLength(1);
    expect(targetAccount.rows[0].exported_at).toBeNull();
  });
});
