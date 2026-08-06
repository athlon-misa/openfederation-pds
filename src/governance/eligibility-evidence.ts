/**
 * Membership evidence attached to a vote at the moment it is cast.
 *
 * Voting requires `community.governance.write`, which a member gets from the
 * role named on their member record. Both the member record and the role record
 * live in the *community's* repo and are signed with the community key, so they
 * are exactly the kind of thing a third party can recheck — but nothing recorded
 * which ones were consulted, so an offline verifier had no way to tell a real
 * electorate from a fabricated one. A decision citing five votes from DIDs that
 * were never members verified as `valid` (#200).
 *
 * A vote is judged eligible **as cast**: later removal or demotion does not
 * retroactively unmake a signed act, and tying it to resolution-time membership
 * would let an owner flip a result by removing voters mid-vote. So the evidence
 * is captured here, when the vote is written, rather than recomputed at tally.
 *
 * Both the CIDs and the resolved answer are recorded. The CIDs let a verifier
 * confirm against the community's own signed records while those records still
 * exist; the resolved role and permission keep the decision readable after a
 * member record has moved on, since `PgBlockstore` prunes superseded blocks and
 * an old CID eventually stops resolving. When the CIDs no longer resolve the
 * verifier says so with its own verdict rather than passing silently — the same
 * shape the quorum floor uses in `verify-decision.ts`.
 */
import { query } from '../db/client.js';
import { MEMBER_COLLECTION, ROLE_COLLECTION, PERMISSIONS } from '../auth/permissions.js';
import { LEGACY_ROLE_PERMISSIONS } from './decision-rules.js';

export interface EvidenceRef {
  uri: string;
  cid: string;
}

export interface EligibilityEvidence {
  /** The voter's member record in the community repo, when found. */
  member: EvidenceRef | null;
  /** The role record naming the permission set, when found. */
  roleRecord: EvidenceRef | null;
  /** Role named on the member record (`owner`, `moderator`, a custom role…). */
  roleName: string | null;
  /** Whether that role carried `community.governance.write` at cast time. */
  grantedGovernanceWrite: boolean;
  /** Set when the evidence could not be assembled, so the gap is legible. */
  unresolved?: string;
}

/**
 * Assemble the evidence for one voter.
 *
 * Never throws: a vote that cannot be evidenced still records *why*, because
 * "we could not tell" and "they were not eligible" are different claims and the
 * verifier reports them differently.
 */
export async function collectEligibilityEvidence(
  communityDid: string,
  voterDid: string,
): Promise<EligibilityEvidence> {
  const empty = (unresolved: string): EligibilityEvidence => ({
    member: null, roleRecord: null, roleName: null, grantedGovernanceWrite: false, unresolved,
  });
  const ref = (collection: string, rkey: string, cid: string): EvidenceRef => ({
    uri: `at://${communityDid}/${collection}/${rkey}`,
    cid,
  });

  try {
    const member = await query<{ rkey: string; cid: string; record: { role?: string; roleRkey?: string } }>(
      `SELECT ri.rkey, ri.cid, ri.record
         FROM members_unique mu
         JOIN records_index ri
           ON ri.community_did = mu.community_did
          AND ri.collection = $3
          AND ri.rkey = mu.record_rkey
        WHERE mu.community_did = $1 AND mu.member_did = $2`,
      [communityDid, voterDid, MEMBER_COLLECTION],
    );
    if (member.rows.length === 0) return empty('no-member-record');

    const memberRef = ref(MEMBER_COLLECTION, member.rows[0].rkey, member.rows[0].cid);
    const memberRecord = member.rows[0].record ?? {};

    // Mirror `getCallerCommunityCapabilities` exactly. A member record that
    // names a `roleRkey` takes its permissions from *that* role record — the
    // record's own `role` string can still say "member" while the assigned role
    // is moderator, so resolving by name would silently read the wrong
    // permission set.
    if (memberRecord.roleRkey) {
      const roleRow = await query<{ rkey: string; cid: string; record: { name?: string; permissions?: unknown } }>(
        `SELECT rkey, cid, record FROM records_index
          WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
        [communityDid, ROLE_COLLECTION, memberRecord.roleRkey],
      );
      if (roleRow.rows.length === 0) {
        return { member: memberRef, roleRecord: null, roleName: memberRecord.role ?? null,
          grantedGovernanceWrite: false, unresolved: 'role-record-missing' };
      }
      const permissions = roleRow.rows[0].record?.permissions;
      return {
        member: memberRef,
        roleRecord: ref(ROLE_COLLECTION, roleRow.rows[0].rkey, roleRow.rows[0].cid),
        roleName: roleRow.rows[0].record?.name ?? memberRecord.role ?? null,
        grantedGovernanceWrite: Array.isArray(permissions)
          && permissions.includes(PERMISSIONS.GOVERNANCE_WRITE),
      };
    }

    // No assigned role record: permissions come from the built-in table keyed by
    // the role name on the member record. There is nothing in the repo to cite,
    // so the role name plus the resolved answer is the whole evidence.
    const roleName = memberRecord.role ?? 'member';
    const legacy = LEGACY_ROLE_PERMISSIONS[roleName] ?? [];
    return {
      member: memberRef,
      roleRecord: null,
      roleName,
      grantedGovernanceWrite: legacy.includes(PERMISSIONS.GOVERNANCE_WRITE),
    };
  } catch (err) {
    return empty(err instanceof Error ? err.message : 'lookup-failed');
  }
}
