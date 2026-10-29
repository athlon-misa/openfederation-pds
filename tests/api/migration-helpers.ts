/**
 * Helpers for account-migration tests on a single PDS: a pseudonym that
 * PLC says lives on another PDS, the repo that PDS would export, and the
 * account this PDS opens for it.
 */
import { Secp256k1Keypair } from '@atproto/crypto';
import { MemoryBlockstore, Repo, WriteOpAction, blocksToCarFile } from '@atproto/repo';
import { api, uniqueHandle, xrpcAuthGet } from './helpers.js';
import { config } from '../../src/config.js';
import { registerDidPlc } from '../../src/identity/plc-client.js';
import { signServiceAuthJwt } from '../../src/auth/service-auth.js';
import {
  generatePseudonymPhrase, derivePseudonymKeys, buildPseudonymGenesisOp, signGenesisOp, didForSignedOp,
  signOwnerJwt, buildMoveOp, signPlcOp,
} from '../../packages/openfederation-pseudonym/src/index.js';

export const CREATE_ACCOUNT = 'com.atproto.server.createAccount';
export const OLD_PDS = 'https://old-pds.example.test';

export interface PseudonymElsewhere {
  did: string;
  phrase: string;
  /** The old PDS's repo signing key, named as the DID's atproto key. */
  oldKey: Secp256k1Keypair;
}

/** A pseudonym registered in PLC, hosted (on paper) by another PDS. */
export async function pseudonymElsewhere(): Promise<PseudonymElsewhere> {
  const phrase = generatePseudonymPhrase();
  const keys = derivePseudonymKeys(phrase);
  const oldKey = await Secp256k1Keypair.create({ exportable: true });
  const signed = signGenesisOp(buildPseudonymGenesisOp({
    ownerDidKey: keys.ownerDidKey, signingDidKey: oldKey.did(), handle: `${uniqueHandle('old')}.old-pds.example.test`,
    pdsEndpoint: OLD_PDS, ownerDid: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', commitmentSaltHex: keys.commitmentSaltHex,
  }), keys.ownerPrivateKey);
  const did = didForSignedOp(signed);
  const res = await fetch(`${config.plc.directoryUrl}/${did}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(signed),
  });
  if (!res.ok) throw new Error(`PLC rejected genesis: ${res.status} ${await res.text()}`);
  return { did, phrase, oldKey };
}

export function newHandle(): string {
  return `${uniqueHandle('mv')}${config.handleSuffix}`;
}

export function proofFor(p: { phrase: string; did: string; aud?: string; lxm?: string }): string {
  return signOwnerJwt({ phrase: p.phrase, did: p.did, aud: p.aud ?? config.pds.serviceDid, lxm: p.lxm ?? CREATE_ACCOUNT });
}

export function createAccount(body: Record<string, unknown>, jwt?: string) {
  const req = api.post(`/xrpc/${CREATE_ACCOUNT}`).send(body).set('Content-Type', 'application/json');
  return jwt ? req.set('Authorization', `Bearer ${jwt}`) : req;
}

/** Open the pseudonym's account on this PDS; returns its session. */
export async function openHere(p: PseudonymElsewhere): Promise<{ accessJwt: string; handle: string }> {
  const res = await createAccount({ did: p.did, handle: newHandle() }, proofFor(p));
  if (res.status !== 200) throw new Error(`createAccount failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { accessJwt: res.body.accessJwt, handle: res.body.handle };
}

export type RecordWrite = { collection: string; rkey: string; record: Record<string, unknown> };

/** The repo the old PDS would export: records signed with `key` under `did`. */
export async function exportedRepo(did: string, key: Secp256k1Keypair, writes: RecordWrite[]): Promise<Uint8Array> {
  const storage = new MemoryBlockstore();
  const repo = await Repo.create(storage, did, key, writes.map((w) => ({ action: WriteOpAction.Create, ...w })));
  return blocksToCarFile(repo.cid, storage.blocks);
}

export function importRepo(car: Uint8Array, jwt: string) {
  return api.post('/xrpc/com.atproto.repo.importRepo')
    .set('Authorization', `Bearer ${jwt}`)
    .set('Content-Type', 'application/vnd.ipld.car')
    .send(Buffer.from(car));
}

/** The owner key signs a PLC update naming what this PDS recommends. */
export async function pointHere(p: PseudonymElsewhere, accessJwt: string): Promise<void> {
  const creds = await xrpcAuthGet('com.atproto.identity.getRecommendedDidCredentials', accessJwt);
  const log = await (await fetch(`${config.plc.directoryUrl}/${p.did}/log`)).json();
  const op = signPlcOp(buildMoveOp({
    previous: log[log.length - 1],
    signingDidKey: creds.body.verificationMethods.atproto,
    pdsEndpoint: creds.body.services.atproto_pds.endpoint,
    handle: creds.body.alsoKnownAs[0].slice('at://'.length),
  }), derivePseudonymKeys(p.phrase).ownerPrivateKey);
  const res = await fetch(`${config.plc.directoryUrl}/${p.did}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(op),
  });
  if (!res.ok) throw new Error(`PLC refused the update: ${res.status} ${await res.text()}`);
}

/** A user account registered in PLC, hosted (on paper) by another PDS that holds both its keys. */
export interface UserElsewhere { did: string; handle: string; signingKey: Secp256k1Keypair; rotationKey: Secp256k1Keypair }

export async function userElsewhere(): Promise<UserElsewhere> {
  const [signingKey, rotationKey] = await Promise.all([
    Secp256k1Keypair.create({ exportable: true }), Secp256k1Keypair.create({ exportable: true }),
  ]);
  const handle = `${uniqueHandle('user')}.old-pds.example.test`;
  const did = await registerDidPlc({ signingKey, rotationKeys: [rotationKey], handle, pdsEndpoint: OLD_PDS });
  return { did, handle, signingKey, rotationKey };
}

/** What the old PDS's getServiceAuth would mint for the move. */
export function serviceAuthFor(u: UserElsewhere, opts: { aud?: string; lxm?: string; iss?: string } = {}): Promise<string> {
  return signServiceAuthJwt({
    keypair: u.signingKey, iss: opts.iss ?? u.did, aud: opts.aud ?? config.pds.serviceDid,
    exp: Math.floor(Date.now() / 1000) + 60, lxm: opts.lxm ?? CREATE_ACCOUNT,
  });
}
