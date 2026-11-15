/**
 * Device signing, phase 4 (#240): losing or replacing the device, rotating
 * its key, the `assisted` switch back and turning it back on, and what a
 * hostile server can and cannot do. Against the dev PLC.
 *
 * The guarantees under test:
 *  - The phrase, or the person's recovery key (#238), points the DID at a new
 *    device key; the old key stops working at once; the server is not needed.
 *  - A server cannot forge: anything it signs fails against the DID's key,
 *    and the device refuses to sign on top of a head it did not sign
 *    (trustedHeadKeys) so a forgery is never blessed later.
 *  - A server cannot silently undo it: for `self` it holds no key that can;
 *    for `assisted` its backup key can, but only as a public PLC operation,
 *    signed by a lower key, which the phrase cancels within 72 hours; this
 *    server emails when it sees it; and after cancelling, device signing
 *    turns back on.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { verifyRepoCar } from '@atproto/repo';
import { xrpcAuthPost, xrpcAuthGet, createTestUser, isPLCAvailable, uniqueHandle } from './helpers.js';
import { query } from '../../src/db/client.js';
import { config } from '../../src/config.js';
import { runtimeSettings } from '../../src/settings/runtime-settings.js';
import { setEmailSenderForTests } from '../../src/email/email-service.js';
import { getKeypairForDid } from '../../src/repo/keypair-utils.js';
import { signWithCustodialKey } from '../../src/identity/plc-ops.js';
import { DEVICE_SIGNING_FEATURES } from '../../src/repo/device-signing-features.js';
import {
  generateCustodyPhrase, deriveCustodyKeys, signOwnerRaw, signPlcOperation, buildCancelOp,
  generateDeviceRepoKey, enableDeviceSigning, disableDeviceSigning, setDeviceRepoKey, rotateDeviceRepoKey,
  buildAtprotoKeyOp, deviceCreateRecord, signCommitBytes, DeviceCommitRejected,
  findDeviceSigningSwitchBack, cancelDeviceSigningSwitchBack, getDeviceSigningStatus,
  generateRecoveryPhrase, deriveRecoveryKey, addRecoveryKey, recoverWithRecoveryKey, buildRemoveRecoveryKeyOp,
  readRepoCar, verifyRepoCommit,
  type CustodyKeys, type DeviceRepoKey, type SignedPlcOperation, type XrpcCaller,
} from '../../packages/openfederation-sdk/src/custody/index.js';

const PASSWORD = 'TestPassword123!';
const PREPARE = 'net.openfederation.repo.prepareCommit';
const SUBMIT = 'net.openfederation.repo.submitCommit';
const STATUS = 'net.openfederation.account.getDeviceSigning';
const POST = 'app.bsky.feed.post';
const plcUrl = () => config.plc.directoryUrl;
const pdsUrl = () => config.pds.serviceUrl;

type User = Awaited<ReturnType<typeof createTestUser>>;

function post(text: string) {
  return { $type: POST, text, createdAt: new Date().toISOString() };
}

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
async function submitToPlc(did: string, op: unknown): Promise<Response> {
  return fetch(`${plcUrl()}/${did}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(op) });
}
async function repoCar(did: string): Promise<Uint8Array> {
  const res = await fetch(`${pdsUrl()}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(did)}`);
  expect(res.status).toBe(200);
  return new Uint8Array(await res.arrayBuffer());
}
async function serverKeyDid(did: string): Promise<string> {
  return (await getKeypairForDid(did)).did();
}
function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
async function flag(did: string): Promise<boolean> {
  return (await query<{ device_signing: boolean }>('SELECT device_signing FROM users WHERE did = $1', [did])).rows[0].device_signing;
}

async function personHeld(target: 'self' | 'assisted', keys: CustodyKeys): Promise<User> {
  const u = await createTestUser(uniqueHandle('dsr'));
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

function write(u: User, device: DeviceRepoKey, text: string, trustedHeadKeys?: string[]) {
  return deviceCreateRecord({ client: clientFor(u), did: u.did, deviceKey: device.privateKey, verifyAgainst: pdsUrl(), collection: POST, record: post(text), trustedHeadKeys });
}

describe('device signing: recovery, rotation and a hostile server (#240, phase 4)', () => {
  let plc = false;
  const policyBefore = runtimeSettings().identity.deviceSigningAllowed;
  const inbox: Array<{ to: string; subject: string; html: string }> = [];

  beforeAll(async () => {
    plc = await isPLCAvailable();
    runtimeSettings().identity.deviceSigningAllowed = true;
    setEmailSenderForTests(async (to, subject, html) => { inbox.push({ to, subject, html }); });
  });
  afterAll(() => {
    runtimeSettings().identity.deviceSigningAllowed = policyBefore;
    setEmailSenderForTests(null);
  });

  describe('getDeviceSigning', () => {
    it('reports policy, custody mode, state and the features the server lists', async () => {
      if (!plc) return;
      const custodial = await createTestUser(uniqueHandle('dsrc'));
      const c = await xrpcAuthGet(STATUS, custodial.accessJwt);
      expect(c.status).toBe(200);
      expect(c.body).toMatchObject({ allowed: true, custodyMode: 'custodial', eligible: false, deviceSigning: false, state: 'off', plcReadable: true });
      expect(c.body.atprotoKey).toBe(c.body.serverKey);
      expect(c.body.features).toEqual(DEVICE_SIGNING_FEATURES.map((f) => ({ ...f })));

      const phrase = deriveCustodyKeys(generateCustodyPhrase());
      const u = await personHeld('self', phrase);
      expect((await getDeviceSigningStatus(clientFor(u)))).toMatchObject({ custodyMode: 'self', eligible: true, state: 'off' });
      runtimeSettings().identity.deviceSigningAllowed = false;
      try {
        expect((await getDeviceSigningStatus(clientFor(u)))).toMatchObject({ allowed: false, eligible: false });
      } finally {
        runtimeSettings().identity.deviceSigningAllowed = true;
      }
      const device = generateDeviceRepoKey();
      await enableDeviceSigning({ plcUrl: plcUrl(), did: u.did, rotationPrivateKey: phrase.rotationPrivateKey, deviceDidKey: device.didKey, client: clientFor(u) });
      expect(await getDeviceSigningStatus(clientFor(u))).toMatchObject({ state: 'on', deviceSigning: true, atprotoKey: device.didKey, recordedKey: device.didKey });
    });
  });

  describe('a self account that loses or replaces its device', () => {
    let user: User;
    let phrase: CustodyKeys;
    let oldDevice: DeviceRepoKey;
    let device: DeviceRepoKey;

    beforeAll(async () => {
      if (!plc) return;
      phrase = deriveCustodyKeys(generateCustodyPhrase());
      oldDevice = generateDeviceRepoKey();
      user = await personHeld('self', phrase);
      await enableDeviceSigning({ plcUrl: plcUrl(), did: user.did, rotationPrivateKey: phrase.rotationPrivateKey, deviceDidKey: oldDevice.didKey, client: clientFor(user) });
      await write(user, oldDevice, 'from the old device');
    });

    it('the phrase points the DID at a new device key; the old key stops working at once', async () => {
      if (!plc) return;
      device = generateDeviceRepoKey();
      const change = await setDeviceRepoKey({ plcUrl: plcUrl(), did: user.did, rotationPrivateKey: phrase.rotationPrivateKey, deviceDidKey: device.didKey, client: clientFor(user) });
      expect(change.cancelUntil).toBeUndefined(); // the top key signed: nothing can cancel it
      expect((await plcData(user.did)).verificationMethods.atproto).toBe(device.didKey);
      expect(await getDeviceSigningStatus(clientFor(user))).toMatchObject({ state: 'on', recordedKey: device.didKey });

      // A commit signed by the lost device is refused.
      const prep = await xrpcAuthPost(PREPARE, user.accessJwt, { writes: [{ action: 'create', collection: POST, value: post('from the lost device') }] });
      const stale = await xrpcAuthPost(SUBMIT, user.accessJwt, { handle: prep.body.handle, sig: b64(signCommitBytes(Buffer.from(prep.body.unsignedCommit, 'base64'), oldDevice.privateKey)) });
      expect(stale.body.error).toBe('InvalidSignature');

      // The new device writes; the whole repository verifies against its key again.
      await write(user, device, 'from the new device', [oldDevice.didKey, device.didKey]);
      await verifyRepoCar(await repoCar(user.did), user.did, device.didKey);
    });

    it('rotates the device key: a new key made on the device, the previous one retired', async () => {
      if (!plc) return;
      const rotated = await rotateDeviceRepoKey({ plcUrl: plcUrl(), did: user.did, rotationPrivateKey: phrase.rotationPrivateKey, client: clientFor(user) });
      expect(rotated.key.didKey).not.toBe(device.didKey);
      expect((await plcData(user.did)).verificationMethods.atproto).toBe(rotated.key.didKey);
      await expect(write(user, device, 'old key')).rejects.toThrow(/does not verify/);
      await write(user, rotated.key, 'rotated', [device.didKey, rotated.key.didKey]);
      await verifyRepoCar(await repoCar(user.did), user.did, rotated.key.didKey);
      device = rotated.key;
    });

    it('the recovery key can point the DID at a new device, cancellable by the phrase for 72 hours', async () => {
      if (!plc) return;
      const recovery = deriveRecoveryKey(generateRecoveryPhrase());
      await addRecoveryKey({ plcUrl: plcUrl(), did: user.did, rotationPrivateKey: phrase.rotationPrivateKey, mode: 'self', recoveryDidKey: recovery.recoveryDidKey });
      const before = (await plcLog(user.did)).at(-1)!;
      const replacement = generateDeviceRepoKey();
      const change = await setDeviceRepoKey({ plcUrl: plcUrl(), did: user.did, recoveryPrivateKey: recovery.recoveryPrivateKey, deviceDidKey: replacement.didKey, client: clientFor(user) });
      expect(change.cancelUntil!.getTime()).toBeGreaterThan(Date.now() + 71 * 3600_000);
      expect((await plcData(user.did)).verificationMethods.atproto).toBe(replacement.didKey);
      await write(user, replacement, 'after a recovery-key device change');

      // Visible as a change by a lower key, and the phrase can cancel it.
      const found = await findDeviceSigningSwitchBack({ plcUrl: plcUrl(), did: user.did });
      expect(found).toMatchObject({ from: device.didKey, to: replacement.didKey, signedBy: recovery.recoveryDidKey, signerRank: 1, cancellable: true });
      expect((await submitToPlc(user.did, signPlcOperation(buildCancelOp(before), phrase.rotationPrivateKey))).ok).toBe(true);
      expect((await plcData(user.did)).verificationMethods.atproto).toBe(device.didKey);
    });

    it('phrase and device lost together: the recovery key brings in a new phrase and a new device key', async () => {
      if (!plc) return;
      const recoveryPhrase = generateRecoveryPhrase();
      const recovery = deriveRecoveryKey(recoveryPhrase);
      // The previous test's recovery key is still there; replace it with a known one.
      const data = await plcData(user.did);
      expect(data.rotationKeys).toHaveLength(2);
      const fresh = deriveCustodyKeys(generateCustodyPhrase());
      const newDevice = generateDeviceRepoKey();
      // Swap the recovery key first (phrase-signed), as a person would set it up.
      expect((await submitToPlc(user.did, signPlcOperation(buildRemoveRecoveryKeyOp({ previous: (await plcLog(user.did)).at(-1)!, mode: 'self' }), phrase.rotationPrivateKey))).ok).toBe(true);
      await addRecoveryKey({ plcUrl: plcUrl(), did: user.did, rotationPrivateKey: phrase.rotationPrivateKey, mode: 'self', recoveryDidKey: recovery.recoveryDidKey });

      const result = await recoverWithRecoveryKey({
        plcUrl: plcUrl(), did: user.did, recoveryPrivateKey: recovery.recoveryPrivateKey,
        newRotationDidKey: fresh.rotationDidKey, newOwnerDidKey: fresh.ownerDidKey, newDeviceDidKey: newDevice.didKey,
      });
      expect(result.cancelUntil.getTime()).toBeGreaterThan(Date.now());
      const after = await plcData(user.did);
      expect(after.rotationKeys).toEqual([fresh.rotationDidKey, recovery.recoveryDidKey]);
      expect(after.verificationMethods.atproto).toBe(newDevice.didKey);
      // The PDS records the new key; the new device writes.
      expect((await xrpcAuthPost('net.openfederation.account.enableDeviceSigning', user.accessJwt, {})).body.atprotoKey).toBe(newDevice.didKey);
      await write(user, newDevice, 'after recovering both');
      await verifyRepoCar(await repoCar(user.did), user.did, newDevice.didKey);
      phrase = fresh;
      device = newDevice;
    });
  });

  describe('a hostile server', () => {
    it('cannot forge: commits it signs fail against the DID, and the device refuses to bless them', async () => {
      if (!plc) return;
      const phrase = deriveCustodyKeys(generateCustodyPhrase());
      const device = generateDeviceRepoKey();
      const user = await personHeld('self', phrase);
      await enableDeviceSigning({ plcUrl: plcUrl(), did: user.did, rotationPrivateKey: phrase.rotationPrivateKey, deviceDidKey: device.didKey, client: clientFor(user) });
      await write(user, device, 'mine');

      // The operator flips its own flag and writes with its key: possible in its own database...
      await query('UPDATE users SET device_signing = false WHERE did = $1', [user.did]);
      const forged = await xrpcAuthPost('com.atproto.repo.createRecord', user.accessJwt, { repo: user.did, collection: POST, record: post('forged') });
      expect(forged.status).toBe(200);
      await query('UPDATE users SET device_signing = true WHERE did = $1', [user.did]);

      // ...but every relay and app checks against the DID's key, which is still the device's.
      expect((await plcData(user.did)).verificationMethods.atproto).toBe(device.didKey);
      const car = await repoCar(user.did);
      await expect(verifyRepoCar(car, user.did, device.didKey)).rejects.toThrow();
      expect(verifyRepoCommit(readRepoCar(car).commit, device.didKey)).toBe(false);

      // And the device does not sign on top of a head it did not sign.
      await expect(write(user, device, 'next', [device.didKey])).rejects.toSatisfy(
        (e: unknown) => e instanceof DeviceCommitRejected && e.reason === 'UntrustedHead');
      // Nor can the server sign the PLC update that would make its key count.
      const op = buildAtprotoKeyOp((await plcLog(user.did)).at(-1)!, await serverKeyDid(user.did));
      await expect(signWithCustodialKey(user.did, op as never)).rejects.toThrow(/does not hold a rotation key/);
    });

    it('cannot silently undo it in assisted: the switch back is public, emailed and cancellable, and it turns back on', async () => {
      if (!plc) return;
      const phrase = deriveCustodyKeys(generateCustodyPhrase());
      const device = generateDeviceRepoKey();
      const user = await personHeld('assisted', phrase);
      const client = clientFor(user);
      await enableDeviceSigning({ plcUrl: plcUrl(), did: user.did, rotationPrivateKey: phrase.rotationPrivateKey, deviceDidKey: device.didKey, client });
      await write(user, device, 'mine');
      expect(await findDeviceSigningSwitchBack({ plcUrl: plcUrl(), did: user.did })).toBeNull();

      // The operator uses its backup rotation key to point the DID at its own key.
      const serverKey = await serverKeyDid(user.did);
      const switchBack = await signWithCustodialKey(user.did, buildAtprotoKeyOp((await plcLog(user.did)).at(-1)!, serverKey) as never);
      expect((await submitToPlc(user.did, switchBack)).ok).toBe(true);

      // Public: the person's client finds it in PLC, signed by a lower key, with its deadline.
      const found = await findDeviceSigningSwitchBack({ plcUrl: plcUrl(), did: user.did });
      expect(found).toMatchObject({ from: device.didKey, to: serverKey, signerRank: 1, cancellable: true });
      expect(found!.cancelUntil.getTime()).toBeGreaterThan(Date.now() + 71 * 3600_000);
      expect(await getDeviceSigningStatus(client)).toMatchObject({ state: 'switchedBack', atprotoKey: serverKey });

      // This server notices on the next device write, turns its flag off and emails the person.
      inbox.length = 0;
      await expect(write(user, device, 'after the switch')).rejects.toMatchObject({ code: 'DeviceSigningOff' });
      expect(await flag(user.did)).toBe(false);
      expect(inbox.find((m) => m.to === `${user.handle}@test.local` && /Device signing is off/.test(m.subject))?.html).toMatch(/72 hours/);

      // While its key is in charge the server writes "as the person".
      const forged = await xrpcAuthPost('com.atproto.repo.createRecord', user.accessJwt, { repo: user.did, collection: POST, record: post('written while switched back') });
      expect(forged.status).toBe(200);

      // The phrase cancels the switch back; the device key is back, and device signing turns on again.
      const { cancelled } = await cancelDeviceSigningSwitchBack({ plcUrl: plcUrl(), did: user.did, rotationPrivateKey: phrase.rotationPrivateKey, client });
      expect(cancelled.cid).toBe(found!.cid);
      expect((await plcData(user.did)).verificationMethods.atproto).toBe(device.didKey);
      expect(await flag(user.did)).toBe(true);
      expect(await getDeviceSigningStatus(client)).toMatchObject({ state: 'on' });
      expect((await xrpcAuthPost('com.atproto.repo.createRecord', user.accessJwt, { repo: user.did, collection: POST, record: post('x') })).body.error).toBe('DeviceSigningRequired');

      // What the server wrote in between is signed by a key the DID no longer names (the operation is nullified),
      // and the device notices before signing on top of it.
      expect(verifyRepoCommit(readRepoCar(await repoCar(user.did)).commit, device.didKey)).toBe(false);
      await expect(write(user, device, 'next', [device.didKey])).rejects.toSatisfy(
        (e: unknown) => e instanceof DeviceCommitRejected && e.reason === 'UntrustedHead');
      // Having reviewed (and kept) the repository, the person signs on top of it.
      await write(user, device, 'reviewed');
      await verifyRepoCar(await repoCar(user.did), user.did, device.didKey);
    });

    it('after a cancelled switch back that the server never noticed, enableDeviceSigning is simply idempotent', async () => {
      if (!plc) return;
      const phrase = deriveCustodyKeys(generateCustodyPhrase());
      const device = generateDeviceRepoKey();
      const user = await personHeld('assisted', phrase);
      const client = clientFor(user);
      await enableDeviceSigning({ plcUrl: plcUrl(), did: user.did, rotationPrivateKey: phrase.rotationPrivateKey, deviceDidKey: device.didKey, client });
      const switchBack = await signWithCustodialKey(user.did, buildAtprotoKeyOp((await plcLog(user.did)).at(-1)!, await serverKeyDid(user.did)) as never);
      expect((await submitToPlc(user.did, switchBack)).ok).toBe(true);
      // The person turns it off here meanwhile (PLC names the server's key, so the server accepts)...
      expect((await xrpcAuthPost('net.openfederation.account.disableDeviceSigning', user.accessJwt, {})).body.deviceSigning).toBe(false);
      // ...then cancels the switch back without telling this server: the status says it can resume.
      const before = (await (await fetch(`${plcUrl()}/${user.did}/log/audit`)).json() as Array<{ operation: SignedPlcOperation; nullified: boolean }>)
        .filter((e) => !e.nullified).at(-2)!.operation;
      expect((await submitToPlc(user.did, signPlcOperation(buildCancelOp(before), phrase.rotationPrivateKey))).ok).toBe(true);
      expect(await getDeviceSigningStatus(client)).toMatchObject({ state: 'resumable', deviceSigning: false, atprotoKey: device.didKey });
      expect((await xrpcAuthPost('net.openfederation.account.enableDeviceSigning', user.accessJwt, {})).status).toBe(200);
      expect(await getDeviceSigningStatus(client)).toMatchObject({ state: 'on' });
      await write(user, device, 'back on');
    });

    it('a cancellation needs a key above the one that switched back; a switch past 72 hours cannot be cancelled', async () => {
      if (!plc) return;
      const phrase = deriveCustodyKeys(generateCustodyPhrase());
      const device = generateDeviceRepoKey();
      const user = await personHeld('assisted', phrase);
      await enableDeviceSigning({ plcUrl: plcUrl(), did: user.did, rotationPrivateKey: phrase.rotationPrivateKey, deviceDidKey: device.didKey, client: clientFor(user) });
      const switchBack = await signWithCustodialKey(user.did, buildAtprotoKeyOp((await plcLog(user.did)).at(-1)!, await serverKeyDid(user.did)) as never);
      expect((await submitToPlc(user.did, switchBack)).ok).toBe(true);
      const someoneElse = deriveCustodyKeys(generateCustodyPhrase());
      await expect(cancelDeviceSigningSwitchBack({ plcUrl: plcUrl(), did: user.did, rotationPrivateKey: someoneElse.rotationPrivateKey }))
        .rejects.toThrow(/does not rank above/);
      const late = await findDeviceSigningSwitchBack({ plcUrl: plcUrl(), did: user.did, now: Date.now() + 73 * 3600_000 });
      expect(late?.cancellable).toBe(false);
      // Clean up: the person turns device signing off for good with the phrase (top key, not cancellable).
      await disableDeviceSigning({ plcUrl: plcUrl(), did: user.did, rotationPrivateKey: phrase.rotationPrivateKey, client: clientFor(user) });
      expect(await getDeviceSigningStatus(clientFor(user))).toMatchObject({ state: 'off' });
    });
  });
});
