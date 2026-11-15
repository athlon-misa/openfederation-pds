/**
 * Device signing, phase 2 (#240): the features that write on the person's
 * behalf, signed on the device, against the dev PLC.
 *
 * With device signing on, each feature either works through the device
 * (net.openfederation.repo.prepareAction, then submitCommit) or is clearly
 * unavailable. Calling a feature directly is still refused: the server never
 * signs for the account. Tokens (service-auth, the SIWOF didToken) are signed
 * on the device and verify against the DID's current atproto key.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { verifyRepoCar } from '@atproto/repo';
import { Secp256k1Keypair } from '@atproto/crypto';
import { Wallet } from 'ethers';
import { xrpcAuthPost, xrpcAuthGet, xrpcGet, createTestUser, isPLCAvailable, uniqueHandle } from './helpers.js';
import { query } from '../../src/db/client.js';
import { config } from '../../src/config.js';
import { runtimeSettings } from '../../src/settings/runtime-settings.js';
import { setEmailSenderForTests } from '../../src/email/email-service.js';
import { RepoEngine } from '../../src/repo/repo-engine.js';
import { getKeypairForDid } from '../../src/repo/keypair-utils.js';
import { verifyAuthorSignature } from '../../src/forum/member-content.js';
import { verifyServiceAuthJwt, signServiceAuthJwt, _clearReplayCache } from '../../src/auth/service-auth.js';
import { currentAtprotoKey } from '../../src/identity/device-signing.js';
import { buildSiwofMessage } from '../../src/identity/siwof.js';
import { verifySignInAssertion } from '../../packages/openfederation-sdk/src/siwof/verify.js';
import {
  generateCustodyPhrase, deriveCustodyKeys, signOwnerRaw, generateDeviceRepoKey, enableDeviceSigning,
  deviceAction, deviceUpdateProfile, deviceCreateThread, deviceCreatePost, deviceDeletePost, deviceRsvp,
  deviceVote, deviceObject, deviceSendContactRequest, deviceRespondToContactRequest, deviceRemoveContact,
  deviceWithdrawContactRequest, deviceBlockContact, deviceUnblockContact, deviceCreateRecord,
  createServiceAuthToken, deviceSignInAssert, signCommitBytes, cidBytes, DeviceCommitRejected,
  type CustodyKeys, type DeviceRepoKey, type XrpcCaller, type DeviceActionRequest,
} from '../../packages/openfederation-sdk/src/custody/index.js';

const PASSWORD = 'TestPassword123!';
const PREPARE_ACTION = 'net.openfederation.repo.prepareAction';
const SUBMIT = 'net.openfederation.repo.submitCommit';
const THREAD = 'net.openfederation.forum.thread';
const POST = 'net.openfederation.forum.post';
const RSVP = 'community.lexicon.calendar.rsvp';
const VOTE = 'net.openfederation.governance.vote';
const OBJECTION = 'net.openfederation.governance.objection';
const PROPOSAL = 'net.openfederation.community.proposal';
const plcUrl = () => config.plc.directoryUrl;
const pdsUrl = () => config.pds.serviceUrl;

type User = Awaited<ReturnType<typeof createTestUser>>;

function clientFor(u: User, tamper?: (body: any) => void): XrpcCaller {
  return {
    async fetch(nsid, opts) {
      const res = opts.method === 'GET' ? await xrpcAuthGet(nsid, u.accessJwt, opts.params) : await xrpcAuthPost(nsid, u.accessJwt, opts.body);
      if (res.status >= 400) throw Object.assign(new Error(res.body?.message ?? `HTTP ${res.status}`), { code: res.body?.error, status: res.status });
      if (nsid === PREPARE_ACTION && tamper) tamper(res.body);
      return res.body;
    },
  };
}

async function personHeld(target: 'self' | 'assisted', keys: CustodyKeys): Promise<User> {
  const u = await createTestUser(uniqueHandle('dsf'));
  const newKeys = { userRotationDidKey: keys.rotationDidKey, ownerDidKey: keys.ownerDidKey };
  const prep = await xrpcAuthPost('net.openfederation.identity.prepareCustodyChange', u.accessJwt, { password: PASSWORD, targetMode: target, ...newKeys });
  expect(prep.status).toBe(200);
  const text = `OpenFederation Custody Change v1\ndid: ${u.did}\noperation: ${prep.body.operationCid}`;
  const fin = await xrpcAuthPost('net.openfederation.identity.finalizeCustodyChange', u.accessJwt, {
    password: PASSWORD, targetMode: target, ...newKeys, operationCid: prep.body.operationCid,
    possession: { rotation: signOwnerRaw(keys.rotationPrivateKey, text), owner: signOwnerRaw(keys.ownerPrivateKey, text) },
  });
  expect(fin.status).toBe(200);
  return u;
}

async function repoCar(did: string): Promise<Uint8Array> {
  const res = await fetch(`${pdsUrl()}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(did)}`);
  expect(res.status).toBe(200);
  return new Uint8Array(await res.arrayBuffer());
}
async function root(did: string): Promise<string | undefined> {
  return (await new RepoEngine(did).getRoot())?.toString();
}
async function record(did: string, collection: string, rkey: string): Promise<Record<string, any> | undefined> {
  return (await new RepoEngine(did).getRecord(collection, rkey))?.record;
}
function rkeyOf(uri: string): string {
  return uri.split('/').pop()!;
}
function expectRefused(res: { status: number; body: { error?: string } }) {
  expect(res.status).toBe(403);
  expect(res.body.error).toBe('DeviceSigningRequired');
}

describe('device signing, phase 2: features signed on the device (#240)', () => {
  let plc = false;
  const policyBefore = runtimeSettings().identity.deviceSigningAllowed;

  let user: User;
  let other: User;
  let owner: User;
  let device: DeviceRepoKey;
  let client: XrpcCaller;
  let publicCommunity: string;
  let privateCommunity: string;
  let modRolePublic: string;
  let modRolePrivate: string;
  const opts = () => ({ client, did: user.did, deviceKey: device.privateKey, verifyAgainst: pdsUrl() });

  beforeAll(async () => {
    plc = await isPLCAvailable();
    runtimeSettings().identity.deviceSigningAllowed = true;
    setEmailSenderForTests(async () => undefined);
    if (!plc) return;

    const phrase = deriveCustodyKeys(generateCustodyPhrase());
    device = generateDeviceRepoKey();
    user = await personHeld('self', phrase);
    other = await createTestUser(uniqueHandle('dsf-o'));
    owner = await createTestUser(uniqueHandle('dsf-own'));
    client = clientFor(user);

    for (const visibility of ['public', 'private'] as const) {
      const created = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
        handle: uniqueHandle(`dsf-${visibility}`), didMethod: 'plc', visibility, joinPolicy: 'open',
      });
      expect(created.status).toBe(201);
      const did = created.body.did;
      const roles = await xrpcAuthGet('net.openfederation.community.listRoles', owner.accessJwt, { communityDid: did });
      const mod = roles.body.roles.find((r: { name: string }) => r.name === 'moderator').rkey;
      for (const member of [user, other]) {
        const joined = await xrpcAuthPost('net.openfederation.community.join', member.accessJwt, { did });
        expect(joined.status).toBeLessThan(300);
        await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, { communityDid: did, memberDid: member.did, roleRkey: mod });
      }
      if (visibility === 'public') { publicCommunity = did; modRolePublic = mod; } else { privateCommunity = did; modRolePrivate = mod; }
    }
    expect(modRolePublic && modRolePrivate).toBeTruthy();

    await enableDeviceSigning({ plcUrl: plcUrl(), did: user.did, rotationPrivateKey: phrase.rotationPrivateKey, deviceDidKey: device.didKey, client });
  }, 120_000);

  afterAll(() => {
    runtimeSettings().identity.deviceSigningAllowed = policyBefore;
    setEmailSenderForTests(null);
  });

  it('every feature called directly is still refused: the server never signs for the account', async () => {
    if (!plc) return;
    const head = await root(user.did);
    const thread = await xrpcAuthPost('net.openfederation.forum.createThread', other.accessJwt, { community: publicCommunity, title: 'theirs' });
    expect(thread.status).toBe(200);
    expectRefused(await xrpcAuthPost('net.openfederation.account.updateProfile', user.accessJwt, { displayName: 'forged' }));
    expectRefused(await xrpcAuthPost('net.openfederation.forum.createThread', user.accessJwt, { community: publicCommunity, title: 'forged' }));
    expectRefused(await xrpcAuthPost('net.openfederation.forum.createThread', user.accessJwt, { community: privateCommunity, title: 'forged' }));
    expectRefused(await xrpcAuthPost('net.openfederation.forum.createPost', user.accessJwt, { community: publicCommunity, root: { uri: thread.body.uri, cid: thread.body.cid }, text: 'forged' }));
    expectRefused(await xrpcAuthPost('net.openfederation.contact.sendRequest', user.accessJwt, { subject: owner.did }));
    expectRefused(await xrpcAuthGet('com.atproto.server.getServiceAuth', user.accessJwt, { aud: 'did:web:example.com' }));
    expect(await root(user.did)).toBe(head);
    // A server-signed record would not verify anyway.
    await expect(new RepoEngine(user.did).putRecord(await getKeypairForDid(user.did), THREAD, 'x', { title: 'x' })).rejects.toThrow(/device/i);
  });

  it('prepareAction refuses methods it does not know, and accounts without device signing', async () => {
    if (!plc) return;
    const unknown = await xrpcAuthPost(PREPARE_ACTION, user.accessJwt, { method: 'com.atproto.repo.createRecord', input: {} });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe('UnsupportedMethod');
    const off = await xrpcAuthPost(PREPARE_ACTION, other.accessJwt, { method: 'net.openfederation.account.updateProfile', input: { displayName: 'x' } });
    expect(off.body.error).toBe('DeviceSigningOff');
    // The method's own validation runs, and its errors come back as they are.
    const invalid = await xrpcAuthPost(PREPARE_ACTION, user.accessJwt, { method: 'net.openfederation.forum.createThread', input: { community: publicCommunity } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe('InvalidRequest');
  });

  describe('profile', () => {
    it('is signed on the device, verifies against the device key, and reaches community member lists', async () => {
      if (!plc) return;
      const res = await deviceUpdateProfile({ ...opts(), displayName: 'Signed on my device', description: 'mine' });
      expect(res.signed).toBe(true);
      expect(res.result.uri).toBe(`at://${user.did}/app.bsky.actor.profile/self`);
      expect((await record(user.did, 'app.bsky.actor.profile', 'self'))?.displayName).toBe('Signed on my device');
      await verifyRepoCar(await repoCar(user.did), user.did, device.didKey);
      const member = await query<{ display_name: string }>('SELECT display_name FROM members_unique WHERE member_did = $1 AND community_did = $2', [user.did, publicCommunity]);
      expect(member.rows[0].display_name).toBe('Signed on my device');
    });

    it('a generic profile write through prepareCommit also reaches member lists', async () => {
      if (!plc) return;
      const current = await record(user.did, 'app.bsky.actor.profile', 'self');
      await deviceCreateRecord({ ...opts(), collection: 'app.bsky.actor.profile', rkey: 'self', record: { ...current, displayName: 'Generic write' } });
      const member = await query<{ display_name: string }>('SELECT display_name FROM members_unique WHERE member_did = $1 AND community_did = $2', [user.did, publicCommunity]);
      expect(member.rows[0].display_name).toBe('Generic write');
    });

    it('the device refuses a prepared profile that says something else', async () => {
      if (!plc) return;
      const head = await root(user.did);
      const tampering = clientFor(user, (body) => { body.writes[0].record.displayName = 'Not what I typed'; });
      await expect(deviceUpdateProfile({ ...opts(), client: tampering, displayName: 'What I typed' })).rejects.toBeInstanceOf(DeviceCommitRejected);
      expect(await root(user.did)).toBe(head);
    });

    it('a prepared action signed by the server\'s key, or prepared on a root that moved, is refused', async () => {
      if (!plc) return;
      const head = await root(user.did);
      const prep = await xrpcAuthPost(PREPARE_ACTION, user.accessJwt, { method: 'net.openfederation.account.updateProfile', input: { displayName: 'forged' } });
      expect(prep.body.kind).toBe('commit');
      const serverSig = await (await getKeypairForDid(user.did)).sign(Buffer.from(prep.body.commit.unsignedCommit, 'base64'));
      const forged = await xrpcAuthPost(SUBMIT, user.accessJwt, { handle: prep.body.handle, sig: Buffer.from(serverSig).toString('base64') });
      expect(forged.body.error).toBe('InvalidSignature');
      expect(await root(user.did)).toBe(head);

      const stale = await xrpcAuthPost(PREPARE_ACTION, user.accessJwt, { method: 'net.openfederation.account.updateProfile', input: { displayName: 'stale' } });
      await deviceUpdateProfile({ ...opts(), displayName: 'in between' });
      const sig = signCommitBytes(Buffer.from(stale.body.commit.unsignedCommit, 'base64'), device.privateKey);
      const late = await xrpcAuthPost(SUBMIT, user.accessJwt, { handle: stale.body.handle, sig: Buffer.from(sig).toString('base64') });
      expect(late.status).toBe(409);
      expect(late.body.error).toBe('RepoHeadMoved');
      expect((await record(user.did, 'app.bsky.actor.profile', 'self'))?.displayName).toBe('in between');
    });
  });

  describe('forum and RSVPs', () => {
    it('public community: thread and post in the person\'s repo, signed by the device, indexed', async () => {
      if (!plc) return;
      const thread = await deviceCreateThread({ ...opts(), community: publicCommunity, title: '  Device thread ' });
      expect(thread.result.uri.startsWith(`at://${user.did}/${THREAD}/`)).toBe(true);
      const indexed = await query('SELECT title FROM forum_threads WHERE uri = $1', [thread.result.uri]);
      expect(indexed.rows[0].title).toBe('Device thread');

      const post = await deviceCreatePost({ ...opts(), community: publicCommunity, root: { uri: thread.result.uri, cid: thread.result.cid }, text: 'Device post' });
      expect(post.result.uri.startsWith(`at://${user.did}/${POST}/`)).toBe(true);
      const read = await xrpcAuthGet('net.openfederation.forum.getThread', other.accessJwt, { uri: thread.result.uri });
      expect(JSON.stringify(read.body)).toContain('Device post');
      await verifyRepoCar(await repoCar(user.did), user.did, device.didKey);

      const del = await deviceDeletePost({ ...opts(), rkey: post.result.rkey });
      expect(del.result).toEqual({ success: true });
      expect(await record(user.did, POST, post.result.rkey)).toBeUndefined();
      expect((await query('SELECT 1 FROM forum_posts WHERE uri = $1', [post.result.uri])).rows).toHaveLength(0);
    });

    it('private community: kept in the community\'s repo, signed by the device as author', async () => {
      if (!plc) return;
      const headBefore = await root(user.did);
      const thread = await deviceCreateThread({ ...opts(), community: privateCommunity, title: 'Private device thread' });
      expect(thread.result.uri.startsWith(`at://${privateCommunity}/${THREAD}/`)).toBe(true);
      const stored = await record(privateCommunity, THREAD, rkeyOf(thread.result.uri));
      expect(stored?.author).toBe(user.did);
      expect(stored?.authorSig.key).toBe(device.didKey);
      expect(await verifyAuthorSignature(stored!)).toBe(true);
      expect(await verifyAuthorSignature({ ...stored!, title: 'changed' })).toBe(false);

      const post = await deviceCreatePost({ ...opts(), community: privateCommunity, root: { uri: thread.result.uri, cid: thread.result.cid }, text: 'Private device post' });
      const storedPost = await record(privateCommunity, POST, rkeyOf(post.result.uri));
      expect(await verifyAuthorSignature(storedPost!)).toBe(true);
      // Nothing went into the person's public repo.
      expect(await root(user.did)).toBe(headBefore);
      // Deleting it is the community repo's business: no signature needed.
      const del = await deviceDeletePost({ ...opts(), rkey: rkeyOf(post.result.uri) });
      expect(del.signed).toBe(false);
      expect(await record(privateCommunity, POST, rkeyOf(post.result.uri))).toBeUndefined();
    });

    it('the device refuses an author record that is not what it asked for, or whose CID is wrong', async () => {
      if (!plc) return;
      const thread = await xrpcAuthPost('net.openfederation.forum.createThread', other.accessJwt, { community: privateCommunity, title: 'theirs' });
      const swapText = clientFor(user, (body) => { body.authorSig.record.text = 'words put in my mouth'; });
      await expect(deviceCreatePost({ ...opts(), client: swapText, community: privateCommunity, root: { uri: thread.body.uri, cid: thread.body.cid }, text: 'mine' }))
        .rejects.toBeInstanceOf(DeviceCommitRejected);
      const swapCid = clientFor(user, (body) => { body.authorSig.cid = body.authorSig.cid.slice(0, -2) + 'aa'; });
      await expect(deviceCreatePost({ ...opts(), client: swapCid, community: privateCommunity, root: { uri: thread.body.uri, cid: thread.body.cid }, text: 'mine' }))
        .rejects.toBeInstanceOf(DeviceCommitRejected);
      const posts = await query('SELECT 1 FROM forum_posts WHERE author_did = $1 AND thread_root_uri = $2', [user.did, thread.body.uri]);
      expect(posts.rows).toHaveLength(0);
    });

    it('an author signature by the server\'s key is refused', async () => {
      if (!plc) return;
      const thread = await xrpcAuthPost('net.openfederation.forum.createThread', other.accessJwt, { community: privateCommunity, title: 'theirs too' });
      const prep = await xrpcAuthPost(PREPARE_ACTION, user.accessJwt, {
        method: 'net.openfederation.forum.createPost',
        input: { community: privateCommunity, root: { uri: thread.body.uri, cid: thread.body.cid }, text: 'forged' },
      });
      expect(prep.body.kind).toBe('authorSig');
      const serverSig = await (await getKeypairForDid(user.did)).sign(cidBytes(prep.body.authorSig.cid));
      const res = await xrpcAuthPost(SUBMIT, user.accessJwt, { handle: prep.body.handle, sig: Buffer.from(serverSig).toString('base64') });
      expect(res.body.error).toBe('InvalidSignature');
      // The right signature still works on a fresh prepare (a handle is used once).
      const again = await xrpcAuthPost(SUBMIT, user.accessJwt, { handle: prep.body.handle, sig: Buffer.from(signCommitBytes(cidBytes(prep.body.authorSig.cid), device.privateKey)).toString('base64') });
      expect(again.body.error).toBe('UnknownCommit');
    });

    it('RSVPs: public in the person\'s repo, private signed as author; changing it replaces it', async () => {
      if (!plc) return;
      for (const community of [publicCommunity, privateCommunity]) {
        const event = await xrpcAuthPost('net.openfederation.calendar.createEvent', owner.accessJwt, { community, name: 'device event' });
        expect(event.status).toBe(200);
        const ref = { uri: event.body.uri, cid: event.body.cid };
        const first = await deviceRsvp({ ...opts(), community, event: ref, status: 'going' });
        const second = await deviceRsvp({ ...opts(), community, event: ref, status: 'interested' });
        expect(second.result.uri).toBe(first.result.uri);
        const rows = await query<{ status: string }>('SELECT status FROM event_rsvps WHERE event_uri = $1 AND attendee_did = $2', [ref.uri, user.did]);
        expect(rows.rows.map((r) => r.status)).toEqual(['interested']);
        const repo = community === publicCommunity ? user.did : community;
        expect(first.result.uri.startsWith(`at://${repo}/${RSVP}/`)).toBe(true);
        if (community === privateCommunity) expect(await verifyAuthorSignature((await record(community, RSVP, rkeyOf(first.result.uri)))!)).toBe(true);
      }
    });
  });

  describe('governance', () => {
    // Once a community decides by vote, its model changes only by vote too:
    // each community gets its model once.
    let objectionCommunity: string;
    async function setModel(community: string, quorum: number, timelockHours: number): Promise<void> {
      const model = await xrpcAuthPost('net.openfederation.community.setGovernanceModel', owner.accessJwt, {
        communityDid: community, governanceModel: 'simple-majority',
        governanceConfig: { quorum, voterRole: 'moderator', proposalTtlDays: 7, timelockHours },
      });
      expect(model.status).toBe(200);
    }
    beforeAll(async () => {
      if (!plc) return;
      await setModel(publicCommunity, 10, 0);
      await setModel(privateCommunity, 10, 0);
      const created = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
        handle: uniqueHandle('dsf-obj'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
      });
      objectionCommunity = created.body.did;
      const roles = await xrpcAuthGet('net.openfederation.community.listRoles', owner.accessJwt, { communityDid: objectionCommunity });
      const mod = roles.body.roles.find((r: { name: string }) => r.name === 'moderator').rkey;
      for (const member of [user, other]) {
        await xrpcAuthPost('net.openfederation.community.join', member.accessJwt, { did: objectionCommunity });
        await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, { communityDid: objectionCommunity, memberDid: member.did, roleRkey: mod });
      }
      await setModel(objectionCommunity, 1, 24);
    }, 60_000);

    async function proposal(community: string): Promise<string> {
      const created = await xrpcAuthPost('net.openfederation.community.createProposal', owner.accessJwt, {
        communityDid: community, targetCollection: 'net.openfederation.community.profile', targetRkey: 'self',
        action: 'write', proposedRecord: { displayName: `proposed ${Date.now()}` },
      });
      expect(created.status).toBe(200);
      return created.body.rkey;
    }
    async function proposalRecord(community: string, rkey: string) {
      return (await record(community, PROPOSAL, rkey))!;
    }

    it('a vote is the device\'s record, counted in the tally (public: in the person\'s repo)', async () => {
      if (!plc) return;
      const rkey = await proposal(publicCommunity);
      const res = await deviceVote({ ...opts(), communityDid: publicCommunity, proposalRkey: rkey, vote: 'for' });
      expect(res.signed).toBe(true);
      expect(res.result).toMatchObject({ recorded: true, status: 'open' });
      expect((await proposalRecord(publicCommunity, rkey)).votesFor).toContain(user.did);
      const votes = await query<{ rkey: string; record: any }>('SELECT rkey, record FROM records_index WHERE community_did = $1 AND collection = $2', [user.did, VOTE]);
      expect(votes.rows.filter((v) => v.record.proposalRkey === rkey)).toHaveLength(1);
      await verifyRepoCar(await repoCar(user.did), user.did, device.didKey);

      // The method's checks run again on submit: a second vote is refused, and nothing is written.
      const again = await deviceVote({ ...opts(), communityDid: publicCommunity, proposalRkey: rkey, vote: 'against' }).catch((e) => e);
      expect(again.code).toBe('AlreadyVoted');
    });

    it('a vote in a private community is signed by the device as author and counted', async () => {
      if (!plc) return;
      const rkey = await proposal(privateCommunity);
      const res = await deviceVote({ ...opts(), communityDid: privateCommunity, proposalRkey: rkey, vote: 'against' });
      expect(res.result).toMatchObject({ recorded: true });
      expect((await proposalRecord(privateCommunity, rkey)).votesAgainst).toContain(user.did);
      const stored = await query<{ record: any }>(
        `SELECT record FROM records_index WHERE community_did = $1 AND collection = $2 AND record->>'proposalRkey' = $3 AND record->>'author' = $4`,
        [privateCommunity, VOTE, rkey, user.did],
      );
      expect(stored.rows).toHaveLength(1);
      expect(await verifyAuthorSignature(stored.rows[0].record)).toBe(true);
    });

    it('a vote prepared while the proposal was open, submitted after it closed, writes nothing', async () => {
      if (!plc) return;
      const rkey = await proposal(publicCommunity);
      const prep = await xrpcAuthPost(PREPARE_ACTION, user.accessJwt, { method: 'net.openfederation.community.voteOnProposal', input: { communityDid: publicCommunity, proposalRkey: rkey, vote: 'for' } });
      expect(prep.body.kind).toBe('commit');
      const head = await root(user.did);
      const p = await proposalRecord(publicCommunity, rkey);
      const { putProposalRecord } = await import('../../src/governance/proposal-resolution.js');
      await putProposalRecord(new RepoEngine(publicCommunity), await getKeypairForDid(publicCommunity), publicCommunity, rkey, { ...p, status: 'rejected', resolvedAt: new Date().toISOString() });
      const sig = signCommitBytes(Buffer.from(prep.body.commit.unsignedCommit, 'base64'), device.privateKey);
      const res = await xrpcAuthPost(SUBMIT, user.accessJwt, { handle: prep.body.handle, sig: Buffer.from(sig).toString('base64') });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('ProposalClosed');
      expect(await root(user.did)).toBe(head);
    });

    it('an objection is the device\'s record and counts towards the hold', async () => {
      if (!plc) return;
      const rkey = await proposal(objectionCommunity);
      const vote = await xrpcAuthPost('net.openfederation.community.voteOnProposal', other.accessJwt, { communityDid: objectionCommunity, proposalRkey: rkey, vote: 'for' });
      expect(vote.body.status).toBe('pending-application');
      const res = await deviceObject({ ...opts(), communityDid: objectionCommunity, proposalRkey: rkey, reason: 'not like this' });
      expect(res.signed).toBe(true);
      expect(res.result).toMatchObject({ recorded: true, objectionCount: 1 });
      const stored = await record(user.did, OBJECTION, (res.result as any).objection.rkey);
      expect(stored?.reason).toBe('not like this');
      await verifyRepoCar(await repoCar(user.did), user.did, device.didKey);
    });
  });

  describe('contacts', () => {
    it('sending, being accepted, confirming on the device, and removing', async () => {
      if (!plc) return;
      const sent = await deviceSendContactRequest({ ...opts(), subject: other.did, note: 'hello' });
      expect(sent.result.uri.startsWith(`at://${user.did}/net.openfederation.contact.request/`)).toBe(true);
      expect((await query('SELECT 1 FROM contact_requests WHERE from_did = $1 AND to_did = $2', [user.did, other.did])).rows).toHaveLength(1);

      // The other side accepts. Their side is written; this account's side waits for its device.
      const accepted = await xrpcAuthPost('net.openfederation.contact.respondToRequest', other.accessJwt, { rkey: sent.result.rkey, action: 'accept' });
      expect(accepted.status).toBe(200);
      expect((await query('SELECT 1 FROM contacts WHERE user_did = $1 AND contact_did = $2', [other.did, user.did])).rows).toHaveLength(1);
      expect((await query('SELECT 1 FROM contacts WHERE user_did = $1 AND contact_did = $2', [user.did, other.did])).rows).toHaveLength(0);
      const incoming = await xrpcAuthGet('net.openfederation.contact.listIncomingRequests', user.accessJwt);
      const confirm = incoming.body.requests.find((r: { fromDid: string }) => r.fromDid === other.did);
      expect(confirm).toBeTruthy();

      const done = await deviceRespondToContactRequest({ ...opts(), rkey: confirm.rkey, action: 'accept', from: other.did });
      expect(done.signed).toBe(true);
      const mine = await query<{ rkey: string }>('SELECT rkey FROM contacts WHERE user_did = $1 AND contact_did = $2', [user.did, other.did]);
      expect(mine.rows).toHaveLength(1);
      expect((await record(user.did, 'net.openfederation.contact.contact', mine.rows[0].rkey))?.subject).toBe(other.did);
      expect((await query('SELECT 1 FROM contact_requests WHERE (from_did = $1 AND to_did = $2) OR (from_did = $2 AND to_did = $1)', [user.did, other.did])).rows).toHaveLength(0);

      await deviceRemoveContact({ ...opts(), subject: other.did });
      expect((await query('SELECT 1 FROM contacts WHERE user_did = $1 OR contact_did = $1', [user.did])).rows).toHaveLength(0);
      expect(await record(user.did, 'net.openfederation.contact.contact', mine.rows[0].rkey)).toBeUndefined();
      await verifyRepoCar(await repoCar(user.did), user.did, device.didKey);
    });

    it('accepting a request on the device writes both sides at once', async () => {
      if (!plc) return;
      const req = await xrpcAuthPost('net.openfederation.contact.sendRequest', owner.accessJwt, { subject: user.did });
      expect(req.status).toBe(200);
      await deviceRespondToContactRequest({ ...opts(), rkey: req.body.rkey, action: 'accept', from: owner.did });
      expect((await query('SELECT 1 FROM contacts WHERE (user_did = $1 AND contact_did = $2) OR (user_did = $2 AND contact_did = $1)', [user.did, owner.did])).rows).toHaveLength(2);
    });

    it('rejecting needs no signature; withdrawing, blocking and unblocking are signed on the device', async () => {
      if (!plc) return;
      const third = await createTestUser(uniqueHandle('dsf-3'));
      const req = await xrpcAuthPost('net.openfederation.contact.sendRequest', third.accessJwt, { subject: user.did });
      const rejected = await deviceRespondToContactRequest({ ...opts(), rkey: req.body.rkey, action: 'reject' });
      expect(rejected.signed).toBe(false);

      const sent = await deviceSendContactRequest({ ...opts(), subject: third.did });
      await deviceWithdrawContactRequest({ ...opts(), rkey: sent.result.rkey });
      expect(await record(user.did, 'net.openfederation.contact.request', sent.result.rkey)).toBeUndefined();

      const again = await deviceSendContactRequest({ ...opts(), subject: third.did });
      await deviceBlockContact({ ...opts(), subject: third.did });
      expect(await record(user.did, 'net.openfederation.contact.request', again.result.rkey)).toBeUndefined();
      const block = await query<{ rkey: string }>('SELECT rkey FROM contact_blocks WHERE blocker_did = $1 AND blocked_did = $2', [user.did, third.did]);
      expect(block.rows).toHaveLength(1);
      expect((await record(user.did, 'net.openfederation.contact.block', block.rows[0].rkey))?.subject).toBe(third.did);

      await deviceUnblockContact({ ...opts(), subject: third.did });
      expect((await query('SELECT 1 FROM contact_blocks WHERE blocker_did = $1', [user.did])).rows).toHaveLength(0);
      await verifyRepoCar(await repoCar(user.did), user.did, device.didKey);
    });
  });

  describe('tokens', () => {
    it('service-auth: getServiceAuth refuses; a token minted on the device verifies against the DID, a server-signed one does not', async () => {
      if (!plc) return;
      _clearReplayCache();
      const aud = 'did:web:service.example.com';
      const token = createServiceAuthToken({ did: user.did, deviceKey: device.privateKey, aud, lxm: 'app.example.method' });
      const claims = await verifyServiceAuthJwt(token, { expectedAud: aud, expectedLxm: 'app.example.method', resolveSigningKey: async (d) => (await currentAtprotoKey(d))! });
      expect(claims.iss).toBe(user.did);

      const forged = await signServiceAuthJwt({ keypair: await getKeypairForDid(user.did), iss: user.did, aud, exp: Math.floor(Date.now() / 1000) + 60, lxm: 'app.example.method' });
      await expect(verifyServiceAuthJwt(forged, { expectedAud: aud, resolveSigningKey: async (d) => (await currentAtprotoKey(d))! })).rejects.toThrow(/signature/i);
    });

    it('SIWOF: refused without signOnDevice; with it, the device signs a didToken any dApp verifies against the DID', async () => {
      if (!plc) return;
      const wallet = Wallet.createRandom();
      const address = wallet.address.toLowerCase();
      const audience = 'https://dapp.example.com/login';
      const message = buildSiwofMessage({
        domain: 'dapp.example.com', accountCaip10: `eip155:1:${address}`, uri: audience, version: '1',
        chainIdCaip2: 'eip155:1', nonce: randomUUID().replace(/-/g, ''), issuedAt: new Date().toISOString(),
        expirationTime: new Date(Date.now() + 5 * 60_000).toISOString(), statement: 'Sign in',
      });
      const challenge = async () => query(
        `INSERT INTO wallet_link_challenges (id, user_did, chain, wallet_address, challenge, expires_at, purpose, audience)
         VALUES ($1, $2, 'ethereum', $3, $4, NOW() + interval '5 minutes', 'signin', $5)`,
        [randomUUID(), user.did, address, message, audience],
      );
      const walletSignature = await wallet.signMessage(message);

      await challenge();
      expectRefused(await xrpcAuthPost('net.openfederation.identity.signInAssert', user.accessJwt, { chain: 'ethereum', walletAddress: address, message, walletSignature }));

      // The refusal left the challenge in place.
      const signedIn = await deviceSignInAssert({ client, did: user.did, deviceKey: device.privateKey, chain: 'ethereum', walletAddress: address, message, walletSignature });
      const verified = await verifySignInAssertion(signedIn.didToken, signedIn.walletProof as any, {
        expectedAudience: audience, resolveSigningKey: async (d: string) => (await currentAtprotoKey(d))!,
      });
      expect(verified.did).toBe(user.did);
      expect(verified.walletAddress.toLowerCase()).toBe(address);

      // A server that swaps the audience gets no signature.
      await challenge();
      const lying: XrpcCaller = {
        async fetch(nsid, o) {
          const body = await client.fetch(nsid, o) as any;
          const [h, b] = body.unsignedDidToken.split('.');
          const claims = JSON.parse(Buffer.from(b, 'base64url').toString());
          body.unsignedDidToken = `${h}.${Buffer.from(JSON.stringify({ ...claims, aud: 'https://evil.example.com' })).toString('base64url')}`;
          return body;
        },
      };
      await expect(deviceSignInAssert({ client: lying, did: user.did, deviceKey: device.privateKey, chain: 'ethereum', walletAddress: address, message, walletSignature }))
        .rejects.toBeInstanceOf(DeviceCommitRejected);
    });

    it('getPrimaryWallet returns the binding without a server-signed proof', async () => {
      if (!plc) return;
      const address = Wallet.createRandom().address.toLowerCase();
      await query(
        `INSERT INTO wallet_links (id, user_did, chain, wallet_address, challenge, signature, is_primary)
         VALUES ($1, $2, 'ethereum', $3, 'x', 'x', TRUE)`,
        [randomUUID(), user.did, address],
      );
      const res = await xrpcGet('net.openfederation.identity.getPrimaryWallet', { did: user.did, chain: 'ethereum' });
      expect(res.status).toBe(200);
      expect(res.body.walletAddress).toBe(address);
      expect(res.body.proof).toBeUndefined();
    });
  });

  it('a prepared action can be inspected and is bound to the account', async () => {
    if (!plc) return;
    const seen: DeviceActionRequest[] = [];
    await deviceAction({ ...opts(), method: 'net.openfederation.account.updateProfile', input: { description: 'inspected' }, expect: (r) => { seen.push(r); } });
    expect(seen[0].kind).toBe('commit');
    expect(seen[0].writes).toEqual([expect.objectContaining({ action: 'update', collection: 'app.bsky.actor.profile', rkey: 'self' })]);

    const prep = await xrpcAuthPost(PREPARE_ACTION, user.accessJwt, { method: 'net.openfederation.account.updateProfile', input: { description: 'mine' } });
    const sig = Buffer.from(signCommitBytes(Buffer.from(prep.body.commit.unsignedCommit, 'base64'), device.privateKey)).toString('base64');
    const stolen = await xrpcAuthPost(SUBMIT, other.accessJwt, { handle: prep.body.handle, sig });
    expect(stolen.body.error).toBe('UnknownCommit');
  });
});

describe('verifyAuthorSignature checks the DID\'s current key (#240)', () => {
  it('a record signed by a key the server once held does not verify after the DID moved to the device', async () => {
    if (!(await isPLCAvailable())) return;
    const phrase = deriveCustodyKeys(generateCustodyPhrase());
    const u = await personHeld('self', phrase);
    const serverKey = await getKeypairForDid(u.did);
    const { cidForRecord } = await import('@atproto/repo');
    const sign = async (key: Secp256k1Keypair | { did(): string; sign(b: Uint8Array): Promise<Uint8Array> }) => {
      const unsigned = { $type: POST, text: 'who wrote this?', author: u.did, createdAt: new Date().toISOString() };
      const cid = await cidForRecord(unsigned);
      return { ...unsigned, authorSig: { key: key.did(), sig: Buffer.from(await key.sign(cid.bytes)).toString('base64url') } };
    };
    const before = await sign(serverKey);
    expect(await verifyAuthorSignature(before)).toBe(true);

    runtimeSettings().identity.deviceSigningAllowed = true;
    const device = generateDeviceRepoKey();
    await enableDeviceSigning({ plcUrl: plcUrl(), did: u.did, rotationPrivateKey: phrase.rotationPrivateKey, deviceDidKey: device.didKey, client: clientFor(u) });
    // The server's key is still in the DID's history; it no longer counts.
    expect(await verifyAuthorSignature(before)).toBe(false);
    expect(await verifyAuthorSignature(await sign(serverKey))).toBe(false);
  });
});
