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
import { encryptToDidKey, decryptWithPrivateKey } from '../crypto/ecies.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';

export class CommunityMoveError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

/** Where the DID says the community lives now; null when it is here. */
export function homeOf(state: PlcState): string | null {
  const endpoint = state.services.atproto_pds?.endpoint;
  if (!endpoint || endpoint === config.pds.serviceUrl) return null;
  return endpoint.replace(/\/+$/, '');
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
  const res = await fetch(`${fromPds}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(did)}`);
  if (!res.ok) throw new CommunityMoveError(502, 'UpstreamFailure', `The community's current PDS did not export the repository (${res.status})`);
  const car = Buffer.from(await res.arrayBuffer());
  if (car.length > MAX_CAR_SIZE) throw new CommunityMoveError(413, 'PayloadTooLarge', 'The repository exceeds 100 MB');
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
      const res = await fetch(`${fromPds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`);
      if (!res.ok) throw new CommunityMoveError(502, 'UpstreamFailure', `The community's current PDS did not serve blob ${cid} (${res.status})`);
      const bytes = Buffer.from(await res.arrayBuffer());
      const mime = res.headers.get('content-type') ?? 'application/octet-stream';
      await store.put(cid, bytes, mime);
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

/** Fetch and import the keys from the old home; returns how many arrived, or null when the old PDS did not answer. */
export async function fetchMovedKeys(did: string, fromPds: string): Promise<number | null> {
  const res = await fetch(`${fromPds}/xrpc/net.openfederation.community.getMovedKeys?did=${encodeURIComponent(did)}`).catch(() => null);
  if (!res || !res.ok) return null;
  const body = await res.json().catch(() => null) as { sealed?: string } | null;
  if (!body?.sealed) return null;
  return importMovedKeys(did, body.sealed);
}

export { currentPlcState, storeSigningKey };
