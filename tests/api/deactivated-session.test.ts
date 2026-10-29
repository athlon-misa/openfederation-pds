/**
 * A deactivated account is never locked out (#265): it can still sign in,
 * but only to check on, fill, activate or back up the account.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { xrpcPost, xrpcAuthGet, xrpcAuthPost, createTestUser, uniqueHandle, isPLCAvailable, testServer } from './helpers.js';
import { config } from '../../src/config.js';
import { fetchTokenKeys, collectTokens, createPseudonym, loginWithPhrase } from '../../packages/openfederation-pseudonym/src/index.js';

const PASSWORD = 'TestPassword123!';

function claim(did: string, jwt: string) {
  return xrpcAuthPost('com.atproto.repo.createRecord', jwt, {
    repo: did, collection: 'net.openfederation.authorship.claim',
    record: { $type: 'net.openfederation.authorship.claim', contentHash: 'ab'.repeat(32), url: 'https://news.example/x', createdAt: new Date().toISOString() },
  });
}

describe('deactivated accounts keep a limited session', () => {
  let plc = false;
  let pdsUrl: string;
  beforeAll(async () => {
    plc = await isPLCAvailable();
    pdsUrl = `http://127.0.0.1:${(testServer.address() as AddressInfo).port}`;
  });

  it('a user signs in while deactivated, can only look after the account, and reactivates', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const user = await createTestUser(uniqueHandle('deact'));
    expect((await xrpcAuthPost('com.atproto.server.deactivateAccount', user.accessJwt, {})).status).toBe(200);

    const login = await xrpcPost('com.atproto.server.createSession', { identifier: user.handle, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({ active: false, status: 'deactivated' });
    const jwt = login.body.accessJwt;

    expect((await xrpcAuthGet('com.atproto.server.checkAccountStatus', jwt)).status).toBe(200);
    expect((await xrpcAuthGet('com.atproto.server.getSession', jwt)).status).toBe(200);
    const refreshed = await xrpcAuthPost('com.atproto.server.refreshSession', login.body.refreshJwt, {});
    expect(refreshed.status).toBe(200);

    const refused = await claim(user.did, jwt);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('AccountDeactivated');
    expect((await xrpcAuthPost('net.openfederation.community.create', jwt, { handle: 'x', name: 'x' })).status).toBe(403);

    expect((await xrpcAuthPost('com.atproto.server.activateAccount', jwt, {})).status).toBe(200);
    const back = await xrpcPost('com.atproto.server.createSession', { identifier: user.handle, password: PASSWORD });
    expect(back.body.active).toBe(true);
    expect((await claim(user.did, back.body.accessJwt)).status).toBe(200);
  });

  it('a pseudonym signs in with its phrase while deactivated and reactivates', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const owner = await createTestUser(uniqueHandle('deact-owner'));
    const keys = await fetchTokenKeys(pdsUrl);
    const [token] = await collectTokens({ pdsUrl, accessJwt: owner.accessJwt, keys, count: config.pseudonym.tokensPerEpoch });
    const p = await createPseudonym({
      pdsUrl, plcUrl: config.plc.directoryUrl, pdsServiceUrl: config.pds.serviceUrl,
      handle: `${uniqueHandle('deact-p')}${config.handleSuffix}`, ownerDid: owner.did, token,
    });
    const first = await loginWithPhrase({ pdsUrl, phrase: p.phrase, expectedServiceDid: config.pds.serviceDid });
    expect((await xrpcAuthPost('com.atproto.server.deactivateAccount', first.accessJwt, {})).status).toBe(200);

    const limited = await loginWithPhrase({ pdsUrl, phrase: p.phrase, expectedServiceDid: config.pds.serviceDid });
    expect(limited).toMatchObject({ did: p.did, active: false, status: 'deactivated' });
    expect((await claim(p.did, limited.accessJwt)).status).toBe(403);
    expect((await xrpcAuthPost('com.atproto.server.activateAccount', limited.accessJwt, {})).status).toBe(200);

    const again = await loginWithPhrase({ pdsUrl, phrase: p.phrase, expectedServiceDid: config.pds.serviceDid });
    expect(again.active).toBe(true);
    expect((await claim(p.did, again.accessJwt)).status).toBe(200);
  });
});
