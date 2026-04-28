import { randomUUID } from 'crypto';
import type { AuthContext } from '../../auth/types.js';
import { query } from '../../db/client.js';
import { throwXrpc } from '../../xrpc/errors.js';
import {
  ensureCommunityExists,
  ensureNotAlreadyMember,
  getJoinPolicy,
  createMemberRecord,
} from './utils.js';

const JOIN_NSID = 'net.openfederation.community.join';
const MAX_KIND_LENGTH = 64;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 64;
const MAX_ATTRIBUTES_SIZE = 4096;

export interface JoinCommunityInput {
  did?: unknown;
  kind?: unknown;
  tags?: unknown;
  attributes?: unknown;
}

export type JoinCommunityResult = {
  status: 'joined' | 'pending';
};

function validateJoinInput(input: JoinCommunityInput): {
  did: string;
  kind?: string;
  tags?: string[];
  attributes?: Record<string, unknown>;
} {
  if (typeof input.did !== 'string' || input.did.length === 0) {
    throwXrpc(JOIN_NSID, 'InvalidRequest', 400, 'Missing required field: did');
  }

  let kind: string | undefined;
  if (input.kind !== undefined && input.kind !== null) {
    if (typeof input.kind !== 'string' || input.kind.length === 0 || input.kind.length > MAX_KIND_LENGTH) {
      throwXrpc(JOIN_NSID, 'InvalidRequest', 400, `kind must be a non-empty string <= ${MAX_KIND_LENGTH} chars`);
    }
    kind = input.kind;
  }

  let tags: string[] | undefined;
  if (input.tags !== undefined && input.tags !== null) {
    if (!Array.isArray(input.tags) || input.tags.length > MAX_TAGS) {
      throwXrpc(JOIN_NSID, 'InvalidRequest', 400, `tags must be an array of up to ${MAX_TAGS} strings`);
    }
    for (const tag of input.tags) {
      if (typeof tag !== 'string' || tag.length === 0 || tag.length > MAX_TAG_LENGTH) {
        throwXrpc(JOIN_NSID, 'InvalidRequest', 400, `each tag must be a non-empty string <= ${MAX_TAG_LENGTH} chars`);
      }
    }
    tags = input.tags;
  }

  let attributes: Record<string, unknown> | undefined;
  if (input.attributes !== undefined && input.attributes !== null) {
    if (typeof input.attributes !== 'object' || Array.isArray(input.attributes)) {
      throwXrpc(JOIN_NSID, 'InvalidRequest', 400, 'attributes must be a JSON object');
    }
    if (JSON.stringify(input.attributes).length > MAX_ATTRIBUTES_SIZE) {
      throwXrpc(JOIN_NSID, 'PayloadTooLarge', 400, `attributes must not exceed ${MAX_ATTRIBUTES_SIZE} bytes when serialized as JSON`);
    }
    attributes = input.attributes as Record<string, unknown>;
  }

  return { did: input.did, kind, tags, attributes };
}

export async function joinCommunityLifecycle(
  caller: AuthContext,
  input: JoinCommunityInput,
): Promise<JoinCommunityResult> {
  const { did, kind, tags, attributes } = validateJoinInput(input);

  await ensureCommunityExists(did);
  await ensureNotAlreadyMember(did, caller.did);

  const joinPolicy = await getJoinPolicy(did);
  if (joinPolicy === 'open') {
    await createMemberRecord(did, caller, { kind, tags, attributes });
    return { status: 'joined' };
  }

  const existingRequest = await query<{ status: string }>(
    'SELECT status FROM join_requests WHERE community_did = $1 AND user_id = $2',
    [did, caller.userId],
  );

  if (existingRequest.rows.length > 0) {
    const status = existingRequest.rows[0].status;
    if (status === 'pending') {
      throwXrpc(JOIN_NSID, 'AlreadyRequested', 409, 'You already have a pending join request');
    }
    if (status === 'rejected') {
      await query(
        `UPDATE join_requests SET status = 'pending', resolved_by = NULL, resolved_at = NULL, created_at = CURRENT_TIMESTAMP
         WHERE community_did = $1 AND user_id = $2`,
        [did, caller.userId],
      );
      return { status: 'pending' };
    }
  }

  await query(
    `INSERT INTO join_requests (id, community_did, user_id, user_did, status)
     VALUES ($1, $2, $3, $4, 'pending')`,
    [randomUUID(), did, caller.userId, caller.did],
  );

  return { status: 'pending' };
}
