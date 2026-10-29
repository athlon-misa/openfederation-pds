/**
 * The client side of moving a community (#267, ADR-002). The owner proves
 * control with the community's primary rotation key, the new PDS pulls
 * everything, and the DID is changed only once the new PDS reports the
 * exact repository the old one serves.
 */
import { Secp256k1Keypair } from '@atproto/crypto';
import * as dagCbor from '@ipld/dag-cbor';
import { signServiceAuthJwt } from '../../src/auth/service-auth.js';
import { buildMoveOp, signPlcOp } from '../../packages/openfederation-pseudonym/src/index.js';

async function xrpc<T>(base: string, nsid: string, opts: { jwt?: string; body?: unknown; query?: Record<string, string> } = {}): Promise<T> {
  const qs = opts.query ? `?${new URLSearchParams(opts.query)}` : '';
  const res = await fetch(`${base}/xrpc/${nsid}${qs}`, {
    method: opts.body !== undefined ? 'POST' : 'GET',
    headers: { ...(opts.jwt ? { Authorization: `Bearer ${opts.jwt}` } : {}), ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (!res.ok) throw new Error(`${nsid} failed (${res.status}): ${json.error ?? ''} ${json.message ?? ''}`.trim());
  return json;
}

export type CommunityMoveStep = 'open' | 'check' | 'point' | 'activate' | 'retire';

interface Recommended { rotationKeys: string[]; alsoKnownAs: string[]; verificationMethods: { atproto: string }; services: { atproto_pds: { endpoint: string } } }

/** A short-lived proof that the holder of the primary rotation key moves this community, naming the owner. */
export async function signCommunityProof(p: { primaryRotationKeyBase64: string; did: string; ownerDid: string; aud: string; lxm: string }): Promise<string> {
  const keypair = await Secp256k1Keypair.import(Buffer.from(p.primaryRotationKeyBase64, 'base64'));
  return signServiceAuthJwt({ keypair, iss: p.did, aud: p.aud, exp: Math.floor(Date.now() / 1000) + 120, lxm: p.lxm, extraClaims: { sub: p.ownerDid } });
}

export async function moveCommunity(p: {
  oldPdsUrl: string; newPdsUrl: string; newServiceDid: string; plcUrl: string;
  did: string; ownerDid: string; ownerOldAccessJwt: string; primaryRotationKeyBase64: string;
  newHandle: string; inviteCode?: string; onStep?: (s: CommunityMoveStep) => void;
}): Promise<{ status: string; missingAttestationKeys: number }> {
  const step = (s: CommunityMoveStep) => p.onStep?.(s);

  step('open');
  const proof = await signCommunityProof({ primaryRotationKeyBase64: p.primaryRotationKeyBase64, did: p.did, ownerDid: p.ownerDid, aud: p.newServiceDid, lxm: 'net.openfederation.community.migrateIn' });
  const opened = await xrpc<{ repoCommit: string; recommended: Recommended }>(p.newPdsUrl, 'net.openfederation.community.migrateIn', {
    jwt: proof, body: { did: p.did, handle: p.newHandle, ...(p.inviteCode ? { inviteCode: p.inviteCode } : {}) },
  });

  step('check');
  const status = await xrpc<{ repoCommit: string; indexedRecords: number; expectedBlobs: number; importedBlobs: number; recommended: Recommended }>(
    p.newPdsUrl, 'net.openfederation.community.checkMigration', { query: { did: p.did } });
  const oldRoot = await fetch(`${p.oldPdsUrl}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(p.did)}`).then(async (r) => (r.ok ? carRoot(new Uint8Array(await r.arrayBuffer())) : null));
  if (status.repoCommit !== opened.repoCommit || status.repoCommit !== oldRoot || status.indexedRecords === 0 || status.importedBlobs !== status.expectedBlobs) {
    throw new Error('The new PDS does not hold the community as the old one serves it; the DID was not changed');
  }

  step('point');
  const r = status.recommended;
  const log = await (await fetch(`${p.plcUrl}/${p.did}/log`)).json() as Parameters<typeof buildMoveOp>[0]['previous'][];
  const op = signPlcOp(buildMoveOp({
    previous: log[log.length - 1], rotationKeys: r.rotationKeys, signingDidKey: r.verificationMethods.atproto,
    pdsEndpoint: r.services.atproto_pds.endpoint, handle: r.alsoKnownAs[0].slice('at://'.length),
  }), new Uint8Array(Buffer.from(p.primaryRotationKeyBase64, 'base64')));
  const plc = await fetch(`${p.plcUrl}/${p.did}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(op) });
  if (!plc.ok) throw new Error(`PLC refused the update (${plc.status}): ${await plc.text()}`);

  step('activate');
  const { token } = await xrpc<{ token: string }>(p.oldPdsUrl, 'com.atproto.server.getServiceAuth',
    { jwt: p.ownerOldAccessJwt, query: { aud: p.newServiceDid, lxm: 'net.openfederation.community.activate' } });
  const activated = await xrpc<{ status: string; missingAttestationKeys: number }>(p.newPdsUrl, 'net.openfederation.community.activate', { jwt: token, body: { did: p.did } });

  step('retire');
  await xrpc(p.oldPdsUrl, 'net.openfederation.community.markMoved', { jwt: p.ownerOldAccessJwt, body: { did: p.did } }).catch(() => undefined);
  return activated;
}

function carRoot(car: Uint8Array): string {
  let len = 0; let shift = 0; let i = 0;
  for (;;) { const b = car[i++]; len |= (b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7; }
  const header = dagCbor.decode(car.subarray(i, i + len)) as { roots: { toString(): string }[] };
  return header.roots[0].toString();
}
