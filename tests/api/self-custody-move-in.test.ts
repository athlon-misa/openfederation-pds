/**
 * A `self` account moving in without its old PDS (#382, ADR-004): proof of
 * control by the DID's top rotation key at createAccount, and importRepo
 * accepting the repository signed by the key the DID named just before the
 * person's own move here. The old PDS exists only on paper (OLD_PDS); its
 * repo signing key is held by the test.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { Secp256k1Keypair } from '@atproto/crypto';
import { xrpcPost, xrpcAuthPost, xrpcAuthGet, getAdminToken, isPLCAvailable, uniqueHandle } from './helpers.js';
import { query } from '../../src/db/client.js';
import { config } from '../../src/config.js';
import { runtimeSettings } from '../../src/settings/runtime-settings.js';
import {
  generateCustodyPhrase, deriveCustodyKeys, buildCustodyGenesisOp, signPlcOperation, didForGenesisOp,
  submitPlcOperation, leavePds, signRotationKeyJwt, type CustodyKeys,
} from '../../packages/openfederation-sdk/src/custody/index.js';
import {
  OLD_PDS, createAccount, exportedRepo, importRepo, pseudonymElsewhere, openHere, pointHere, userElsewhere, type RecordWrite,
} from './migration-helpers.js';

const PASSWORD = 'Move-in-pw-123!';
const CLAIM = 'net.openfederation.authorship.claim';
const PLC = config.plc.directoryUrl;

interface SelfElsewhere {
  did: string;
  keys: CustodyKeys;
  /** The old PDS's repo signing key, the DID's atproto key. */
  oldKey: Secp256k1Keypair;
  /** In `assisted`: the old PDS's backup rotation key, listed second. */
  backupKey: Secp256k1Keypair;
}

/** An ADR-003 account hosted (on paper) by another PDS. */
async function selfElsewhere(mode: 'self' | 'assisted' = 'self'): Promise<SelfElsewhere> {
  const keys = deriveCustodyKeys(generateCustodyPhrase());
  const [oldKey, backupKey] = await Promise.all([
    Secp256k1Keypair.create({ exportable: true }), Secp256k1Keypair.create({ exportable: true }),
  ]);
  const genesis = signPlcOperation(buildCustodyGenesisOp({
    mode, userRotationDidKey: keys.rotationDidKey, pdsRotationDidKey: mode === 'assisted' ? backupKey.did() : undefined,
    atprotoDidKey: oldKey.did(), ownerDidKey: keys.ownerDidKey,
    handle: `${uniqueHandle('old')}.old-pds.example.test`, pdsEndpoint: OLD_PDS,
  }), keys.rotationPrivateKey);
  const did = didForGenesisOp(genesis);
  await submitPlcOperation(PLC, did, genesis);
  return { did, keys, oldKey, backupKey };
}

function label(): string { return uniqueHandle('mi'); }

async function reserve(did: string): Promise<string> {
  const res = await xrpcPost('com.atproto.server.reserveSigningKey', { did });
  expect(res.status).toBe(200);
  return res.body.signingKey;
}

/** leavePds, pointing the DID here with the reserved key. */
async function leaveHere(a: SelfElsewhere, signingKey: string, o: { signer?: Uint8Array; keepOtherRotationKeys?: boolean; handle?: string } = {}) {
  await leavePds({
    plcUrl: PLC, did: a.did, rotationPrivateKey: o.signer ?? a.keys.rotationPrivateKey,
    pdsEndpoint: config.pds.serviceUrl, atprotoDidKey: signingKey, keepOtherRotationKeys: o.keepOtherRotationKeys,
    ...(o.handle ? { handle: o.handle } : {}),
  });
}

function proof(a: SelfElsewhere, key: Uint8Array = a.keys.rotationPrivateKey, aud = config.pds.serviceDid): string {
  return signRotationKeyJwt({ rotationPrivateKey: key, did: a.did, aud });
}

function body(a: SelfElsewhere, name: string, extra: Record<string, unknown> = {}) {
  return { did: a.did, handle: `${name}${config.handleSuffix}`, email: `${name}@test.local`, password: PASSWORD, ...extra };
}

function claims(n: number): RecordWrite[] {
  return Array.from({ length: n }, (_, i) => ({
    collection: CLAIM, rkey: `3kmovein00${i}`,
    record: { $type: CLAIM, contentHash: `${i}`.repeat(64), url: `https://news.example/move-in/${i}`, createdAt: new Date().toISOString() },
  }));
}

async function invite(): Promise<string> {
  return (await xrpcAuthPost('net.openfederation.invite.create', await getAdminToken(), { maxUses: 1 })).body.code;
}

async function userRow(did: string) {
  return (await query<{ id: string; status: string; custody_mode: string; migrating_in: boolean; rotation_did_key: string | null; auth_type: string }>(
    'SELECT id, status, custody_mode, migrating_in, rotation_did_key, auth_type FROM users WHERE did = $1', [did])).rows[0];
}

describe('self-custody accounts moving in (ADR-004)', () => {
  let plc = false;
  const savedMigration = { ...runtimeSettings().migration };
  const savedCustody = [...runtimeSettings().identity.custodyAllowed];
  beforeAll(async () => { plc = await isPLCAvailable(); });
  afterEach(() => {
    Object.assign(runtimeSettings().migration, savedMigration);
    runtimeSettings().identity.custodyAllowed = [...savedCustody];
  });

  it('leavePds first: opens a self account with the top rotation key, imports the old repository, activates', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    runtimeSettings().migration.accounts = 'open';
    const a = await selfElsewhere();
    const car = await exportedRepo(a.did, a.oldKey, claims(2));
    const name = label();
    await leaveHere(a, await reserve(a.did), { handle: `${name}${config.handleSuffix}` });

    const opened = await createAccount(body(a, name), proof(a));
    expect(opened.status).toBe(200);
    expect(opened.body.rotationDeviceShare).toBeUndefined();
    const row = await userRow(a.did);
    expect(row).toMatchObject({ status: 'deactivated', custody_mode: 'self', migrating_in: true, rotation_did_key: null, auth_type: 'local' });
    expect((await query('SELECT 1 FROM vault_shares WHERE user_did = $1', [a.did])).rows).toHaveLength(0);
    const audit = await query<{ meta: Record<string, unknown> }>(
      `SELECT meta FROM audit_log WHERE action = 'account.moveIn' AND target_id = $1`, [row.id]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].meta).toMatchObject({ did: a.did, method: 'rotation-key' });

    // The DID's current key is this PDS's; the repository is signed by the old PDS's.
    const imported = await importRepo(car, opened.body.accessJwt);
    expect(imported.status).toBe(200);
    const status = await xrpcAuthGet('com.atproto.server.checkAccountStatus', opened.body.accessJwt);
    expect(status.body).toMatchObject({ activated: false, validDid: true, indexedRecords: 2 });

    const activated = await xrpcAuthPost('com.atproto.server.activateAccount', opened.body.accessJwt, {});
    expect(activated.status).toBe(200);
    expect(await userRow(a.did)).toMatchObject({ status: 'approved', custody_mode: 'self', migrating_in: false });

    // A password login works, and the old repository is never accepted again (#265).
    const session = await xrpcPost('com.atproto.server.createSession', { identifier: `${name}@test.local`, password: PASSWORD });
    expect(session.status).toBe(200);
    const security = await xrpcAuthGet('net.openfederation.account.getSecurityLevel', session.body.accessJwt);
    expect(security.body.custodyMode).toBe('self');
    expect((await xrpcAuthPost('com.atproto.server.deactivateAccount', session.body.accessJwt, {})).status).toBe(200);
    const limited = await xrpcPost('com.atproto.server.createSession', { identifier: `${name}@test.local`, password: PASSWORD });
    const again = await importRepo(car, limited.body.accessJwt);
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('InvalidSignature');
  });

  it('open first: imports while the old key is still current, then leavePds and activate', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    runtimeSettings().migration.accounts = 'open';
    const a = await selfElsewhere();
    const name = label();
    const key = await reserve(a.did);
    const opened = await createAccount(body(a, name), proof(a));
    expect(opened.status).toBe(200);
    expect((await importRepo(await exportedRepo(a.did, a.oldKey, claims(1)), opened.body.accessJwt)).status).toBe(200);
    // Not pointing here yet: activation is refused.
    expect((await xrpcAuthPost('com.atproto.server.activateAccount', opened.body.accessJwt, {})).body.error).toBe('IncompatibleDidDoc');
    await leaveHere(a, key);
    expect((await xrpcAuthPost('com.atproto.server.activateAccount', opened.body.accessJwt, {})).status).toBe(200);
  });

  it('refuses to open an account the DID already points at with a key this PDS did not reserve', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    runtimeSettings().migration.accounts = 'open';
    const a = await selfElsewhere();
    await leaveHere(a, (await Secp256k1Keypair.create()).did());
    const res = await createAccount(body(a, label()), proof(a));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('SigningKeyNotReserved');
    expect(await userRow(a.did)).toBeUndefined();
  });

  it('assisted: the person\'s top key opens the account; the old PDS\'s lower key cannot', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    runtimeSettings().migration.accounts = 'open';
    const a = await selfElsewhere('assisted');
    const lower = await createAccount(body(a, label()), proof(a, await a.backupKey.export()));
    expect(lower.status).toBe(401);
    expect(lower.body.error).toBe('InvalidToken');
    expect(await userRow(a.did)).toBeUndefined();
    const top = await createAccount(body(a, label()), proof(a));
    expect(top.status).toBe(200);
    expect((await userRow(a.did)).custody_mode).toBe('self');
  });

  it('refuses a proof signed by a key that is not a rotation key (the owner key, the atproto key\'s owner aside)', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    runtimeSettings().migration.accounts = 'open';
    const a = await selfElsewhere();
    const res = await createAccount(body(a, label()), proof(a, a.keys.ownerPrivateKey));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('InvalidToken');
    const stranger = deriveCustodyKeys(generateCustodyPhrase());
    const other = await createAccount(body(a, label()), proof(a, stranger.rotationPrivateKey));
    expect(other.status).toBe(401);
    const wrongAud = await createAccount(body(a, label()), proof(a, a.keys.rotationPrivateKey, 'did:web:elsewhere.example'));
    expect(wrongAud.status).toBe(401);
    expect(await userRow(a.did)).toBeUndefined();
  });

  it('refuses a user DID without openfederation_owner (only service auth moves it) and asks for email and password', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    runtimeSettings().migration.accounts = 'open';
    const u = await userElsewhere();
    const jwt = signRotationKeyJwt({ rotationPrivateKey: await u.rotationKey.export(), did: u.did, aud: config.pds.serviceDid });
    const res = await createAccount({ did: u.did, handle: `${label()}${config.handleSuffix}`, email: 'x@test.local', password: PASSWORD }, jwt);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('IncompatibleDidDoc');

    const a = await selfElsewhere();
    const noPassword = await createAccount({ did: a.did, handle: `${label()}${config.handleSuffix}` }, proof(a));
    expect(noPassword.status).toBe(400);
    expect(noPassword.body.error).toBe('InvalidRequest');
  });

  it('MIGRATION_ACCOUNTS=closed refuses before anything is stored', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    runtimeSettings().migration.accounts = 'closed';
    const a = await selfElsewhere();
    const res = await createAccount(body(a, label()), proof(a));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('MigrationNotAllowed');
    expect(await userRow(a.did)).toBeUndefined();
    expect((await query('SELECT 1 FROM repo_roots WHERE did = $1', [a.did])).rows).toHaveLength(0);
  });

  it('MIGRATION_ACCOUNTS=invite needs an invite code, and spends it', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    runtimeSettings().migration.accounts = 'invite';
    const a = await selfElsewhere();
    const without = await createAccount(body(a, label()), proof(a));
    expect(without.status).toBe(400);
    expect(without.body.error).toBe('InvalidInviteCode');
    expect(await userRow(a.did)).toBeUndefined();
    const code = await invite();
    const name = label();
    const ok = await createAccount(body(a, name, { inviteCode: code }), proof(a));
    expect(ok.status).toBe(200);
    const used = await query<{ uses_count: number }>('SELECT uses_count FROM invites WHERE code = $1', [code]);
    expect(used.rows[0].uses_count).toBe(1);
  });

  it('refuses when this server does not allow self accounts', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    runtimeSettings().migration.accounts = 'open';
    runtimeSettings().identity.custodyAllowed = ['custodial', 'assisted'];
    const a = await selfElsewhere();
    const res = await createAccount(body(a, label()), proof(a));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('CustodyModeNotAllowed');
  });

  it('refuses a repository signed by the key two operations back; accepts the one just before', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    runtimeSettings().migration.accounts = 'open';
    const a = await selfElsewhere();
    // An intermediate home between the first one and this PDS.
    const middleKey = await Secp256k1Keypair.create({ exportable: true });
    await leavePds({ plcUrl: PLC, did: a.did, rotationPrivateKey: a.keys.rotationPrivateKey, pdsEndpoint: 'https://middle-pds.example.test', atprotoDidKey: middleKey.did() });
    await leaveHere(a, await reserve(a.did));
    const opened = await createAccount(body(a, label()), proof(a));
    expect(opened.status).toBe(200);

    const older = await importRepo(await exportedRepo(a.did, a.oldKey, claims(1)), opened.body.accessJwt);
    expect(older.status).toBe(400);
    expect(older.body.error).toBe('InvalidSignature');
    expect((await importRepo(await exportedRepo(a.did, middleKey, claims(1)), opened.body.accessJwt)).status).toBe(200);
  });

  it('refuses the old PDS\'s repository when the old PDS\'s key signed the move here', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    runtimeSettings().migration.accounts = 'open';
    const a = await selfElsewhere('assisted');
    // The backup key points the DID here; the person's key stays on top.
    await leaveHere(a, await reserve(a.did), { signer: await a.backupKey.export(), keepOtherRotationKeys: true });
    const opened = await createAccount(body(a, label()), proof(a));
    expect(opened.status).toBe(200);
    const res = await importRepo(await exportedRepo(a.did, a.oldKey, claims(1)), opened.body.accessJwt);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidSignature');
  });

  it('refuses the earlier key once another PLC operation followed the move here', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    runtimeSettings().migration.accounts = 'open';
    const a = await selfElsewhere();
    const key = await reserve(a.did);
    await leaveHere(a, key);
    await leaveHere(a, key); // a second update, still pointing here
    const opened = await createAccount(body(a, label()), proof(a));
    expect(opened.status).toBe(200);
    const res = await importRepo(await exportedRepo(a.did, a.oldKey, claims(1)), opened.body.accessJwt);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidSignature');
  });

  it('keeps the current-key rule for pseudonyms: after pointing here, the old PDS\'s repository is refused', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const p = await pseudonymElsewhere();
    const { accessJwt } = await openHere(p);
    await pointHere(p, accessJwt);
    const res = await importRepo(await exportedRepo(p.did, p.oldKey, claims(1)), accessJwt);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidSignature');
  });
});
