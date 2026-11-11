/**
 * Remove a community and everything stored for it, inside the caller's
 * transaction: membership, repository, keys, and blobs no other repository
 * owns. Returns the CIDs of those blobs; their files are removed with
 * `removeBlobFiles` after the transaction commits. Used by community.delete
 * and by the takedown sweep.
 */
import type { PoolClient } from 'pg';

export async function deleteCommunityData(client: PoolClient, did: string): Promise<string[]> {
  await client.query('DELETE FROM join_requests WHERE community_did = $1', [did]);
  await client.query('DELETE FROM members_unique WHERE community_did = $1', [did]);
  await client.query('DELETE FROM records_index WHERE community_did = $1', [did]);
  await client.query('DELETE FROM repo_blocks WHERE community_did = $1', [did]);
  await client.query('DELETE FROM repo_roots WHERE did = $1', [did]);
  await client.query('DELETE FROM commits WHERE community_did = $1', [did]);
  await client.query('DELETE FROM signing_keys WHERE community_did = $1', [did]);
  await client.query('DELETE FROM plc_keys WHERE community_did = $1', [did]);
  await client.query('DELETE FROM blob_owners WHERE did = $1', [did]);
  const orphaned = await client.query<{ cid: string }>(
    `DELETE FROM blobs b WHERE b.did = $1 AND NOT EXISTS (SELECT 1 FROM blob_owners o WHERE o.cid = b.cid) RETURNING cid`,
    [did]);
  await client.query('DELETE FROM communities WHERE did = $1', [did]);
  return orphaned.rows.map((row) => row.cid);
}
