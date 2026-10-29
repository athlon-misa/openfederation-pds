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

  for (let i = 0; i < data.records.length; i += BATCH) {
    const batch = data.records.slice(i, i + BATCH);
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
