/**
 * Device signing (#240, ADR-003 decision 14), against the dev PLC.
 *
 * The person's device holds the repo signing key and the DID's `atproto`
 * verification method names it. The server prepares commits; the device
 * checks and signs them; the server verifies the signature against the DID's
 * current key (from PLC) and stores them. Every server-signed write for the
 * account refuses, and for a `self` account nothing the server holds can
 * point the DID back at a server key.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { verifyRepoCar } from '@atproto/repo';
import { Secp256k1Keypair } from '@atproto/crypto';
import { xrpcAuthPost, xrpcAuthGet, createTestUser, isPLCAvailable, uniqueHandle } from './helpers.js';
import { query } from '../../src/db/client.js';
import { config } from '../../src/config.js';
import { runtimeSettings } from '../../src/settings/runtime-settings.js';
import { setEmailSenderForTests } from '../../src/email/email-service.js';
import { RepoEngine } from '../../src/repo/repo-engine.js';
import { getKeypairForDid } from '../../src/repo/keypair-utils.js';
import { DeviceSigningRequiredError } from '../../src/repo/device-signing-state.js';
import { getUserSigningKey } from '../../src/identity/user-identity.js';
import { signWithCustodialKey } from '../../src/identity/plc-ops.js';
import {
  generateCustodyPhrase, deriveCustodyKeys, signOwnerRaw, signPlcOperation, plcOperationSigner, buildCancelOp,
  generateDeviceRepoKey, enableDeviceSigning, disableDeviceSigning, setAtprotoKey, buildAtprotoKeyOp,
  deviceCreateRecord, devicePutRecord, deviceDeleteRecord, deviceApplyWrites, signCommitBytes, verifyPreparedCommit,
  readRepoCar, verifyRepoCommit, DeviceCommitRejected,
  type CustodyKeys, type DeviceRepoKey, type PreparedCommit, type SignedPlcOperation, type XrpcCaller,
} from '../../packages/openfederation-sdk/src/custody/index.js';

const PASSWORD = 'TestPassword123!';
const PREPARE = 'net.openfederation.repo.prepareCommit';
const SUBMIT = 'net.openfederation.repo.submitCommit';
const ENABLE = 'net.openfederation.account.enableDeviceSigning';
const DISABLE = 'net.openfederation.account.disableDeviceSigning';
const POST = 'app.bsky.feed.post';
const plcUrl = () => config.plc.directoryUrl;
const pdsUrl = () => config.pds.serviceUrl;

type User = Awaited<ReturnType<typeof createTestUser>>;

function post(text: string) {
  return { $type: POST, text, createdAt: new Date().toISOString() };
}

/** The SDK client interface over the test server. */
function clientFor(u: User): XrpcCaller {
  return {
    async fetch(nsid, opts) {
      const res = opts.method === 'GET' ? await xrpcAuthGet(nsid, u.accessJwt, opts.params) : await xrpcAuthPost(nsid, u.accessJwt, opts.body);
      if (res.status >= 400) throw Object.assign(new Error(res.body?.message ?? `HTTP ${res.status}`), { code: res.body?.error, status: res.status });
      return res.body;
    },
  };
}

async function plcData(did: string): Promise<{ rotationKeys: string[]; verificationMethods: Record<string, string> }> {
  return (await fetch(`${plcUrl()}/${did}/data`)).json();
}
async function plcLog(did: string): Promise<SignedPlcOperation[]> {
  return (await fetch(`${plcUrl()}/${did}/log`)).json();
}
async function repoCar(did: string): Promise<Uint8Array> {
  const res = await fetch(`${pdsUrl()}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(did)}`);
  expect(res.status).toBe(200);
  return new Uint8Array(await res.arrayBuffer());
}
async function root(did: string): Promise<string | undefined> {
  return (await new RepoEngine(did).getRoot())?.toString();
}
async function serverKeyDid(did: string): Promise<string> {
  return (await getKeypairForDid(did)).did();
}
function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
function prepareOne(u: User, text: string, rkey?: string) {
  return xrpcAuthPost(PREPARE, u.accessJwt, { writes: [{ action: 'create', collection: POST, ...(rkey ? { rkey } : {}), value: post(text) }] });
}

/** A custodial test user the PDS moves to `target`, holding `keys` (as custody-recovery-key.test.ts). */
async function personHeld(target: 'self' | 'assisted', keys: CustodyKeys): Promise<User> {
  const u = await createTestUser(uniqueHandle('ds'));
  const newKeys = { userRotationDidKey: keys.rotationDidKey, ownerDidKey: keys.ownerDidKey };
  const prep = await xrpcAuthPost('net.openfederation.identity.prepareCustodyChange', u.accessJwt, { password: PASSWORD, targetMode: target, ...newKeys });
  expect(prep.status).toBe(200);
  const text = `OpenFederation Custody Change v1\ndid: ${u.did}\noperation: ${prep.body.operationCid}`;
  const fin = await xrpcAuthPost('net.openfederation.identity.finalizeCustodyChange', u.accessJwt, {
    password: PASSWORD, targetMode: target, ...newKeys, operationCid: prep.body.operationCid,
    possession: { rotation: signOwnerRaw(keys.rotationPrivateKey, text), owner: signOwnerRaw(keys.ownerPrivateKey, text) },
  });
  expect(fin.status).toBe(200);
  return u;
}

describe('device signing (#240)', () => {
  let plc = false;
  const policyBefore = runtimeSettings().identity.deviceSigningAllowed;

  beforeAll(async () => {
    plc = await isPLCAvailable();
    runtimeSettings().identity.deviceSigningAllowed = true;
    setEmailSenderForTests(async () => undefined);
  });
  afterAll(() => {
    runtimeSettings().identity.deviceSigningAllowed = policyBefore;
    setEmailSenderForTests(null);
  });

  describe('turning it on', () => {
    it('is refused for custodial accounts', async () => {
      if (!plc) return;
      const u = await createTestUser(uniqueHandle('dsc'));
      const res = await xrpcAuthPost(ENABLE, u.accessJwt, {});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('CustodyModeNotSupported');
    });

    it('is refused where the installation does not offer it', async () => {
      if (!plc) return;
      const u = await personHeld('self', deriveCustodyKeys(generateCustodyPhrase()));
      runtimeSettings().identity.deviceSigningAllowed = false;
      try {
        const res = await xrpcAuthPost(ENABLE, u.accessJwt, {});
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('DeviceSigningNotAllowed');
      } finally {
        runtimeSettings().identity.deviceSigningAllowed = true;
      }
      const cfg = await xrpcAuthGet('net.openfederation.server.getPublicConfig', u.accessJwt);
      expect(cfg.body.identity.deviceSigningAllowed).toBe(true);
    });

    it('is refused while PLC still names the server\'s key (a switch alone protects nothing)', async () => {
      if (!plc) return;
      const u = await personHeld('self', deriveCustodyKeys(generateCustodyPhrase()));
      const res = await xrpcAuthPost(ENABLE, u.accessJwt, {});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('AtprotoKeyNotDevice');
      expect((await query('SELECT device_signing FROM users WHERE did = $1', [u.did])).rows[0].device_signing).toBe(false);
    });
  });

  describe('a self account with device signing on', () => {
    let user: User;
    let other: User;
    let phrase: CustodyKeys;
    let device: DeviceRepoKey;
    let client: XrpcCaller;

    beforeAll(async () => {
      if (!plc) return;
      phrase = deriveCustodyKeys(generateCustodyPhrase());
      device = generateDeviceRepoKey();
      user = await personHeld('self', phrase);
      other = await createTestUser(uniqueHandle('dso'));
      client = clientFor(user);
      // A record written by the server before the switch, so the repo has history.
      const before = await xrpcAuthPost('com.atproto.repo.createRecord', user.accessJwt, { repo: user.did, collection: POST, rkey: 'before', record: post('server-signed, before') });
      expect(before.status).toBe(200);
    });

    it('turns on: the phrase points the DID at the device key, then the PDS records it', async () => {
      if (!plc) return;
      await enableDeviceSigning({ plcUrl: plcUrl(), did: user.did, rotationPrivateKey: phrase.rotationPrivateKey, deviceDidKey: device.didKey, client });
      expect((await plcData(user.did)).verificationMethods.atproto).toBe(device.didKey);
      const level = await xrpcAuthGet('net.openfederation.account.getSecurityLevel', user.accessJwt);
      expect(level.body).toMatchObject({ custodyMode: 'self', deviceSigning: true, deviceSigningKey: device.didKey });
      // Idempotent.
      expect((await xrpcAuthPost(ENABLE, user.accessJwt, {})).status).toBe(200);
    });

    it('refuses every server-signed write for the account, before anything changes', async () => {
      if (!plc) return;
      const head = await root(user.did);
      const expectRefused = (res: { status: number; body: { error?: string } }) => {
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('DeviceSigningRequired');
      };
      expectRefused(await xrpcAuthPost('com.atproto.repo.createRecord', user.accessJwt, { repo: user.did, collection: POST, record: post('forged?') }));
      expectRefused(await xrpcAuthPost('com.atproto.repo.putRecord', user.accessJwt, { repo: user.did, collection: POST, rkey: 'before', record: post('forged?') }));
      expectRefused(await xrpcAuthPost('com.atproto.repo.deleteRecord', user.accessJwt, { repo: user.did, collection: POST, rkey: 'before' }));
      expectRefused(await xrpcAuthPost('net.openfederation.account.updateProfile', user.accessJwt, { displayName: 'forged' }));
      expectRefused(await xrpcAuthPost('net.openfederation.contact.sendRequest', user.accessJwt, { subject: other.did }));
      expectRefused(await xrpcAuthGet('com.atproto.server.getServiceAuth', user.accessJwt, { aud: 'did:web:example.com' }));
      // An accepted contact request would write into this account's repo too.
      const req = await xrpcAuthPost('net.openfederation.contact.sendRequest', other.accessJwt, { subject: user.did });
      expect(req.status).toBe(200);
      expectRefused(await xrpcAuthPost('net.openfederation.contact.respondToRequest', user.accessJwt, { rkey: req.body.rkey, action: 'accept' }));
      expect((await query('SELECT 1 FROM contacts WHERE user_did = $1 OR contact_did = $1', [user.did])).rows).toHaveLength(0);
      // Rejecting writes only the requester's repo: allowed.
      expect((await xrpcAuthPost('net.openfederation.contact.respondToRequest', user.accessJwt, { rkey: req.body.rkey, action: 'reject' })).status).toBe(200);

      // The engine refuses on its own, for any path that forgets to check.
      await expect(new RepoEngine(user.did).putRecord(await getKeypairForDid(user.did), POST, 'engine', post('forged?')))
        .rejects.toBeInstanceOf(DeviceSigningRequiredError);
      expect(await root(user.did)).toBe(head);
    });

    it('accepts its own device-signed record: stored, readable, verifiable against the device key', async () => {
      if (!plc) return;
      const res = await deviceCreateRecord({ client, did: user.did, deviceKey: device.privateKey, verifyAgainst: pdsUrl(), collection: POST, rkey: 'mine', record: post('signed on my device') });
      expect(res.writes[0].uri).toBe(`at://${user.did}/${POST}/mine`);

      const got = await xrpcAuthGet('com.atproto.repo.getRecord', user.accessJwt, { repo: user.did, collection: POST, rkey: 'mine' });
      expect(got.status).toBe(200);
      expect(got.body.value.text).toBe('signed on my device');
      expect(got.body.cid).toBe(res.writes[0].cid);

      const latest = await xrpcAuthGet('com.atproto.sync.getLatestCommit', user.accessJwt, { did: user.did });
      expect(latest.body).toMatchObject({ cid: res.commit.cid, rev: res.commit.rev });

      // Standard AT Protocol verification: the whole repo, signed by the DID's current atproto key.
      const car = await repoCar(user.did);
      const verified = await verifyRepoCar(car, user.did, device.didKey);
      expect(verified.creates.map((c) => `${c.collection}/${c.rkey}`)).toEqual(expect.arrayContaining([`${POST}/mine`, `${POST}/before`]));
      await expect(verifyRepoCar(car, user.did, await serverKeyDid(user.did))).rejects.toThrow();
      const { commit } = readRepoCar(car);
      expect(commit.cid).toBe(res.commit.cid);
      expect(verifyRepoCommit(commit, device.didKey)).toBe(true);
    });

    it('updates, deletes and batches with the device key', async () => {
      if (!plc) return;
      await devicePutRecord({ client, did: user.did, deviceKey: device.privateKey, verifyAgainst: pdsUrl(), collection: POST, rkey: 'mine', record: post('edited') });
      await deviceApplyWrites({
        client, did: user.did, deviceKey: device.privateKey, verifyAgainst: pdsUrl(),
        writes: [
          { action: 'create', collection: POST, rkey: 'a', record: post('a') },
          { action: 'create', collection: POST, record: post('b, rkey chosen on the device') },
          { action: 'delete', collection: POST, rkey: 'before' },
        ],
      });
      await deviceDeleteRecord({ client, did: user.did, deviceKey: device.privateKey, verifyAgainst: pdsUrl(), collection: POST, rkey: 'a' });
      const list = await xrpcAuthGet('com.atproto.repo.listRecords', user.accessJwt, { repo: user.did, collection: POST });
      const texts = list.body.records.map((r: { value: { text: string } }) => r.value.text).sort();
      expect(texts).toEqual(['b, rkey chosen on the device', 'edited']);
      await verifyRepoCar(await repoCar(user.did), user.did, device.didKey);
    });

    it('refuses a commit signed by the server\'s key or any other key, and keeps the head', async () => {
      if (!plc) return;
      const head = await root(user.did);
      const serverKey = await Secp256k1Keypair.import(Buffer.from((await getUserSigningKey(user.did))!, 'base64'));
      for (const sign of [
        async (bytes: Uint8Array) => serverKey.sign(bytes),
        async (bytes: Uint8Array) => signCommitBytes(bytes, generateDeviceRepoKey().privateKey),
        async (bytes: Uint8Array) => signCommitBytes(bytes, phrase.rotationPrivateKey),
      ]) {
        const prep = await prepareOne(user, 'not by my device');
        expect(prep.status).toBe(200);
        const sig = await sign(Buffer.from(prep.body.unsignedCommit, 'base64'));
        const res = await xrpcAuthPost(SUBMIT, user.accessJwt, { handle: prep.body.handle, sig: b64(sig) });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('InvalidSignature');
      }
      // A high-S form of a valid signature is refused too (AT Protocol requires low-S).
      const prep = await prepareOne(user, 'malleable');
      const sig = signCommitBytes(Buffer.from(prep.body.unsignedCommit, 'base64'), device.privateKey);
      const n = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
      const s = BigInt('0x' + Buffer.from(sig.slice(32)).toString('hex'));
      const highS = new Uint8Array([...sig.slice(0, 32), ...Buffer.from((n - s).toString(16).padStart(64, '0'), 'hex')]);
      const res = await xrpcAuthPost(SUBMIT, user.accessJwt, { handle: prep.body.handle, sig: b64(highS) });
      expect(res.body.error).toBe('InvalidSignature');
      expect(await root(user.did)).toBe(head);
    });

    it('refuses a stale prepare (the head moved) and a replayed submit', async () => {
      if (!plc) return;
      const first = await prepareOne(user, 'first');
      const second = await prepareOne(user, 'second');
      const sign = (p: { body: { unsignedCommit: string } }) => b64(signCommitBytes(Buffer.from(p.body.unsignedCommit, 'base64'), device.privateKey));
      const ok = await xrpcAuthPost(SUBMIT, user.accessJwt, { handle: second.body.handle, sig: sign(second) });
      expect(ok.status).toBe(200);
      const stale = await xrpcAuthPost(SUBMIT, user.accessJwt, { handle: first.body.handle, sig: sign(first) });
      expect(stale.status).toBe(409);
      expect(stale.body.error).toBe('RepoHeadMoved');
      const replay = await xrpcAuthPost(SUBMIT, user.accessJwt, { handle: second.body.handle, sig: sign(second) });
      expect(replay.status).toBe(400);
      expect(replay.body.error).toBe('UnknownCommit');
    });

    it('refuses an expired prepare', async () => {
      if (!plc) return;
      const prep = await prepareOne(user, 'late');
      await query("UPDATE pending_device_commits SET expires_at = NOW() - interval '1 second' WHERE id = $1", [prep.body.handle]);
      const res = await xrpcAuthPost(SUBMIT, user.accessJwt, { handle: prep.body.handle, sig: b64(signCommitBytes(Buffer.from(prep.body.unsignedCommit, 'base64'), device.privateKey)) });
      expect(res.body.error).toBe('CommitExpired');
    });

    it('another user can neither prepare for this account nor submit its prepared commit', async () => {
      if (!plc) return;
      const foreign = await xrpcAuthPost(PREPARE, other.accessJwt, { repo: user.did, writes: [{ action: 'create', collection: POST, value: post('x') }] });
      expect(foreign.status).toBe(403);
      const prep = await prepareOne(user, 'mine alone');
      const sig = b64(signCommitBytes(Buffer.from(prep.body.unsignedCommit, 'base64'), device.privateKey));
      const stolen = await xrpcAuthPost(SUBMIT, other.accessJwt, { handle: prep.body.handle, sig });
      expect(stolen.body.error).toBe('UnknownCommit');
      // Still the owner's to submit.
      expect((await xrpcAuthPost(SUBMIT, user.accessJwt, { handle: prep.body.handle, sig })).status).toBe(200);
    });

    it('accounts without device signing cannot prepare', async () => {
      if (!plc) return;
      const res = await prepareOne(other, 'x');
      expect(res.body.error).toBe('DeviceSigningOff');
    });

    it('bounds pending prepares per account', async () => {
      if (!plc) return;
      await query('DELETE FROM pending_device_commits WHERE did = $1', [user.did]);
      for (let i = 0; i < 8; i++) expect((await prepareOne(user, `p${i}`)).status).toBe(200);
      const ninth = await prepareOne(user, 'p8');
      expect(ninth.status).toBe(429);
      expect(ninth.body.error).toBe('TooManyPendingCommits');
      await query('DELETE FROM pending_device_commits WHERE did = $1', [user.did]);
    });

    it('the device refuses to sign a commit holding a record it did not write', async () => {
      if (!plc) return;
      // The server prepares two records but tells the device about one.
      const asked = post('asked for');
      const prep = await xrpcAuthPost(PREPARE, user.accessJwt, { writes: [
        { action: 'create', collection: POST, rkey: 'asked', value: asked },
        { action: 'create', collection: POST, rkey: 'smuggled', value: post('slipped in by the server') },
      ] });
      expect(prep.status).toBe(200);
      const tampered: PreparedCommit = { ...prep.body, writes: prep.body.writes.slice(0, 1) };
      const writes = [{ action: 'create' as const, collection: POST, rkey: 'asked', record: asked }];
      const car = await repoCar(user.did);
      expect(() => verifyPreparedCommit({ did: user.did, prepared: tampered, writes, previousCar: car }))
        .toThrow(/new tree has/);
      // An honest prepare passes; the same one with a different record body does not.
      const mine = post('what I wrote');
      const honest = await xrpcAuthPost(PREPARE, user.accessJwt, { writes: [{ action: 'create', collection: POST, rkey: 'body', value: mine }] });
      expect(() => verifyPreparedCommit({
        did: user.did, prepared: honest.body, previousCar: car,
        writes: [{ action: 'create', collection: POST, rkey: 'body', record: mine }],
      })).not.toThrow();
      expect(() => verifyPreparedCommit({
        did: user.did, prepared: honest.body, previousCar: car,
        writes: [{ action: 'create', collection: POST, rkey: 'body', record: post('something else') }],
      })).toThrow(DeviceCommitRejected);
      await query('DELETE FROM pending_device_commits WHERE did = $1', [user.did]);
    });

    it('nothing the server holds can point a self DID\'s atproto key back at the server', async () => {
      if (!plc) return;
      const previous = (await plcLog(user.did)).at(-1)!;
      const op = buildAtprotoKeyOp(previous, await serverKeyDid(user.did));
      // The server's repo key is not a rotation key, and it holds no rotation key for a self account.
      const serverRepoKey = new Uint8Array(Buffer.from((await getUserSigningKey(user.did))!, 'base64'));
      const res = await fetch(`${plcUrl()}/${user.did}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(signPlcOperation(op, serverRepoKey)),
      });
      expect(res.ok).toBe(false);
      await expect(signWithCustodialKey(user.did, op as never)).rejects.toThrow(/does not hold a rotation key/);
      expect((await plcData(user.did)).verificationMethods.atproto).toBe(device.didKey);
    });

    it('turning it off (phrase-signed) restores server writes', async () => {
      if (!plc) return;
      // Off is refused while PLC still names the device key.
      expect((await xrpcAuthPost(DISABLE, user.accessJwt, {})).body.error).toBe('AtprotoKeyNotServer');
      await disableDeviceSigning({ plcUrl: plcUrl(), did: user.did, rotationPrivateKey: phrase.rotationPrivateKey, client });
      expect((await plcData(user.did)).verificationMethods.atproto).toBe(await serverKeyDid(user.did));
      const res = await xrpcAuthPost('com.atproto.repo.createRecord', user.accessJwt, { repo: user.did, collection: POST, record: post('server-signed again') });
      expect(res.status).toBe(200);
      await verifyRepoCar(await repoCar(user.did), user.did, await serverKeyDid(user.did));
      expect((await prepareOne(user, 'x')).body.error).toBe('DeviceSigningOff');
    });

    it('turns itself off when PLC names the server\'s key again without the PDS being told', async () => {
      if (!plc) return;
      await enableDeviceSigning({ plcUrl: plcUrl(), did: user.did, rotationPrivateKey: phrase.rotationPrivateKey, deviceDidKey: device.didKey, client });
      const prep = await prepareOne(user, 'after the switch back');
      await setAtprotoKey({ plcUrl: plcUrl(), did: user.did, rotationPrivateKey: phrase.rotationPrivateKey, atprotoDidKey: await serverKeyDid(user.did) });
      const res = await xrpcAuthPost(SUBMIT, user.accessJwt, { handle: prep.body.handle, sig: b64(signCommitBytes(Buffer.from(prep.body.unsignedCommit, 'base64'), device.privateKey)) });
      expect(res.body.error).toBe('DeviceSigningOff');
      expect((await query('SELECT device_signing FROM users WHERE did = $1', [user.did])).rows[0].device_signing).toBe(false);
      expect((await xrpcAuthPost('com.atproto.repo.createRecord', user.accessJwt, { repo: user.did, collection: POST, record: post('ok') })).status).toBe(200);
    });
  });

  describe('an assisted account', () => {
    it('a switch back by the server\'s backup key is public in PLC and the phrase cancels it', async () => {
      if (!plc) return;
      const phrase = deriveCustodyKeys(generateCustodyPhrase());
      const device = generateDeviceRepoKey();
      const user = await personHeld('assisted', phrase);
      await enableDeviceSigning({ plcUrl: plcUrl(), did: user.did, rotationPrivateKey: phrase.rotationPrivateKey, deviceDidKey: device.didKey, client: clientFor(user) });

      // A hostile operator uses its backup rotation key (second in the list).
      const before = (await plcLog(user.did)).at(-1)!;
      const switchBack = await signWithCustodialKey(user.did, buildAtprotoKeyOp(before, await serverKeyDid(user.did)) as never);
      const submitted = await fetch(`${plcUrl()}/${user.did}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(switchBack) });
      expect(submitted.ok).toBe(true);
      expect((await plcData(user.did)).verificationMethods.atproto).toBe(await serverKeyDid(user.did));

      // What the dashboard's recentIdentityChanges reads: signed by a lower key, so cancellable.
      const audit = await (await fetch(`${plcUrl()}/${user.did}/log/audit`)).json() as Array<{ operation: SignedPlcOperation; nullified: boolean }>;
      const live = audit.filter((e) => !e.nullified);
      const last = live.at(-1)!.operation;
      const signer = plcOperationSigner(last, before.rotationKeys);
      expect(before.rotationKeys.indexOf(signer!)).toBeGreaterThan(0);
      expect(last.verificationMethods.atproto).not.toBe(before.verificationMethods.atproto);

      // The phrase cancels it within 72 hours: the device key is back.
      await fetch(`${plcUrl()}/${user.did}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signPlcOperation(buildCancelOp(before), phrase.rotationPrivateKey)),
      });
      expect((await plcData(user.did)).verificationMethods.atproto).toBe(device.didKey);
      // The device keeps writing.
      const res = await deviceCreateRecord({ client: clientFor(user), did: user.did, deviceKey: device.privateKey, verifyAgainst: pdsUrl(), collection: POST, record: post('still mine') });
      expect(res.commit.cid).toBeTruthy();
      await verifyRepoCar(await repoCar(user.did), user.did, device.didKey);
    });
  });
});
