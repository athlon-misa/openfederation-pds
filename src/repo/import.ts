/**
 * Importing a repository from a CAR file (account migration, restore).
 *
 * The CAR is fully verified before anything is stored: the commit names the
 * expected DID, its signature verifies with the given atproto key, and the
 * record tree is complete. Only the blocks that belong to the verified repo
 * are kept, and everything is written in one transaction.
 */
import type { PoolClient } from 'pg';
import { readCarWithRoot, verifyRepo, cborToLex, RepoVerificationError } from '@atproto/repo';
import { cborDecode } from '@atproto/common';
import { lexToJson } from '@atproto/lexicon';
import { authorSignatureValid, recordAuthor } from '../governance/author-signature.js';
import { atprotoKeyHistory } from '../identity/account-migration.js';
import { verifyExternalKeyProof } from '../identity/external-keys.js';

export class RepoImportError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export interface VerifiedImport {
  root: string;
  rev: string;
  blocks: { cid: string; bytes: Uint8Array }[];
  records: { collection: string; rkey: string; cid: string; record: unknown }[];
}

export const MAX_CAR_SIZE = 100 * 1024 * 1024;

/**
 * Parse and verify a repository CAR for `did`. The key the commit must be
 * signed with (a did:key) is looked up only once the CAR is known to be this
 * DID's repository.
 */
export async function verifyRepoImport(
  did: string, carBytes: Uint8Array, resolveSigningKey: () => Promise<string | null>,
): Promise<VerifiedImport> {
  if (carBytes.length === 0) throw new RepoImportError(400, 'InvalidRequest', 'Empty CAR body');

  let car: Awaited<ReturnType<typeof readCarWithRoot>>;
  try {
    car = await readCarWithRoot(carBytes);
  } catch {
    throw new RepoImportError(400, 'InvalidCar', 'Failed to parse CAR data');
  }

  // Checked before the full verification so a backup of another account gets
  // a precise error.
  let commit: { did?: unknown; rev?: unknown } | null;
  try {
    const bytes = car.blocks.get(car.root);
    commit = bytes ? cborDecode(bytes) as { did?: unknown; rev?: unknown } : null;
  } catch {
    commit = null;
  }
  if (!commit || typeof commit.did !== 'string' || typeof commit.rev !== 'string') {
    throw new RepoImportError(400, 'InvalidCar', 'CAR root is not a repository commit');
  }
  if (commit.did !== did) throw new RepoImportError(400, 'DidMismatch', 'The CAR\'s commit belongs to a different DID');

  let signingKey: string | null;
  try {
    signingKey = await resolveSigningKey();
  } catch {
    signingKey = null;
  }
  if (!signingKey) throw new RepoImportError(400, 'UnresolvableDid', 'Could not resolve the DID\'s atproto signing key');

  let verified: Awaited<ReturnType<typeof verifyRepo>>;
  try {
    verified = await verifyRepo(car.blocks, car.root, did, signingKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof RepoVerificationError && message.startsWith('Invalid signature')) {
      throw new RepoImportError(400, 'InvalidSignature', 'The commit is not signed by the DID\'s current atproto key');
    }
    throw new RepoImportError(400, 'InvalidRepo', `The repository is incomplete or malformed: ${message}`);
  }

  const kept = verified.commit.newBlocks;
  const blocks: VerifiedImport['blocks'] = [];
  kept.forEach((bytes, cid) => { blocks.push({ cid: cid.toString(), bytes }); });

  const records = verified.creates.map((c) => {
    const bytes = kept.get(c.cid);
    if (!bytes) throw new RepoImportError(400, 'InvalidRepo', `Missing record block ${c.cid.toString()}`);
    return { collection: c.collection, rkey: c.rkey, cid: c.cid.toString(), record: lexToJson(cborToLex(bytes)) };
  });

  return { root: verified.commit.cid.toString(), rev: verified.commit.rev, blocks, records };
}

const BATCH = 500;

/**
 * Store a verified import for `did` inside the caller's transaction. With
 * `replace`, the DID's existing blocks and index rows go first (an account
 * opened for migration has an empty placeholder repo).
 */
const GOVERNANCE_VOTE = 'net.openfederation.governance.vote';
const GOVERNANCE_OBJECTION = 'net.openfederation.governance.objection';
const GOVERNANCE_DECISION = 'net.openfederation.governance.decision';

/**
 * Which imported records may enter `records_index`.
 *
 * Votes and objections are counted from `records_index` for the repo they sit
 * in, and their standing comes from the endpoint that wrote them (it checks the
 * voter is entitled to vote). An imported repository is signed by its owner and
 * by nobody else, so a vote or objection inside it is only that owner's claim.
 * Such a record is kept in the repository (the blocks are stored untouched) but
 * is not indexed when it names a community hosted here that the importing DID
 * is not a member of, and never when the importing repo is itself a community.
 * A decision record belongs to the community repo that resolved the proposal
 * and is likewise never indexed from an imported account repo.
 */
/**
 * In a community repo, decisions are the community's own and are kept. Votes
 * and objections there belong to a private community's members and count for
 * their `author`, so one is kept only if that author signed it (checked
 * against every key the author's DID has held). Anything else in those
 * collections is dropped: it would be a vote or a hold nobody cast.
 */
export async function communityGovernanceRecordsToKeep(
  records: VerifiedImport['records'],
): Promise<VerifiedImport['records']> {
  const keys = new Map<string, string[]>();
  const kept: VerifiedImport['records'] = [];
  for (const r of records) {
    if (r.collection !== GOVERNANCE_VOTE && r.collection !== GOVERNANCE_OBJECTION) {
      kept.push(r);
      continue;
    }
    const record = (r.record ?? {}) as Record<string, unknown>;
    const author = recordAuthor(record);
    if (!author) continue;
    if (!keys.has(author)) keys.set(author, await atprotoKeyHistory(author).catch(() => []));
    if (await authorSignatureValid(record, keys.get(author)!)) kept.push(r);
  }
  return kept;
}

const EXTERNAL_KEY_COLLECTION = 'net.openfederation.identity.externalKey';

/**
 * Key claims (net.openfederation.identity.externalKey) are only indexed when
 * the record carries the claimant's proof for this very DID, the same proof
 * setExternalKey demands. Without this, a repository import could claim
 * someone else's public key, and block its real owner from claiming it.
 * Claims written before records kept their proof are dropped from the index;
 * the owner claims them again.
 */
export function externalKeyClaimsToKeep(did: string, records: VerifiedImport['records']): VerifiedImport['records'] {
  return records.filter((r) => {
    if (r.collection !== EXTERNAL_KEY_COLLECTION) return true;
    const rec = (r.record ?? {}) as Record<string, unknown>;
    const { type, purpose, publicKey, proof } = rec;
    if (typeof type !== 'string' || typeof purpose !== 'string' || typeof publicKey !== 'string' || typeof proof !== 'string') return false;
    return verifyExternalKeyProof(did, r.rkey, type, purpose, publicKey, proof).valid === true;
  });
}

async function indexableRecords(
  client: PoolClient,
  did: string,
  allRecords: VerifiedImport['records'],
): Promise<VerifiedImport['records']> {
  const records = externalKeyClaimsToKeep(did, allRecords);
  const governance = records.filter((r) =>
    r.collection === GOVERNANCE_VOTE || r.collection === GOVERNANCE_OBJECTION || r.collection === GOVERNANCE_DECISION);
  if (governance.length === 0) return records;

  const isCommunity = (await client.query('SELECT 1 FROM communities WHERE did = $1', [did])).rows.length > 0;
  if (isCommunity) return communityGovernanceRecordsToKeep(records);

  const named = [...new Set(governance
    .map((r) => (r.record as { community?: unknown } | null)?.community)
    .filter((c): c is string => typeof c === 'string'))];
  const hostedHere = new Set((await client.query<{ did: string }>(
    'SELECT did FROM communities WHERE did = ANY($1)', [named])).rows.map((r) => r.did));
  const memberOf = new Set((await client.query<{ community_did: string }>(
    'SELECT community_did FROM members_unique WHERE member_did = $1 AND community_did = ANY($2)', [did, named])).rows.map((r) => r.community_did));

  return records.filter((r) => {
    if (r.collection === GOVERNANCE_DECISION) return false;
    if (r.collection !== GOVERNANCE_VOTE && r.collection !== GOVERNANCE_OBJECTION) return true;
    const community = (r.record as { community?: unknown } | null)?.community;
    if (typeof community !== 'string') return true;
    return !hostedHere.has(community) || memberOf.has(community);
  });
}

export async function storeRepoImport(client: PoolClient, did: string, data: VerifiedImport, opts: { replace: boolean }): Promise<void> {
  if (opts.replace) {
    await client.query('DELETE FROM records_index WHERE community_did = $1', [did]);
    await client.query('DELETE FROM repo_blocks WHERE community_did = $1', [did]);
  }

  for (let i = 0; i < data.blocks.length; i += BATCH) {
    const batch = data.blocks.slice(i, i + BATCH);
    await client.query(
      `INSERT INTO repo_blocks (community_did, cid, block_bytes, rev)
       SELECT $1, cid, bytes, $4 FROM unnest($2::text[], $3::bytea[]) AS b(cid, bytes)
       ON CONFLICT (community_did, cid) DO NOTHING`,
      [did, batch.map((b) => b.cid), batch.map((b) => Buffer.from(b.bytes)), data.rev],
    );
  }

  await client.query(
    `INSERT INTO repo_roots (did, root_cid, rev) VALUES ($1, $2, $3)
     ON CONFLICT (did) DO UPDATE SET root_cid = $2, rev = $3`,
    [did, data.root, data.rev],
  );

  const records = await indexableRecords(client, did, data.records);
  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH);
    await client.query(
      `INSERT INTO records_index (community_did, collection, rkey, record, cid)
       SELECT $1, collection, rkey, record::jsonb, cid
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS r(collection, rkey, record, cid)
       ON CONFLICT (community_did, collection, rkey) DO UPDATE SET record = EXCLUDED.record, cid = EXCLUDED.cid`,
      [did, batch.map((r) => r.collection), batch.map((r) => r.rkey), batch.map((r) => JSON.stringify(r.record)), batch.map((r) => r.cid)],
    );
  }
}

/** Read a request body as bytes, refusing more than MAX_CAR_SIZE. */
export async function readCarBody(req: AsyncIterable<Buffer | string>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_CAR_SIZE) throw new RepoImportError(413, 'PayloadTooLarge', 'CAR body exceeds maximum size of 100 MB');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
