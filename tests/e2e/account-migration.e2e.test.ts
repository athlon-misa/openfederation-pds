/**
 * E2E: moving a pseudonym between two PDSes sharing one PLC directory.
 * PDS A is the in-process test server; PDS B is a second process
 * (second-pds.ts). Later migration slices extend this file.
 */
import type { AddressInfo } from 'node:net';
import { isPLCAvailable, createTestUser, uniqueHandle, testServer, xrpcGet } from './helpers.js';
import { startSecondPds, type SecondPds } from './second-pds.js';
import { config } from '../../src/config.js';
import {
  fetchTokenKeys, collectTokens, createPseudonym, loginWithPhrase, openAccountForMove,
} from '../../packages/openfederation-pseudonym/src/index.js';

let plc = false;
let pdsA: string;
let pdsB: SecondPds | null = null;

beforeAll(async () => {
  plc = await isPLCAvailable();
  pdsA = `http://127.0.0.1:${(testServer.address() as AddressInfo).port}`;
  if (plc) pdsB = await startSecondPds();
}, 150_000);

afterAll(async () => {
  await pdsB?.stop();
});

async function get(base: string, nsid: string, jwt: string) {
  const res = await fetch(`${base}/xrpc/${nsid}`, { headers: { Authorization: `Bearer ${jwt}` } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('account migration', () => {
  it('opens a deactivated account for a pseudonym on the new PDS; the old home keeps working', async (ctx) => {
    if (!plc || !pdsB) ctx.skip('PLC directory not available');
    const owner = await createTestUser(uniqueHandle('mig-owner'));
    const keys = await fetchTokenKeys(pdsA);
    const [token] = await collectTokens({ pdsUrl: pdsA, accessJwt: owner.accessJwt, keys, count: config.pseudonym.tokensPerEpoch });
    const pseudonym = await createPseudonym({
      pdsUrl: pdsA, plcUrl: config.plc.directoryUrl, pdsServiceUrl: config.pds.serviceUrl,
      handle: `${uniqueHandle('mover')}${config.handleSuffix}`, ownerDid: owner.did, token,
    });

    const label = pseudonym.handle.slice(0, -config.handleSuffix.length);
    const opened = await openAccountForMove({
      newPdsUrl: pdsB!.url, newServiceDid: pdsB!.serviceDid, phrase: pseudonym.phrase,
      did: pseudonym.did, handle: `${label}${pdsB!.handleSuffix}`,
    });
    expect(opened.did).toBe(pseudonym.did);

    // B: deactivated, empty repo, and the DID does not point at B yet.
    const status = await get(pdsB!.url, 'com.atproto.server.checkAccountStatus', opened.accessJwt);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ activated: false, validDid: false, indexedRecords: 0 });

    // Opening it twice is refused.
    await expect(openAccountForMove({
      newPdsUrl: pdsB!.url, newServiceDid: pdsB!.serviceDid, phrase: pseudonym.phrase,
      did: pseudonym.did, handle: `${label}-2${pdsB!.handleSuffix}`,
    })).rejects.toThrow(/AlreadyExists/);

    // A: nothing changed for readers or for the owner.
    const described = await xrpcGet('com.atproto.repo.describeRepo', { repo: pseudonym.did });
    expect(described.status).toBe(200);
    const session = await loginWithPhrase({ pdsUrl: pdsA, phrase: pseudonym.phrase, expectedServiceDid: config.pds.serviceDid });
    expect(session.did).toBe(pseudonym.did);
  });
});
