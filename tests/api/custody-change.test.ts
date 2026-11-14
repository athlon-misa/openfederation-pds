/**
 * Custody modes, step 4a (ADR-003, decision 5): changing modes in every
 * direction. Towards the person, the PDS signs with its key after proof that
 * the user holds the new keys. Towards the PDS, the user signs with their
 * rotation key and submits to PLC; a password alone never hands the identity
 * over. The mode changes only once PLC shows the result; finalize is
 * idempotent.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { xrpcAuthPost, xrpcAuthGet, createTestUser, isPLCAvailable, uniqueHandle } from './helpers.js';
import { query } from '../../src/db/client.js';
import { config } from '../../src/config.js';
import { runtimeSettings } from '../../src/settings/runtime-settings.js';
import { setEmailSenderForTests } from '../../src/email/email-service.js';
import { getShare } from '../../src/vault/vault-store.js';
import { combineShares } from '../../src/vault/shamir.js';
import { Secp256k1Keypair } from '@atproto/crypto';
import {
  generateCustodyPhrase, deriveCustodyKeys, signPlcOperation, submitPlcOperation, signOwnerRaw,
  type CustodyKeys, type PlcOperation,
} from '../../packages/openfederation-sdk/src/custody/index.js';

const PASSWORD = 'TestPassword123!';
const PREPARE = 'net.openfederation.identity.prepareCustodyChange';
const FINALIZE = 'net.openfederation.identity.finalizeCustodyChange';
const mails: { to: string; subject: string }[] = [];

type User = Awaited<ReturnType<typeof createTestUser>>;

async function plcData(did: string) {
  return (await fetch(`${config.plc.directoryUrl}/${did}/data`)).json() as Promise<{ rotationKeys: string[]; verificationMethods: Record<string, string> }>;
}
async function mode(did: string) {
  return (await query<{ custody_mode: string }>('SELECT custody_mode FROM users WHERE did = $1', [did])).rows[0].custody_mode;
}
async function pdsKeyHeld(did: string): Promise<string | null> {
  const [a, b] = [await getShare(did, 2), await getShare(did, 3)];
  return a && b ? (await Secp256k1Keypair.import(combineShares([a, b]))).did() : null;
}
/** What the client signs to prove it holds the new keys (decision 5). */
function possession(did: string, cid: string, keys: CustodyKeys) {
  const text = `OpenFederation Custody Change v1\ndid: ${did}\noperation: ${cid}`;
  return { rotation: signOwnerRaw(keys.rotationPrivateKey, text), owner: signOwnerRaw(keys.ownerPrivateKey, text) };
}

describe('changing custody modes', () => {
  let plc = false;
  let user: User;
  let keys: CustodyKeys;
  let originalPdsKey: string;
  const savedAllowed = [...runtimeSettings().identity.custodyAllowed];

  beforeAll(async () => {
    plc = await isPLCAvailable();
    setEmailSenderForTests(async (to, subject) => { mails.push({ to, subject }); });
    if (!plc) return;
    user = await createTestUser(uniqueHandle('cc'));
    keys = deriveCustodyKeys(generateCustodyPhrase());
    originalPdsKey = (await pdsKeyHeld(user.did))!;
  });
  afterAll(() => { setEmailSenderForTests(null); runtimeSettings().identity.custodyAllowed = [...savedAllowed]; });
  beforeEach(() => { mails.length = 0; runtimeSettings().identity.custodyAllowed = [...savedAllowed]; });

  const prepare = (target: string, extra: Record<string, unknown> = {}) =>
    xrpcAuthPost(PREPARE, user.accessJwt, { password: PASSWORD, targetMode: target, ...extra });
  const finalize = (target: string, extra: Record<string, unknown>) =>
    xrpcAuthPost(FINALIZE, user.accessJwt, { password: PASSWORD, targetMode: target, ...extra });

  it('custodial → assisted: refuses a wrong password or a bad possession proof, then the PDS signs; finalize is idempotent', async () => {
    if (!plc) return;
    const newKeys = { userRotationDidKey: keys.rotationDidKey, ownerDidKey: keys.ownerDidKey };
    expect((await xrpcAuthPost(PREPARE, user.accessJwt, { password: 'Wrong-pass-123!', targetMode: 'assisted', ...newKeys })).status).toBe(401);

    const prep = await prepare('assisted', newKeys);
    expect(prep.status).toBe(200);
    expect(prep.body).toMatchObject({ signer: 'pds' });
    expect(prep.body.operation.rotationKeys).toEqual([keys.rotationDidKey, originalPdsKey]);
    expect(prep.body.operation.verificationMethods.openfederation_owner).toBe(keys.ownerDidKey);

    const stranger = deriveCustodyKeys(generateCustodyPhrase());
    const bad = await finalize('assisted', { ...newKeys, operationCid: prep.body.operationCid, possession: possession(user.did, prep.body.operationCid, stranger) });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('PossessionProofInvalid');
    expect((await plcData(user.did)).rotationKeys).toEqual([originalPdsKey]);

    const proof = possession(user.did, prep.body.operationCid, keys);
    const ok = await finalize('assisted', { ...newKeys, operationCid: prep.body.operationCid, possession: proof });
    expect(ok.status).toBe(200);
    expect(ok.body.custodyMode).toBe('assisted');
    expect((await plcData(user.did)).rotationKeys).toEqual([keys.rotationDidKey, originalPdsKey]);
    expect(await mode(user.did)).toBe('assisted');
    expect(await pdsKeyHeld(user.did)).toBe(originalPdsKey);
    expect(mails.some((m) => /custody/i.test(m.subject))).toBe(true);

    const again = await finalize('assisted', { ...newKeys, operationCid: prep.body.operationCid, possession: proof });
    expect(again.status).toBe(200);
  });

  it('assisted → self: the user signs and submits; the PDS deletes its shares once PLC shows it', async () => {
    if (!plc) return;
    const prep = await prepare('self');
    expect(prep.body).toMatchObject({ signer: 'user' });
    expect(prep.body.operation.rotationKeys).toEqual([keys.rotationDidKey]);

    const early = await finalize('self', { operationCid: prep.body.operationCid });
    expect(early.status).toBe(400);
    expect(early.body.error).toBe('NotSubmitted');

    await submitPlcOperation(config.plc.directoryUrl, user.did, signPlcOperation(prep.body.operation as PlcOperation, keys.rotationPrivateKey));
    const done = await finalize('self', { operationCid: prep.body.operationCid });
    expect(done.status).toBe(200);
    expect(await mode(user.did)).toBe('self');
    expect(await pdsKeyHeld(user.did)).toBeNull();
    const level = await xrpcAuthGet('net.openfederation.account.getSecurityLevel', user.accessJwt);
    expect(level.body).toMatchObject({ custodyMode: 'self', pdsHoldsRotationKey: false });
  });

  it('self → assisted: the PDS makes a new key for itself; the user adds it', async () => {
    if (!plc) return;
    const prep = await prepare('assisted');
    expect(prep.body.signer).toBe('user');
    const newPdsKey = prep.body.pdsRotationDidKey as string;
    expect(newPdsKey).toMatch(/^did:key:zQ3s/);
    expect(newPdsKey).not.toBe(originalPdsKey);
    expect(prep.body.operation.rotationKeys).toEqual([keys.rotationDidKey, newPdsKey]);

    await submitPlcOperation(config.plc.directoryUrl, user.did, signPlcOperation(prep.body.operation as PlcOperation, keys.rotationPrivateKey));
    const done = await finalize('assisted', { operationCid: prep.body.operationCid, pdsRotationDidKey: newPdsKey });
    expect(done.status).toBe(200);
    expect(await mode(user.did)).toBe('assisted');
    expect(await pdsKeyHeld(user.did)).toBe(newPdsKey);
  });

  it('assisted → custodial: the user signs; the owner key leaves the DID', async () => {
    if (!plc) return;
    const pdsKey = (await pdsKeyHeld(user.did))!;
    const prep = await prepare('custodial');
    expect(prep.body.operation.rotationKeys).toEqual([pdsKey]);
    expect(prep.body.operation.verificationMethods.openfederation_owner).toBeUndefined();
    await submitPlcOperation(config.plc.directoryUrl, user.did, signPlcOperation(prep.body.operation as PlcOperation, keys.rotationPrivateKey));
    const done = await finalize('custodial', { operationCid: prep.body.operationCid });
    expect(done.status).toBe(200);
    expect(await mode(user.did)).toBe('custodial');
    expect((await plcData(user.did)).rotationKeys).toEqual([pdsKey]);
  });

  it('custodial → self in one step: the PDS signs, then deletes its shares', async () => {
    if (!plc) return;
    const fresh = deriveCustodyKeys(generateCustodyPhrase());
    const newKeys = { userRotationDidKey: fresh.rotationDidKey, ownerDidKey: fresh.ownerDidKey };
    const prep = await prepare('self', newKeys);
    expect(prep.body.signer).toBe('pds');
    const done = await finalize('self', { ...newKeys, operationCid: prep.body.operationCid, possession: possession(user.did, prep.body.operationCid, fresh) });
    expect(done.status).toBe(200);
    expect(await mode(user.did)).toBe('self');
    expect(await pdsKeyHeld(user.did)).toBeNull();
    expect((await plcData(user.did)).rotationKeys).toEqual([fresh.rotationDidKey]);
  });

  it('refuses the same mode, a mode the policy excludes, and a stale operation', async () => {
    if (!plc) return;
    const other = await createTestUser(uniqueHandle('cc2'));
    const k = deriveCustodyKeys(generateCustodyPhrase());
    const newKeys = { userRotationDidKey: k.rotationDidKey, ownerDidKey: k.ownerDidKey };
    const same = await xrpcAuthPost(PREPARE, other.accessJwt, { password: PASSWORD, targetMode: 'custodial' });
    expect(same.body.error).toBe('InvalidRequest');
    runtimeSettings().identity.custodyAllowed = ['custodial', 'assisted'];
    const excluded = await xrpcAuthPost(PREPARE, other.accessJwt, { password: PASSWORD, targetMode: 'self', ...newKeys });
    expect(excluded.status).toBe(403);
    expect(excluded.body.error).toBe('CustodyModeNotAllowed');
    const prep = await xrpcAuthPost(PREPARE, other.accessJwt, { password: PASSWORD, targetMode: 'assisted', ...newKeys });
    const stale = await xrpcAuthPost(FINALIZE, other.accessJwt, {
      password: PASSWORD, targetMode: 'assisted', ...newKeys, operationCid: 'bafyreinotthisoperation', possession: possession(other.did, prep.body.operationCid, k),
    });
    expect(stale.status).toBe(400);
    expect(stale.body.error).toBe('OperationMismatch');
    expect(await mode(other.did)).toBe('custodial');
  });
});
