/**
 * Custody modes, step 3 (ADR-003, decision 4): sign-up for `assisted` and
 * `self` accounts. The client makes the keys from a phrase, builds and signs
 * the did:plc genesis (the user's key first; in `assisted` the key the PDS
 * reserved second), submits it to PLC, then registers here with the same
 * rules as account.register.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import {
  xrpcPost, xrpcAuthPost, xrpcAuthGet, getAdminToken, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { query } from '../../src/db/client.js';
import { config } from '../../src/config.js';
import { runtimeSettings } from '../../src/settings/runtime-settings.js';
import { getShare } from '../../src/vault/vault-store.js';
import { combineShares } from '../../src/vault/shamir.js';
import { Secp256k1Keypair } from '@atproto/crypto';
import {
  generateCustodyPhrase, deriveCustodyKeys, buildCustodyGenesisOp, buildCustodyChangeOp, signPlcOperation,
  didForGenesisOp, submitPlcOperation, type SelfCustodyMode, type SignedPlcOperation,
} from '../../packages/openfederation-sdk/src/custody/index.js';

const REGISTER = 'net.openfederation.account.registerSelfCustody';
const PASSWORD = 'Self-custody-pw-123!';

async function reserveSigningKey(): Promise<string> {
  const res = await xrpcPost('com.atproto.server.reserveSigningKey', {});
  expect(res.status).toBe(200);
  return res.body.signingKey;
}
async function reservePdsKey(): Promise<string> {
  const res = await xrpcPost('net.openfederation.account.reserveCustodyKey', {});
  expect(res.status).toBe(200);
  return res.body.rotationKey;
}
async function invite(): Promise<string> {
  return (await xrpcAuthPost('net.openfederation.invite.create', await getAdminToken(), { maxUses: 1 })).body.code;
}

interface Prepared { did: string; label: string; email: string; keys: ReturnType<typeof deriveCustodyKeys>; genesis: SignedPlcOperation }

/** Keys from a fresh phrase, a genesis op as the client builds it, submitted to PLC. */
async function prepare(mode: SelfCustodyMode, o: {
  pdsRotationDidKey?: string; extraRotationKey?: boolean; endpoint?: string; handleSuffix?: string; noOwnerKey?: boolean; signingKey?: string;
} = {}): Promise<Prepared> {
  const keys = deriveCustodyKeys(generateCustodyPhrase());
  const label = uniqueHandle('sc');
  const op = buildCustodyGenesisOp({
    mode, userRotationDidKey: keys.rotationDidKey, pdsRotationDidKey: o.pdsRotationDidKey,
    atprotoDidKey: o.signingKey ?? await reserveSigningKey(), ownerDidKey: keys.ownerDidKey,
    handle: `${label}${o.handleSuffix ?? config.handleSuffix}`, pdsEndpoint: o.endpoint ?? config.pds.serviceUrl,
  });
  if (o.extraRotationKey) op.rotationKeys.push(deriveCustodyKeys(generateCustodyPhrase()).rotationDidKey);
  if (o.noOwnerKey) delete op.verificationMethods.openfederation_owner;
  const genesis = signPlcOperation(op, keys.rotationPrivateKey);
  const did = didForGenesisOp(genesis);
  await submitPlcOperation(config.plc.directoryUrl, did, genesis);
  return { did, label, email: `${label}@test.local`, keys, genesis };
}

async function register(p: Prepared, mode: SelfCustodyMode) {
  return xrpcPost(REGISTER, { did: p.did, mode, handle: p.label, email: p.email, password: PASSWORD, inviteCode: await invite() });
}

describe('account.registerSelfCustody', () => {
  let plc = false;
  const saved = [...runtimeSettings().identity.custodyAllowed];
  beforeAll(async () => { plc = await isPLCAvailable(); });
  afterEach(() => { runtimeSettings().identity.custodyAllowed = [...saved]; });

  it('registers a self account: pending approval, no rotation key here, signing key stored', async () => {
    if (!plc) return;
    const p = await prepare('self');
    const res = await register(p, 'self');
    expect(res.status).toBe(201);
    // The full handle, the one in the genesis operation (#411).
    expect(res.body).toMatchObject({ did: p.did, handle: `${p.label}${config.handleSuffix}`, status: 'pending', custodyMode: 'self' });
    const row = await query<{ custody_mode: string; status: string }>('SELECT custody_mode, status FROM users WHERE did = $1', [p.did]);
    expect(row.rows[0]).toEqual({ custody_mode: 'self', status: 'pending' });
    expect((await query('SELECT 1 FROM vault_shares WHERE user_did = $1', [p.did])).rows).toHaveLength(0);
    expect((await query('SELECT 1 FROM user_signing_keys WHERE user_did = $1', [p.did])).rows).toHaveLength(1);
  });

  it('once approved, signs in with the password and reports custody honestly', async () => {
    if (!plc) return;
    const p = await prepare('self');
    const reg = await register(p, 'self');
    expect((await xrpcAuthPost('net.openfederation.account.approve', await getAdminToken(), { userId: reg.body.id })).status).toBe(200);
    const session = await xrpcPost('com.atproto.server.createSession', { identifier: p.label, password: PASSWORD });
    expect(session.status).toBe(200);
    const level = await xrpcAuthGet('net.openfederation.account.getSecurityLevel', session.body.accessJwt);
    expect(level.body).toMatchObject({ custodyMode: 'self', pdsHoldsRotationKey: false });
  });

  it('registers an assisted account: the PDS keeps its reserved key as shares, listed second', async () => {
    if (!plc) return;
    const pdsKey = await reservePdsKey();
    const p = await prepare('assisted', { pdsRotationDidKey: pdsKey });
    const res = await register(p, 'assisted');
    expect(res.status).toBe(201);
    expect(res.body.custodyMode).toBe('assisted');
    const rebuilt = combineShares([(await getShare(p.did, 2))!, (await getShare(p.did, 3))!]);
    expect((await Secp256k1Keypair.import(rebuilt)).did()).toBe(pdsKey);
    // The reservation is used up.
    const again = await prepare('assisted', { pdsRotationDidKey: pdsKey });
    const reused = await register(again, 'assisted');
    expect(reused.status).toBe(400);
    expect(reused.body.error).toBe('PdsKeyNotReserved');
  });

  it('refuses a mode the policy does not allow, before anything is stored', async () => {
    if (!plc) return;
    runtimeSettings().identity.custodyAllowed = ['custodial', 'assisted'];
    const p = await prepare('self');
    const res = await register(p, 'self');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('CustodyModeNotAllowed');
    expect((await query('SELECT 1 FROM users WHERE did = $1', [p.did])).rows).toHaveLength(0);
  });

  it('refuses genesis operations that do not match the mode or this server', async () => {
    if (!plc) return;
    const cases: Array<[string, Promise<Prepared>, SelfCustodyMode, string]> = [
      ['an extra rotation key', prepare('self', { extraRotationKey: true }), 'self', 'InvalidGenesis'],
      ['assisted with only the user key', prepare('self'), 'assisted', 'InvalidGenesis'],
      ['assisted with a key this PDS did not make', prepare('assisted', { pdsRotationDidKey: deriveCustodyKeys(generateCustodyPhrase()).rotationDidKey }), 'assisted', 'PdsKeyNotReserved'],
      ['another server', prepare('self', { endpoint: 'https://elsewhere.example.test' }), 'self', 'InvalidGenesis'],
      ['another handle domain', prepare('self', { handleSuffix: '.elsewhere.example.test' }), 'self', 'InvalidGenesis'],
      ['no owner key', prepare('self', { noOwnerKey: true }), 'self', 'InvalidGenesis'],
      ['a signing key not reserved here', prepare('self', { signingKey: (await Secp256k1Keypair.create()).did() }), 'self', 'SigningKeyNotReserved'],
    ];
    for (const [why, prepared, mode, error] of cases) {
      const p = await prepared;
      const res = await register(p, mode);
      expect(res.body.error, why).toBe(error);
      expect((await query('SELECT 1 FROM users WHERE did = $1', [p.did])).rows, why).toHaveLength(0);
    }
  });

  it('refuses a DID that already has more than its genesis operation', async () => {
    if (!plc) return;
    const p = await prepare('self');
    const update = signPlcOperation(buildCustodyChangeOp({ previous: p.genesis, rotationKeys: [p.keys.rotationDidKey], ownerDidKey: p.keys.ownerDidKey }), p.keys.rotationPrivateKey);
    await submitPlcOperation(config.plc.directoryUrl, p.did, update);
    const res = await register(p, 'self');
    expect(res.body.error).toBe('InvalidGenesis');
  });

  it('refuses a handle that does not match the genesis', async () => {
    if (!plc) return;
    const p = await prepare('self');
    const res = await xrpcPost(REGISTER, { did: p.did, mode: 'self', handle: uniqueHandle('other'), email: p.email, password: PASSWORD, inviteCode: await invite() });
    expect(res.body.error).toBe('InvalidGenesis');
  });
});
