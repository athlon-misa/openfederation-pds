/**
 * Remove a user account and everything stored for it: keys, repository,
 * blobs nobody else owns, memberships, sessions, roles. Used by the admin
 * deleteAccount endpoint and by the migration clean-up (#265).
 */
import type { PoolClient } from 'pg';
import { getBlobStore } from '../blob/blob-store.js';

export async function deleteAccountData(client: PoolClient, user: { id: string; did: string }): Promise<void> {
  await client.query('DELETE FROM user_signing_keys WHERE user_did = $1', [user.did]);
  await client.query('DELETE FROM reserved_signing_keys WHERE did = $1', [user.did]);
  await client.query('DELETE FROM records_index WHERE community_did = $1', [user.did]);
  await client.query('DELETE FROM repo_blocks WHERE community_did = $1', [user.did]);
  await client.query('DELETE FROM repo_roots WHERE did = $1', [user.did]);

  // Blobs: drop this account's ownership; a blob no repo owns any more goes too.
  await client.query('DELETE FROM blob_owners WHERE did = $1', [user.did]);
  const orphaned = await client.query<{ cid: string }>(
    `DELETE FROM blobs b WHERE b.did = $1 AND NOT EXISTS (SELECT 1 FROM blob_owners o WHERE o.cid = b.cid) RETURNING cid`,
    [user.did]);
  const store = await getBlobStore();
  for (const { cid } of orphaned.rows) await store.delete(cid).catch(() => undefined);

  await client.query('DELETE FROM custodial_secrets WHERE user_did = $1', [user.did]);
  await client.query('DELETE FROM members_unique WHERE member_did = $1', [user.did]);
  await client.query('DELETE FROM join_requests WHERE user_id = $1', [user.id]);
  await client.query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
  await client.query('DELETE FROM user_roles WHERE user_id = $1', [user.id]);
  await client.query('DELETE FROM users WHERE id = $1', [user.id]);
}
