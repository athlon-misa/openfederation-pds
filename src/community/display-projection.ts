import { query } from '../db/client.js';

export type DisplayFields = {
  displayName: string;
  avatarUrl: string | null;
};

export type OptionalDisplayFields = {
  displayName?: string;
  avatarUrl?: string;
};

/**
 * Batch-resolve optional display fields for a list of DIDs.
 * Returns a Map keyed by DID. Fields are absent (not null) when no profile record exists.
 * One SQL query for the entire batch — safe for up to ~100 DIDs.
 */
export async function batchResolveOptionalDisplayFields(
  dids: string[],
): Promise<Map<string, OptionalDisplayFields>> {
  const result = new Map<string, OptionalDisplayFields>();
  if (dids.length === 0) return result;

  const rows = await query<{ community_did: string; collection: string; record: any }>(
    `SELECT community_did, collection, record
     FROM records_index
     WHERE community_did = ANY($1)
       AND collection LIKE '%.actor.profile'
       AND rkey = 'self'
     ORDER BY community_did,
              CASE WHEN collection = 'app.bsky.actor.profile' THEN 1 ELSE 0 END ASC`,
    [dids],
  );

  // For each DID take the first row (non-bsky sorted first = higher priority)
  for (const row of rows.rows) {
    if (result.has(row.community_did)) continue;
    const profile = row.record ?? {};
    const fields: OptionalDisplayFields = {};
    const dn = profile.displayName;
    const av = profile.avatarUrl ?? profile.avatar;
    if (dn) fields.displayName = dn;
    if (av) fields.avatarUrl = av;
    result.set(row.community_did, fields);
  }

  return result;
}

/**
 * Resolve the display name and avatar URL for a user DID by looking at
 * their profile records in records_index.
 *
 * Precedence: custom *.actor.profile (non-bsky) → app.bsky.actor.profile → handle fallback.
 */
export async function resolveDisplayFields(
  memberDid: string,
  handle: string,
): Promise<DisplayFields> {
  const profileResult = await query<{ collection: string; record: any }>(
    `SELECT collection, record FROM records_index
     WHERE community_did = $1
       AND collection LIKE '%.actor.profile'
       AND rkey = 'self'
     ORDER BY CASE WHEN collection = 'app.bsky.actor.profile' THEN 1 ELSE 0 END ASC`,
    [memberDid],
  );

  // Non-bsky profile has precedence (ordered first by the CASE expression above)
  const profile = profileResult.rows[0]?.record ?? null;
  return {
    displayName: profile?.displayName || handle,
    avatarUrl: profile?.avatarUrl || profile?.avatar || null,
  };
}

/**
 * Update the display projection columns on members_unique for every
 * community row belonging to a given member DID.
 * Called after account.updateProfile to fan out the new display name.
 */
export async function fanOutDisplayFields(
  memberDid: string,
  handle: string,
): Promise<void> {
  const fields = await resolveDisplayFields(memberDid, handle);
  await query(
    `UPDATE members_unique
     SET display_name = $1, avatar_url = $2
     WHERE member_did = $3`,
    [fields.displayName, fields.avatarUrl, memberDid],
  );
}

/**
 * Sync the role / kind / tags / attributes columns on a single members_unique
 * row from the values that were just written to records_index.
 */
export async function syncMemberRoleProjection(
  communityDid: string,
  memberDid: string,
  fields: {
    role?: string | null;
    roleRkey?: string | null;
    kind?: string | null;
    tags?: string[] | null;
    attributes?: Record<string, unknown> | null;
  },
): Promise<void> {
  await query(
    `UPDATE members_unique
     SET role      = COALESCE($3, role),
         role_rkey = $4,
         kind      = $5,
         tags      = $6,
         attributes = $7
     WHERE community_did = $1 AND member_did = $2`,
    [
      communityDid,
      memberDid,
      fields.role ?? null,
      fields.roleRkey ?? null,
      fields.kind ?? null,
      fields.tags ? JSON.stringify(fields.tags) : null,
      fields.attributes ? JSON.stringify(fields.attributes) : null,
    ],
  );
}
