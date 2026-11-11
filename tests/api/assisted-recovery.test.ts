/**
 * Custody modes, step 4b (ADR-003, decision 10): recovery for `assisted`
 * accounts. The person lost their phrase; after an identity verification the
 * server signs, with its second-priority key, an update that puts the
 * person's new keys first. The account is emailed every time the server
 * signs for an assisted account, and the old key can cancel the update
 * within 72 hours, so a recovery someone else started fails if the real
 * person still has their phrase.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { xrpcAuthPost, createTestUser, getAdminToken, isPLCAvailable, uniqueHandle } from './helpers.js';
import { query } from '../../src/db/client.js';
import { config } from '../../src/config.js';
import { setEmailSenderForTests } from '../../src/email/email-service.js';
import {
  generateCustodyPhrase, deriveCustodyKeys, signPlcOperation, submitPlcOperation, signOwnerRaw, buildCancelOp,
  type CustodyKeys, type SignedPlcOperation,
} from '../../packages/openfederation-sdk/src/custody/index.js';

const PASSWORD = 'TestPassword123!';
const RECOVER = 'net.openfederation.identity.recoverAssistedAccount';
const inbox: { to: string; subject: string; html: string }[] = [];

type User = Awaited<ReturnType<typeof createTestUser>>;

async function plcData(did: string) {
  return (await fetch(`${config.plc.directoryUrl}/${did}/data`)).json() as Promise<{ rotationKeys: string[]; verificationMethods: Record<string, string> }>;
}
async function plcLog(did: string): Promise<SignedPlcOperation[]> {
  return (await fetch(`${config.plc.directoryUrl}/${did}/log`)).json();
}
async function emailOf(did: string): Promise<string> {
  return (await query<{ email: string }>('SELECT email FROM users WHERE did = $1', [did])).rows[0].email;
}
function possession(did: string, cid: string, k: CustodyKeys) {
  const text = `OpenFederation Custody Change v1\ndid: ${did}\noperation: ${cid}`;
  return { rotation: signOwnerRaw(k.rotationPrivateKey, text), owner: signOwnerRaw(k.ownerPrivateKey, text) };
}
/** Without operationCid the endpoint only plans: the update and the text to sign. */
async function recoveryPlan(u: User, k: CustodyKeys) {
  return xrpcAuthPost(RECOVER, u.accessJwt, { password: PASSWORD, userRotationDidKey: k.rotationDidKey, ownerDidKey: k.ownerDidKey });
}

/** A custodial test user switched to assisted with `keys` (ADR-003 step 4a). */
async function assistedUser(keys: CustodyKeys): Promise<User> {
  const u = await createTestUser(uniqueHandle('ar'));
  const newKeys = { userRotationDidKey: keys.rotationDidKey, ownerDidKey: keys.ownerDidKey };
  const prep = await xrpcAuthPost('net.openfederation.identity.prepareCustodyChange', u.accessJwt, { password: PASSWORD, targetMode: 'assisted', ...newKeys });
  const fin = await xrpcAuthPost('net.openfederation.identity.finalizeCustodyChange', u.accessJwt, {
    password: PASSWORD, targetMode: 'assisted', ...newKeys, operationCid: prep.body.operationCid, possession: possession(u.did, prep.body.operationCid, keys),
  });
  expect(fin.status).toBe(200);
  return u;
}

describe('assisted recovery', () => {
  let plc = false;
  let admin: string;
  let user: User;
  let oldKeys: CustodyKeys;
  let pdsKey: string;

  async function verifyIdentity(u: User) {
    expect((await xrpcAuthPost('net.openfederation.admin.createVerificationChallenge', admin, { did: u.did })).status).toBe(200);
    const mail = [...inbox].reverse().find((m) => m.subject.includes('Identity Verification'));
    const nonce = mail?.html.match(/letter-spacing: 2px;">([0-9a-f]{64})</)?.[1];
    expect((await xrpcAuthPost('net.openfederation.admin.verifyChallenge', admin, { did: u.did, nonce })).body.verified).toBe(true);
  }

  beforeAll(async () => {
    plc = await isPLCAvailable();
    setEmailSenderForTests(async (to, subject, html) => { inbox.push({ to, subject, html }); });
    if (!plc) return;
    admin = await getAdminToken();
    oldKeys = deriveCustodyKeys(generateCustodyPhrase());
    user = await assistedUser(oldKeys);
    pdsKey = (await plcData(user.did)).rotationKeys[1];
  });
  afterAll(() => setEmailSenderForTests(null));
  beforeEach(() => { inbox.length = 0; });

  it('needs a fresh identity verification', async () => {
    if (!plc) return;
    const k = deriveCustodyKeys(generateCustodyPhrase());
    const res = await recoveryPlan(user, k);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('VerificationRequired');
  });

  it('after verification, the server signs the person\'s new keys in first, and emails the 72-hour notice', async () => {
    if (!plc) return;
    await verifyIdentity(user);
    const fresh = deriveCustodyKeys(generateCustodyPhrase());
    const plan = await recoveryPlan(user, fresh);
    expect(plan.status).toBe(200);
    expect(plan.body.operation.rotationKeys).toEqual([fresh.rotationDidKey, pdsKey]);

    const wrong = await xrpcAuthPost(RECOVER, user.accessJwt, {
      password: PASSWORD, userRotationDidKey: fresh.rotationDidKey, ownerDidKey: fresh.ownerDidKey,
      operationCid: plan.body.operationCid, possession: possession(user.did, plan.body.operationCid, oldKeys),
    });
    expect(wrong.body.error).toBe('PossessionProofInvalid');

    const res = await xrpcAuthPost(RECOVER, user.accessJwt, {
      password: PASSWORD, userRotationDidKey: fresh.rotationDidKey, ownerDidKey: fresh.ownerDidKey,
      operationCid: plan.body.operationCid, possession: possession(user.did, plan.body.operationCid, fresh),
    });
    expect(res.status).toBe(200);
    expect(new Date(res.body.cancelUntil).getTime() - Date.now()).toBeGreaterThan(71 * 3600_000);
    const data = await plcData(user.did);
    expect(data.rotationKeys).toEqual([fresh.rotationDidKey, pdsKey]);
    expect(data.verificationMethods.openfederation_owner).toBe(fresh.ownerDidKey);
    const notice = inbox.find((m) => /identity was changed/i.test(m.subject));
    expect(notice?.html).toMatch(/72 hours/);
    expect(notice?.to).toBe(await emailOf(user.did));

    // One verification, one recovery.
    const again = await recoveryPlan(user, deriveCustodyKeys(generateCustodyPhrase()));
    expect(again.body.error).toBe('VerificationRequired');
  });

  it('the old key cancels the server\'s update within 72 hours (PLC nullification)', async () => {
    if (!plc) return;
    const log = await plcLog(user.did);
    // The recovery is the latest operation; cancel it from the one before.
    const cancel = signPlcOperation(buildCancelOp(log[log.length - 2]), oldKeys.rotationPrivateKey);
    await submitPlcOperation(config.plc.directoryUrl, user.did, cancel);
    expect((await plcData(user.did)).rotationKeys).toEqual([oldKeys.rotationDidKey, pdsKey]);
  });

  it('is only for assisted accounts', async () => {
    if (!plc) return;
    const custodial = await createTestUser(uniqueHandle('arc'));
    await verifyIdentity(custodial);
    const res = await recoveryPlan(custodial, deriveCustodyKeys(generateCustodyPhrase()));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NotAssisted');
  });

  it('a move signed by the server for an assisted account also sends the notice', async () => {
    if (!plc) return;
    const keys = deriveCustodyKeys(generateCustodyPhrase());
    const u = await assistedUser(keys);
    inbox.length = 0;
    await xrpcAuthPost('com.atproto.identity.requestPlcOperationSignature', u.accessJwt, {});
    const code = inbox.map((m) => m.html.match(/>([0-9A-F]{5}-[0-9A-F]{5})</)?.[1]).find(Boolean);
    const signed = await xrpcAuthPost('com.atproto.identity.signPlcOperation', u.accessJwt, { token: code, password: PASSWORD });
    expect(signed.status).toBe(200);
    expect(inbox.some((m) => /identity was changed/i.test(m.subject) && /72 hours/.test(m.html))).toBe(true);
  });
});
