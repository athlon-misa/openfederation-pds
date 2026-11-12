/**
 * Leaving a PDS without its help (#241). An `assisted` or `self` account
 * holds the top rotation key of its DID, so the person can sign the PLC
 * update that points the DID at another PDS and names that PDS's repo
 * signing key. From then on the old PDS's key no longer verifies new
 * commits for the DID, and readers resolve the account elsewhere: the old
 * operator is cut off, whatever it does.
 *
 * leavePds does that one step. copyRepo moves the repository (from the
 * public sync endpoints, or from a saved CAR) and its blobs into the new
 * PDS, given a session there.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { didKeyFor } from './encoding.js';
import { cidForPlcOp, signPlcOperation, type PlcOperation, type SignedPlcOperation } from './plc.js';
import { readRepoCar, type CommitRef } from './repo-watch.js';

/**
 * The PLC update that moves a DID: `atproto_pds` and the `atproto` key
 * change; other verification methods (the owner key) stay. Without
 * `handle`, alsoKnownAs stays too.
 */
export function buildLeaveOp(p: {
  previous: SignedPlcOperation;
  pdsEndpoint: string;
  /** The repo signing key at the new PDS (com.atproto.server.reserveSigningKey or getRecommendedDidCredentials). */
  atprotoDidKey: string;
  rotationKeys: string[];
  handle?: string;
}): PlcOperation {
  const alsoKnownAs = p.handle
    ? [`at://${p.handle}`, ...p.previous.alsoKnownAs.filter((a) => !a.startsWith('at://'))]
    : [...p.previous.alsoKnownAs];
  return {
    type: 'plc_operation',
    prev: cidForPlcOp(p.previous),
    rotationKeys: [...p.rotationKeys],
    verificationMethods: { ...p.previous.verificationMethods, atproto: p.atprotoDidKey },
    alsoKnownAs,
    services: { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: p.pdsEndpoint } },
  };
}

export interface LeaveResult {
  previous: SignedPlcOperation;
  operation: SignedPlcOperation;
}

/**
 * Point the DID at another PDS, signed with the person's rotation key
 * (`deriveCustodyKeys(phrase).rotationPrivateKey`), and check PLC shows it.
 *
 * By default the new rotation keys are the person's key alone: an
 * `assisted` account becomes `self`, so the old PDS's lower key can no
 * longer change the DID. Pass `keepOtherRotationKeys` to keep the list as
 * it is.
 */
export async function leavePds(p: {
  plcUrl: string;
  did: string;
  rotationPrivateKey: Uint8Array;
  pdsEndpoint: string;
  atprotoDidKey: string;
  handle?: string;
  keepOtherRotationKeys?: boolean;
  fetch?: typeof globalThis.fetch;
}): Promise<LeaveResult> {
  const doFetch = p.fetch ?? ((...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args));
  const plc = p.plcUrl.replace(/\/+$/, '');
  const logRes = await doFetch(`${plc}/${p.did}/log`);
  if (!logRes.ok) throw new Error(`PLC log lookup failed (${logRes.status})`);
  const log = await logRes.json() as Array<SignedPlcOperation | { type: string }>;
  const previous = log[log.length - 1] as SignedPlcOperation | undefined;
  if (!previous || previous.type !== 'plc_operation') throw new Error('The DID has no current PLC operation (deleted, or a legacy format)');

  const myKey = didKeyFor('secp256k1', secp256k1.getPublicKey(p.rotationPrivateKey, true));
  if (!previous.rotationKeys.includes(myKey)) throw new Error('This key is not a rotation key of the DID; PLC would refuse the update');
  const rotationKeys = p.keepOtherRotationKeys ? previous.rotationKeys : [myKey];

  const operation = signPlcOperation(buildLeaveOp({
    previous, pdsEndpoint: p.pdsEndpoint, atprotoDidKey: p.atprotoDidKey, rotationKeys, handle: p.handle,
  }), p.rotationPrivateKey);
  const submitted = await doFetch(`${plc}/${p.did}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(operation),
  });
  if (!submitted.ok) throw new Error(`PLC refused the operation (${submitted.status}): ${await submitted.text()}`);

  const dataRes = await doFetch(`${plc}/${p.did}/data`);
  if (!dataRes.ok) throw new Error(`PLC read-back failed (${dataRes.status})`);
  const data = await dataRes.json() as { services?: { atproto_pds?: { endpoint?: string } }; verificationMethods?: { atproto?: string } };
  if (data.services?.atproto_pds?.endpoint !== p.pdsEndpoint || data.verificationMethods?.atproto !== p.atprotoDidKey) {
    throw new Error('PLC does not show the update');
  }
  return { previous, operation };
}

/**
 * Copy a repository and its blobs into a new PDS (com.atproto.repo.importRepo,
 * listMissingBlobs, uploadBlob), with a session for the account there.
 * The repository comes from `car` (a copy saved earlier, e.g. a RepoWatcher
 * result) or from `fromUrl`'s public com.atproto.sync.getRepo. Blobs come
 * from `fromUrl`'s com.atproto.sync.getBlob. Returns the commit imported,
 * to compare with the new PDS's checkAccountStatus.
 *
 * The new PDS decides what it accepts: some only accept a repository signed
 * by the DID's current `atproto` key, so import before leavePds changes it.
 */
export async function copyRepo(p: {
  did: string;
  toUrl: string;
  accessJwt: string;
  fromUrl?: string;
  car?: Uint8Array;
  fetch?: typeof globalThis.fetch;
}): Promise<{ commit: CommitRef; blobsCopied: number }> {
  const doFetch = p.fetch ?? ((...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args));
  const to = p.toUrl.replace(/\/+$/, '');
  const from = p.fromUrl?.replace(/\/+$/, '');
  const did = encodeURIComponent(p.did);
  const auth = { Authorization: `Bearer ${p.accessJwt}` };
  const fail = async (what: string, res: Response) => {
    const json = await res.json().catch(() => ({})) as { error?: string; message?: string };
    return new Error(`${what} (${res.status}): ${json.error ?? ''} ${json.message ?? ''}`.trim());
  };

  let car = p.car;
  if (!car) {
    if (!from) throw new Error('copyRepo needs car or fromUrl');
    const res = await doFetch(`${from}/xrpc/com.atproto.sync.getRepo?did=${did}`);
    if (!res.ok) throw new Error(`The source did not export the repository (${res.status})`);
    car = new Uint8Array(await res.arrayBuffer());
  }
  const { commit } = readRepoCar(car);
  if (commit.did !== p.did) throw new Error(`The repository is for ${commit.did}, not ${p.did}`);

  const imported = await doFetch(`${to}/xrpc/com.atproto.repo.importRepo`, {
    method: 'POST', headers: { 'Content-Type': 'application/vnd.ipld.car', ...auth }, body: car as BodyInit,
  });
  if (!imported.ok) throw await fail('The new PDS refused the repository', imported);

  let blobsCopied = 0;
  for (;;) {
    // Each upload removes a blob from the missing list, so always read the first page.
    const page = await doFetch(`${to}/xrpc/com.atproto.repo.listMissingBlobs?limit=100`, { headers: auth });
    if (!page.ok) throw await fail('listMissingBlobs failed', page);
    const { blobs } = await page.json() as { blobs: { cid: string }[] };
    if (blobs.length === 0) break;
    if (!from) throw new Error(`The new PDS is missing ${blobs.length} blob(s); pass fromUrl to copy them`);
    for (const { cid } of blobs) {
      const blob = await doFetch(`${from}/xrpc/com.atproto.sync.getBlob?did=${did}&cid=${encodeURIComponent(cid)}`);
      if (!blob.ok) throw new Error(`The source did not serve blob ${cid} (${blob.status})`);
      const up = await doFetch(`${to}/xrpc/com.atproto.repo.uploadBlob`, {
        method: 'POST',
        headers: { 'Content-Type': blob.headers.get('content-type') ?? 'application/octet-stream', ...auth },
        body: new Uint8Array(await blob.arrayBuffer()),
      });
      if (!up.ok) throw await fail(`The new PDS refused blob ${cid}`, up);
      const json = await up.json() as { blob?: { ref?: { $link?: string } } };
      if (json.blob?.ref?.$link !== cid) throw new Error(`Blob ${cid} arrived as ${json.blob?.ref?.$link}`);
      blobsCopied++;
    }
  }
  return { commit: { rev: commit.rev, cid: commit.cid }, blobsCopied };
}
