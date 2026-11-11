/**
 * A community moving between PDSes (#267, ADR-002). The new PDS pulls the
 * repository and blobs from wherever the DID currently points, verifies the
 * repository against the DID's current signing key, and rebuilds its
 * derived tables. Once the DID points here, it fetches the attestation keys
 * the old PDS hands over encrypted to this PDS's signing key.
 */
import type { PoolClient } from 'pg';
import { Secp256k1Keypair } from '@atproto/crypto';
import { config } from '../config.js';
import { query, withTransaction } from '../db/client.js';
import { getBlobStore } from '../blob/blob-store.js';
import { currentPlcState, atprotoKeyFor, type PlcState } from '../identity/account-migration.js';
import { getSigningKey, storeSigningKey } from '../identity/manager.js';
import { encryptKeyBytes } from '../auth/encryption.js';
import { verifyRepoImport, storeRepoImport, MAX_CAR_SIZE, RepoImportError } from '../repo/import.js';
import { rebuildCommunityProjections, refreshMemberDisplay } from './projections.js';
import { listReferencedBlobs } from '../repo/blob-refs.js';
import { unwrapDEK, wrapDEK } from '../attestation/encryption.js';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { assertPublicHttpsUrl, readLimitedBytes, OutboundFetchError } from '../security/outbound-fetch.js';

const PEER_FETCH_TIMEOUT_MS = 60_000;
const MAX_MOVED_KEYS_BYTES = 4 * 1024 * 1024;

/**
 * Fetch from the PDS a community is moving from. That address comes out of the
 * community's DID document, which its owner writes, so it is treated as
 * untrusted: in production it must be a public HTTPS host, redirects are
 * refused, and the request cannot hang. Outside production a local PDS on
 * plain HTTP is allowed, which is what development and the test suite use.
 */
async function fetchFromPeer(rawUrl: string): Promise<Response> {
  let url: URL;
  try {
    url = config.env.isProduction ? await assertPublicHttpsUrl(rawUrl) : new URL(rawUrl);
  } catch (err) {
    const why = err instanceof OutboundFetchError ? err.message : 'address is invalid';
    throw new CommunityMoveError(400, 'IncompatibleDidDoc', `The community's current PDS cannot be reached from here: ${why}`);
  }
  return fetch(url, { redirect: 'error', signal: AbortSignal.timeout(PEER_FETCH_TIMEOUT_MS) });
}

async function readPeerBody(res: Response, maxBytes: number, what: string): Promise<Buffer> {
  try {
    return Buffer.from(await readLimitedBytes(res, maxBytes));
  } catch (err) {
    if (err instanceof OutboundFetchError) throw new CommunityMoveError(413, 'PayloadTooLarge', `${what} is too large (limit ${maxBytes} bytes)`);
    throw err;
  }
}
import { encryptToDidKey, decryptWithPrivateKey } from '../crypto/ecies.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';

export class CommunityMoveError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

/** Where the DID says the community lives now; null when it is here. */
export function homeOf(state: PlcState): string | null {
  const endpoint = state.services.atproto_pds?.endpoint;
  if (!endpoint) return null;
  // Compared without trailing slashes, so "https://pds.example/" in the DID
  // document and "https://pds.example" in the config are the same place.
  const here = (config.pds.serviceUrl || '').replace(/\/+$/, '');
  const there = endpoint.replace(/\/+$/, '');
  return there === here ? null : there;
}

/** Fresh signing and recovery keys for a community arriving here. */
export async function provisionCommunityKeys(client: PoolClient, did: string): Promise<{ signingDidKey: string; recoveryDidKey: string }> {
  const [signing, recovery] = await Promise.all([
    Secp256k1Keypair.create({ exportable: true }), Secp256k1Keypair.create({ exportable: true }),
  ]);
  const signingBytes = Buffer.from(await signing.export());
  await client.query(
    `INSERT INTO signing_keys (community_did, signing_key_bytes) VALUES ($1, $2)
     ON CONFLICT (community_did) DO NOTHING`,
    [did, await encryptKeyBytes(signingBytes, 'identity.signing-key')]);
  const recoveryBytes = Buffer.from(await recovery.export());
  await client.query(
    `INSERT INTO plc_keys (community_did, recovery_key_bytes) VALUES ($1, $2)
     ON CONFLICT (community_did) DO NOTHING`,
    [did, await encryptKeyBytes(recoveryBytes, 'identity.recovery-key')]);
  signingBytes.fill(0); recoveryBytes.fill(0);
  return { signingDidKey: signing.did(), recoveryDidKey: recovery.did() };
}

/** Pull the repository from the community's current home and store it, replacing what is here. */
export async function pullCommunityRepo(did: string, fromPds: string): Promise<{ root: string; records: number; members: number; attestations: number }> {
  const res = await fetchFromPeer(`${fromPds}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(did)}`);
  if (!res.ok) throw new CommunityMoveError(502, 'UpstreamFailure', `The community's current PDS did not export the repository (${res.status})`);
  // Read with the limit applied as the bytes arrive, not after buffering them all.
  const car = await readPeerBody(res, MAX_CAR_SIZE, 'The repository');
  let verified;
  try {
    verified = await verifyRepoImport(did, car, () => atprotoKeyFor(did));
  } catch (err) {
    if (err instanceof RepoImportError) throw new CommunityMoveError(err.status, err.code, err.message);
    throw err;
  }
  const counts = await withTransaction(async (client) => {
    await storeRepoImport(client, did, verified, { replace: true });
    return rebuildCommunityProjections(client, did);
  });
  await refreshMemberDisplay(did);
  return { root: verified.root, records: verified.records.length, ...counts };
}

/** Copy every blob the repository references that this PDS does not hold for the community. */
export async function pullCommunityBlobs(did: string, fromPds: string): Promise<{ expected: number; copied: number }> {
  const store = await getBlobStore();
  let expected = 0; let copied = 0;
  let cursor: string | undefined;
  for (;;) {
    const page = await listReferencedBlobs(did, { limit: 500, cursor });
    for (const cid of page) {
      expected++;
      const owned = await query('SELECT 1 FROM blob_owners WHERE cid = $1 AND did = $2', [cid, did]);
      if (owned.rows.length > 0) continue;
      const res = await fetchFromPeer(`${fromPds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`);
      if (!res.ok) throw new CommunityMoveError(502, 'UpstreamFailure', `The community's current PDS did not serve blob ${cid} (${res.status})`);
      const bytes = await readPeerBody(res, config.blob.maxSize, `Blob ${cid}`);
      // The store is content-addressed and shared by every repo here. Bytes go
      // in under a CID only if they hash to it; otherwise a repo could name the
      // CID of someone else's blob and have its old PDS supply different bytes.
      if (!(await bytesMatchCid(cid, bytes))) {
        throw new CommunityMoveError(502, 'UpstreamFailure', `Blob ${cid} from the community's current PDS does not match its CID`);
      }
      // The remote content type is only a claim; anything this PDS would not
      // accept on upload is stored as opaque bytes.
      const claimed = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      const mime = config.blob.allowedMimeTypes.includes(claimed) ? claimed : 'application/octet-stream';
      // Same CID means same bytes, so a blob already held is left as it is.
      if (!(await store.exists(cid))) await store.put(cid, bytes, mime);
      await query('INSERT INTO blobs (cid, did, mime_type, size) VALUES ($1, $2, $3, $4) ON CONFLICT (cid) DO NOTHING', [cid, did, mime, bytes.length]);
      await query('INSERT INTO blob_owners (cid, did) VALUES ($1, $2) ON CONFLICT (cid, did) DO NOTHING', [cid, did]);
      copied++;
    }
    if (page.length < 500) break;
    cursor = page[page.length - 1];
  }
  return { expected, copied };
}

export async function communityBlobCounts(did: string): Promise<{ expected: number; imported: number }> {
  const row = (await query<{ expected: string; imported: string }>(
    `SELECT COUNT(*) AS expected,
            COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM blob_owners o WHERE o.cid = refs.cid AND o.did = $1)) AS imported
     FROM (SELECT DISTINCT jsonb_path_query(record, 'lax $.** ? (@."$type" == "blob").ref."$link"') #>> '{}' AS cid
           FROM records_index WHERE community_did = $1) refs WHERE refs.cid IS NOT NULL`, [did])).rows[0];
  return { expected: Number(row.expected), imported: Number(row.imported) };
}

/** What the owner should put in the DID to bring the community here. Convention: rotation key 0 is the owner's. */
export async function recommendedCommunityCredentials(did: string, state: PlcState): Promise<Record<string, unknown>> {
  const row = (await query<{ handle: string; recovery_did_key: string | null }>(
    'SELECT handle, recovery_did_key FROM communities WHERE did = $1', [did])).rows[0];
  const keypair = await getKeypairForDid(did);
  return {
    rotationKeys: [state.rotationKeys[0], ...(row?.recovery_did_key ? [row.recovery_did_key] : [])],
    alsoKnownAs: [`at://${row?.handle ?? ''}${config.handleSuffix}`],
    verificationMethods: { atproto: keypair.did() },
    services: { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: config.pds.serviceUrl } },
  };
}

interface MovedKeyRow {
  rkey: string; visibility: string; dekIssuer: string | null; dekSubject: string | null;
  commitmentHash: string | null; commitmentSalt: string | null; issuerSignature: string | null;
  schemaHash: string | null; accessPolicy: unknown;
}

/** The old PDS's side: the attestation keys, readable only by the DID's current signing key. */
export async function sealMovedKeys(did: string, recipientDidKey: string): Promise<{ count: number; sealed: string }> {
  const rows = (await query<{
    rkey: string; visibility: string; encrypted_dek_issuer: string | null; encrypted_dek_subject: string | null;
    commitment_hash: string | null; commitment_salt: string | null; issuer_signature: string | null;
    schema_hash: string | null; access_policy: unknown;
  }>('SELECT rkey, visibility, encrypted_dek_issuer, encrypted_dek_subject, commitment_hash, commitment_salt, issuer_signature, schema_hash, access_policy FROM attestation_encryption WHERE community_did = $1', [did])).rows;
  const keys: MovedKeyRow[] = [];
  for (const r of rows) {
    keys.push({
      rkey: r.rkey, visibility: r.visibility,
      dekIssuer: r.encrypted_dek_issuer ? (await unwrapDEK(r.encrypted_dek_issuer)).toString('base64') : null,
      dekSubject: r.encrypted_dek_subject ? (await unwrapDEK(r.encrypted_dek_subject)).toString('base64') : null,
      commitmentHash: r.commitment_hash, commitmentSalt: r.commitment_salt, issuerSignature: r.issuer_signature,
      schemaHash: r.schema_hash, accessPolicy: r.access_policy,
    });
  }
  const plaintext = Buffer.from(JSON.stringify({ did, keys }));
  const sealed = encryptToDidKey(recipientDidKey, plaintext).toString('base64');
  plaintext.fill(0);
  return { count: keys.length, sealed };
}

/** The new PDS's side: open the sealed keys with the community's signing key and wrap them under this PDS's secret. */
export async function importMovedKeys(did: string, sealedBase64: string): Promise<number> {
  const signingBase64 = await getSigningKey(did);
  if (!signingBase64) throw new CommunityMoveError(500, 'InternalServerError', 'No signing key for the community');
  const priv = Buffer.from(signingBase64, 'base64');
  let parsed: { did: string; keys: MovedKeyRow[] };
  try {
    parsed = JSON.parse(decryptWithPrivateKey(priv, Buffer.from(sealedBase64, 'base64')).toString('utf8'));
  } catch {
    throw new CommunityMoveError(400, 'InvalidRequest', 'The sealed keys could not be opened with this PDS\'s key');
  } finally {
    priv.fill(0);
  }
  if (parsed.did !== did) throw new CommunityMoveError(400, 'InvalidRequest', 'The sealed keys belong to another community');
  let n = 0;
  for (const k of parsed.keys) {
    const issuer = k.dekIssuer ? await wrapDEK(Buffer.from(k.dekIssuer, 'base64')) : null;
    const subject = k.dekSubject ? await wrapDEK(Buffer.from(k.dekSubject, 'base64')) : null;
    await query(
      `INSERT INTO attestation_encryption
         (id, community_did, rkey, visibility, encrypted_dek_issuer, encrypted_dek_subject, commitment_hash, commitment_salt, issuer_signature, schema_hash, access_policy)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (community_did, rkey) DO UPDATE SET
         visibility = EXCLUDED.visibility, encrypted_dek_issuer = EXCLUDED.encrypted_dek_issuer,
         encrypted_dek_subject = EXCLUDED.encrypted_dek_subject, commitment_hash = EXCLUDED.commitment_hash,
         commitment_salt = EXCLUDED.commitment_salt, issuer_signature = EXCLUDED.issuer_signature,
         schema_hash = EXCLUDED.schema_hash, access_policy = EXCLUDED.access_policy`,
      [did, k.rkey, k.visibility, issuer, subject, k.commitmentHash, k.commitmentSalt, k.issuerSignature, k.schemaHash,
        k.accessPolicy === null || k.accessPolicy === undefined ? null : JSON.stringify(k.accessPolicy)]);
    n++;
  }
  return n;
}

/** Private attestation records that have no keys here yet. */
export async function missingAttestationKeys(did: string): Promise<number> {
  const row = (await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM records_index r
     WHERE r.community_did = $1 AND r.collection = 'net.openfederation.community.attestation'
       AND r.record->>'visibility' = 'private'
       AND NOT EXISTS (SELECT 1 FROM attestation_encryption e WHERE e.community_did = r.community_did AND e.rkey = r.rkey)`, [did])).rows[0];
  return Number(row.n);
}

/** True when `bytes` hash to `cid` (sha-256 CIDs only, which is what blobs use). */
async function bytesMatchCid(cid: string, bytes: Uint8Array): Promise<boolean> {
  let parsed: CID;
  try {
    parsed = CID.parse(cid);
  } catch {
    return false;
  }
  if (parsed.multihash.code !== sha256.code) return false;
  const digest = await sha256.digest(bytes);
  return Buffer.from(digest.digest).equals(Buffer.from(parsed.multihash.digest));
}

/**
 * Fetch and import the keys from the old home. Returns how many arrived, or
 * null when the old PDS did not answer or what it sent could not be used.
 *
 * Never throws for a bad answer: the old home is not in a position to block
 * the community's activation here by returning junk. The keys stay missing and
 * the call can be repeated.
 */
export async function fetchMovedKeys(did: string, fromPds: string): Promise<number | null> {
  try {
    const res = await fetchFromPeer(`${fromPds}/xrpc/net.openfederation.community.getMovedKeys?did=${encodeURIComponent(did)}`);
    if (!res.ok) return null;
    const body = JSON.parse((await readPeerBody(res, MAX_MOVED_KEYS_BYTES, 'The key bundle')).toString('utf-8')) as { sealed?: string } | null;
    if (!body?.sealed || typeof body.sealed !== 'string') return null;
    return await importMovedKeys(did, body.sealed);
  } catch (err) {
    console.warn('community %s: moved keys could not be imported from %s:', did, fromPds, err instanceof Error ? err.message : err);
    return null;
  }
}

export { currentPlcState, storeSigningKey };

/**
 * Mark the copy here as moved to `home`. Returns whether it is now (or already
 * was) marked moved.
 *
 * A suspended or taken-down community is left as it is. Its owner is still
 * free to take it elsewhere, but the copy here stays under moderation: if a
 * move could overwrite that status, moving away and straight back would be a
 * way to lift a suspension or takedown without an administrator.
 */
export async function markCommunityMoved(did: string, home: string): Promise<boolean> {
  const result = await query<{ changed: boolean }>(
    `UPDATE communities
     SET status = 'moved', status_changed_at = CURRENT_TIMESTAMP, status_reason = $2
     WHERE did = $1 AND status = 'active'
     RETURNING true AS changed`,
    [did, `moved to ${home}`],
  );
  if (result.rows.length > 0) return true;
  const current = await query<{ status: string }>('SELECT status FROM communities WHERE did = $1', [did]);
  return current.rows[0]?.status === 'moved';
}
