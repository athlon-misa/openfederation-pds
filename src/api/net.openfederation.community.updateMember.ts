import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityPermission } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';
import { query } from '../db/client.js';
import { ROLE_COLLECTION, MEMBER_COLLECTION } from '../auth/permissions.js';

interface UpdateMemberInput {
  communityDid?: string;
  memberDid?: string;
  role?: string | null;
  roleRkey?: string | null;
  kind?: string | null;
  tags?: string[] | null;
  attributes?: Record<string, unknown> | null;
}

const MAX_KIND_LENGTH = 64;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 64;
const MAX_ATTRIBUTES_SIZE = 4096;

type MemberRecord = {
  did: string;
  handle: string;
  joinedAt: string;
  role?: string;
  roleRkey?: string;
  kind?: string;
  tags?: string[];
  attributes?: Record<string, unknown>;
};

/**
 * Partial update for community member records. Replaces updateMemberRole.
 * Any subset of role/roleRkey/kind/tags/attributes may be supplied; fields
 * not supplied are preserved. Pass `null` to clear an optional field.
 */
export default async function updateMember(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const input: UpdateMemberInput = req.body ?? {};
    const { communityDid, memberDid } = input;

    if (!communityDid || !memberDid) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required fields: communityDid, memberDid',
      });
      return;
    }

    const hasRoleRkey = input.roleRkey !== undefined;
    const hasRole = input.role !== undefined;
    const hasKind = input.kind !== undefined;
    const hasTags = input.tags !== undefined;
    const hasAttributes = input.attributes !== undefined;

    if (!hasRole && !hasRoleRkey && !hasKind && !hasTags && !hasAttributes) {
      res.status(400).json({
        error: 'InvalidRequest',
        message:
          'Supply at least one of: role, roleRkey, kind, tags, attributes',
      });
      return;
    }

    // Owner role is assigned once at community creation and transferred via
    // community.transfer — never through a member update. Reject explicit
    // attempts to escalate.
    if (hasRole && input.role === 'owner') {
      res.status(400).json({
        error: 'InvalidRequest',
        message: "Cannot assign role 'owner' via updateMember; use community.transfer.",
      });
      return;
    }

    // Field shape + size validation — PDS does not enforce vocabulary but
    // does enforce bounds so a single member record can't balloon storage.
    if (hasKind && input.kind !== null) {
      if (typeof input.kind !== 'string' || input.kind.length > MAX_KIND_LENGTH) {
        res.status(400).json({
          error: 'InvalidRequest',
          message: `kind must be a string <= ${MAX_KIND_LENGTH} chars`,
        });
        return;
      }
    }
    if (hasTags && input.tags !== null) {
      if (!Array.isArray(input.tags) || input.tags.length > MAX_TAGS) {
        res.status(400).json({
          error: 'InvalidRequest',
          message: `tags must be an array of up to ${MAX_TAGS} strings`,
        });
        return;
      }
      for (const t of input.tags) {
        if (typeof t !== 'string' || t.length === 0 || t.length > MAX_TAG_LENGTH) {
          res.status(400).json({
            error: 'InvalidRequest',
            message: `each tag must be a non-empty string <= ${MAX_TAG_LENGTH} chars`,
          });
          return;
        }
      }
    }
    if (hasAttributes && input.attributes !== null) {
      if (typeof input.attributes !== 'object' || Array.isArray(input.attributes)) {
        res.status(400).json({
          error: 'InvalidRequest',
          message: 'attributes must be a JSON object',
        });
        return;
      }
      if (JSON.stringify(input.attributes).length > MAX_ATTRIBUTES_SIZE) {
        res.status(400).json({
          error: 'PayloadTooLarge',
          message: `attributes must not exceed ${MAX_ATTRIBUTES_SIZE} bytes when serialized as JSON`,
        });
        return;
      }
    }

    const hasPermission = await requireCommunityPermission(
      req as AuthRequest & { auth: AuthContext },
      res,
      communityDid,
      'community.member.write',
    );
    if (!hasPermission) return;

    // If roleRkey is provided, verify the target role exists
    let resolvedRoleName: string | undefined;
    if (hasRoleRkey && input.roleRkey) {
      const roleResult = await query<{ record: { name?: string } }>(
        `SELECT record FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
        [communityDid, ROLE_COLLECTION, input.roleRkey],
      );
      if (roleResult.rows.length === 0) {
        res.status(404).json({ error: 'RoleNotFound', message: 'Target role not found' });
        return;
      }
      resolvedRoleName = roleResult.rows[0].record?.name;
    }

    const memberResult = await query<{ record_rkey: string }>(
      'SELECT record_rkey FROM members_unique WHERE community_did = $1 AND member_did = $2',
      [communityDid, memberDid],
    );
    if (memberResult.rows.length === 0) {
      res.status(404).json({ error: 'NotMember', message: 'Target DID is not a member of this community' });
      return;
    }

    const memberRkey = memberResult.rows[0].record_rkey;
    const engine = new RepoEngine(communityDid);
    const existing = await engine.getRecord(MEMBER_COLLECTION, memberRkey);
    if (!existing) {
      res.status(404).json({ error: 'NotMember', message: 'Member record not found in repository' });
      return;
    }

    const prev = existing.record as MemberRecord;

    // Refuse to change the owner's role/roleRkey regardless of caller
    if (prev.role === 'owner' && (hasRole || hasRoleRkey)) {
      res.status(403).json({ error: 'CannotChangeOwner', message: "Cannot change the owner's role." });
      return;
    }

    // Build the merged record. Undefined → preserve existing value;
    // null → delete the key entirely from the stored record.
    const next: MemberRecord = { ...prev };

    if (hasRoleRkey) {
      if (input.roleRkey === null || input.roleRkey === '') {
        delete next.roleRkey;
      } else {
        next.roleRkey = input.roleRkey!;
        delete next.role; // roleRkey supersedes plain role
      }
    }
    if (hasRole) {
      if (input.role === null || input.role === '') {
        delete next.role;
      } else {
        next.role = input.role;
        // If explicit plain role supplied, drop any stale roleRkey
        if (!hasRoleRkey) delete next.roleRkey;
      }
    }
    if (hasKind) {
      if (input.kind === null || input.kind === '') delete next.kind;
      else next.kind = input.kind;
    }
    if (hasTags) {
      if (input.tags === null || (Array.isArray(input.tags) && input.tags.length === 0)) {
        delete next.tags;
      } else {
        next.tags = input.tags as string[];
      }
    }
    if (hasAttributes) {
      if (
        input.attributes === null ||
        (typeof input.attributes === 'object' && Object.keys(input.attributes as object).length === 0)
      ) {
        delete next.attributes;
      } else {
        next.attributes = input.attributes as Record<string, unknown>;
      }
    }

    const keypair = await getKeypairForDid(communityDid);
    const result = await engine.putRecord(keypair, MEMBER_COLLECTION, memberRkey, next);

    await auditLog('community.updateMember', req.auth!.userId, communityDid, {
      memberDid,
      changed: {
        role: hasRole,
        roleRkey: hasRoleRkey,
        kind: hasKind,
        tags: hasTags,
        attributes: hasAttributes,
      },
      resolvedRoleName,
    });

    res.status(200).json({
      uri: result.uri,
      cid: result.cid,
      role: next.role ?? resolvedRoleName,
      roleRkey: next.roleRkey,
      kind: next.kind,
      tags: next.tags,
      attributes: next.attributes,
    });
  } catch (error) {
    console.error('Error in updateMember:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to update member' });
  }
}
