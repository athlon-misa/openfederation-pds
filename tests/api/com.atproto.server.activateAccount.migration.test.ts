/**
 * Account migration, last step (#263): an account that moved here is
 * activated once its DID names this PDS and this PDS's signing key.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { xrpcAuthGet, xrpcAuthPost, isPLCAvailable, testServer } from './helpers.js';
import { config } from '../../src/config.js';
import { query } from '../../src/db/client.js';
import { buildMoveOp, signPlcOp, derivePseudonymKeys, loginWithPhrase } from '../../packages/openfederation-pseudonym/src/index.js';
import { pseudonymElsewhere, openHere, exportedRepo, importRepo, type PseudonymElsewhere } from './migration-helpers.js';

/** The owner key signs a PLC update naming what this PDS recommends. */
async function pointHere(p: PseudonymElsewhere, accessJwt: string): Promise<void> {
  const creds = await xrpcAuthGet('com.atproto.identity.getRecommendedDidCredentials', accessJwt);
  const log = await (await fetch(`${config.plc.directoryUrl}/${p.did}/log`)).json();
  const op = signPlcOp(buildMoveOp({
    previous: log[log.length - 1],
    signingDidKey: creds.body.verificationMethods.atproto,
    pdsEndpoint: creds.body.services.atproto_pds.endpoint,
    handle: creds.body.alsoKnownAs[0].slice('at://'.length),
  }), derivePseudonymKeys(p.phrase).ownerPrivateKey);
  const res = await fetch(`${config.plc.directoryUrl}/${p.did}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(op),
  });
  if (!res.ok) throw new Error(`PLC refused the update: ${res.status} ${await res.text()}`);
}

describe('com.atproto.server.activateAccount (account migration)', () => {
  let plc = false;
  let pdsUrl: string;
  beforeAll(async () => {
    plc = await isPLCAvailable();
    pdsUrl = `http://127.0.0.1:${(testServer.address() as AddressInfo).port}`;
  });

  it('recommends this PDS, its signing key and the handle here', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const p = await pseudonymElsewhere();
    const { accessJwt, handle } = await openHere(p);
    const creds = await xrpcAuthGet('com.atproto.identity.getRecommendedDidCredentials', accessJwt);
    expect(creds.status).toBe(200);
    const key = (await query<{ n: number }>('SELECT 1 AS n FROM user_signing_keys WHERE user_did = $1', [p.did])).rows;
    expect(key).toHaveLength(1);
    expect(creds.body).toMatchObject({
      alsoKnownAs: [`at://${handle}`],
      services: { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: config.pds.serviceUrl } },
    });
    expect(creds.body.verificationMethods.atproto).toMatch(/^did:key:z/);
    expect(creds.body.rotationKeys).toBeUndefined();
  });

  it('refuses to activate while the DID still points elsewhere', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const p = await pseudonymElsewhere();
    const { accessJwt } = await openHere(p);
    const res = await xrpcAuthPost('com.atproto.server.activateAccount', accessJwt, {});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('IncompatibleDidDoc');
  });

  it('activates once the DID points here; the owner logs in with the phrase and publishes', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const p = await pseudonymElsewhere();
    const { accessJwt } = await openHere(p);
    expect((await importRepo(await exportedRepo(p.did, p.oldKey, [
      { collection: 'app.bsky.actor.profile', rkey: 'self', record: { $type: 'app.bsky.actor.profile', displayName: 'Mover' } },
    ]), accessJwt)).status).toBe(200);

    await pointHere(p, accessJwt);
    const before = await xrpcAuthGet('com.atproto.server.checkAccountStatus', accessJwt);
    expect(before.body).toMatchObject({ activated: false, validDid: true });

    const activated = await xrpcAuthPost('com.atproto.server.activateAccount', accessJwt, {});
    expect(activated.status).toBe(200);

    const row = (await query<{ status: string; migrating_in: boolean; status_changed_at: string | null }>(
      'SELECT status, migrating_in, status_changed_at FROM users WHERE did = $1', [p.did])).rows[0];
    expect(row).toEqual({ status: 'approved', migrating_in: false, status_changed_at: null });

    // The migration session is retired with the token version; the phrase logs in.
    expect((await xrpcAuthGet('com.atproto.server.checkAccountStatus', accessJwt)).status).toBe(401);
    const session = await loginWithPhrase({ pdsUrl, phrase: p.phrase, expectedServiceDid: config.pds.serviceDid });
    const posted = await xrpcAuthPost('com.atproto.repo.createRecord', session.accessJwt, {
      repo: p.did, collection: 'net.openfederation.authorship.claim',
      record: { $type: 'net.openfederation.authorship.claim', contentHash: 'ef'.repeat(32), url: 'https://news.example/new-home', createdAt: new Date().toISOString() },
    });
    expect(posted.status).toBe(200);
  });
});
