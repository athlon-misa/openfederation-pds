import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRole, requireApprovedUser, isRemoteCaller, communityWriteRefusal } from '../auth/guards.js';
import { generateInviteCode } from '../auth/utils.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';

interface InviteInput {
  maxUses?: number;
  expiresAt?: string;
  boundTo?: string;
  note?: string;
  count?: number;
  community?: string;
}

/** Most codes one call may create (one per person, e.g. an imported member list). */
const MAX_COUNT = 100;

/**
 * May the caller make invite codes that also join `community` (#403)? A PDS
 * admin for any community; its owner for their own. A PDS moderator who does
 * not own the community may not: the codes add people to someone else's
 * community. Refuses (and answers) when not.
 */
async function authorizeCommunityInvite(req: AuthRequest, res: Response, community: unknown): Promise<boolean> {
  if (!requireApprovedUser(req, res)) return false;
  if (isRemoteCaller(req)) {
    res.status(403).json({ error: 'Forbidden', message: 'Invite codes are made by accounts on this PDS' });
    return false;
  }
  if (typeof community !== 'string' || !community.startsWith('did:')) {
    res.status(400).json({ error: 'InvalidRequest', message: 'community must be a DID' });
    return false;
  }
  const found = await query<{ owner_did: string | null; status: string }>(
    'SELECT owner_did, status FROM communities WHERE did = $1', [community],
  );
  const row = found.rows[0];
  const isAdmin = req.auth!.roles.includes('admin');
  // Someone else's (possibly private) community answers like a missing one.
  if (!row || (!isAdmin && row.owner_did !== req.auth!.did)) {
    res.status(404).json({ error: 'NotFound', message: 'Community not found' });
    return false;
  }
  const refusal = communityWriteRefusal(row.status);
  if (refusal) {
    res.status(refusal.status).json({ error: refusal.error, message: refusal.message });
    return false;
  }
  return true;
}

export default async function createInvite(req: AuthRequest, res: Response): Promise<void> {
  const input: InviteInput = req.body || {};
  const community = input.community ?? null;
  if (community !== null) {
    if (!(await authorizeCommunityInvite(req, res, community))) return;
  } else if (!requireRole(req, res, ['admin', 'moderator'])) {
    return;
  }

  const maxUses = input.maxUses ?? 1;

  if (!Number.isInteger(maxUses) || maxUses < 1) {
    res.status(400).json({
      error: 'InvalidRequest',
      message: 'maxUses must be an integer greater than 0',
    });
    return;
  }

  const count = input.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
    res.status(400).json({
      error: 'InvalidRequest',
      message: `count must be an integer from 1 to ${MAX_COUNT}`,
    });
    return;
  }

  let expiresAt: string | null = null;
  if (input.expiresAt) {
    const parsed = new Date(input.expiresAt);
    if (Number.isNaN(parsed.getTime())) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'expiresAt must be an ISO date string',
      });
      return;
    }
    expiresAt = parsed.toISOString();
  }

  const boundTo = input.boundTo || null;
  const note = input.note || null;

  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const code = generateInviteCode();
    await query(
      `INSERT INTO invites (code, created_by, max_uses, expires_at, bound_to, note, community_did)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [code, req.auth!.userId, maxUses, expiresAt, boundTo, note, community]
    );
    codes.push(code);
  }

  await auditLog('invite.create', req.auth!.userId, community, {
    maxUses, expiresAt, boundTo, note, ...(input.count !== undefined ? { count } : {}),
    ...(community ? { community } : {}),
  });

  res.status(201).json({
    code: codes[0],
    maxUses,
    expiresAt,
    ...(boundTo ? { boundTo } : {}),
    ...(note ? { note } : {}),
    ...(community ? { community } : {}),
    ...(input.count !== undefined ? { codes } : {}),
  });
}
