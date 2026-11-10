/**
 * Remove a user account and everything stored for it: keys, repository,
 * blobs nobody else owns, memberships, sessions, roles. Used by the admin
 * deleteAccount endpoint and by the migration clean-up (#265).
 */
import type { PoolClient } from 'pg';
import { getBlobStore } from '../blob/blob-store.js';

/**
 * Delete the account's rows, inside the caller's transaction. Returns the CIDs
 * of blobs nothing references any more; their files are removed by
 * `removeBlobFiles` *after* the transaction commits. Deleting the files inside
 * it meant a rollback restored the rows but not the bytes.
 */
export async function deleteAccountData(client: PoolClient, user: { id: string; did: string }): Promise<string[]> {
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

  // The shares of the rotation key. Two of the three are held here, which is
  // enough to rebuild the key, so they must not outlive the account.
  await client.query('DELETE FROM vault_shares WHERE user_did = $1', [user.did]);
  // Wallets: the links (still published, and still "already linked" for
  // anyone else who holds the address), pending challenges, and keys in custody.
  await client.query('DELETE FROM wallet_link_challenges WHERE user_did = $1', [user.did]);
  await client.query('DELETE FROM wallet_links WHERE user_did = $1', [user.did]);
  await client.query('DELETE FROM wallet_custody WHERE user_did = $1', [user.did]);
  // Clients authorised through OAuth.
  await client.query(`DELETE FROM oauth_tokens WHERE data->>'sub' = $1`, [user.did]);
  await client.query('DELETE FROM oauth_device_accounts WHERE account_sub = $1', [user.did]);

  await client.query('DELETE FROM custodial_secrets WHERE user_did = $1', [user.did]);
  await client.query('DELETE FROM members_unique WHERE member_did = $1', [user.did]);
  await client.query('DELETE FROM join_requests WHERE user_id = $1', [user.id]);
  await client.query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
  await client.query('DELETE FROM user_roles WHERE user_id = $1', [user.id]);
  await client.query('DELETE FROM users WHERE id = $1', [user.id]);
  return orphaned.rows.map((row) => row.cid);
}

/** Remove blob files whose rows a committed deletion has already removed. */
export async function removeBlobFiles(cids: string[]): Promise<void> {
  if (cids.length === 0) return;
  const store = await getBlobStore();
  for (const cid of cids) {
    await store.delete(cid).catch((err) => console.error(`Could not remove blob file ${cid}:`, err));
  }
}
