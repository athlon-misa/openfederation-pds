/**
 * Moving a `self` or `assisted` account into another OpenFederation PDS
 * without the old PDS (#382, docs/adr/ADR-004-self-custody-move-in.md).
 *
 * The person proves control to the new PDS with the DID's top rotation key
 * (the phrase), the repository and blobs come from a backup the person
 * downloaded while the old PDS still answered (`downloadBackup`), and
 * `leavePds` points the DID at the new PDS. The account arrives as `self`.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { base64UrlEncode } from './encoding.js';
import { leavePds, copyRepo, type BackupBlob } from './leave.js';
import { readRepoCar, type CommitRef } from './repo-watch.js';

export const CREATE_ACCOUNT_NSID = 'com.atproto.server.createAccount';

type Fetch = typeof globalThis.fetch;
const defaultFetch: Fetch = (...args) => globalThis.fetch(...args);
const utf8 = (s: string) => new TextEncoder().encode(s);
const b64urlJson = (value: unknown) => base64UrlEncode(utf8(JSON.stringify(value)));
const trim = (url: string) => url.replace(/\/+$/, '');

/**
 * A short-lived ES256K JWT in the shape of AT Protocol service auth, signed
 * with the DID's rotation key: iss = the DID, aud = the new PDS's service
 * DID, lxm = the method it may be used for (createAccount by default). The
 * new PDS accepts it only from the DID's first rotation key, within 300 s.
 */
export function signRotationKeyJwt(p: {
  rotationPrivateKey: Uint8Array; did: string; aud: string; lxm?: string; ttlSeconds?: number;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const jti = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const header = b64urlJson({ typ: 'JWT', alg: 'ES256K' });
  const payload = b64urlJson({ iss: p.did, aud: p.aud, lxm: p.lxm ?? CREATE_ACCOUNT_NSID, iat: now, exp: now + (p.ttlSeconds ?? 120), jti });
  const sig = secp256k1.sign(sha256(utf8(`${header}.${payload}`)), p.rotationPrivateKey, { lowS: true }).toCompactRawBytes();
  return `${header}.${payload}.${base64UrlEncode(sig)}`;
}

async function failure(what: string, res: Response): Promise<Error> {
  const json = await res.json().catch(() => ({})) as { error?: string; message?: string };
  return new Error(`${what} (${res.status}): ${json.error ?? ''} ${json.message ?? ''}`.trim());
}

/** A repository and the blobs its records reference, saved from a PDS. */
export interface RepoBackup {
  did: string;
  car: Uint8Array;
  commit: CommitRef;
  blobs: BackupBlob[];
}

/**
 * Save the account's repository and every blob it references from its
 * current PDS (public com.atproto.sync.getRepo, listBlobs, getBlob). Do this
 * before leavePds, and regularly: the old PDS may not answer later, and the
 * blobs exist nowhere else. Keep the result where the old operator can't
 * reach it.
 */
export async function downloadBackup(p: { pdsUrl: string; did: string; fetch?: Fetch }): Promise<RepoBackup> {
  const doFetch = p.fetch ?? defaultFetch;
  const from = trim(p.pdsUrl);
  const did = encodeURIComponent(p.did);
  const repo = await doFetch(`${from}/xrpc/com.atproto.sync.getRepo?did=${did}`);
  if (!repo.ok) throw await failure('The PDS did not export the repository', repo);
  const car = new Uint8Array(await repo.arrayBuffer());
  const { commit } = readRepoCar(car);
  if (commit.did !== p.did) throw new Error(`The repository is for ${commit.did}, not ${p.did}`);

  const blobs: BackupBlob[] = [];
  let cursor: string | undefined;
  do {
    const page = await doFetch(`${from}/xrpc/com.atproto.sync.listBlobs?did=${did}&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (!page.ok) throw await failure('The PDS did not list the blobs', page);
    const json = await page.json() as { cids: string[]; cursor?: string };
    for (const cid of json.cids) {
      const blob = await doFetch(`${from}/xrpc/com.atproto.sync.getBlob?did=${did}&cid=${encodeURIComponent(cid)}`);
      if (!blob.ok) throw await failure(`The PDS did not serve blob ${cid}`, blob);
      blobs.push({ cid, mimeType: blob.headers.get('content-type') ?? 'application/octet-stream', bytes: new Uint8Array(await blob.arrayBuffer()) });
    }
    cursor = json.cids.length > 0 ? json.cursor : undefined;
  } while (cursor);
  return { did: p.did, car, commit: { rev: commit.rev, cid: commit.cid }, blobs };
}

/**
 * Reserve the repo signing key the new PDS will use for the DID
 * (com.atproto.server.reserveSigningKey). Pass it to leavePds as
 * `atprotoDidKey` when leaving before the account exists there. Reserving
 * again replaces the reservation, so do it once per move.
 */
export async function reserveSigningKeyAt(p: { pdsUrl: string; did: string; fetch?: Fetch }): Promise<string> {
  const res = await (p.fetch ?? defaultFetch)(`${trim(p.pdsUrl)}/xrpc/com.atproto.server.reserveSigningKey`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ did: p.did }),
  });
  if (!res.ok) throw await failure('reserveSigningKey failed', res);
  return (await res.json() as { signingKey: string }).signingKey;
}

export interface MovedInSession { did: string; handle: string; accessJwt: string; refreshJwt: string }

/**
 * Open the account at the new PDS with a proof signed by the DID's top
 * rotation key (com.atproto.server.createAccount). It starts deactivated and
 * `self`. `handle` is the full handle there; `email` and `password` are the
 * new login there. `inviteCode` is needed where `migration.accounts` is
 * `invite` (net.openfederation.server.getPublicConfig).
 */
export async function openAccountWithRotationKey(p: {
  newPdsUrl: string; newServiceDid: string; did: string; rotationPrivateKey: Uint8Array;
  handle: string; email: string; password: string; inviteCode?: string; fetch?: Fetch;
}): Promise<MovedInSession> {
  const proof = signRotationKeyJwt({ rotationPrivateKey: p.rotationPrivateKey, did: p.did, aud: p.newServiceDid });
  const res = await (p.fetch ?? defaultFetch)(`${trim(p.newPdsUrl)}/xrpc/${CREATE_ACCOUNT_NSID}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${proof}` },
    body: JSON.stringify({ did: p.did, handle: p.handle, email: p.email, password: p.password, ...(p.inviteCode ? { inviteCode: p.inviteCode } : {}) }),
  });
  if (!res.ok) throw await failure('The new PDS did not open the account', res);
  const created = await res.json() as MovedInSession;
  if (created.did !== p.did) throw new Error(`The new PDS opened ${created.did}, expected ${p.did}`);
  return created;
}

export type MoveInStep = 'open' | 'import' | 'check' | 'point' | 'activate';

/**
 * Move a `self` or `assisted` account into another OpenFederation PDS with
 * the phrase alone: open the account there → import the backup's repository
 * and blobs → check the new PDS holds them → point the DID there (leavePds,
 * skipped when it already does) → activate → sign in.
 *
 * Works whether or not leavePds already ran. If it did, `pdsEndpoint` (the
 * endpoint passed to leavePds; default `newPdsUrl`) tells that apart, and
 * the DID must name the key reserved there (reserveSigningKeyAt). Until the
 * DID is pointed, a refusal leaves everything as it was. Without
 * `allowMissingBlobs`, the move stops before pointing the DID if a blob the
 * records reference is not in the backup.
 */
export async function moveIn(p: {
  plcUrl: string;
  newPdsUrl: string;
  newServiceDid: string;
  /** The new PDS's service URL, as the DID names it; default newPdsUrl. */
  pdsEndpoint?: string;
  did: string;
  rotationPrivateKey: Uint8Array;
  handle: string;
  email: string;
  password: string;
  inviteCode?: string;
  backup: RepoBackup;
  /** The person's recovery key, kept below theirs by leavePds (recovery.ts). */
  recoveryDidKey?: string;
  allowMissingBlobs?: boolean;
  onStep?: (step: MoveInStep) => void | Promise<void>;
  fetch?: Fetch;
}): Promise<MovedInSession & { pointed: boolean; missingBlobs: string[] }> {
  const doFetch = p.fetch ?? defaultFetch;
  const to = trim(p.newPdsUrl);
  const plc = trim(p.plcUrl);
  const step = async (s: MoveInStep) => { await p.onStep?.(s); };
  if (p.backup.did !== p.did) throw new Error(`The backup is for ${p.backup.did}, not ${p.did}`);
  const get = async <T>(nsid: string, jwt: string): Promise<T> => {
    const res = await doFetch(`${to}/xrpc/${nsid}`, { headers: { Authorization: `Bearer ${jwt}` } });
    if (!res.ok) throw await failure(`${nsid} failed`, res);
    return await res.json() as T;
  };
  const plcData = async () => {
    const res = await doFetch(`${plc}/${p.did}/data`);
    if (!res.ok) throw new Error(`PLC lookup failed (${res.status})`);
    return await res.json() as { services?: { atproto_pds?: { endpoint?: string } }; verificationMethods?: { atproto?: string } };
  };

  await step('open');
  const before = await plcData();
  const alreadyPointed = before.services?.atproto_pds?.endpoint === trim(p.pdsEndpoint ?? p.newPdsUrl);
  // Reserving again would replace the key the DID already names.
  if (!alreadyPointed) await reserveSigningKeyAt({ pdsUrl: to, did: p.did, fetch: doFetch });
  const opened = await openAccountWithRotationKey({ ...p, newPdsUrl: to, fetch: doFetch });
  const creds = await get<{ verificationMethods?: { atproto?: string }; services?: { atproto_pds?: { endpoint?: string } } }>(
    'com.atproto.identity.getRecommendedDidCredentials', opened.accessJwt);
  const signingKey = creds.verificationMethods?.atproto;
  const endpoint = creds.services?.atproto_pds?.endpoint;
  if (!signingKey || !endpoint) throw new Error('The new PDS did not recommend DID credentials');
  if (alreadyPointed && before.verificationMethods?.atproto !== signingKey) {
    throw new Error('The DID names a signing key the new PDS does not hold; reserve it there (reserveSigningKeyAt) before leavePds');
  }

  await step('import');
  const copied = await copyRepo({
    did: p.did, toUrl: to, accessJwt: opened.accessJwt, car: p.backup.car, backupBlobs: p.backup.blobs,
    allowMissingBlobs: p.allowMissingBlobs, fetch: doFetch,
  });

  await step('check');
  const status = await get<{ repoCommit: string; expectedBlobs: number; importedBlobs: number }>('com.atproto.server.checkAccountStatus', opened.accessJwt);
  if (status.repoCommit !== p.backup.commit.cid) throw new Error('The new PDS does not hold the backed-up repository; the DID was not changed');
  if (!p.allowMissingBlobs && status.importedBlobs !== status.expectedBlobs) {
    throw new Error(`The new PDS holds ${status.importedBlobs} of ${status.expectedBlobs} blobs; the DID was not changed`);
  }

  await step('point');
  if (!alreadyPointed) {
    await leavePds({
      plcUrl: plc, did: p.did, rotationPrivateKey: p.rotationPrivateKey, pdsEndpoint: endpoint, atprotoDidKey: signingKey,
      handle: p.handle, recoveryDidKey: p.recoveryDidKey, fetch: doFetch,
    });
  }

  await step('activate');
  const activated = await doFetch(`${to}/xrpc/com.atproto.server.activateAccount`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opened.accessJwt}` }, body: '{}',
  });
  if (!activated.ok) throw await failure('The new PDS did not activate the account', activated);
  const session = await doFetch(`${to}/xrpc/com.atproto.server.createSession`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: p.email, password: p.password }),
  });
  if (!session.ok) throw await failure('Signing in at the new PDS failed', session);
  const json = await session.json() as MovedInSession;
  return { did: json.did, handle: json.handle, accessJwt: json.accessJwt, refreshJwt: json.refreshJwt, pointed: !alreadyPointed, missingBlobs: copied.missingBlobs ?? [] };
}
