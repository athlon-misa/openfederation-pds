/**
 * Community invite codes (#403): an invite code that names a community also
 * brings the new account into it.
 *
 * At sign-up the claim is remembered (`invite_community_joins`, in the same
 * transaction as the account). The join itself is the ordinary one,
 * `joinCommunityLifecycle`, as if the person had pressed "Join" themselves, so
 * the community's rules hold: an open community takes them in, one that
 * approves members gets a join request for its owner to resolve, and a
 * suspended, moved or removed community takes nobody. Joining needs an
 * approved account, so under `ACCOUNT_APPROVAL=manual` the join waits until
 * an admin approves the account (`applyInviteCommunityJoins` is called from
 * there too).
 *
 * The code holder learns the community's DID (they were sent the code for
 * it), nobody else does: a community code is listed with its community only
 * to PDS staff (invite.list).
 */
import type { PoolClient } from 'pg';
import type { AuthContext, UserRole, UserStatus } from '../auth/types.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';
import { XrpcError } from '../xrpc/errors.js';
import { joinCommunityLifecycle } from './membership/join.js';

export type InviteJoinStatus = 'joined' | 'pending' | 'waitingForApproval' | 'refused';
export interface InviteJoinResult { did: string; status: InviteJoinStatus }

/** The community an invite code joins, if it is a community code. */
export async function inviteCommunity(runner: { query: PoolClient['query'] } | null, code: string): Promise<string | null> {
  const sql = 'SELECT community_did FROM invites WHERE code = $1';
  const result = runner
    ? await runner.query<{ community_did: string | null }>(sql, [code])
    : await query<{ community_did: string | null }>(sql, [code]);
  return result.rows[0]?.community_did ?? null;
}

/** Inside the sign-up transaction, after the code was claimed: remember the join it promises. */
export async function rememberInviteCommunity(client: PoolClient, code: string, userId: string): Promise<string | null> {
  const community = await inviteCommunity(client, code);
  if (!community) return null;
  await client.query(
    `INSERT INTO invite_community_joins (user_id, community_did, invite_code)
     VALUES ($1, $2, $3) ON CONFLICT (user_id, community_did) DO NOTHING`,
    [userId, community, code],
  );
  return community;
}

const SETTLED: Record<string, InviteJoinStatus> = {
  AlreadyMember: 'joined',
  AlreadyRequested: 'pending',
};

/**
 * Carry out the joins waiting for this account. Does nothing (and reports
 * `waitingForApproval`) while the account is not approved. Never throws:
 * signing up or approving an account must not fail because a community
 * could not be joined.
 */
export async function applyInviteCommunityJoins(userId: string): Promise<InviteJoinResult[]> {
  try {
    const waiting = await query<{ community_did: string }>(
      'SELECT community_did FROM invite_community_joins WHERE user_id = $1 ORDER BY created_at', [userId],
    );
    if (waiting.rows.length === 0) return [];
    const user = (await query<{ id: string; handle: string; email: string; did: string; status: UserStatus }>(
      'SELECT id, handle, email, did, status FROM users WHERE id = $1', [userId],
    )).rows[0];
    if (!user || user.status !== 'approved') {
      return waiting.rows.map((r) => ({ did: r.community_did, status: 'waitingForApproval' }));
    }
    const roles = (await query<{ role: UserRole }>('SELECT role FROM user_roles WHERE user_id = $1', [userId])).rows.map((r) => r.role);
    const caller: AuthContext = {
      userId: user.id, handle: user.handle, email: user.email, did: user.did, status: user.status, roles, authMethod: 'local',
    };

    const results: InviteJoinResult[] = [];
    for (const { community_did: did } of waiting.rows) {
      let status: InviteJoinStatus;
      try {
        status = (await joinCommunityLifecycle(caller, { did })).status;
      } catch (err) {
        status = err instanceof XrpcError ? (SETTLED[err.code] ?? 'refused') : 'refused';
        if (!(err instanceof XrpcError)) console.error('[invite] community join failed:', err);
      }
      await query('DELETE FROM invite_community_joins WHERE user_id = $1 AND community_did = $2', [userId, did]);
      await auditLog('community.join', userId, did, { via: 'invite', result: status });
      results.push({ did, status });
    }
    return results;
  } catch (err) {
    console.error('[invite] applying community invite joins failed:', err);
    return [];
  }
}
