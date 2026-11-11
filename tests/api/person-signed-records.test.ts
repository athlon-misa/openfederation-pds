/**
 * Person-signed records (ADR-003, decision 11). The PDS holds the repo key, so
 * it can write records as a user; a record that matters carries `ownerSig`,
 * a signature by the person's owner key over the record's CID (without
 * ownerSig), its DID and its collection. A forgery by the PDS becomes
 * detectable: net.openfederation.identity.verifyRecord says whether a record
 * is person-signed.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { api, xrpcGet, xrpcPost, xrpcAuthPost, getAdminToken, isPLCAvailable, uniqueHandle, createTestUser } from './helpers.js';
import { config } from '../../src/config.js';
import {
  generateCustodyPhrase, deriveCustodyKeys, buildCustodyGenesisOp, signPlcOperation, didForGenesisOp, submitPlcOperation,
  signOwnerRaw, signRecord, verifyOwnerRecord, recordCid, type CustodyKeys,
} from '../../packages/openfederation-sdk/src/custody/index.js';
import { verifyOwnerSignedRecord } from '../../src/identity/owner-record.js';

const VERIFY = 'net.openfederation.identity.verifyRecord';
const PASSWORD = 'Self-custody-pw-123!';
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

/** A `self` account (ADR-003 step 3), approved and signed in. */
async function selfAccount(): Promise<{ did: string; jwt: string; keys: CustodyKeys }> {
  const keys = deriveCustodyKeys(generateCustodyPhrase());
  const label = uniqueHandle('psr');
  const signingKey = (await xrpcPost('com.atproto.server.reserveSigningKey', {})).body.signingKey;
  const genesis = signPlcOperation(buildCustodyGenesisOp({
    mode: 'self', userRotationDidKey: keys.rotationDidKey, atprotoDidKey: signingKey, ownerDidKey: keys.ownerDidKey,
    handle: `${label}${config.handleSuffix}`, pdsEndpoint: config.pds.serviceUrl,
  }), keys.rotationPrivateKey);
  const did = didForGenesisOp(genesis);
  await submitPlcOperation(config.plc.directoryUrl, did, genesis);
  const admin = await getAdminToken();
  const invite = (await xrpcAuthPost('net.openfederation.invite.create', admin, { maxUses: 1 })).body.code;
  const reg = await xrpcPost('net.openfederation.account.registerSelfCustody', { did, mode: 'self', handle: label, email: `${label}@test.local`, password: PASSWORD, inviteCode: invite });
  expect(reg.status).toBe(201);
  await xrpcAuthPost('net.openfederation.account.approve', admin, { userId: reg.body.id });
  const jwt = (await xrpcPost('com.atproto.server.createSession', { identifier: label, password: PASSWORD })).body.accessJwt;
  return { did, jwt, keys };
}

async function write(jwt: string, repo: string, collection: string, record: Record<string, unknown>) {
  const res = await xrpcAuthPost('com.atproto.repo.createRecord', jwt, { repo, collection, record });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.uri as string;
}

describe('person-signed records', () => {
  let plc = false;
  let me: Awaited<ReturnType<typeof selfAccount>>;
  beforeAll(async () => {
    plc = await isPLCAvailable();
    if (plc) me = await selfAccount();
  });

  it('SDK: the signature binds the content, the DID and the collection', () => {
    const keys = deriveCustodyKeys(generateCustodyPhrase());
    const record = { $type: 'app.bsky.feed.post', text: 'Night Desk filed this', createdAt: '2026-11-12T10:00:00.000Z' };
    const signed = signRecord(record, { did: 'did:plc:a', collection: 'app.bsky.feed.post' }, (t) => signOwnerRaw(keys.ownerPrivateKey, t));
    expect(signed.ownerSig.cid).toBe(recordCid(record));
    const ok = { did: 'did:plc:a', collection: 'app.bsky.feed.post', ownerDidKey: keys.ownerDidKey };
    expect(verifyOwnerRecord(signed, ok)).toMatchObject({ ok: true });
    expect(verifyOwnerSignedRecord(signed, ok)).toMatchObject({ ok: true }); // the server's own check agrees
    expect(verifyOwnerRecord({ ...signed, text: 'edited' }, ok)).toMatchObject({ ok: false, reason: 'CidMismatch' });
    expect(verifyOwnerRecord(signed, { ...ok, did: 'did:plc:b' })).toMatchObject({ ok: false, reason: 'SignatureInvalid' });
    expect(verifyOwnerRecord(signed, { ...ok, collection: 'app.bsky.feed.like' })).toMatchObject({ ok: false, reason: 'SignatureInvalid' });
  });

  it('a record the person signed verifies as person-signed through the PDS', async () => {
    if (!plc) return;
    const record = { $type: 'app.bsky.feed.post', text: 'Signed by me, not my server', createdAt: new Date().toISOString() };
    const uri = await write(me.jwt, me.did, 'app.bsky.feed.post', signRecord(record, { did: me.did, collection: 'app.bsky.feed.post' }, (t) => signOwnerRaw(me.keys.ownerPrivateKey, t)));
    const res = await xrpcGet(VERIFY, { uri });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ uri, personSigned: true, ownerKey: me.keys.ownerDidKey });
  });

  it('a record with a file reference: the CID the client signed is the one the PDS recomputes', async () => {
    if (!plc) return;
    const up = await api.post('/xrpc/com.atproto.repo.uploadBlob').set('Authorization', `Bearer ${me.jwt}`).set('Content-Type', 'image/png').send(PNG);
    const record = { $type: 'app.bsky.actor.profile', displayName: 'Elena', avatar: up.body.blob };
    const uri = await write(me.jwt, me.did, 'app.bsky.actor.profile', signRecord(record, { did: me.did, collection: 'app.bsky.actor.profile' }, (t) => signOwnerRaw(me.keys.ownerPrivateKey, t)));
    expect((await xrpcGet(VERIFY, { uri })).body.personSigned).toBe(true);
  });

  it('an authorship claim declares ownerSig and verifies', async () => {
    if (!plc) return;
    const record = { $type: 'net.openfederation.authorship.claim', contentHash: 'a'.repeat(64), createdAt: new Date().toISOString() };
    const uri = await write(me.jwt, me.did, 'net.openfederation.authorship.claim', signRecord(record, { did: me.did, collection: 'net.openfederation.authorship.claim' }, (t) => signOwnerRaw(me.keys.ownerPrivateKey, t)));
    expect((await xrpcGet(VERIFY, { uri })).body.personSigned).toBe(true);
  });

  it('what the PDS writes on its own is not person-signed', async () => {
    if (!plc) return;
    // Unsigned.
    const plain = await write(me.jwt, me.did, 'app.bsky.feed.post', { $type: 'app.bsky.feed.post', text: 'no signature', createdAt: new Date().toISOString() });
    expect((await xrpcGet(VERIFY, { uri: plain })).body).toMatchObject({ personSigned: false, reason: 'NotSigned' });
    // A signature copied onto changed content (what a PDS forging a post would have to do).
    const record = { $type: 'app.bsky.feed.post', text: 'original', createdAt: new Date().toISOString() };
    const signed = signRecord(record, { did: me.did, collection: 'app.bsky.feed.post' }, (t) => signOwnerRaw(me.keys.ownerPrivateKey, t));
    const forged = await write(me.jwt, me.did, 'app.bsky.feed.post', { ...signed, text: 'forged' });
    expect((await xrpcGet(VERIFY, { uri: forged })).body).toMatchObject({ personSigned: false, reason: 'CidMismatch' });
  });

  it('a custodial account has no owner key to sign with', async () => {
    if (!plc) return;
    const user = await createTestUser(uniqueHandle('psrc'));
    const keys = deriveCustodyKeys(generateCustodyPhrase());
    const record = { $type: 'app.bsky.feed.post', text: 'claims a key it does not have', createdAt: new Date().toISOString() };
    const uri = await write(user.accessJwt, user.did, 'app.bsky.feed.post', signRecord(record, { did: user.did, collection: 'app.bsky.feed.post' }, (t) => signOwnerRaw(keys.ownerPrivateKey, t)));
    expect((await xrpcGet(VERIFY, { uri })).body).toMatchObject({ personSigned: false, reason: 'NoOwnerKey' });
  });

  it('answers NotFound for a record that is not here', async () => {
    const res = await xrpcGet(VERIFY, { uri: 'at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/app.bsky.feed.post/3kaaaaaaaaaaa' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('RecordNotFound');
  });
});
