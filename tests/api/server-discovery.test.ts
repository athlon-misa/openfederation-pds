/**
 * What a client needs to know about a PDS before moving an account or a
 * community to it (#268): the standard describeServer (service DID, handle
 * domains) and the migration policies + PLC directory in getPublicConfig.
 */
import { describe, it, expect } from 'vitest';
import { xrpcGet, createTestUser, isPLCAvailable, uniqueHandle } from './helpers.js';
import { query } from '../../src/db/client.js';
import { config } from '../../src/config.js';

describe('server discovery', () => {
  it('com.atproto.server.describeServer names the service DID and handle domain', async () => {
    const res = await xrpcGet('com.atproto.server.describeServer');
    expect(res.status).toBe(200);
    expect(res.body.did).toBe(config.pds.serviceDid);
    expect(res.body.availableUserDomains).toEqual([config.handleSuffix]);
    expect(typeof res.body.inviteCodeRequired).toBe('boolean');
  });

  it('getPublicConfig reports every migration policy and the PLC directory', async () => {
    const res = await xrpcGet('net.openfederation.server.getPublicConfig');
    expect(res.status).toBe(200);
    expect(res.body.migration).toEqual({
      accounts: config.migration.accounts, pseudonyms: config.migration.pseudonyms, communities: config.migration.communities,
    });
    expect(res.body.plcDirectoryUrl).toBe(config.plc.directoryUrl);
  });

  it('com.atproto.sync.getLatestCommit returns the repository\'s current commit', async () => {
    if (!(await isPLCAvailable())) return;
    const user = await createTestUser(uniqueHandle('glc'));
    const res = await xrpcGet('com.atproto.sync.getLatestCommit', { did: user.did });
    expect(res.status).toBe(200);
    const root = (await query<{ root_cid: string; rev: string }>('SELECT root_cid, rev FROM repo_roots WHERE did = $1', [user.did])).rows[0];
    expect(res.body).toEqual({ cid: root.root_cid, rev: root.rev });
    expect((await xrpcGet('com.atproto.sync.getLatestCommit', { did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa' })).status).toBe(404);
  });
});
