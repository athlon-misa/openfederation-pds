import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { query } from '../../src/db/client.js';
import {
  getCallerMembership,
  getCommunityAccess,
  getCallerCommunityCapabilities,
} from '../../src/community/visibility.js';
import { MEMBER_COLLECTION, ROLE_COLLECTION } from '../../src/auth/permissions.js';
import type { AuthContext } from '../../src/auth/types.js';

const COMMUNITY_DID = `did:plc:test-access-${Date.now()}`;

function caller(userId: string, did: string, roles: AuthContext['roles'] = []): AuthContext {
  return { userId, handle: 'h', email: `${userId}@test.local`, did, status: 'approved', roles };
}

const owner = { id: randomUUID(), did: `did:plc:owner-${Date.now()}` };
const legacyMember = { id: randomUUID(), did: `did:plc:legacy-${Date.now()}` };
const customMember = { id: randomUUID(), did: `did:plc:custom-${Date.now()}` };
const requester = { id: randomUUID(), did: `did:plc:req-${Date.now()}` };
const stranger = { id: randomUUID(), did: `did:plc:stranger-${Date.now()}` };

async function seedUser(u: { id: string; did: string }) {
  await query(
    `INSERT INTO users (id, handle, email, password_hash, status, did)
     VALUES ($1, $2, $3, 'x', 'approved', $4)`,
    [u.id, `h-${u.id}`, `${u.id}@test.local`, u.did],
  );
}

beforeAll(async () => {
  for (const u of [owner, legacyMember, customMember, requester, stranger]) {
    await seedUser(u);
  }
  await query(
    `INSERT INTO communities (did, handle, did_method, created_by)
     VALUES ($1, $2, 'plc', $3)`,
    [COMMUNITY_DID, `c-${Date.now()}`, owner.id],
  );
  // settings record: private community
  await query(
    `INSERT INTO records_index (community_did, collection, rkey, cid, record)
     VALUES ($1, 'net.openfederation.community.settings', 'self', 'bafyfake', $2)`,
    [COMMUNITY_DID, JSON.stringify({ visibility: 'private' })],
  );
  // legacy member: role stored inline on member record
  await query(
    `INSERT INTO records_index (community_did, collection, rkey, cid, record)
     VALUES ($1, $2, 'mem-legacy', 'bafyfake', $3)`,
    [COMMUNITY_DID, MEMBER_COLLECTION, JSON.stringify({ role: 'moderator' })],
  );
  await query(
    `INSERT INTO members_unique (community_did, member_did, record_rkey)
     VALUES ($1, $2, 'mem-legacy')`,
    [COMMUNITY_DID, legacyMember.did],
  );
  // custom-role member: member record points at a role record via roleRkey
  await query(
    `INSERT INTO records_index (community_did, collection, rkey, cid, record)
     VALUES ($1, $2, 'role-editor', 'bafyfake', $3)`,
    [COMMUNITY_DID, ROLE_COLLECTION, JSON.stringify({ name: 'Editor', permissions: ['community.member.read'] })],
  );
  await query(
    `INSERT INTO records_index (community_did, collection, rkey, cid, record)
     VALUES ($1, $2, 'mem-custom', 'bafyfake', $3)`,
    [COMMUNITY_DID, MEMBER_COLLECTION, JSON.stringify({ roleRkey: 'role-editor' })],
  );
  await query(
    `INSERT INTO members_unique (community_did, member_did, record_rkey)
     VALUES ($1, $2, 'mem-custom')`,
    [COMMUNITY_DID, customMember.did],
  );
  // pending join request
  await query(
    `INSERT INTO join_requests (id, community_did, user_id, user_did, status)
     VALUES ($1, $2, $3, $4, 'pending')`,
    [randomUUID(), COMMUNITY_DID, requester.id, requester.did],
  );
});

afterAll(async () => {
  // communities cascade-deletes members_unique + join_requests; records_index has no FK
  await query(`DELETE FROM records_index WHERE community_did = $1`, [COMMUNITY_DID]);
  await query(`DELETE FROM communities WHERE did = $1`, [COMMUNITY_DID]);
  await query(`DELETE FROM users WHERE id = ANY($1)`, [
    [owner.id, legacyMember.id, customMember.id, requester.id, stranger.id],
  ]);
});

describe('community access (single-query rewrite must preserve all of this)', () => {
  it('owner: isOwner true, exists true, private visibility surfaced', async () => {
    const access = await getCommunityAccess({
      communityDid: COMMUNITY_DID,
      caller: caller(owner.id, owner.did),
    });
    expect(access.exists).toBe(true);
    expect(access.isOwner).toBe(true);
    expect(access.isAdmin).toBe(false);
    expect(access.visibility).toBe('private');
  });

  it('PDS admin: isAdmin true even when not a member', async () => {
    const access = await getCommunityAccess({
      communityDid: COMMUNITY_DID,
      caller: caller(stranger.id, stranger.did, ['admin']),
    });
    expect(access.isAdmin).toBe(true);
    expect(access.membership).toBeNull();
  });

  it('legacy member: status member, inline role name', async () => {
    const m = await getCallerMembership({
      communityDid: COMMUNITY_DID,
      caller: caller(legacyMember.id, legacyMember.did),
    });
    expect(m).toEqual({ status: 'member', role: 'moderator' });
  });

  it('custom-role member: role name resolved from role record, roleRkey set', async () => {
    const m = await getCallerMembership({
      communityDid: COMMUNITY_DID,
      caller: caller(customMember.id, customMember.did),
    });
    expect(m).toMatchObject({ status: 'member', role: 'Editor', roleRkey: 'role-editor' });
  });

  it('custom-role member: capabilities come from the role record permissions', async () => {
    const caps = await getCallerCommunityCapabilities({
      communityDid: COMMUNITY_DID,
      caller: caller(customMember.id, customMember.did),
    });
    expect(caps.hasAllPermissions).toBe(false);
    expect(caps.permissions).toEqual(['community.member.read']);
  });

  it('legacy member: capabilities fall back to LEGACY_ROLE_PERMISSIONS for moderator', async () => {
    const caps = await getCallerCommunityCapabilities({
      communityDid: COMMUNITY_DID,
      caller: caller(legacyMember.id, legacyMember.did),
    });
    expect(caps.hasAllPermissions).toBe(false);
    expect(caps.permissions).toContain('community.member.write');
  });

  it('pending join request: status pending with joinRequestStatus', async () => {
    const m = await getCallerMembership({
      communityDid: COMMUNITY_DID,
      caller: caller(requester.id, requester.did),
    });
    expect(m).toEqual({ status: 'pending', joinRequestStatus: 'pending' });
  });

  it('stranger: membership null', async () => {
    const m = await getCallerMembership({
      communityDid: COMMUNITY_DID,
      caller: caller(stranger.id, stranger.did),
    });
    expect(m).toBeNull();
  });

  it('no caller: membership null, access still resolves community', async () => {
    const m = await getCallerMembership({ communityDid: COMMUNITY_DID });
    expect(m).toBeNull();
    const access = await getCommunityAccess({ communityDid: COMMUNITY_DID });
    expect(access.exists).toBe(true);
    expect(access.isOwner).toBe(false);
  });

  it('nonexistent community: exists false', async () => {
    const access = await getCommunityAccess({
      communityDid: 'did:plc:does-not-exist-xyz',
      caller: caller(stranger.id, stranger.did),
    });
    expect(access.exists).toBe(false);
  });
});
