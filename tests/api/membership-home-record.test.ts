/**
 * Membership records in the member's own repo (#385).
 *
 * Joining a public community on this PDS writes
 * `net.openfederation.community.membership` (rkey = the community's DID) into
 * the member's repo, as a signed commit, alongside the community-side
 * `member` record; leaving deletes it. Private communities get no home record
 * (a user's repo is public, ADR-001), and a community turning private takes
 * the records this PDS holds out of its members' repos. A pseudonym's record
 * lives in the pseudonym's repo, never in the person's main account. Device
 * signing accounts (#240) get no server-side write.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import {
  xrpcAuthPost, xrpcAuthGet, xrpcGet, xrpcPost, createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { query } from '../../src/db/client.js';
import { setPlcClientForTests } from '../../src/identity/plc-client.js';
import { preparePseudonym } from './pseudonym-test-kit.js';
import { issueSessionForTests } from './pseudonym-session-for-tests.js';
import { joinCommunityLifecycle } from '../../src/community/membership/join.js';
import { createMemberRecordForDid } from '../../src/community/membership/utils.js';
import {
  MEMBERSHIP_COLLECTION, backfillHomeMemberships,
} from '../../src/community/membership/home-record.js';
import { RepoEngine } from '../../src/repo/repo-engine.js';

type User = { accessJwt: string; did: string; handle: string };

async function homeRecords(repoDid: string) {
  const rows = await query<{ rkey: string; record: Record<string, unknown> }>(
    'SELECT rkey, record FROM records_index WHERE community_did = $1 AND collection = $2',
    [repoDid, MEMBERSHIP_COLLECTION],
  );
  return rows.rows;
}

async function repoRev(did: string): Promise<string | null> {
  const r = await query<{ rev: string }>('SELECT rev FROM repo_roots WHERE did = $1', [did]);
  return r.rows[0]?.rev ?? null;
}

describe('membership records in the member\'s repo (#385)', () => {
  let plc = false;
  let owner: User;

  const createCommunity = async (who: User, visibility: 'public' | 'private', joinPolicy: 'open' | 'approval' = 'open') => {
    const res = await xrpcAuthPost('net.openfederation.community.create', who.accessJwt, {
      handle: uniqueHandle('hm'), didMethod: 'plc', visibility, joinPolicy,
    });
    expect(res.status).toBe(201);
    return res.body.did as string;
  };

  beforeAll(async () => {
    plc = await isPLCAvailable();
    if (!plc) return;
    owner = await createTestUser(uniqueHandle('hm-owner'));
  }, 60_000);

  afterEach(() => setPlcClientForTests(null));

  it('joining a public community writes a signed membership record in the member\'s repo; leaving deletes it', async () => {
    if (!plc) return;
    const community = await createCommunity(owner, 'public');
    const member = await createTestUser(uniqueHandle('hm-mem'));
    const revBefore = await repoRev(member.did);

    const join = await xrpcAuthPost('net.openfederation.community.join', member.accessJwt, { did: community });
    expect(join.status).toBe(200);
    expect(join.body.status).toBe('joined');
    expect(join.body.homeRecord).toMatchObject({
      collection: MEMBERSHIP_COLLECTION,
      rkey: community,
      uri: `at://${member.did}/${MEMBERSHIP_COLLECTION}/${community}`,
      written: true,
    });

    const records = await homeRecords(member.did);
    expect(records).toHaveLength(1);
    expect(records[0].rkey).toBe(community);
    expect(records[0].record).toMatchObject({ $type: MEMBERSHIP_COLLECTION, community });
    expect(typeof records[0].record.createdAt).toBe('string');
    // A real commit: the member's repo moved to a new revision.
    expect(await repoRev(member.did)).not.toBe(revBefore);
    // Served like any other record.
    const got = await xrpcGet('com.atproto.repo.getRecord', { repo: member.did, collection: MEMBERSHIP_COLLECTION, rkey: community });
    expect(got.status).toBe(200);
    expect(got.body.value.community).toBe(community);

    const leave = await xrpcAuthPost('net.openfederation.community.leave', member.accessJwt, { did: community });
    expect(leave.status).toBe(200);
    expect(leave.body.homeRecord).toMatchObject({ collection: MEMBERSHIP_COLLECTION, rkey: community, deleted: true });
    expect(await homeRecords(member.did)).toHaveLength(0);
  });

  it('the owner of a new public community gets a membership record too; a private one gets none', async () => {
    if (!plc) return;
    const founder = await createTestUser(uniqueHandle('hm-found'));
    const pub = await createCommunity(founder, 'public');
    const priv = await createCommunity(founder, 'private');
    const rkeys = (await homeRecords(founder.did)).map((r) => r.rkey);
    expect(rkeys).toContain(pub);
    expect(rkeys).not.toContain(priv);
  });

  it('joining a private community writes no home record', async () => {
    if (!plc) return;
    const community = await createCommunity(owner, 'private');
    const member = await createTestUser(uniqueHandle('hm-priv'));
    const join = await xrpcAuthPost('net.openfederation.community.join', member.accessJwt, { did: community });
    expect(join.status).toBe(200);
    expect(join.body.status).toBe('joined');
    expect(join.body.homeRecord).toBeUndefined();
    expect(await homeRecords(member.did)).toHaveLength(0);
  });

  it('an approved join request writes the home record', async () => {
    if (!plc) return;
    const community = await createCommunity(owner, 'public', 'approval');
    const member = await createTestUser(uniqueHandle('hm-appr'));
    const join = await xrpcAuthPost('net.openfederation.community.join', member.accessJwt, { did: community });
    expect(join.body.status).toBe('pending');
    expect(join.body.homeRecord).toBeUndefined();
    expect(await homeRecords(member.did)).toHaveLength(0);

    const list = await xrpcAuthGet('net.openfederation.community.listJoinRequests', owner.accessJwt, { did: community });
    const request = list.body.requests.find((r: { userDid: string }) => r.userDid === member.did);
    const resolve = await xrpcAuthPost('net.openfederation.community.resolveJoinRequest', owner.accessJwt, {
      requestId: request.id, action: 'approve',
    });
    expect(resolve.status).toBe(200);
    expect((await homeRecords(member.did)).map((r) => r.rkey)).toEqual([community]);
  });

  it('removing a member deletes the home record this PDS holds for them', async () => {
    if (!plc) return;
    const community = await createCommunity(owner, 'public');
    const member = await createTestUser(uniqueHandle('hm-rm'));
    await xrpcAuthPost('net.openfederation.community.join', member.accessJwt, { did: community });
    expect(await homeRecords(member.did)).toHaveLength(1);
    const rm = await xrpcAuthPost('net.openfederation.community.removeMember', owner.accessJwt, { did: community, memberDid: member.did });
    expect(rm.status).toBe(200);
    expect(await homeRecords(member.did)).toHaveLength(0);
  });

  it('device signing: the join succeeds, the server writes nothing in the member\'s repo and says so', async () => {
    if (!plc) return;
    const community = await createCommunity(owner, 'public');
    const member = await createTestUser(uniqueHandle('hm-dev'));
    await query('UPDATE users SET device_signing = true WHERE did = $1', [member.did]);
    try {
      const join = await xrpcAuthPost('net.openfederation.community.join', member.accessJwt, { did: community });
      expect(join.status).toBe(200);
      expect(join.body.status).toBe('joined');
      expect(join.body.homeRecord).toMatchObject({ rkey: community, written: false });
      expect(join.body.homeRecord.record).toMatchObject({ $type: MEMBERSHIP_COLLECTION, community });
      expect(await homeRecords(member.did)).toHaveLength(0);

      const leave = await xrpcAuthPost('net.openfederation.community.leave', member.accessJwt, { did: community });
      expect(leave.status).toBe(200);
      expect(leave.body.homeRecord).toMatchObject({ rkey: community, deleted: false });
    } finally {
      await query('UPDATE users SET device_signing = false WHERE did = $1', [member.did]);
    }
  });

  it('a caller from another PDS is told to write the record at home; nothing is written here', async () => {
    if (!plc) return;
    const community = await createCommunity(owner, 'public');
    const remoteDid = 'did:plc:remotememberxxxxxxxxxxxxx';
    const result = await joinCommunityLifecycle({
      userId: remoteDid, handle: remoteDid, email: '', did: remoteDid,
      status: 'approved', roles: [], authMethod: 'service-auth',
    }, { did: community });
    expect(result.status).toBe('joined');
    expect(result.homeRecord).toMatchObject({
      uri: `at://${remoteDid}/${MEMBERSHIP_COLLECTION}/${community}`, rkey: community, written: false,
    });
    expect(await homeRecords(remoteDid)).toHaveLength(0);
  });

  it('a pseudonym\'s membership record goes in the pseudonym\'s repo, never the person\'s main account', async () => {
    if (!plc) return;
    const community = await createCommunity(owner, 'public');
    const person = await createTestUser(uniqueHandle('hm-person'));
    // The person's main account is a member too, so it has a repo the record
    // could wrongly land in.
    await xrpcAuthPost('net.openfederation.community.join', person.accessJwt, { did: community });
    const mainBefore = await homeRecords(person.did);

    const pn = await preparePseudonym();
    const created = await xrpcPost('net.openfederation.pseudonym.createAccount', { did: pn.did, token: pn.token });
    expect(created.status).toBe(201);
    setPlcClientForTests(null);
    const row = await query<{ id: string }>('SELECT id FROM users WHERE did = $1', [pn.did]);
    const session = await issueSessionForTests({ id: row.rows[0].id, did: pn.did, handle: pn.handle });

    const join = await xrpcAuthPost('net.openfederation.community.join', session.accessJwt, { did: community });
    expect(join.status).toBe(200);
    expect(join.body.homeRecord).toMatchObject({ uri: `at://${pn.did}/${MEMBERSHIP_COLLECTION}/${community}`, written: true });
    expect((await homeRecords(pn.did)).map((r) => r.rkey)).toEqual([community]);
    // The main account's repo is exactly as it was.
    expect(await homeRecords(person.did)).toEqual(mainBefore);
    const anywhere = await query(
      `SELECT community_did FROM records_index WHERE collection = $1 AND rkey = $2`,
      [MEMBERSHIP_COLLECTION, community],
    );
    // The owner (who founded it), the person and the pseudonym: each in their own repo.
    expect(anywhere.rows.map((r) => r.community_did).sort()).toEqual([owner.did, person.did, pn.did].sort());
  });

  it('turning a community private removes the membership records held here and reports the ones it cannot reach', async () => {
    if (!plc) return;
    const community = await createCommunity(owner, 'public');
    const a = await createTestUser(uniqueHandle('hm-pa'));
    const b = await createTestUser(uniqueHandle('hm-pb'));
    for (const m of [a, b]) await xrpcAuthPost('net.openfederation.community.join', m.accessJwt, { did: community });
    // A member whose home is another PDS, and one who signs on their device.
    await createMemberRecordForDid(community, 'did:plc:elsewherememberxxxxxxxxx', 'elsewhere.example', {});
    await query('UPDATE users SET device_signing = true WHERE did = $1', [b.did]);
    try {
      expect(await homeRecords(a.did)).toHaveLength(1);
      expect(await homeRecords(b.did)).toHaveLength(1);

      const upd = await xrpcAuthPost('net.openfederation.community.update', owner.accessJwt, { did: community, visibility: 'private' });
      expect(upd.status).toBe(200);
      expect(upd.body.success).toBe(true);
      expect(upd.body.membershipRecords).toEqual({ removed: 2, keptOnDevice: 1, elsewhere: 1 });
      expect(await homeRecords(a.did)).toHaveLength(0);
      expect(await homeRecords(owner.did).then((r) => r.filter((x) => x.rkey === community))).toHaveLength(0);
      // The device-signing member's record stays for their device to remove.
      expect(await homeRecords(b.did)).toHaveLength(1);

      // A change that does not make it private reports nothing.
      const again = await xrpcAuthPost('net.openfederation.community.update', owner.accessJwt, { did: community, displayName: 'x' });
      expect(again.body.membershipRecords).toBeUndefined();
    } finally {
      await query('UPDATE users SET device_signing = false WHERE did = $1', [b.did]);
    }
  });

  it('backfill: dry run by default, --apply writes the missing records, and a second run finds nothing', async () => {
    if (!plc) return;
    const pub = await createCommunity(owner, 'public');
    const priv = await createCommunity(owner, 'private');
    const m = await createTestUser(uniqueHandle('hm-bf'));
    for (const c of [pub, priv]) await xrpcAuthPost('net.openfederation.community.join', m.accessJwt, { did: c });
    // As if the member had joined before #385: no home record.
    const engine = new RepoEngine(m.did);
    const { getKeypairForDid } = await import('../../src/repo/keypair-utils.js');
    await engine.deleteRecord(await getKeypairForDid(m.did), MEMBERSHIP_COLLECTION, pub);
    expect(await homeRecords(m.did)).toHaveLength(0);

    const dry = await backfillHomeMemberships({ apply: false, communities: [pub, priv] });
    expect(dry.missing).toBe(1);
    expect(dry.written).toBe(0);
    expect(await homeRecords(m.did)).toHaveLength(0);

    const applied = await backfillHomeMemberships({ apply: true, communities: [pub, priv] });
    expect(applied.written).toBe(1);
    expect((await homeRecords(m.did)).map((r) => r.rkey)).toEqual([pub]);

    const again = await backfillHomeMemberships({ apply: true, communities: [pub, priv] });
    expect(again.missing).toBe(0);
    expect(again.written).toBe(0);
  });
});
