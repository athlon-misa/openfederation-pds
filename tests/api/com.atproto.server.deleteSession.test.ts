/**
 * com.atproto.server.deleteSession takes the refresh token the AT Protocol
 * way, as the bearer token with no body (#412: a pen name's sign-out in the
 * dashboard got a 400 for it), and still the way this server's own clients
 * send it, as `refreshJwt` in the body with the access token as the bearer.
 */
import { describe, it, expect } from 'vitest';
import { xrpcAuthPost, xrpcPost, getAdminHandle, getAdminPassword, isPLCAvailable } from './helpers.js';
import { derivePseudonymKeys, signText } from '../../packages/openfederation-pseudonym/src/keys.js';
import { buildLoginMessage } from '../../packages/openfederation-pseudonym/src/formats.js';
import { preparePseudonym } from './pseudonym-test-kit.js';

const NSID = 'com.atproto.server.deleteSession';

async function adminLogin() {
  const res = await xrpcPost('com.atproto.server.createSession', { identifier: getAdminHandle(), password: getAdminPassword() });
  expect(res.status).toBe(200);
  return res.body as { accessJwt: string; refreshJwt: string };
}

describe('com.atproto.server.deleteSession', () => {
  it('the refresh token as the bearer, empty body: signed out, and the token no longer refreshes', async () => {
    const { refreshJwt } = await adminLogin();
    const out = await xrpcAuthPost(NSID, refreshJwt, {});
    expect(out.status).toBe(200);
    expect((await xrpcPost('com.atproto.server.refreshSession', { refreshJwt })).status).toBe(401);
  });

  it('the refresh token as the bearer, no body at all', async () => {
    const { refreshJwt } = await adminLogin();
    expect((await xrpcAuthPost(NSID, refreshJwt)).status).toBe(200);
    expect((await xrpcPost('com.atproto.server.refreshSession', { refreshJwt })).status).toBe(401);
  });

  it('refreshJwt in the body with the access token as the bearer (the dashboard\'s own sign-out)', async () => {
    const { accessJwt, refreshJwt } = await adminLogin();
    expect((await xrpcAuthPost(NSID, accessJwt, { refreshJwt })).status).toBe(200);
    expect((await xrpcPost('com.atproto.server.refreshSession', { refreshJwt })).status).toBe(401);
  });

  it('no token anywhere: 400', async () => {
    const res = await xrpcPost(NSID, {});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidRequest');
  });

  it('a pen name signs out with its refresh token, as the dashboard sends it', async (ctx) => {
    if (!(await isPLCAvailable())) ctx.skip('PLC directory not available');
    const p = await preparePseudonym();
    expect((await xrpcPost('net.openfederation.pseudonym.createAccount', { did: p.did, token: p.token })).status).toBe(201);
    const k = derivePseudonymKeys(p.phrase);
    const ch = await xrpcPost('net.openfederation.pseudonym.getLoginChallenge', { ownerKey: k.ownerDidKey });
    const signature = signText(k.ownerPrivateKey, buildLoginMessage({ serviceDid: ch.body.serviceDid, challenge: ch.body.challenge }));
    const login = await xrpcPost('net.openfederation.pseudonym.createSession', { challengeId: ch.body.challengeId, signature });
    expect(login.status).toBe(200);

    const out = await xrpcAuthPost(NSID, login.body.refreshJwt, {});
    expect(out.status).toBe(200);
    expect((await xrpcAuthPost('com.atproto.server.refreshSession', login.body.refreshJwt, {})).status).toBe(401);
  });
});
