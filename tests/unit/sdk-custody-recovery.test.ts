/**
 * Optional recovery for `self` and `assisted` identities (#238, ADR-003
 * decision 13), SDK side, against a fake PLC directory that applies PLC's
 * rules: `prev` must be the head (or, to cancel, an earlier operation within
 * 72 hours), and the signer must be a rotation key of the state before;
 * replacing an operation needs a key ranked higher than the one that signed it.
 */
import { describe, it, expect } from 'vitest';
import {
  generateCustodyPhrase, deriveCustodyKeys, buildCustodyGenesisOp, signPlcOperation, didForGenesisOp, cidForPlcOp,
  plcOperationSigner, buildCancelOp, didKeyFor,
  generateRecoveryPhrase, deriveRecoveryKey, RECOVERY_KEY_PATH, PLC_CANCEL_WINDOW_MS,
  buildAddRecoveryKeyOp, buildRemoveRecoveryKeyOp, buildRecoveryOp, recoveryKeyOf,
  addRecoveryKey, removeRecoveryKey, recoverWithRecoveryKey, leavePds,
  type CustodyKeys, type SignedPlcOperation,
} from '../../packages/openfederation-sdk/src/custody/index.js';
import { secp256k1 } from '@noble/curves/secp256k1';

const FIXED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PLC = 'https://plc.test';

function fakePlc() {
  const logs = new Map<string, { op: SignedPlcOperation; at: number }[]>();
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const [, did, tail] = url.pathname.split('/');
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const log = logs.get(did);
    if (init?.method === 'POST') {
      const op = JSON.parse(String(init.body)) as SignedPlcOperation;
      if (op.prev === null) { logs.set(did, [{ op, at: Date.now() }]); return json(200, {}); }
      if (!log) return json(404, { message: 'unknown DID' });
      const i = log.findIndex((e) => cidForPlcOp(e.op) === op.prev);
      if (i === -1) return json(400, { message: 'prev not found' });
      const keys = log[i].op.rotationKeys;
      const signer = plcOperationSigner(op, keys);
      if (!signer) return json(400, { message: 'invalid signature' });
      if (i < log.length - 1) {
        const replaced = log[i + 1];
        const replacedSigner = plcOperationSigner(replaced.op, keys)!;
        if (keys.indexOf(signer) >= keys.indexOf(replacedSigner)) return json(400, { message: 'not a higher key' });
        if (Date.now() - replaced.at > PLC_CANCEL_WINDOW_MS) return json(400, { message: 'too late' });
        log.splice(i + 1);
      }
      log.push({ op, at: Date.now() });
      return json(200, {});
    }
    if (!log) return json(404, { message: 'unknown DID' });
    if (tail === 'log') return json(200, log.map((e) => e.op));
    if (tail === 'data') { const { sig: _s, prev: _p, type: _t, ...data } = log[log.length - 1].op; return json(200, data); }
    return json(404, {});
  }) as typeof globalThis.fetch;
  return { fetch, head: (did: string) => logs.get(did)!.at(-1)!.op };
}

const randomDidKey = () => didKeyFor('secp256k1', secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), true));

async function genesis(plc: ReturnType<typeof fakePlc>, mode: 'self' | 'assisted', keys: CustodyKeys, pdsRotationDidKey?: string): Promise<string> {
  const signed = signPlcOperation(buildCustodyGenesisOp({
    mode, userRotationDidKey: keys.rotationDidKey, pdsRotationDidKey, atprotoDidKey: randomDidKey(), ownerDidKey: keys.ownerDidKey,
    handle: 'rec.example.test', pdsEndpoint: 'https://pds.example.test',
  }), keys.rotationPrivateKey);
  const did = didForGenesisOp(signed);
  await plc.fetch(`${PLC}/${did}`, { method: 'POST', body: JSON.stringify(signed) });
  return did;
}

describe('recovery phrase', () => {
  it('derives its own key at its own path: never the identity phrase\'s keys, even from the same words', () => {
    expect(RECOVERY_KEY_PATH).toBe("m/1985'/2'");
    const id = deriveCustodyKeys(FIXED);
    const rec = deriveRecoveryKey(FIXED);
    expect(rec.recoveryDidKey).toMatch(/^did:key:zQ3s/);
    expect([id.rotationDidKey, id.ownerDidKey]).not.toContain(rec.recoveryDidKey);
    expect(deriveRecoveryKey(`  ${FIXED.toUpperCase()} `).recoveryDidKey).toBe(rec.recoveryDidKey);
    expect(generateRecoveryPhrase().split(' ')).toHaveLength(12);
    expect(() => deriveRecoveryKey('one two three')).toThrow('InvalidPhrase');
  });
});

describe('recovery operations', () => {
  const base = (rotationKeys: string[]): SignedPlcOperation => ({
    type: 'plc_operation', prev: null, rotationKeys, sig: 'x',
    verificationMethods: { atproto: 'did:key:zAtproto', openfederation_owner: 'did:key:zOwner' },
    alsoKnownAs: ['at://a.example'], services: { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: 'https://pds.example' } },
  });

  it('add: directly below the phrase key, everything else kept; refused when one is there', () => {
    const r = randomDidKey(); const u = randomDidKey(); const pds = randomDidKey();
    expect(buildAddRecoveryKeyOp({ previous: base([u]), mode: 'self', recoveryDidKey: r }).rotationKeys).toEqual([u, r]);
    const op = buildAddRecoveryKeyOp({ previous: base([u, pds]), mode: 'assisted', recoveryDidKey: r });
    expect(op.rotationKeys).toEqual([u, r, pds]);
    expect(op.verificationMethods).toEqual(base([]).verificationMethods);
    expect(op.alsoKnownAs).toEqual(['at://a.example']);
    expect(op.prev).toBe(cidForPlcOp(base([u, pds])));
    expect(() => buildAddRecoveryKeyOp({ previous: base([u, r]), mode: 'self', recoveryDidKey: randomDidKey() })).toThrow(/already has a recovery key/);
    expect(() => buildAddRecoveryKeyOp({ previous: base([u, r, pds]), mode: 'assisted', recoveryDidKey: randomDidKey() })).toThrow(/already has a recovery key/);
    expect(() => buildAddRecoveryKeyOp({ previous: base([u]), mode: 'self', recoveryDidKey: u })).toThrow(/already a rotation key/);
    expect(() => buildAddRecoveryKeyOp({ previous: base([u]), mode: 'assisted', recoveryDidKey: r })).toThrow(/assisted/);
  });

  it('remove: the inverse', () => {
    const r = randomDidKey(); const u = randomDidKey(); const pds = randomDidKey();
    expect(recoveryKeyOf([u, r, pds], 'assisted')).toBe(r);
    expect(recoveryKeyOf([u, pds], 'assisted')).toBeNull();
    expect(buildRemoveRecoveryKeyOp({ previous: base([u, r, pds]), mode: 'assisted' }).rotationKeys).toEqual([u, pds]);
    expect(buildRemoveRecoveryKeyOp({ previous: base([u, r]), mode: 'self' }).rotationKeys).toEqual([u]);
    expect(() => buildRemoveRecoveryKeyOp({ previous: base([u]), mode: 'self' })).toThrow(/no recovery key/);
  });

  it('recover: new phrase key first and new owner key, recovery key (or a new one) next, the rest kept', () => {
    const r = randomDidKey(); const u = randomDidKey(); const pds = randomDidKey(); const n = randomDidKey(); const o = randomDidKey();
    const op = buildRecoveryOp({ previous: base([u, r, pds]), recoveryDidKey: r, newRotationDidKey: n, newOwnerDidKey: o });
    expect(op.rotationKeys).toEqual([n, r, pds]);
    expect(op.verificationMethods).toEqual({ atproto: 'did:key:zAtproto', openfederation_owner: o });
    const r2 = randomDidKey();
    expect(buildRecoveryOp({ previous: base([u, r]), recoveryDidKey: r, newRotationDidKey: n, newOwnerDidKey: o, newRecoveryDidKey: r2 }).rotationKeys).toEqual([n, r2]);
    expect(() => buildRecoveryOp({ previous: base([u, pds]), recoveryDidKey: r, newRotationDidKey: n, newOwnerDidKey: o })).toThrow(/not a rotation key/);
    expect(() => buildRecoveryOp({ previous: base([u, r]), recoveryDidKey: r, newRotationDidKey: r, newOwnerDidKey: o })).toThrow(/differ/);
  });
});

describe('add, lose the phrase, recover (fake PLC)', () => {
  it('self: add, recover with the recovery key, and the old phrase can cancel it', async () => {
    const plc = fakePlc();
    const io = { plcUrl: PLC, fetch: plc.fetch };
    const phrase = deriveCustodyKeys(generateCustodyPhrase());
    const recovery = deriveRecoveryKey(generateRecoveryPhrase());
    const did = await genesis(plc, 'self', phrase);

    const added = await addRecoveryKey({ ...io, did, rotationPrivateKey: phrase.rotationPrivateKey, mode: 'self', recoveryDidKey: recovery.recoveryDidKey });
    expect(plc.head(did).rotationKeys).toEqual([phrase.rotationDidKey, recovery.recoveryDidKey]);
    expect(added.previous.rotationKeys).toEqual([phrase.rotationDidKey]);
    await expect(addRecoveryKey({ ...io, did, rotationPrivateKey: phrase.rotationPrivateKey, mode: 'self', recoveryDidKey: randomDidKey() }))
      .rejects.toThrow(/already has a recovery key/);

    const fresh = deriveCustodyKeys(generateCustodyPhrase());
    const before = Date.now();
    const rec = await recoverWithRecoveryKey({ ...io, did, recoveryPrivateKey: recovery.recoveryPrivateKey, newRotationDidKey: fresh.rotationDidKey, newOwnerDidKey: fresh.ownerDidKey });
    expect(plc.head(did).rotationKeys).toEqual([fresh.rotationDidKey, recovery.recoveryDidKey]);
    expect(plc.head(did).verificationMethods.openfederation_owner).toBe(fresh.ownerDidKey);
    expect(plcOperationSigner(rec.operation, rec.previous.rotationKeys)).toBe(recovery.recoveryDidKey);
    expect(rec.cancelUntil.getTime()).toBeGreaterThanOrEqual(before + PLC_CANCEL_WINDOW_MS);
    expect(rec.cancelUntil.getTime()).toBeLessThanOrEqual(Date.now() + PLC_CANCEL_WINDOW_MS);

    // The old phrase still holds the top key of the state before: it cancels.
    const cancel = signPlcOperation(buildCancelOp(rec.previous), phrase.rotationPrivateKey);
    expect((await plc.fetch(`${PLC}/${did}`, { method: 'POST', body: JSON.stringify(cancel) })).ok).toBe(true);
    expect(plc.head(did).rotationKeys).toEqual([phrase.rotationDidKey, recovery.recoveryDidKey]);
    expect(plc.head(did).verificationMethods.openfederation_owner).toBe(phrase.ownerDidKey);
  });

  it('assisted: the PDS backup key stays last; remove takes the recovery key out', async () => {
    const plc = fakePlc();
    const io = { plcUrl: PLC, fetch: plc.fetch };
    const phrase = deriveCustodyKeys(generateCustodyPhrase());
    const pds = randomDidKey();
    const recovery = deriveRecoveryKey(generateRecoveryPhrase());
    const did = await genesis(plc, 'assisted', phrase, pds);

    await addRecoveryKey({ ...io, did, rotationPrivateKey: phrase.rotationPrivateKey, mode: 'assisted', recoveryDidKey: recovery.recoveryDidKey });
    expect(plc.head(did).rotationKeys).toEqual([phrase.rotationDidKey, recovery.recoveryDidKey, pds]);
    await removeRecoveryKey({ ...io, did, rotationPrivateKey: phrase.rotationPrivateKey, mode: 'assisted' });
    expect(plc.head(did).rotationKeys).toEqual([phrase.rotationDidKey, pds]);
    await addRecoveryKey({ ...io, did, rotationPrivateKey: phrase.rotationPrivateKey, mode: 'assisted', recoveryDidKey: recovery.recoveryDidKey });

    const fresh = deriveCustodyKeys(generateCustodyPhrase());
    const newRecovery = deriveRecoveryKey(generateRecoveryPhrase());
    await recoverWithRecoveryKey({ ...io, did, recoveryPrivateKey: recovery.recoveryPrivateKey, newRotationDidKey: fresh.rotationDidKey, newOwnerDidKey: fresh.ownerDidKey, newRecoveryDidKey: newRecovery.recoveryDidKey });
    expect(plc.head(did).rotationKeys).toEqual([fresh.rotationDidKey, newRecovery.recoveryDidKey, pds]);
  });

  it('refuses before submitting: a key that is not first, or a recovery key the DID does not list', async () => {
    const plc = fakePlc();
    const io = { plcUrl: PLC, fetch: plc.fetch };
    const phrase = deriveCustodyKeys(generateCustodyPhrase());
    const other = deriveCustodyKeys(generateCustodyPhrase());
    const recovery = deriveRecoveryKey(generateRecoveryPhrase());
    const did = await genesis(plc, 'self', phrase);
    await expect(addRecoveryKey({ ...io, did, rotationPrivateKey: other.rotationPrivateKey, mode: 'self', recoveryDidKey: recovery.recoveryDidKey }))
      .rejects.toThrow(/first rotation key/);
    await expect(removeRecoveryKey({ ...io, did, rotationPrivateKey: phrase.rotationPrivateKey, mode: 'self' })).rejects.toThrow(/no recovery key/);
    await expect(recoverWithRecoveryKey({ ...io, did, recoveryPrivateKey: recovery.recoveryPrivateKey, newRotationDidKey: other.rotationDidKey, newOwnerDidKey: other.ownerDidKey }))
      .rejects.toThrow(/not a rotation key/);
    expect(plc.head(did).rotationKeys).toEqual([phrase.rotationDidKey]);
  });

  it('leavePds keeps a recovery key when asked', async () => {
    const plc = fakePlc();
    const io = { plcUrl: PLC, fetch: plc.fetch };
    const phrase = deriveCustodyKeys(generateCustodyPhrase());
    const pds = randomDidKey();
    const recovery = deriveRecoveryKey(generateRecoveryPhrase());
    const did = await genesis(plc, 'assisted', phrase, pds);
    await addRecoveryKey({ ...io, did, rotationPrivateKey: phrase.rotationPrivateKey, mode: 'assisted', recoveryDidKey: recovery.recoveryDidKey });
    const atproto = randomDidKey();
    await leavePds({ ...io, did, rotationPrivateKey: phrase.rotationPrivateKey, pdsEndpoint: 'https://new.example', atprotoDidKey: atproto, recoveryDidKey: recovery.recoveryDidKey });
    expect(plc.head(did).rotationKeys).toEqual([phrase.rotationDidKey, recovery.recoveryDidKey]);
  });
});
