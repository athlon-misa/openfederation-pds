/**
 * Derived tables a community's records project into: members_unique and
 * community_attestation_index. Written on every record write, and rebuilt
 * from records_index when a community arrives from another PDS (#267).
 */
import type { PoolClient } from 'pg';
import { query } from '../db/client.js';
import { resolveDisplayFields, fanOutDisplayFields } from './display-projection.js';

export const MEMBER_COLLECTION = 'net.openfederation.community.member';
export const ATTESTATION_COLLECTION = 'net.openfederation.community.attestation';

type Runner = { query: (text: string, params?: unknown[]) => Promise<unknown> };

export async function projectMemberRow(client: Runner, communityDid: string, rkey: string, record: Record<string, unknown>): Promise<void> {
  const rec = record as {
    did?: string; handle?: string | null; role?: string | null; roleRkey?: string | null;
    kind?: string | null; tags?: string[] | null; attributes?: Record<string, unknown> | null;
  };
  if (!rec.did) return;
  await client.query(
    `INSERT INTO members_unique
       (community_did, member_did, record_rkey, handle, role, role_rkey, kind, tags, attributes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (community_did, member_did) DO UPDATE
       SET record_rkey = EXCLUDED.record_rkey,
           handle      = COALESCE(EXCLUDED.handle, members_unique.handle),
           role        = COALESCE(EXCLUDED.role, members_unique.role),
           role_rkey   = EXCLUDED.role_rkey,
           kind        = EXCLUDED.kind,
           tags        = EXCLUDED.tags,
           attributes  = EXCLUDED.attributes`,
    [
      communityDid, rec.did, rkey, rec.handle ?? null, rec.role ?? null, rec.roleRkey ?? null, rec.kind ?? null,
      rec.tags ? JSON.stringify(rec.tags) : null, rec.attributes ? JSON.stringify(rec.attributes) : null,
    ],
  );
}

export async function upsertAttestationIndex(
  communityDid: string, rkey: string, subjectDid: string, subjectHandle: string,
  type: string, claim: unknown, issuedAt: string, expiresAt: string | null, client: Runner = { query },
): Promise<void> {
  const display = await resolveDisplayFields(subjectDid, subjectHandle);
  await client.query(
    `INSERT INTO community_attestation_index
       (community_did, rkey, subject_did, subject_handle, subject_display_name, subject_avatar_url,
        type, claim, issued_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (community_did, rkey) DO UPDATE SET
       subject_display_name = EXCLUDED.subject_display_name,
       subject_avatar_url   = EXCLUDED.subject_avatar_url,
       type                 = EXCLUDED.type,
       claim                = EXCLUDED.claim,
       issued_at            = EXCLUDED.issued_at,
       expires_at           = EXCLUDED.expires_at`,
    [
      communityDid, rkey, subjectDid, subjectHandle, display.displayName, display.avatarUrl,
      type, claim ? JSON.stringify(claim) : null, issuedAt, expiresAt,
    ],
  );
}

/** Rebuild both projections for a community from its records_index rows, inside the caller's transaction. */
export async function rebuildCommunityProjections(client: PoolClient, communityDid: string): Promise<{ members: number; attestations: number }> {
  await client.query('DELETE FROM members_unique WHERE community_did = $1', [communityDid]);
  await client.query('DELETE FROM community_attestation_index WHERE community_did = $1', [communityDid]);
  const rows = (await client.query<{ collection: string; rkey: string; record: Record<string, unknown> }>(
    'SELECT collection, rkey, record FROM records_index WHERE community_did = $1 AND collection = ANY($2)',
    [communityDid, [MEMBER_COLLECTION, ATTESTATION_COLLECTION]])).rows;
  let members = 0; let attestations = 0;
  for (const row of rows) {
    if (row.collection === MEMBER_COLLECTION) {
      await projectMemberRow(client, communityDid, row.rkey, row.record);
      members++;
      continue;
    }
    const a = row.record as {
      subjectDid?: string; subjectHandle?: string; type?: string; claim?: unknown;
      visibility?: string; issuedAt?: string; expiresAt?: string;
    };
    if (!a.subjectDid || !a.type || !a.issuedAt) continue;
    const claim = a.visibility === 'private' || (a.claim as { encrypted?: boolean } | undefined)?.encrypted ? null : a.claim;
    await upsertAttestationIndex(communityDid, row.rkey, a.subjectDid, a.subjectHandle ?? '', a.type, claim, a.issuedAt, a.expiresAt ?? null, client);
    attestations++;
  }
  return { members, attestations };
}

/** Display names and avatars for every member, resolved after a rebuild. */
export async function refreshMemberDisplay(communityDid: string): Promise<void> {
  const members = (await query<{ member_did: string; handle: string | null }>(
    'SELECT member_did, handle FROM members_unique WHERE community_did = $1', [communityDid])).rows;
  for (const m of members) await fanOutDisplayFields(m.member_did, m.handle ?? '').catch(() => undefined);
}
