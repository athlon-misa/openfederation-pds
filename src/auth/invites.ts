/**
 * Claiming an invite code: the same rules for sign-up
 * (net.openfederation.account.register) and for a user account moving here
 * from another PDS (com.atproto.server.createAccount, #266). Runs inside
 * the caller's transaction, with the invite row locked.
 */
import type { PoolClient } from 'pg';

export class InviteError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

/** Anything that can run a read: the pool's `query`, or a transaction client. */
export type RowReader = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: (text: string, params?: any[]) => Promise<{ rows: any[] }>;
};

type InviteRow = { code: string; max_uses: number; uses_count: number; expires_at: string | null; bound_to: string | null };

function assertInviteRowUsable(invite: InviteRow | undefined, email: string | null): asserts invite is InviteRow {
  if (!invite) throw new InviteError(403, 'InviteInvalid', 'Invite code is invalid');
  if (invite.expires_at && new Date(invite.expires_at).getTime() <= Date.now()) {
    throw new InviteError(403, 'InviteExpired', 'Invite code has expired');
  }
  if (invite.uses_count >= invite.max_uses) {
    throw new InviteError(403, 'InviteUsed', 'Invite code has already been used');
  }
  if (invite.bound_to && invite.bound_to.toLowerCase().trim() !== (email ?? '').toLowerCase().trim()) {
    throw new InviteError(403, 'InviteBound', 'This invite code is bound to a specific email address.');
  }
}

/**
 * Check, without locking or claiming, that an invite code could be used now.
 * For refusing an obviously bad request early, before work that cannot be
 * undone (registering a DID). `claimInvite` still decides for real.
 */
export async function assertInviteUsable(
  runner: RowReader,
  code: string,
  email: string | null,
): Promise<void> {
  const result: { rows: InviteRow[] } = await runner.query(
    'SELECT code, max_uses, uses_count, expires_at, bound_to FROM invites WHERE code = $1',
    [code],
  );
  assertInviteRowUsable(result.rows[0], email);
}

export async function claimInvite(client: PoolClient, code: string, email: string | null, userId: string | null): Promise<void> {
  const inviteResult = await client.query<InviteRow>(
    `SELECT code, max_uses, uses_count, expires_at, bound_to FROM invites WHERE code = $1 FOR UPDATE`,
    [code],
  );
  const invite = inviteResult.rows[0];
  assertInviteRowUsable(invite, email);
  await client.query(
    `UPDATE invites
     SET uses_count = uses_count + 1, used_by = COALESCE($2, used_by), used_at = CURRENT_TIMESTAMP
     WHERE code = $1`,
    [invite.code, invite.max_uses === 1 && userId ? userId : null],
  );
}
