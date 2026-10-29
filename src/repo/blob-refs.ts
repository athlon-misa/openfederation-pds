/**
 * Blobs a repository references: every `{ $type: 'blob', ref: { $link } }`
 * anywhere in its indexed records. Used by account migration (#264): the old
 * PDS lists them, the new PDS reports the ones it does not hold yet.
 */
import { query } from '../db/client.js';

const BLOB_LINKS = `lax $.** ? (@."$type" == "blob").ref."$link"`;

/** One row per (record, blob) reference in the repo of `did`. */
const REFS = `
  SELECT jsonb_path_query(r.record, '${BLOB_LINKS}') #>> '{}' AS cid, r.collection, r.rkey
  FROM records_index r WHERE r.community_did = $1`;

/** Referenced blob CIDs in CID order, after `cursor`. */
export async function listReferencedBlobs(did: string, opts: { limit: number; cursor?: string }): Promise<string[]> {
  const rows = await query<{ cid: string }>(
    `SELECT DISTINCT cid FROM (${REFS}) refs
     WHERE cid IS NOT NULL AND ($2::text IS NULL OR cid > $2)
     ORDER BY cid LIMIT $3`,
    [did, opts.cursor ?? null, opts.limit]);
  return rows.rows.map((r) => r.cid);
}

/** Referenced blobs this PDS holds no copy of for `did`, with one record that references each. */
export async function listMissingBlobs(did: string, opts: { limit: number; cursor?: string }): Promise<{ cid: string; recordUri: string }[]> {
  const rows = await query<{ cid: string; collection: string; rkey: string }>(
    `SELECT DISTINCT ON (refs.cid) refs.cid, refs.collection, refs.rkey FROM (${REFS}) refs
     WHERE refs.cid IS NOT NULL AND ($2::text IS NULL OR refs.cid > $2)
       AND NOT EXISTS (SELECT 1 FROM blob_owners o WHERE o.cid = refs.cid AND o.did = $1)
     ORDER BY refs.cid, refs.collection, refs.rkey LIMIT $3`,
    [did, opts.cursor ?? null, opts.limit]);
  return rows.rows.map((r) => ({ cid: r.cid, recordUri: `at://${did}/${r.collection}/${r.rkey}` }));
}

/** How many distinct blobs the repo references, and how many of them this PDS holds for it. */
export async function countBlobs(did: string): Promise<{ expected: number; imported: number }> {
  const row = (await query<{ expected: string; imported: string }>(
    `SELECT COUNT(*) AS expected,
            COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM blob_owners o WHERE o.cid = refs.cid AND o.did = $1)) AS imported
     FROM (SELECT DISTINCT cid FROM (${REFS}) r WHERE cid IS NOT NULL) refs`,
    [did])).rows[0];
  return { expected: Number(row.expected), imported: Number(row.imported) };
}
