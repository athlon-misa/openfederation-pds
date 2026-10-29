/**
 * Moving a pseudonym to another PDS (AT Protocol account migration). The
 * owner key is the pseudonym's only PLC rotation key, so the owner proves
 * control to the new PDS directly; the old PDS does not have to help.
 */
import { utf8ToBytes } from '@noble/hashes/utils';
import * as dagCbor from '@ipld/dag-cbor';
import { derivePseudonymKeys, signBytes } from './keys.js';
import { base64UrlEncode } from './formats.js';
import { buildMoveOp, signPlcOp } from './plc.js';
import { loginWithPhrase } from './client.js';

const CREATE_ACCOUNT = 'com.atproto.server.createAccount';

function b64urlJson(value: unknown): string {
  return base64UrlEncode(utf8ToBytes(JSON.stringify(value)));
}

/**
 * A short-lived ES256K JWT signed by the owner key, in the shape of AT
 * Protocol service auth: iss = the pseudonym DID, aud = the new PDS's service
 * DID, lxm = the method it may be used for.
 */
export function signOwnerJwt(p: { phrase: string; did: string; aud: string; lxm: string; ttlSeconds?: number }): string {
  const keys = derivePseudonymKeys(p.phrase);
  const now = Math.floor(Date.now() / 1000);
  const jti = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const header = b64urlJson({ typ: 'JWT', alg: 'ES256K' });
  const payload = b64urlJson({ iss: p.did, aud: p.aud, lxm: p.lxm, iat: now, exp: now + (p.ttlSeconds ?? 120), jti });
  return `${header}.${payload}.${signBytes(keys.ownerPrivateKey, utf8ToBytes(`${header}.${payload}`))}`;
}

async function call<T>(pdsUrl: string, nsid: string, body: unknown, bearer?: string): Promise<T> {
  const res = await fetch(`${pdsUrl}/xrpc/${nsid}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({})) as { error?: string; message?: string };
  if (!res.ok) throw new Error(`${nsid} failed (${res.status}): ${json.error ?? ''} ${json.message ?? ''}`.trim());
  return json as T;
}

/**
 * First step of a move: reserve a signing key at the new PDS and open the
 * pseudonym's account there. The account starts deactivated; nothing changes
 * for readers until the DID is pointed at the new PDS and the account is
 * activated. `newServiceDid` is the DID of the PDS you mean to move to.
 */
export async function openAccountForMove(p: {
  newPdsUrl: string; newServiceDid: string; phrase: string; did: string; handle: string;
}): Promise<{ did: string; handle: string; signingKey: string; accessJwt: string; refreshJwt: string }> {
  const { signingKey } = await call<{ signingKey: string }>(p.newPdsUrl, 'com.atproto.server.reserveSigningKey', { did: p.did });
  const proof = signOwnerJwt({ phrase: p.phrase, did: p.did, aud: p.newServiceDid, lxm: CREATE_ACCOUNT });
  const created = await call<{ did: string; handle: string; accessJwt: string; refreshJwt: string }>(
    p.newPdsUrl, CREATE_ACCOUNT, { did: p.did, handle: p.handle }, proof);
  if (created.did !== p.did) throw new Error(`New PDS opened ${created.did}, expected ${p.did}`);
  return { ...created, signingKey };
}

export type MoveStep = 'open' | 'export' | 'import' | 'check' | 'point' | 'activate' | 'retire';

async function get<T>(pdsUrl: string, nsid: string, bearer: string): Promise<T> {
  const res = await fetch(`${pdsUrl}/xrpc/${nsid}`, { headers: { Authorization: `Bearer ${bearer}` } });
  const json = await res.json().catch(() => ({})) as { error?: string; message?: string };
  if (!res.ok) throw new Error(`${nsid} failed (${res.status}): ${json.error ?? ''} ${json.message ?? ''}`.trim());
  return json as T;
}

interface AccountStatus { activated: boolean; validDid: boolean; repoCommit: string; indexedRecords: number }

/**
 * Move a pseudonym to another PDS, in the standard AT Protocol order:
 * open the account there (deactivated) → copy the repository → check it
 * arrived → point the DID there → activate → retire the old home.
 *
 * The DID is only pointed at the new PDS once that PDS reports the exact
 * repository the old one exported, so a refusal or failure at any earlier
 * step leaves the pseudonym working where it was. Returns a session at the
 * new home. `onStep` is called (and awaited) as each step starts, for progress
 * displays.
 */
export async function moveAccount(p: {
  oldPdsUrl: string; oldServiceDid: string;
  newPdsUrl: string; newServiceDid: string;
  plcUrl: string; phrase: string; did: string; newHandle: string;
  onStep?: (step: MoveStep) => void | Promise<void>;
}): Promise<{ did: string; handle: string; accessJwt: string; refreshJwt: string }> {
  const step = async (s: MoveStep) => { await p.onStep?.(s); };

  await step('open');
  const opened = await openAccountForMove({
    newPdsUrl: p.newPdsUrl, newServiceDid: p.newServiceDid, phrase: p.phrase, did: p.did, handle: p.newHandle,
  });

  await step('export');
  const exported = await fetch(`${p.oldPdsUrl}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(p.did)}`);
  if (!exported.ok) throw new Error(`Old PDS did not export the repository (${exported.status})`);
  const car = new Uint8Array(await exported.arrayBuffer());

  await step('import');
  const imported = await fetch(`${p.newPdsUrl}/xrpc/com.atproto.repo.importRepo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/vnd.ipld.car', Authorization: `Bearer ${opened.accessJwt}` },
    body: car,
  });
  if (!imported.ok) {
    const json = await imported.json().catch(() => ({})) as { error?: string; message?: string };
    throw new Error(`New PDS refused the repository (${imported.status}): ${json.error ?? ''} ${json.message ?? ''}`.trim());
  }

  await step('check');
  const status = await get<AccountStatus>(p.newPdsUrl, 'com.atproto.server.checkAccountStatus', opened.accessJwt);
  const exportedRoot = carRoot(car);
  if (status.repoCommit !== exportedRoot || status.indexedRecords === 0) {
    throw new Error('The new PDS does not hold the exported repository; the DID was not changed');
  }

  await step('point');
  const creds = await get<{ alsoKnownAs?: string[]; verificationMethods?: { atproto?: string }; services?: { atproto_pds?: { endpoint?: string } } }>(
    p.newPdsUrl, 'com.atproto.identity.getRecommendedDidCredentials', opened.accessJwt);
  const signingKey = creds.verificationMethods?.atproto;
  const endpoint = creds.services?.atproto_pds?.endpoint;
  const handle = creds.alsoKnownAs?.find((a) => a.startsWith('at://'))?.slice('at://'.length);
  if (!signingKey || !endpoint || !handle) throw new Error('New PDS did not recommend DID credentials');
  const logRes = await fetch(`${p.plcUrl}/${p.did}/log`);
  if (!logRes.ok) throw new Error(`PLC log lookup failed (${logRes.status})`);
  const log = await logRes.json() as Parameters<typeof buildMoveOp>[0]['previous'][];
  const op = signPlcOp(buildMoveOp({ previous: log[log.length - 1], signingDidKey: signingKey, pdsEndpoint: endpoint, handle }),
    derivePseudonymKeys(p.phrase).ownerPrivateKey);
  const plc = await fetch(`${p.plcUrl}/${p.did}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(op) });
  if (!plc.ok) throw new Error(`PLC refused the update (${plc.status}): ${await plc.text()}`);

  await step('activate');
  await call(p.newPdsUrl, 'com.atproto.server.activateAccount', {}, opened.accessJwt);
  const session = await loginWithPhrase({ pdsUrl: p.newPdsUrl, phrase: p.phrase, expectedServiceDid: p.newServiceDid });

  await step('retire');
  try {
    const old = await loginWithPhrase({ pdsUrl: p.oldPdsUrl, phrase: p.phrase, expectedServiceDid: p.oldServiceDid });
    await call(p.oldPdsUrl, 'com.atproto.server.deactivateAccount', {}, old.accessJwt);
  } catch {
    // The move is complete either way; the old home can be retired later.
  }
  return session;
}

/** Root CID of a CAR file (CARv1 header: { roots: [cid], version: 1 }). */
function carRoot(car: Uint8Array): string {
  let len = 0; let shift = 0; let i = 0;
  for (;;) {
    const b = car[i++];
    len |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  const header = dagCbor.decode(car.subarray(i, i + len)) as { roots: { toString(): string }[] };
  return header.roots[0].toString();
}
