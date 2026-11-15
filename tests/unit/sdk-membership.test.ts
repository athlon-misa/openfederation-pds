/**
 * SDK client: joining and leaving communities, with the membership record
 * in the member's own repo (#385), against a fake fetch.
 *
 * On this server, the server writes the home record itself. On another PDS,
 * the SDK joins there with a service-auth token from home, then writes the
 * record at home; leaving deletes it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenFederationClient } from '../../packages/openfederation-sdk/src/client.js';
import { TokenManager } from '../../packages/openfederation-sdk/src/auth.js';
import { MEMBERSHIP_COLLECTION } from '../../packages/openfederation-sdk/src/index.js';

const HOME = 'https://home.example';
const REMOTE = 'https://remote.example';
const COMMUNITY = 'did:plc:communityxxxxxxxxxxxxxxxx';
const user = { did: 'did:plc:viewerxxxxxxxxxxxxxxxxxxx', handle: 'viewer.home.example', email: '', active: true };

function jwt(expInSec: number): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + expInSec })}.sig`;
}

type Call = { method: string; url: URL; auth: string | null; body?: any };

function fakeFetch(respond: (c: Call) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? 'GET',
      url,
      auth: new Headers(init?.headers).get('authorization'),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return respond(call);
  }));
  return calls;
}

function client(): OpenFederationClient {
  const c = new OpenFederationClient({ serverUrl: HOME, partnerKey: 'pk', storage: 'memory', autoRefresh: false });
  (c as unknown as { tokens: TokenManager }).tokens.setTokens(jwt(900), 'refresh-0', user);
  return c;
}

const path = (c: Call) => `${c.method} ${c.url.origin}${c.url.pathname}`;
const homeRecord = (written: boolean) => ({
  uri: `at://${user.did}/${MEMBERSHIP_COLLECTION}/${COMMUNITY}`,
  collection: MEMBERSHIP_COLLECTION,
  rkey: COMMUNITY,
  record: { $type: MEMBERSHIP_COLLECTION, community: COMMUNITY, createdAt: '2026-11-15T00:00:00.000Z' },
  written,
});

afterEach(() => vi.unstubAllGlobals());

describe('SDK joinCommunity / leaveCommunity', () => {
  it('on the home server: one join call; the server wrote the record', async () => {
    const calls = fakeFetch(() => Response.json({ status: 'joined', homeRecord: homeRecord(true) }));
    const result = await client().joinCommunity({ did: COMMUNITY });
    expect(calls.map(path)).toEqual([`POST ${HOME}/xrpc/net.openfederation.community.join`]);
    expect(calls[0].body).toEqual({ did: COMMUNITY });
    expect(result).toEqual({ status: 'joined', homeRecord: { uri: homeRecord(true).uri, written: true } });
  });

  it('on another PDS: joins there with a service-auth token, then writes the record at home', async () => {
    const calls = fakeFetch((c) => {
      const p = path(c);
      if (p === `GET ${REMOTE}/xrpc/com.atproto.server.describeServer`) return Response.json({ did: 'did:web:remote.example' });
      if (p === `GET ${HOME}/xrpc/com.atproto.server.getServiceAuth`) return Response.json({ token: 'svc-token' });
      if (p === `POST ${REMOTE}/xrpc/net.openfederation.community.join`) {
        return Response.json({ status: 'joined', homeRecord: { ...homeRecord(false) } });
      }
      if (p === `POST ${HOME}/xrpc/com.atproto.repo.putRecord`) return Response.json({ uri: homeRecord(false).uri, cid: 'bafy' });
      return new Response('unexpected', { status: 500 });
    });

    const result = await client().joinCommunity({ did: COMMUNITY, pdsUrl: `${REMOTE}/`, kind: 'fan' });
    expect(calls.map(path)).toEqual([
      `GET ${REMOTE}/xrpc/com.atproto.server.describeServer`,
      `GET ${HOME}/xrpc/com.atproto.server.getServiceAuth`,
      `POST ${REMOTE}/xrpc/net.openfederation.community.join`,
      `POST ${HOME}/xrpc/com.atproto.repo.putRecord`,
    ]);
    expect(calls[1].url.searchParams.get('aud')).toBe('did:web:remote.example');
    expect(calls[1].url.searchParams.get('lxm')).toBe('net.openfederation.community.join');
    expect(calls[2].auth).toBe('Bearer svc-token');
    expect(calls[2].body).toEqual({ did: COMMUNITY, kind: 'fan' });
    expect(calls[3].body).toEqual({
      repo: user.did, collection: MEMBERSHIP_COLLECTION, rkey: COMMUNITY,
      record: homeRecord(false).record,
    });
    expect(result).toEqual({ status: 'joined', homeRecord: { uri: homeRecord(false).uri, written: true } });
  });

  it('writes nothing at home for a pending request or a private community', async () => {
    for (const answer of [{ status: 'pending' }, { status: 'joined' }]) {
      const calls = fakeFetch((c) => {
        const p = path(c);
        if (p.endsWith('describeServer')) return Response.json({ did: 'did:web:remote.example' });
        if (p.endsWith('getServiceAuth')) return Response.json({ token: 't' });
        return Response.json(answer);
      });
      const result = await client().joinCommunity({ did: COMMUNITY, pdsUrl: REMOTE });
      expect(calls.some((c) => c.url.pathname.endsWith('putRecord'))).toBe(false);
      expect(result.homeRecord).toBeNull();
      vi.unstubAllGlobals();
    }
  });

  it('a home write that fails does not undo the join: it is reported', async () => {
    fakeFetch((c) => {
      const p = path(c);
      if (p.endsWith('describeServer')) return Response.json({ did: 'did:web:remote.example' });
      if (p.endsWith('getServiceAuth')) return Response.json({ token: 't' });
      if (p.endsWith('putRecord')) return Response.json({ error: 'DeviceSigningRequired', message: 'device' }, { status: 403 });
      return Response.json({ status: 'joined', homeRecord: homeRecord(false) });
    });
    const result = await client().joinCommunity({ did: COMMUNITY, pdsUrl: REMOTE });
    expect(result.status).toBe('joined');
    expect(result.homeRecord).toMatchObject({ uri: homeRecord(false).uri, written: false });
    expect(result.homeRecord?.error).toBeTruthy();
  });

  it('leaving another PDS\'s community deletes the home record when there is one', async () => {
    const calls = fakeFetch((c) => {
      const p = path(c);
      if (p.endsWith('describeServer')) return Response.json({ did: 'did:web:remote.example' });
      if (p.endsWith('getServiceAuth')) return Response.json({ token: 'svc-leave' });
      if (p === `POST ${REMOTE}/xrpc/net.openfederation.community.leave`) return Response.json({ success: true });
      if (p === `GET ${HOME}/xrpc/com.atproto.repo.getRecord`) return Response.json({ uri: homeRecord(true).uri, value: homeRecord(true).record });
      if (p === `POST ${HOME}/xrpc/com.atproto.repo.deleteRecord`) return Response.json({});
      return new Response('unexpected', { status: 500 });
    });
    const result = await client().leaveCommunity({ did: COMMUNITY, pdsUrl: REMOTE });
    expect(calls.map(path)).toEqual([
      `GET ${REMOTE}/xrpc/com.atproto.server.describeServer`,
      `GET ${HOME}/xrpc/com.atproto.server.getServiceAuth`,
      `POST ${REMOTE}/xrpc/net.openfederation.community.leave`,
      `GET ${HOME}/xrpc/com.atproto.repo.getRecord`,
      `POST ${HOME}/xrpc/com.atproto.repo.deleteRecord`,
    ]);
    expect(calls[1].url.searchParams.get('lxm')).toBe('net.openfederation.community.leave');
    expect(calls[2].auth).toBe('Bearer svc-leave');
    expect(calls[4].body).toEqual({ repo: user.did, collection: MEMBERSHIP_COLLECTION, rkey: COMMUNITY });
    expect(result).toEqual({ success: true, homeRecordDeleted: true });
  });

  it('leaving with no home record deletes nothing; on the home server the server does it', async () => {
    let calls = fakeFetch((c) => {
      const p = path(c);
      if (p.endsWith('describeServer')) return Response.json({ did: 'did:web:remote.example' });
      if (p.endsWith('getServiceAuth')) return Response.json({ token: 't' });
      if (p.endsWith('getRecord')) return Response.json({ error: 'RecordNotFound' }, { status: 404 });
      return Response.json({ success: true });
    });
    expect(await client().leaveCommunity({ did: COMMUNITY, pdsUrl: REMOTE })).toEqual({ success: true, homeRecordDeleted: false });
    expect(calls.some((c) => c.url.pathname.endsWith('deleteRecord'))).toBe(false);
    vi.unstubAllGlobals();

    calls = fakeFetch(() => Response.json({ success: true, homeRecord: { collection: MEMBERSHIP_COLLECTION, rkey: COMMUNITY, deleted: true } }));
    expect(await client().leaveCommunity({ did: COMMUNITY })).toEqual({ success: true, homeRecordDeleted: true });
    expect(calls.map(path)).toEqual([`POST ${HOME}/xrpc/net.openfederation.community.leave`]);
  });
});
