/**
 * How many members could vote, at one instant (#199).
 *
 * An override round's default bar is two-thirds of the electorate, so something
 * has to know how large the electorate is. Nothing did: every permission check
 * in the system asks "may *this caller* do this?", which is the right question
 * everywhere except here.
 *
 * The count is taken once, when the round opens, and frozen onto the proposal
 * record. It is deliberately not recomputed afterwards — a bar that moved with
 * the membership could be cleared by adding or removing members mid-round
 * rather than by winning the argument, which is precisely the manipulation the
 * override round exists to make unnecessary.
 *
 * Resolution mirrors `getCallerCommunityCapabilities` exactly, including the
 * `roleRkey` indirection: a member record can read `role: "member"` while its
 * `roleRkey` points at moderator, and resolving by name would count the wrong
 * people. The two tables are shared (`LEGACY_ROLE_PERMISSIONS`) rather than
 * copied.
 */

import { query } from '../db/client.js';
import { MEMBER_COLLECTION, ROLE_COLLECTION } from '../auth/permissions.js';
import { GOVERNANCE_WRITE_PERMISSION, LEGACY_ROLE_PERMISSIONS } from './decision-rules.js';

/**
 * Members of `communityDid` whose role carries `community.governance.write`.
 *
 * Counts member records, which is what the electorate is made of: community
 * creation writes an owner member record, so the owner is included without
 * being special-cased.
 */
export async function countEligibleVoters(communityDid: string): Promise<number> {
  const result = await query<{ role: string | null; role_rkey: string | null; role_record: any }>(
    `SELECT mr.record->>'role'     AS role,
            mr.record->>'roleRkey' AS role_rkey,
            rr.record              AS role_record
     FROM records_index mr
     LEFT JOIN records_index rr
       ON rr.community_did = mr.community_did
      AND rr.collection = $3
      AND rr.rkey = mr.record->>'roleRkey'
     WHERE mr.community_did = $1 AND mr.collection = $2`,
    [communityDid, MEMBER_COLLECTION, ROLE_COLLECTION],
  );

  let eligible = 0;
  for (const row of result.rows) {
    // A member record naming a roleRkey answers to that role record and to
    // nothing else. If the record is missing the role grants nothing — falling
    // back to the name would resolve a deleted role to whatever a built-in role
    // of the same name happens to carry.
    const permissions = row.role_rkey
      ? (Array.isArray(row.role_record?.permissions) ? row.role_record.permissions : [])
      : (LEGACY_ROLE_PERMISSIONS[row.role || 'member'] || []);
    if (permissions.includes(GOVERNANCE_WRITE_PERMISSION)) eligible++;
  }
  return eligible;
}
