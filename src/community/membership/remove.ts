import type { AuthContext } from '../../auth/types.js';
import { query } from '../../db/client.js';
import { throwXrpc } from '../../xrpc/errors.js';
import { auditLog } from '../../db/audit.js';
import {
  requireString,
  getCommunityOwner,
  getMemberRkey,
  deleteMemberRecord,
  getUserDid,
  getUserIdByDid,
} from './utils.js';

const REMOVE_NSID = 'net.openfederation.community.removeMember';

export interface RemoveMemberInput {
  did?: unknown;
  memberDid?: unknown;
}

export async function removeMemberLifecycle(
  caller: AuthContext,
  input: RemoveMemberInput,
): Promise<{ success: true }> {
  const communityDid = requireString(input.did, REMOVE_NSID, 'Missing required fields: did, memberDid');
  const memberDid = requireString(input.memberDid, REMOVE_NSID, 'Missing required fields: did, memberDid');
  const community = await getCommunityOwner(communityDid, REMOVE_NSID);

  const isOwner = community.created_by === caller.userId;
  const isAdmin = caller.roles.includes('admin');
  if (!isOwner && !isAdmin) {
    throwXrpc(REMOVE_NSID, 'Forbidden', 403, 'Only the community owner or PDS admin can remove members');
  }

  const ownerDid = await getUserDid(community.created_by);
  if (ownerDid === memberDid) {
    throwXrpc(REMOVE_NSID, 'Forbidden', 403, 'Cannot remove the community owner');
  }

  const memberRkey = await getMemberRkey(communityDid, memberDid);
  if (!memberRkey) {
    throwXrpc(REMOVE_NSID, 'NotMember', 400, 'User is not a member of this community');
  }

  await deleteMemberRecord(communityDid, memberRkey);

  const removedUserId = await getUserIdByDid(memberDid);
  if (removedUserId) {
    await query(
      'DELETE FROM join_requests WHERE community_did = $1 AND user_id = $2',
      [communityDid, removedUserId],
    );
  }

  await auditLog('community.removeMember', caller.userId, communityDid, { memberDid });
  return { success: true };
}
