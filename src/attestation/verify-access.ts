/**
 * Who may verify an attestation hosted here.
 *
 * A public attestation in a public community: anyone. A private attestation,
 * or any attestation in a private community: a PDS admin, the community's
 * owner and members, the attestation's subject, and whoever holds an active,
 * unexpired viewing grant for it (`attestation.createViewingGrant`, issued by
 * the subject). Callers from other PDSes are identified by service auth.
 */
import type { AuthContext } from '../auth/types.js';
import { query } from '../db/client.js';
import { getCommunityAccess, canViewPrivateCommunity } from '../community/visibility.js';

const ATTESTATION_COLLECTION = 'net.openfederation.community.attestation';

export async function isPrivateAttestation(communityDid: string, rkey: string): Promise<boolean> {
  const row = await query<{ visibility: string }>(
    'SELECT visibility FROM attestation_encryption WHERE community_did = $1 AND rkey = $2', [communityDid, rkey]);
  return row.rows[0]?.visibility === 'private';
}

export interface VerifyAccess {
  allowed: boolean;
  /**
   * Set when the caller may look only because of viewing grants: the fields
   * they were granted (null: the whole claim). Unset: no restriction.
   */
  grantedFields?: string[] | null;
}

export async function verifyAccess(caller: AuthContext | undefined, communityDid: string, rkey: string): Promise<VerifyAccess> {
  const access = await getCommunityAccess({ communityDid, caller });
  const communityPrivate = access.exists && access.visibility === 'private';
  if (!communityPrivate && !(await isPrivateAttestation(communityDid, rkey))) return { allowed: true };
  if (!caller?.did) return { allowed: false };
  if (canViewPrivateCommunity(access)) return { allowed: true }; // admin, owner, member

  const subject = await query<{ subject: string | null }>(
    `SELECT record->>'subjectDid' AS subject FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
    [communityDid, ATTESTATION_COLLECTION, rkey]);
  if (subject.rows[0]?.subject === caller.did) return { allowed: true };

  const grants = await query<{ granted_fields: unknown }>(
    `SELECT granted_fields FROM viewing_grants
     WHERE attestation_community_did = $1 AND attestation_rkey = $2 AND granted_to_did = $3
       AND status = 'active' AND expires_at > NOW()`,
    [communityDid, rkey, caller.did]);
  if (grants.rows.length === 0) return { allowed: false };
  // Several grants: the union of what they disclose; one without a field list discloses everything.
  if (grants.rows.some((g) => g.granted_fields === null || g.granted_fields === undefined)) return { allowed: true, grantedFields: null };
  const fields = new Set<string>();
  for (const g of grants.rows) if (Array.isArray(g.granted_fields)) for (const f of g.granted_fields) if (typeof f === 'string') fields.add(f);
  return { allowed: true, grantedFields: [...fields] };
}

export async function mayVerifyAttestation(caller: AuthContext | undefined, communityDid: string, rkey: string): Promise<boolean> {
  return (await verifyAccess(caller, communityDid, rkey)).allowed;
}
