/**
 * Optional recovery for `self` and `assisted` identities (#238, ADR-003
 * decision 13), against the dev PLC. The recovery key is a second rotation
 * key the person holds, directly below their phrase key; the PDS never holds
 * it and is not involved in using it. What the PDS must do is tolerate it:
 * custody changes and the server's assisted recovery keep it in place, and a
 * recovery signed with it leaves the account's mode alone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { xrpcAuthPost, xrpcAuthGet, createTestUser, getAdminToken, isPLCAvailable, uniqueHandle } from './helpers.js';
import { query } from '../../src/db/client.js';
import { config } from '../../src/config.js';
import { setEmailSenderForTests } from '../../src/email/email-service.js';
import { getShare } from '../../src/vault/vault-store.js';
import { combineShares } from '../../src/vault/shamir.js';
import { Secp256k1Keypair } from '@atproto/crypto';
import {
  generateCustodyPhrase, deriveCustodyKeys, signPlcOperation, submitPlcOperation, signOwnerRaw, buildCancelOp, plcOperationSigner,
  generateRecoveryPhrase, deriveRecoveryKey, addRecoveryKey, removeRecoveryKey, recoverWithRecoveryKey,
  type CustodyKeys, type PlcOperation, type RecoveryKey, type SignedPlcOperation,
} from '../../packages/openfederation-sdk/src/custody/index.js';

const PASSWORD = 'TestPassword123!';
const PREPARE = 'net.openfederation.identity.prepareCustodyChange';
const FINALIZE = 'net.openfederation.identity.finalizeCustodyChange';
const RECOVER = 'net.openfederation.identity.recoverAssistedAccount';
const inbox: { to: string; subject: string; html: string }[] = [];
const plcUrl = () => config.plc.directoryUrl;

type User = Awaited<ReturnType<typeof createTestUser>>;

async function rotationKeys(did: string): Promise<string[]> {
  return (await (await fetch(`${plcUrl()}/${did}/data`)).json()).rotationKeys;
}
async function ownerKey(did: string): Promise<string | undefined> {
  return (await (await fetch(`${plcUrl()}/${did}/data`)).json()).verificationMethods.openfederation_owner;
}
async function plcLog(did: string): Promise<SignedPlcOperation[]> {
  return (await fetch(`${plcUrl()}/${did}/log`)).json();
}
async function mode(did: string) {
  return (await query<{ custody_mode: string }>('SELECT custody_mode FROM users WHERE did = $1', [did])).rows[0].custody_mode;
}
async function pdsKeyHeld(did: string): Promise<string | null> {
  const [a, b] = [await getShare(did, 2), await getShare(did, 3)];
  return a && b ? (await Secp256k1Keypair.import(combineShares([a, b]))).did() : null;
}
function possession(did: string, cid: string, k: CustodyKeys) {
  const text = `OpenFederation Custody Change v1\ndid: ${did}\noperation: ${cid}`;
  return { rotation: signOwnerRaw(k.rotationPrivateKey, text), owner: signOwnerRaw(k.ownerPrivateKey, text) };
}

/** A custodial test user the PDS moves to `target`, holding `keys`. */
async function personHeld(target: 'self' | 'assisted', keys: CustodyKeys): Promise<User> {
  const u = await createTestUser(uniqueHandle('rk'));
  const newKeys = { userRotationDidKey: keys.rotationDidKey, ownerDidKey: keys.ownerDidKey };
  const prep = await xrpcAuthPost(PREPARE, u.accessJwt, { password: PASSWORD, targetMode: target, ...newKeys });
  const fin = await xrpcAuthPost(FINALIZE, u.accessJwt, {
    password: PASSWORD, targetMode: target, ...newKeys, operationCid: prep.body.operationCid, possession: possession(u.did, prep.body.operationCid, keys),
  });
  expect(fin.status).toBe(200);
  return u;
}

/** A change the user signs (towards the PDS, or assisted → self). */
async function userSignedChange(u: User, keys: CustodyKeys, target: string): Promise<{ operation: PlcOperation }> {
  const prep = await xrpcAuthPost(PREPARE, u.accessJwt, { password: PASSWORD, targetMode: target });
  expect(prep.status).toBe(200);
  await submitPlcOperation(plcUrl(), u.did, signPlcOperation(prep.body.operation, keys.rotationPrivateKey));
  const done = await xrpcAuthPost(FINALIZE, u.accessJwt, {
    password: PASSWORD, targetMode: target, operationCid: prep.body.operationCid,
    ...(prep.body.pdsRotationDidKey ? { pdsRotationDidKey: prep.body.pdsRotationDidKey } : {}),
  });
  expect(done.status).toBe(200);
  return prep.body;
}

describe('recovery key (#238)', () => {
  let plc = false;
  beforeAll(async () => {
    plc = await isPLCAvailable();
    setEmailSenderForTests(async (to, subject, html) => { inbox.push({ to, subject, html }); });
  });
  afterAll(() => setEmailSenderForTests(null));

  describe('a self account', () => {
    let user: User;
    let phrase: CustodyKeys;
    let recovery: RecoveryKey;
    let fresh: CustodyKeys;

    beforeAll(async () => {
      if (!plc) return;
      phrase = deriveCustodyKeys(generateCustodyPhrase());
      recovery = deriveRecoveryKey(generateRecoveryPhrase());
      user = await personHeld('self', phrase);
    });

    it('adds a recovery key below its phrase key, without the PDS', async () => {
      if (!plc) return;
      await addRecoveryKey({ plcUrl: plcUrl(), did: user.did, rotationPrivateKey: phrase.rotationPrivateKey, mode: 'self', recoveryDidKey: recovery.recoveryDidKey });
      expect(await rotationKeys(user.did)).toEqual([phrase.rotationDidKey, recovery.recoveryDidKey]);
      expect(await mode(user.did)).toBe('self');
      const level = await xrpcAuthGet('net.openfederation.account.getSecurityLevel', user.accessJwt);
      expect(level.body).toMatchObject({ custodyMode: 'self', pdsHoldsRotationKey: false });
    });

    it('loses the phrase and recovers with the recovery key; the mode stays self and the account still writes', async () => {
      if (!plc) return;
      fresh = deriveCustodyKeys(generateCustodyPhrase());
      const res = await recoverWithRecoveryKey({
        plcUrl: plcUrl(), did: user.did, recoveryPrivateKey: recovery.recoveryPrivateKey,
        newRotationDidKey: fresh.rotationDidKey, newOwnerDidKey: fresh.ownerDidKey,
      });
      expect(res.cancelUntil.getTime() - Date.now()).toBeGreaterThan(71 * 3600_000);
      expect(await rotationKeys(user.did)).toEqual([fresh.rotationDidKey, recovery.recoveryDidKey]);
      expect(await ownerKey(user.did)).toBe(fresh.ownerDidKey);
      expect(await mode(user.did)).toBe('self');
      // Signed by a lower key: the dashboard's history shows it as cancellable with the old phrase.
      const signer = plcOperationSigner(res.operation, res.previous.rotationKeys);
      expect(res.previous.rotationKeys.indexOf(signer!)).toBeGreaterThan(0);

      const post = await xrpcAuthPost('com.atproto.repo.createRecord', user.accessJwt, {
        repo: user.did, collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.post', text: 'still here', createdAt: new Date().toISOString() },
      });
      expect(post.status).toBe(200);
    });

    it('the phrase cancels a recovery someone else starts with the recovery key, within 72 hours', async () => {
      if (!plc) return;
      const thief = deriveCustodyKeys(generateCustodyPhrase());
      const stolen = await recoverWithRecoveryKey({
        plcUrl: plcUrl(), did: user.did, recoveryPrivateKey: recovery.recoveryPrivateKey,
        newRotationDidKey: thief.rotationDidKey, newOwnerDidKey: thief.ownerDidKey,
      });
      expect((await rotationKeys(user.did))[0]).toBe(thief.rotationDidKey);
      await submitPlcOperation(plcUrl(), user.did, signPlcOperation(buildCancelOp(stolen.previous), fresh.rotationPrivateKey));
      expect(await rotationKeys(user.did)).toEqual([fresh.rotationDidKey, recovery.recoveryDidKey]);
      expect(await ownerKey(user.did)).toBe(fresh.ownerDidKey);
    });

    it('self → assisted → self keeps the recovery key under the phrase key, the PDS key last', async () => {
      if (!plc) return;
      const toAssisted = await userSignedChange(user, fresh, 'assisted');
      const pds = (await pdsKeyHeld(user.did))!;
      expect(toAssisted.operation.rotationKeys).toEqual([fresh.rotationDidKey, recovery.recoveryDidKey, pds]);
      expect(await rotationKeys(user.did)).toEqual([fresh.rotationDidKey, recovery.recoveryDidKey, pds]);
      expect(await mode(user.did)).toBe('assisted');

      const toSelf = await userSignedChange(user, fresh, 'self');
      expect(toSelf.operation.rotationKeys).toEqual([fresh.rotationDidKey, recovery.recoveryDidKey]);
      expect(await mode(user.did)).toBe('self');
      expect(await pdsKeyHeld(user.did)).toBeNull();
    });

    it('removes the recovery key with the phrase', async () => {
      if (!plc) return;
      await removeRecoveryKey({ plcUrl: plcUrl(), did: user.did, rotationPrivateKey: fresh.rotationPrivateKey, mode: 'self' });
      expect(await rotationKeys(user.did)).toEqual([fresh.rotationDidKey]);
    });
  });

  describe('an assisted account', () => {
    let admin: string;
    let user: User;
    let phrase: CustodyKeys;
    let recovery: RecoveryKey;
    let pds: string;

    beforeAll(async () => {
      if (!plc) return;
      admin = await getAdminToken();
      phrase = deriveCustodyKeys(generateCustodyPhrase());
      recovery = deriveRecoveryKey(generateRecoveryPhrase());
      user = await personHeld('assisted', phrase);
      pds = (await pdsKeyHeld(user.did))!;
      await addRecoveryKey({ plcUrl: plcUrl(), did: user.did, rotationPrivateKey: phrase.rotationPrivateKey, mode: 'assisted', recoveryDidKey: recovery.recoveryDidKey });
    });

    it('lists phrase key, recovery key, PDS key', async () => {
      if (!plc) return;
      expect(await rotationKeys(user.did)).toEqual([phrase.rotationDidKey, recovery.recoveryDidKey, pds]);
    });

    it("the server's assisted recovery keeps the recovery key in place", async () => {
      if (!plc) return;
      inbox.length = 0;
      expect((await xrpcAuthPost('net.openfederation.admin.createVerificationChallenge', admin, { did: user.did })).status).toBe(200);
      const mail = [...inbox].reverse().find((m) => m.subject.includes('Identity Verification'));
      const nonce = mail?.html.match(/letter-spacing: 2px;">([0-9a-f]{64})</)?.[1];
      expect((await xrpcAuthPost('net.openfederation.admin.verifyChallenge', admin, { did: user.did, nonce })).body.verified).toBe(true);

      const fresh = deriveCustodyKeys(generateCustodyPhrase());
      const base = { password: PASSWORD, userRotationDidKey: fresh.rotationDidKey, ownerDidKey: fresh.ownerDidKey };
      const plan = await xrpcAuthPost(RECOVER, user.accessJwt, base);
      expect(plan.status).toBe(200);
      expect(plan.body.operation.rotationKeys).toEqual([fresh.rotationDidKey, recovery.recoveryDidKey, pds]);
      const res = await xrpcAuthPost(RECOVER, user.accessJwt, { ...base, operationCid: plan.body.operationCid, possession: possession(user.did, plan.body.operationCid, fresh) });
      expect(res.status).toBe(200);
      expect(await rotationKeys(user.did)).toEqual([fresh.rotationDidKey, recovery.recoveryDidKey, pds]);

      // The old phrase cancels it (it outranks the PDS key that signed).
      const log = await plcLog(user.did);
      await submitPlcOperation(plcUrl(), user.did, signPlcOperation(buildCancelOp(log[log.length - 2]), phrase.rotationPrivateKey));
      expect(await rotationKeys(user.did)).toEqual([phrase.rotationDidKey, recovery.recoveryDidKey, pds]);
    });

    it('recovers with the recovery key: the PDS key stays, the mode stays assisted', async () => {
      if (!plc) return;
      const fresh = deriveCustodyKeys(generateCustodyPhrase());
      await recoverWithRecoveryKey({
        plcUrl: plcUrl(), did: user.did, recoveryPrivateKey: recovery.recoveryPrivateKey,
        newRotationDidKey: fresh.rotationDidKey, newOwnerDidKey: fresh.ownerDidKey,
      });
      expect(await rotationKeys(user.did)).toEqual([fresh.rotationDidKey, recovery.recoveryDidKey, pds]);
      expect(await mode(user.did)).toBe('assisted');
      expect(await pdsKeyHeld(user.did)).toBe(pds);
      phrase = fresh;
    });

    it('assisted → self keeps the recovery key; assisted → custodial takes it out with the owner key', async () => {
      if (!plc) return;
      const toSelf = await userSignedChange(user, phrase, 'self');
      expect(toSelf.operation.rotationKeys).toEqual([phrase.rotationDidKey, recovery.recoveryDidKey]);

      const toAssisted = await userSignedChange(user, phrase, 'assisted');
      const newPds = (await pdsKeyHeld(user.did))!;
      expect(toAssisted.operation.rotationKeys).toEqual([phrase.rotationDidKey, recovery.recoveryDidKey, newPds]);

      const toCustodial = await userSignedChange(user, phrase, 'custodial');
      expect(toCustodial.operation.rotationKeys).toEqual([newPds]);
      expect(await mode(user.did)).toBe('custodial');
    });
  });
});
