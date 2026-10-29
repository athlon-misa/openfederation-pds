/**
 * A community arriving on this PDS (#267, ADR-002), with its old home
 * played by a small HTTP stub: the gate, the proof, the pull and rebuild,
 * activation once the DID points here, and the attestation keys sealed to
 * this PDS's new signing key.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Secp256k1Keypair } from '@atproto/crypto';
import { api, xrpcGet, isPLCAvailable } from './helpers.js';
import { config } from '../../src/config.js';
import { query } from '../../src/db/client.js';
import { registerDidPlc } from '../../src/identity/plc-client.js';
import { signServiceAuthJwt } from '../../src/auth/service-auth.js';
import { currentPlcState } from '../../src/identity/account-migration.js';
import { encryptToDidKey } from '../../src/crypto/ecies.js';
import { unwrapDEK } from '../../src/attestation/encryption.js';
import { buildMoveOp, signPlcOp } from '../../packages/openfederation-pseudonym/src/index.js';
import { exportedRepo, userElsewhere } from './migration-helpers.js';
import { uniqueHandle } from './helpers.js';
import { signCommunityProof } from '../e2e/community-move.js';

const original = { ...config.migration };
const MEMBER = 'net.openfederation.community.member';
const ATTESTATION = 'net.openfederation.community.attestation';

/** A community that lives (on paper) at the stub, with one member and one private attestation. */
async function communityElsewhere(stubUrl: string, memberDid: string) {
  const [oldKey, ownerPrimary, oldRecovery] = await Promise.all([
    Secp256k1Keypair.create({ exportable: true }), Secp256k1Keypair.create({ exportable: true }), Secp256k1Keypair.create({ exportable: true }),
  ]);
  const handle = `${uniqueHandle('oldcomm')}.old-pds.example.test`;
  const did = await registerDidPlc({ signingKey: oldKey, rotationKeys: [ownerPrimary, oldRecovery], handle, pdsEndpoint: stubUrl });
  const dek = crypto.randomBytes(32);
  const car = await exportedRepo(did, oldKey, [
    { collection: 'net.openfederation.community.profile', rkey: 'self', record: { displayName: 'Old Comm', description: '', createdAt: new Date().toISOString() } },
    { collection: MEMBER, rkey: '3kmember00001', record: { did: memberDid, handle: 'member', joinedAt: new Date().toISOString() } },
    { collection: ATTESTATION, rkey: '3katt0000001', record: {
      subjectDid: memberDid, subjectHandle: 'member', type: 'credential', visibility: 'private',
      claim: { encrypted: true, ciphertext: 'AA==', iv: 'AA==', authTag: 'AA==' }, commitment: 'c'.repeat(64), issuedAt: new Date().toISOString(),
    } },
  ]);
  return { did, handle, oldKey, ownerPrimary, dek, car };
}

describe('community migration (this PDS as the new home)', () => {
  let plc = false;
  let stub: http.Server;
  let stubUrl: string;
  const repos = new Map<string, Uint8Array>();
  const deks = new Map<string, Buffer>();

  beforeAll(async () => {
    plc = await isPLCAvailable();
    stub = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://stub');
      const did = url.searchParams.get('did') ?? '';
      if (url.pathname === '/xrpc/com.atproto.sync.getRepo' && repos.has(did)) {
        res.writeHead(200, { 'Content-Type': 'application/vnd.ipld.car' }); res.end(Buffer.from(repos.get(did)!)); return;
      }
      if (url.pathname === '/xrpc/com.atproto.sync.listBlobs') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ cids: [] })); return; }
      if (url.pathname === '/xrpc/net.openfederation.community.getMovedKeys' && deks.has(did)) {
        // Sealed to whatever signing key the DID names now, as the real old PDS does.
        const state = await currentPlcState(did);
        const payload = JSON.stringify({ did, keys: [{
          rkey: '3katt0000001', visibility: 'private', dekIssuer: deks.get(did)!.toString('base64'), dekSubject: deks.get(did)!.toString('base64'),
          commitmentHash: 'c'.repeat(64), commitmentSalt: 's'.repeat(64), issuerSignature: null, schemaHash: null, accessPolicy: null,
        }] });
        const sealed = encryptToDidKey(state!.verificationMethods.atproto, Buffer.from(payload)).toString('base64');
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ did, recipient: state!.verificationMethods.atproto, count: 1, sealed })); return;
      }
      res.writeHead(404); res.end('{}');
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
    stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => stub.close(() => r())));
  afterEach(() => { Object.assign(config.migration, original); });

  const migrateIn = (body: Record<string, unknown>, jwt?: string) => {
    const r = api.post('/xrpc/net.openfederation.community.migrateIn').send(body).set('Content-Type', 'application/json');
    return jwt ? r.set('Authorization', `Bearer ${jwt}`) : r;
  };
  const proofFor = async (c: { did: string; ownerPrimary: Secp256k1Keypair }, ownerDid: string) => signCommunityProof({
    primaryRotationKeyBase64: Buffer.from(await c.ownerPrimary.export()).toString('base64'),
    did: c.did, ownerDid, aud: config.pds.serviceDid, lxm: 'net.openfederation.community.migrateIn',
  });

  it('refuses at the gate or without a rotation-key proof, before anything is stored', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const owner = await userElsewhere();
    const c = await communityElsewhere(stubUrl, owner.did);
    repos.set(c.did, c.car);

    config.migration.communities = 'closed';
    const closed = await migrateIn({ did: c.did, handle: uniqueHandle('mv') }, await proofFor(c, owner.did));
    expect(closed.status).toBe(403);
    expect(closed.body.error).toBe('MigrationNotAllowed');

    config.migration.communities = 'invite';
    const noInvite = await migrateIn({ did: c.did, handle: uniqueHandle('mv') }, await proofFor(c, owner.did));
    expect(noInvite.status).toBe(400);
    expect(noInvite.body.error).toBe('InvalidInviteCode');

    config.migration.communities = 'open';
    const noProof = await migrateIn({ did: c.did, handle: uniqueHandle('mv') });
    expect(noProof.status).toBe(401);
    const stranger = await Secp256k1Keypair.create();
    const wrongKey = await migrateIn({ did: c.did, handle: uniqueHandle('mv') }, await signServiceAuthJwt({
      keypair: stranger, iss: c.did, aud: config.pds.serviceDid, exp: Math.floor(Date.now() / 1000) + 60,
      lxm: 'net.openfederation.community.migrateIn', extraClaims: { sub: owner.did },
    }));
    expect(wrongKey.status).toBe(401);
    expect(wrongKey.body.error).toBe('InvalidToken');
    expect((await query('SELECT 1 FROM communities WHERE did = $1', [c.did])).rows).toHaveLength(0);
  });

  it('pulls the community, rebuilds its indexes, activates once the DID points here, and receives the keys', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    config.migration.communities = 'open';
    const owner = await userElsewhere();
    const c = await communityElsewhere(stubUrl, owner.did);
    repos.set(c.did, c.car); deks.set(c.did, c.dek);
    const label = uniqueHandle('arrived');

    const opened = await migrateIn({ did: c.did, handle: label }, await proofFor(c, owner.did));
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({ did: c.did, status: 'importing', fromPds: stubUrl, indexedRecords: 3, members: 1, attestations: 1, expectedBlobs: 0 });
    expect(opened.body.recommended.rotationKeys).toEqual([c.ownerPrimary.did(), expect.stringMatching(/^did:key:zQ3s/)]);
    expect(opened.body.recommended.services.atproto_pds.endpoint).toBe(config.pds.serviceUrl);

    const row = (await query<{ status: string; owner_did: string; from_pds: string }>('SELECT status, owner_did, from_pds FROM communities WHERE did = $1', [c.did])).rows[0];
    expect(row).toEqual({ status: 'importing', owner_did: owner.did, from_pds: stubUrl });
    expect((await query('SELECT 1 FROM members_unique WHERE community_did = $1 AND member_did = $2', [c.did, owner.did])).rows).toHaveLength(1);
    expect((await query('SELECT 1 FROM community_attestation_index WHERE community_did = $1', [c.did])).rows).toHaveLength(1);

    const check = await xrpcGet('net.openfederation.community.checkMigration', { did: c.did });
    expect(check.body).toMatchObject({ status: 'importing', validDid: false, repoCommit: opened.body.repoCommit, members: 1, attestations: 1, missingAttestationKeys: 1 });

    // Not yet: the DID still points at the stub. Writes are refused meanwhile.
    const ownerAuth = (lxm: string) => signServiceAuthJwt({ keypair: owner.signingKey, iss: owner.did, aud: config.pds.serviceDid, exp: Math.floor(Date.now() / 1000) + 60, lxm });
    const early = await api.post('/xrpc/net.openfederation.community.activate').set('Authorization', `Bearer ${await ownerAuth('net.openfederation.community.activate')}`).send({ did: c.did });
    expect(early.status).toBe(400);
    expect(early.body.error).toBe('IncompatibleDidDoc');
    const importing = await api.post('/xrpc/net.openfederation.community.update').set('Authorization', `Bearer ${await ownerAuth('net.openfederation.community.update')}`).send({ did: c.did, description: 'x' });
    expect(importing.body.error).toBe('CommunityImporting');

    // The owner points the DID here with the recommended credentials.
    const r = check.body.recommended;
    const log = await (await fetch(`${config.plc.directoryUrl}/${c.did}/log`)).json();
    const op = signPlcOp(buildMoveOp({
      previous: log[log.length - 1], rotationKeys: r.rotationKeys, signingDidKey: r.verificationMethods.atproto,
      pdsEndpoint: r.services.atproto_pds.endpoint, handle: r.alsoKnownAs[0].slice('at://'.length),
    }), await c.ownerPrimary.export());
    expect((await fetch(`${config.plc.directoryUrl}/${c.did}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(op) })).ok).toBe(true);

    const activated = await api.post('/xrpc/net.openfederation.community.activate').set('Authorization', `Bearer ${await ownerAuth('net.openfederation.community.activate')}`).send({ did: c.did });
    expect(activated.status).toBe(200);
    expect(activated.body).toMatchObject({ status: 'active', keysImported: 1, missingAttestationKeys: 0 });
    const enc = (await query<{ encrypted_dek_issuer: string; commitment_salt: string }>('SELECT encrypted_dek_issuer, commitment_salt FROM attestation_encryption WHERE community_did = $1', [c.did])).rows[0];
    expect((await unwrapDEK(enc.encrypted_dek_issuer)).equals(c.dek)).toBe(true);
    expect(enc.commitment_salt).toBe('s'.repeat(64));

    // Live here now, owned by a DID on another PDS.
    expect((await xrpcGet('net.openfederation.community.get', { did: c.did })).body.status).toBe('active');
    const updated = await api.post('/xrpc/net.openfederation.community.update').set('Authorization', `Bearer ${await ownerAuth('net.openfederation.community.update')}`).send({ did: c.did, description: 'Arrived' });
    expect(updated.status).toBe(200);
    const again = await migrateIn({ did: c.did, handle: label }, await proofFor(c, owner.did));
    expect(again.status).toBe(400); // the DID points here: nothing to pull from
    expect(again.body.error).toBe('IncompatibleDidDoc');
  });
});
