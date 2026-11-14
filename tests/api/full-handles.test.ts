/**
 * #411: AT Protocol handles are full domain names. Accounts and communities
 * store the short name; every response gives the name plus this server's
 * handle domain, the same name the DID document carries in `alsoKnownAs`.
 * Inputs take either form.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import {
  api, xrpcPost, xrpcGet, xrpcAuthGet, xrpcAuthPost, getAdminToken, getAdminHandle, getAdminPassword,
  createTestUser, uniqueHandle, isPLCAvailable, testServer,
} from './helpers.js';
import { config } from '../../src/config.js';
import { runtimeSettings } from '../../src/settings/runtime-settings.js';
import { fetchTokenKeys, collectTokens, createPseudonym, loginWithPhrase } from '../../packages/openfederation-pseudonym/src/index.js';

const full = (name: string) => `${name}${config.handleSuffix}`;

/** The `at://` name in a DID's document, from the PLC directory. */
async function plcHandle(did: string): Promise<string | undefined> {
  const doc = await (await fetch(`${config.plc.directoryUrl}/${did}`)).json() as { alsoKnownAs?: string[] };
  return doc.alsoKnownAs?.find((a) => a.startsWith('at://'))?.slice('at://'.length);
}

describe('full handles in responses (#411)', () => {
  let plc = false;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let adminToken: string;

  beforeAll(async () => {
    plc = await isPLCAvailable();
    adminToken = await getAdminToken();
    if (plc) user = await createTestUser(uniqueHandle('fullh'));
  });

  it('the bootstrap admin (local only, no PLC identity) signs in and is named with this server\'s domain', async () => {
    const res = await xrpcPost('com.atproto.server.createSession', { identifier: getAdminHandle(), password: getAdminPassword() });
    expect(res.status).toBe(200);
    expect(res.body.handle).toBe(full(getAdminHandle()));
    // ...and that name resolves to it here, like any other account's.
    const resolved = await xrpcGet('com.atproto.identity.resolveHandle', { handle: res.body.handle });
    expect(resolved.body.did).toBe(res.body.did);
  });

  it('session endpoints give the handle in the DID document', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const inDidDoc = await plcHandle(user.did);
    expect(inDidDoc).toBe(full(user.handle));

    const created = await xrpcPost('com.atproto.server.createSession', { identifier: user.handle, password: 'TestPassword123!' });
    expect(created.body.handle).toBe(inDidDoc);
    const session = await xrpcAuthGet('com.atproto.server.getSession', created.body.accessJwt);
    expect(session.body.handle).toBe(inDidDoc);
    const refreshed = await api.post('/xrpc/com.atproto.server.refreshSession').set('Authorization', `Bearer ${created.body.refreshJwt}`);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.handle).toBe(inDidDoc);
  });

  it('registration answers with the full handle, and accepts it as input', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const invite = await xrpcAuthPost('net.openfederation.invite.create', adminToken, { maxUses: 1 });
    const name = uniqueHandle('fullreg');
    const reg = await xrpcPost('net.openfederation.account.register', {
      handle: full(name).toUpperCase(), email: `${name}@test.local`, password: 'TestPassword123!', inviteCode: invite.body.code,
    });
    expect(reg.status).toBe(201);
    expect(reg.body.handle).toBe(full(name));
    expect(await plcHandle(reg.body.did)).toBe(full(name));

    // Pending: an admin finds it by its full handle, sees it in full, and approves it by it.
    const pending = await xrpcAuthGet('net.openfederation.account.list', adminToken, { status: 'pending', q: full(name) });
    expect(pending.body.users.map((u: { handle: string }) => u.handle)).toEqual([full(name)]);
    const approved = await xrpcAuthPost('net.openfederation.account.approve', adminToken, { handle: full(name) });
    expect(approved.status).toBe(200);
    expect(approved.body.handle).toBe(full(name));
  });

  it('a handle under another domain is not taken for this server\'s name', async () => {
    const res = await xrpcPost('net.openfederation.account.register', {
      handle: 'someone.other-server.example', email: 'someone@test.local', password: 'TestPassword123!',
    });
    expect(res.status).toBe(400);
  });

  it('repository, profile and admin listings give the full handle', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const repo = await xrpcGet('com.atproto.repo.describeRepo', { repo: user.did });
    expect(repo.body.handle).toBe(full(user.handle));
    const profile = await xrpcGet('net.openfederation.account.getProfile', { did: user.did });
    expect(profile.body.handle).toBe(full(user.handle));

    // Searching by the full handle finds the stored short name.
    const list = await xrpcAuthGet('net.openfederation.account.list', adminToken, { q: full(user.handle) });
    expect(list.status).toBe(200);
    expect(list.body.users.map((u: { handle: string }) => u.handle)).toEqual([full(user.handle)]);
  });

  it('communities and their members are named in full; the community\'s matches its DID document', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const name = uniqueHandle('fullc');
    const created = await xrpcAuthPost('net.openfederation.community.create', user.accessJwt, {
      handle: name, didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    expect(created.status).toBe(201);
    expect(created.body.handle).toBe(full(name));
    expect(await plcHandle(created.body.did)).toBe(full(name));

    const got = await xrpcAuthGet('net.openfederation.community.get', user.accessJwt, { did: created.body.did });
    expect(got.body.handle).toBe(full(name));
    expect(got.body.displayName).toBe(name);
    const mine = await xrpcAuthGet('net.openfederation.community.listMine', user.accessJwt);
    expect(mine.body.communities.find((c: { did: string }) => c.did === created.body.did)?.handle).toBe(full(name));
    // Discovery: the local directory entries, and a search by the short name still finds it.
    const found = await xrpcGet('net.openfederation.community.discover', { q: name });
    expect(found.body.communities.find((c: { did: string }) => c.did === created.body.did)?.handle).toBe(full(name));
    const members = await xrpcAuthGet('net.openfederation.community.listMembers', user.accessJwt, { did: created.body.did });
    expect(members.body.members.find((m: { did: string }) => m.did === user.did)?.handle).toBe(full(user.handle));

    const directory = await api.get('/.well-known/openfederation-communities.json');
    if (directory.status === 200) {
      const entry = directory.body.communities.find((c: { did: string }) => c.did === created.body.did);
      if (entry) expect(entry.handle).toBe(full(name));
    }
  });

  it('webfinger takes the full handle too', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const res = await api.get('/.well-known/webfinger').query({ resource: `acct:${full(user.handle)}@${config.pds.hostname}` });
    expect(res.status).toBe(200);
  });

  it('a pen name\'s session gives its full handle, the one in its DID document', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const pdsUrl = `http://127.0.0.1:${(testServer.address() as AddressInfo).port}`;
    const keys = await fetchTokenKeys(pdsUrl);
    const [token] = await collectTokens({ pdsUrl, accessJwt: user.accessJwt, keys, count: runtimeSettings().pseudonym.tokensPerEpoch });
    const handle = full(uniqueHandle('fullpen'));
    const p = await createPseudonym({
      pdsUrl, plcUrl: config.plc.directoryUrl, pdsServiceUrl: config.pds.serviceUrl, handle, ownerDid: user.did, token,
    });
    expect(p.handle).toBe(handle);
    const session = await loginWithPhrase({ pdsUrl, phrase: p.phrase, expectedServiceDid: config.pds.serviceDid });
    expect(session.handle).toBe(handle);
    expect(await plcHandle(p.did)).toBe(handle);
  });

  // Last: a role change ends the user's sessions.
  it('a role change names the account in full', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const roles = await xrpcAuthPost('net.openfederation.account.updateRoles', adminToken, { did: user.did, addRoles: ['auditor'] });
    expect(roles.body.handle).toBe(full(user.handle));
  });
});
