import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { query } from '../db/client.js';
import { requireCommunityReadable } from '../auth/guards.js';

const ATTESTATION_COLLECTION = 'net.openfederation.community.attestation';

export default async function listAttestations(req: AuthRequest, res: Response): Promise<void> {
  try {
    const communityDid = req.query.communityDid as string;
    const subjectDid = req.query.subjectDid as string | undefined;
    const type = req.query.type as string | undefined;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 100);
    const cursor = req.query.cursor as string | undefined;

    if (!communityDid || !communityDid.startsWith('did:')) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'communityDid parameter is required and must be a valid DID',
      });
      return;
    }

    if (!(await requireCommunityReadable(req, res, communityDid))) return;

    // The projection intentionally contains metadata for both public and
    // encrypted attestations.  Only expose a private row when the caller is
    // one of the principals covered by its disclosure policy.  Community
    // readability alone is not sufficient: a member must not enumerate
    // another member's private attestations.
    const privateAccess: string[] = [];
    const privateParams: (string | number)[] = [];
    const access = req.auth;
    if (access?.roles.includes('admin')) {
      privateAccess.push(`TRUE`);
    } else if (access) {
      privateParams.push(access.did);
      const callerDidParam = '$2';
      privateAccess.push(`ai.subject_did = ${callerDidParam}`);
      const allowlistedDidParam = '$2';
      privateAccess.push(`ae.access_policy->>'type' = 'did-allowlist' AND ae.access_policy->'dids' ? ${allowlistedDidParam}`);
      privateAccess.push(`ae.access_policy->>'type' = 'community-member' AND EXISTS (
        SELECT 1 FROM members_unique policy_member
        WHERE policy_member.community_did = ae.access_policy->>'communityDid'
          AND policy_member.member_did = ${callerDidParam}
      )`);
      // Owner access is deliberately scoped to the attestation's community.
      privateParams.push(access.userId);
      privateAccess.push(`EXISTS (
        SELECT 1 FROM communities attestation_community
        WHERE attestation_community.did = ai.community_did
          AND attestation_community.created_by = $3
      )`);
      // An active viewing grant is an explicit disclosure authorization.
      privateAccess.push(`EXISTS (
        SELECT 1 FROM viewing_grants vg
        WHERE vg.attestation_community_did = ai.community_did
          AND vg.attestation_rkey = ai.rkey
          AND vg.granted_to_did = ${callerDidParam}
          AND vg.status = 'active' AND vg.expires_at > NOW()
      )`);
    }
    const privateVisibilityClause = privateAccess.length > 0
      ? `COALESCE(ae.visibility, 'public') <> 'private' OR (${privateAccess.join(' OR ')})`
      : `COALESCE(ae.visibility, 'public') <> 'private'`;

    // Read from the write-time projection index — single SELECT, no join needed
    let sql = `SELECT ai.rkey, ai.subject_did, ai.subject_handle, ai.subject_display_name, ai.subject_avatar_url,
                      type, COALESCE(ai.claim, '{}'::jsonb) AS claim, issued_at, expires_at
               FROM community_attestation_index ai
               LEFT JOIN attestation_encryption ae
                 ON ae.community_did = ai.community_did AND ae.rkey = ai.rkey
               WHERE ai.community_did = $1 AND (${privateVisibilityClause})`;
    const params: (string | number)[] = [communityDid, ...privateParams];
    let paramIdx = params.length + 1;

    if (subjectDid) {
      sql += ` AND ai.subject_did = $${paramIdx}`;
      params.push(subjectDid);
      paramIdx++;
    }

    if (type) {
      sql += ` AND ai.type = $${paramIdx}`;
      params.push(type);
      paramIdx++;
    }

    if (cursor) {
      sql += ` AND ai.rkey > $${paramIdx}`;
      params.push(cursor);
      paramIdx++;
    }

    sql += ` ORDER BY ai.rkey ASC LIMIT $${paramIdx}`;
    params.push(limit + 1);

    const result = await query<{
      rkey: string;
      subject_did: string;
      subject_handle: string;
      subject_display_name: string;
      subject_avatar_url: string | null;
      type: string;
      claim: unknown;
      issued_at: Date;
      expires_at: Date | null;
    }>(sql, params);

    let rows = result.rows;
    let nextCursor: string | undefined;
    if (rows.length > limit) {
      rows = rows.slice(0, limit);
      nextCursor = rows[rows.length - 1].rkey;
    }

    const attestations = rows.map(row => ({
      uri: `at://${communityDid}/${ATTESTATION_COLLECTION}/${row.rkey}`,
      rkey: row.rkey,
      subjectDid: row.subject_did,
      subjectHandle: row.subject_handle,
      subjectDisplayName: row.subject_display_name,
      subjectAvatarUrl: row.subject_avatar_url ?? null,
      type: row.type,
      claim: row.claim,
      issuedAt: new Date(row.issued_at).toISOString(),
      ...(row.expires_at ? { expiresAt: new Date(row.expires_at).toISOString() } : {}),
    }));

    res.status(200).json({
      attestations,
      ...(nextCursor ? { cursor: nextCursor } : {}),
    });
  } catch (error) {
    console.error('Error in listAttestations:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to list attestations' });
  }
}
