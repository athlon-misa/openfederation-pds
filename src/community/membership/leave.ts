import type { AuthContext } from '../../auth/types.js';
import { query } from '../../db/client.js';
import { throwXrpc } from '../../xrpc/errors.js';
import { requireString, getCommunityOwner, getMemberRkey, deleteMemberRecord } from './utils.js';

const LEAVE_NSID = 'net.openfederation.community.leave';

export interface LeaveCommunityInput {
  did?: unknown;
}

export async function leaveCommunityLifecycle(
  caller: AuthContext,
  input: LeaveCommunityInput,
): Promise<{ success: true }> {
  const communityDid = requireString(input.did, LEAVE_NSID, 'Missing required field: did');
  const community = await getCommunityOwner(communityDid, LEAVE_NSID);

  if (community.created_by === caller.userId) {
    throwXrpc(LEAVE_NSID, 'Forbidden', 403, 'The community owner cannot leave the community');
  }

  const memberRkey = await getMemberRkey(communityDid, caller.did);
  if (!memberRkey) {
    throwXrpc(LEAVE_NSID, 'NotMember', 400, 'You are not a member of this community');
  }

  await deleteMemberRecord(communityDid, memberRkey);
  await query(
    'DELETE FROM join_requests WHERE community_did = $1 AND user_id = $2',
    [communityDid, caller.userId],
  );

  return { success: true };
}
