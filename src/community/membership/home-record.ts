/**
 * Membership records in the member's own repo (#385).
 *
 * A membership is a `net.openfederation.community.member` record in the
 * community's repo, on the community's PDS. That record stays the authority.
 * Its counterpart lives in the member's repo, as follows do in AT Protocol:
 * `net.openfederation.community.membership`, `{ community, createdAt }`, at
 * rkey = the community's DID (one per community, so writing it twice changes
 * nothing). It lets the member's home PDS (and any client) know every
 * community the member belongs to, on any PDS, without asking peers. A home
 * record the community does not confirm is a bookmark, not a membership.
 *
 * Rules:
 *   - Public communities only. A user's repo is public whatever the
 *     community's visibility (ADR-001), so a record for a private community
 *     would say who belongs to it. Private memberships are found through
 *     peers, as before; a community that turns private has the records this
 *     PDS holds removed (`removeHomeMembershipsForCommunity`).
 *   - The record goes in the repo of the DID that joined. A pseudonym joins
 *     as itself, so its record is in the pseudonym's repo, never the
 *     person's main account (this module never looks for a "main account").
 *   - Only for accounts whose repo is here and that the server may sign for.
 *     A member from another PDS, or one whose device signs their repo (#240),
 *     writes it themselves; the join answer carries the record to write.
 *
 * Writing the home record never fails a join or leave: the community-side
 * record is what counts. A failure is logged; the backfill can repair it.
 */
import { query } from '../../db/client.js';
import { RepoEngine } from '../../repo/repo-engine.js';
import { getKeypairForDid } from '../../repo/keypair-utils.js';
import { isDeviceSigningOn } from '../../repo/device-signing-state.js';

export const MEMBERSHIP_COLLECTION = 'net.openfederation.community.membership';

export interface MembershipRecord {
  [key: string]: unknown;
  $type: typeof MEMBERSHIP_COLLECTION;
  community: string;
  createdAt: string;
}

export function membershipRecord(communityDid: string, createdAt: string = new Date().toISOString()): MembershipRecord {
  return { $type: MEMBERSHIP_COLLECTION, community: communityDid, createdAt };
}

export function membershipUri(memberDid: string, communityDid: string): string {
  return `at://${memberDid}/${MEMBERSHIP_COLLECTION}/${communityDid}`;
}

/** What a join tells the caller about the home record (absent for private communities). */
export interface HomeRecordWrite {
  uri: string;
  collection: typeof MEMBERSHIP_COLLECTION;
  rkey: string;
  record: MembershipRecord;
  /** True when this PDS wrote it; false when the member's home PDS or device must. */
  written: boolean;
}

/** What a leave tells the caller about the home record. */
export interface HomeRecordDelete {
  collection: typeof MEMBERSHIP_COLLECTION;
  rkey: string;
  /** True when this PDS removed it from the member's repo; false when the member's home must, if it holds one. */
  deleted: boolean;
}

export async function isPublicCommunity(communityDid: string): Promise<boolean> {
  const settings = await query<{ visibility: string | null }>(
    `SELECT record->>'visibility' AS visibility FROM records_index
     WHERE community_did = $1 AND collection = 'net.openfederation.community.settings' AND rkey = 'self'`,
    [communityDid],
  );
  return settings.rows[0]?.visibility !== 'private';
}

/**
 * Whether `did` is an account whose repo this server holds and may sign:
 * a user here (not a community, not an external account), with a repo.
 */
async function serverWritesRepoOf(did: string): Promise<boolean> {
  const result = await query<{ device_signing: boolean }>(
    `SELECT u.device_signing FROM users u
       JOIN repo_roots r ON r.did = u.did
      WHERE u.did = $1 AND COALESCE(u.auth_type, 'local') <> 'external'
        AND NOT EXISTS (SELECT 1 FROM communities c WHERE c.did = u.did)`,
    [did],
  );
  return result.rows.length > 0 && result.rows[0].device_signing !== true;
}

/**
 * After a membership became real on this PDS: put the home record in the
 * member's repo when the server may, and say what the member's side should
 * hold. Null for a private community: no home record at all.
 */
export async function writeHomeMembership(memberDid: string, communityDid: string): Promise<HomeRecordWrite | null> {
  try {
    if (!(await isPublicCommunity(communityDid))) return null;
  } catch (err) {
    console.error('could not read the visibility of %s:', communityDid, err);
    return null;
  }
  const record = membershipRecord(communityDid);
  const out: HomeRecordWrite = {
    uri: membershipUri(memberDid, communityDid),
    collection: MEMBERSHIP_COLLECTION,
    rkey: communityDid,
    record,
    written: false,
  };
  try {
    if (!(await serverWritesRepoOf(memberDid))) return out;
    const engine = new RepoEngine(memberDid);
    const existing = await engine.getRecord(MEMBERSHIP_COLLECTION, communityDid);
    if (existing) {
      out.record = existing.record as MembershipRecord;
    } else {
      await engine.putRecord(await getKeypairForDid(memberDid), MEMBERSHIP_COLLECTION, communityDid, record);
    }
    out.written = true;
  } catch (err) {
    console.error('could not write membership record for %s in %s:', communityDid, memberDid, err);
  }
  return out;
}

/** Rkeys of the member's home records naming `communityDid` (the community's DID, normally; any rkey a client chose too). */
async function homeRecordRkeys(memberDid: string, communityDid: string): Promise<string[]> {
  const rows = await query<{ rkey: string }>(
    `SELECT rkey FROM records_index
      WHERE community_did = $1 AND collection = $2 AND (rkey = $3 OR record->>'community' = $3)`,
    [memberDid, MEMBERSHIP_COLLECTION, communityDid],
  );
  return rows.rows.map((r) => r.rkey);
}

/** After a membership ended on this PDS: remove the home record from the member's repo when the server may. */
export async function deleteHomeMembership(memberDid: string, communityDid: string): Promise<HomeRecordDelete> {
  const out: HomeRecordDelete = { collection: MEMBERSHIP_COLLECTION, rkey: communityDid, deleted: false };
  try {
    if (!(await serverWritesRepoOf(memberDid))) return out;
    const rkeys = await homeRecordRkeys(memberDid, communityDid);
    if (rkeys.length > 0) {
      await new RepoEngine(memberDid).applyWrites(
        await getKeypairForDid(memberDid),
        rkeys.map((rkey) => ({ action: 'delete' as const, collection: MEMBERSHIP_COLLECTION, rkey })),
      );
    }
    out.deleted = true;
  } catch (err) {
    console.error('could not delete membership record for %s in %s:', communityDid, memberDid, err);
  }
  return out;
}

export interface HomeMembershipRemoval {
  /** Records removed from members' repos on this PDS. */
  removed: number;
  /** Records left in place because the member's device signs their repo (#240): their device must remove them. */
  keptOnDevice: number;
  /** Members whose repo is on another PDS: a record there cannot be removed from here. */
  elsewhere: number;
}

/**
 * A community turned private: take the membership records naming it out of
 * the repos this PDS holds. Copies anyone fetched while it was public, and
 * records on other PDSes, cannot be recalled; `elsewhere` counts the members
 * whose home is another PDS so the owner can be told.
 */
export async function removeHomeMembershipsForCommunity(communityDid: string): Promise<HomeMembershipRemoval> {
  const rows = await query<{ repo: string; rkey: string }>(
    `SELECT community_did AS repo, rkey FROM records_index
      WHERE collection = $1 AND (rkey = $2 OR record->>'community' = $2)`,
    [MEMBERSHIP_COLLECTION, communityDid],
  );
  const byRepo = new Map<string, string[]>();
  for (const r of rows.rows) byRepo.set(r.repo, [...(byRepo.get(r.repo) ?? []), r.rkey]);

  const result: HomeMembershipRemoval = { removed: 0, keptOnDevice: 0, elsewhere: 0 };
  for (const [repo, rkeys] of byRepo) {
    if (await isDeviceSigningOn(repo)) {
      result.keptOnDevice += rkeys.length;
      continue;
    }
    try {
      await new RepoEngine(repo).applyWrites(
        await getKeypairForDid(repo),
        rkeys.map((rkey) => ({ action: 'delete' as const, collection: MEMBERSHIP_COLLECTION, rkey })),
      );
      result.removed += rkeys.length;
    } catch (err) {
      console.error('community %s is private: could not remove the membership record in %s:', communityDid, repo, err);
    }
  }

  const elsewhere = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM members_unique mu
      WHERE mu.community_did = $1
        AND NOT EXISTS (
          SELECT 1 FROM users u JOIN repo_roots r ON r.did = u.did
           WHERE u.did = mu.member_did AND COALESCE(u.auth_type, 'local') <> 'external')`,
    [communityDid],
  );
  result.elsewhere = parseInt(elsewhere.rows[0]?.count ?? '0', 10);
  return result;
}

// ── Backfill ─────────────────────────────────────────────────────────────────

export interface BackfillResult {
  /** Public communities looked at. */
  communities: number;
  /** Members with a repo here the server may write, and no home record. */
  missing: number;
  /** Records written (0 on a dry run). */
  written: number;
  /** Members skipped: repo elsewhere, or device signing. */
  skipped: number;
  failed: number;
}

/**
 * Write the missing home records for existing members of public communities
 * hosted here (#385). Dry run unless `apply`. Idempotent: a member who already
 * has the record is not counted as missing. `communities` limits the run.
 */
export async function backfillHomeMemberships(opts: {
  apply: boolean;
  communities?: string[];
  log?: (line: string) => void;
}): Promise<BackfillResult> {
  const log = opts.log ?? (() => {});
  const communities = await query<{ did: string }>(
    `SELECT c.did FROM communities c
      WHERE c.status IN ('active', 'suspended')
        AND ($1::text[] IS NULL OR c.did = ANY($1))
        AND NOT EXISTS (
          SELECT 1 FROM records_index s
           WHERE s.community_did = c.did AND s.collection = 'net.openfederation.community.settings'
             AND s.rkey = 'self' AND s.record->>'visibility' = 'private')
      ORDER BY c.did`,
    [opts.communities ?? null],
  );

  const result: BackfillResult = { communities: communities.rows.length, missing: 0, written: 0, skipped: 0, failed: 0 };
  for (const { did: communityDid } of communities.rows) {
    const members = await query<{ member_did: string; created_at: Date | null; has_record: boolean }>(
      `SELECT mu.member_did, mu.created_at,
              EXISTS (SELECT 1 FROM records_index ri
                       WHERE ri.community_did = mu.member_did AND ri.collection = $2
                         AND (ri.rkey = $1 OR ri.record->>'community' = $1)) AS has_record
         FROM members_unique mu
        WHERE mu.community_did = $1
        ORDER BY mu.member_did`,
      [communityDid, MEMBERSHIP_COLLECTION],
    );
    for (const m of members.rows) {
      if (m.has_record) continue;
      if (!(await serverWritesRepoOf(m.member_did))) {
        result.skipped++;
        continue;
      }
      result.missing++;
      if (!opts.apply) {
        log(`would write ${membershipUri(m.member_did, communityDid)}`);
        continue;
      }
      try {
        const createdAt = m.created_at ? new Date(m.created_at).toISOString() : undefined;
        await new RepoEngine(m.member_did).putRecord(
          await getKeypairForDid(m.member_did), MEMBERSHIP_COLLECTION, communityDid, membershipRecord(communityDid, createdAt),
        );
        result.written++;
        log(`wrote ${membershipUri(m.member_did, communityDid)}`);
      } catch (err) {
        result.failed++;
        log(`failed ${membershipUri(m.member_did, communityDid)}: ${(err as Error).message}`);
      }
    }
  }
  return result;
}
