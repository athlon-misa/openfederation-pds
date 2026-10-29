/**
 * Account migration, first step (#261): the new PDS opens a deactivated
 * account for a pseudonym DID that lives on another PDS. The owner proves
 * control with a JWT signed by the DID's rotation key (the owner key).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Secp256k1Keypair } from '@atproto/crypto';
import { api, xrpcAuthGet, xrpcPost, isPLCAvailable, uniqueHandle } from './helpers.js';
import { config } from '../../src/config.js';
import { query } from '../../src/db/client.js';
import { getKeypairForDid } from '../../src/repo/keypair-utils.js';
import { registerDidPlc } from '../../src/identity/plc-client.js';
import { generatePseudonymPhrase, signOwnerJwt } from '../../packages/openfederation-pseudonym/src/index.js';
import { CREATE_ACCOUNT, OLD_PDS, pseudonymElsewhere, newHandle, proofFor, createAccount } from './migration-helpers.js';

const NSID = CREATE_ACCOUNT;

describe('com.atproto.server.createAccount (account migration)', () => {
  let plc = false;
  beforeAll(async () => { plc = await isPLCAvailable(); });

  it('opens a deactivated account with the key reserved for the DID', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const { did, phrase } = await pseudonymElsewhere();
    const reserved = await xrpcPost('com.atproto.server.reserveSigningKey', { did });
    expect(reserved.status).toBe(200);

    const handle = newHandle();
    const res = await createAccount({ did, handle }, proofFor({ phrase, did }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ did, handle });
    expect(typeof res.body.accessJwt).toBe('string');

    const row = (await query<{ status: string; migrating_in: boolean; auth_type: string; email: string | null }>(
      'SELECT status, migrating_in, auth_type, email FROM users WHERE did = $1', [did])).rows[0];
    expect(row).toEqual({ status: 'deactivated', migrating_in: true, auth_type: 'pseudonym', email: null });
    expect((await getKeypairForDid(did)).did()).toBe(reserved.body.signingKey);

    const status = await xrpcAuthGet('com.atproto.server.checkAccountStatus', res.body.accessJwt);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      activated: false, validDid: false, indexedRecords: 0, privateStateValues: 0, expectedBlobs: 0, importedBlobs: 0,
    });
    expect(status.body.repoBlocks).toBeGreaterThan(0);
    expect(typeof status.body.repoCommit).toBe('string');

    // Pseudonyms are never audited, on arrival either.
    const audits = await query('SELECT 1 FROM audit_log WHERE actor_id = $1 OR target_id = $2',
      [(await query<{ id: string }>('SELECT id FROM users WHERE did = $1', [did])).rows[0].id, did]);
    expect(audits.rows).toHaveLength(0);
  });

  it('refuses a token signed by a key that is not a rotation key', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const { did } = await pseudonymElsewhere();
    const stranger = generatePseudonymPhrase();
    const res = await createAccount({ did, handle: newHandle() }, proofFor({ phrase: stranger, did }));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('InvalidToken');
  });

  it('refuses a token for another DID, another service, or another method', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const a = await pseudonymElsewhere();
    const b = await pseudonymElsewhere();
    const otherDid = await createAccount({ did: a.did, handle: newHandle() }, proofFor({ phrase: b.phrase, did: b.did }));
    expect(otherDid.status).toBe(401);
    const otherAud = await createAccount({ did: a.did, handle: newHandle() },
      proofFor({ phrase: a.phrase, did: a.did, aud: 'did:web:other-pds.example.test' }));
    expect(otherAud.status).toBe(401);
    const otherLxm = await createAccount({ did: a.did, handle: newHandle() },
      proofFor({ phrase: a.phrase, did: a.did, lxm: 'com.atproto.repo.createRecord' }));
    expect(otherLxm.status).toBe(401);
    const longLived = await createAccount({ did: a.did, handle: newHandle() },
      signOwnerJwt({ phrase: a.phrase, did: a.did, aud: config.pds.serviceDid, lxm: NSID, ttlSeconds: 3600 }));
    expect(longLived.status).toBe(401);
    for (const r of [otherDid, otherAud, otherLxm, longLived]) expect(r.body.error).toBe('InvalidToken');
  });

  it('refuses a replayed token and a DID that already has an account here', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const { did, phrase } = await pseudonymElsewhere();
    const proof = proofFor({ phrase, did });
    expect((await createAccount({ did, handle: newHandle() }, proof)).status).toBe(200);

    const replay = await createAccount({ did, handle: newHandle() }, proof);
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe('InvalidToken');

    const again = await createAccount({ did, handle: newHandle() }, proofFor({ phrase, did }));
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('AlreadyExists');
  });

  it('refuses a taken handle, a handle under another domain, and a missing token', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const first = await pseudonymElsewhere();
    const handle = newHandle();
    expect((await createAccount({ did: first.did, handle }, proofFor(first))).status).toBe(200);

    const second = await pseudonymElsewhere();
    const taken = await createAccount({ did: second.did, handle }, proofFor(second));
    expect(taken.status).toBe(400);
    expect(taken.body.error).toBe('HandleNotAvailable');

    const domain = await createAccount({ did: second.did, handle: 'someone.elsewhere.example' }, proofFor(second));
    expect(domain.status).toBe(400);
    expect(domain.body.error).toBe('UnsupportedDomain');

    const missing = await createAccount({ did: second.did, handle: newHandle() });
    expect(missing.status).toBe(401);
    expect(missing.body.error).toBe('AuthRequired');
  });

  it('only imports DIDs: without one it points to account.register', async () => {
    const res = await createAccount({ handle: newHandle() });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidRequest');
  });

  it('refuses a DID that is not a pseudonym (until custodial moves arrive)', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    // An ordinary custodial-shaped DID: two rotation keys, no commitment.
    const did = await registerDidPlc({
      signingKey: await Secp256k1Keypair.create(),
      rotationKeys: [await Secp256k1Keypair.create(), await Secp256k1Keypair.create()],
      handle: `${uniqueHandle('plain')}.old-pds.example.test`,
      pdsEndpoint: OLD_PDS,
    });
    const res = await createAccount({ did, handle: newHandle() }, proofFor({ phrase: generatePseudonymPhrase(), did }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('IncompatibleDidDoc');
  });

  it('checkAccountStatus requires a session', async () => {
    const res = await api.get('/xrpc/com.atproto.server.checkAccountStatus');
    expect(res.status).toBe(401);
  });
});
