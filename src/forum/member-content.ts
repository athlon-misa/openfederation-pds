/**
 * Where what members write in a community is stored.
 *
 * Forum threads, forum posts and RSVPs are written by members. In a public
 * community they go into the author's own repository, the ordinary AT Protocol
 * arrangement: the author's repo is public, and so is the community.
 *
 * In a private community that arrangement leaks. A user's repository is public
 * whatever the community's visibility, so the text of a "private" post, the
 * community it belongs to and the fact that its author is a member could all be
 * read straight out of the author's repo by anyone.
 *
 * So for a private community the record is written to the community's own
 * repository, which only members can read. Authorship is not lost: the record
 * names its `author` and carries `authorSig`, the author's signature over the
 * rest of the record. Anyone who can read the record can check it against the
 * author's atproto signing key.
 */
import { cidForRecord } from '@atproto/repo';
import type { Keypair } from '@atproto/crypto';
import { query } from '../db/client.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { atprotoKeyHistory } from '../identity/account-migration.js';
import {
  authorSignatureValid, recordAuthor, withoutAuthorSignature, type AuthorSignature,
} from '../governance/author-signature.js';
export type { AuthorSignature } from '../governance/author-signature.js';
import { FORUM_THREAD, FORUM_POST, CALENDAR_RSVP } from './forum-index.js';
import { VOTE_COLLECTION, OBJECTION_COLLECTION, PROPOSAL_COLLECTION } from '../governance/decision-rules.js';

const SETTINGS_COLLECTION = 'net.openfederation.community.settings';

function withoutSignature(record: Record<string, unknown>): Record<string, unknown> {
  return withoutAuthorSignature(record);
}

async function signedBy(author: string, keypair: Keypair, record: Record<string, unknown>): Promise<Record<string, unknown>> {
  const unsigned = { ...withoutSignature(record), author };
  const cid = await cidForRecord(unsigned);
  const sig = Buffer.from(await keypair.sign(cid.bytes)).toString('base64url');
  const authorSig: AuthorSignature = { key: keypair.did(), sig };
  return { ...unsigned, authorSig };
}

/**
 * Check a record's author signature against every key the author's DID has
 * held as its atproto signing key, so records written before a key rotation
 * still verify. False for a record with no signature, a changed record, one
 * attributed to someone whose key did not sign it, or one whose author's DID
 * has been deleted.
 */
export async function verifyAuthorSignature(record: Record<string, unknown>): Promise<boolean> {
  const author = recordAuthor(record);
  if (!author) return false;
  try {
    return await authorSignatureValid(record, await atprotoKeyHistory(author));
  } catch {
    return false;
  }
}

export async function isPrivateCommunity(communityDid: string): Promise<boolean> {
  const settings = await query<{ visibility: string | null }>(
    `SELECT record->>'visibility' AS visibility FROM records_index
     WHERE community_did = $1 AND collection = $2 AND rkey = 'self'`,
    [communityDid, SETTINGS_COLLECTION],
  );
  return settings.rows[0]?.visibility === 'private';
}

export interface StoredMemberContent {
  uri: string;
  cid: string;
  rkey: string;
  /** The repository the record was written to: the community's, or the author's. */
  repo: string;
  /** The record exactly as stored (signed, for a private community). */
  record: Record<string, unknown>;
}

/**
 * Store a member's record for a community: in the community's repository,
 * signed by the author, when the community is private; in the author's own
 * repository otherwise. `rkey` may be given to replace an existing record.
 */
export async function writeMemberContent(opts: {
  communityDid: string;
  authorDid: string;
  collection: string;
  record: Record<string, unknown>;
  rkey?: string;
  /** Skip the visibility lookup when the caller already knows. */
  private?: boolean;
}): Promise<StoredMemberContent> {
  const rkey = opts.rkey ?? RepoEngine.generateTid();
  const authorKeypair = await getKeypairForDid(opts.authorDid);
  const inCommunityRepo = opts.private ?? await isPrivateCommunity(opts.communityDid);

  if (!inCommunityRepo) {
    const result = await new RepoEngine(opts.authorDid).putRecord(authorKeypair, opts.collection, rkey, opts.record);
    return { uri: result.uri, cid: result.cid, rkey, repo: opts.authorDid, record: opts.record };
  }

  const record = await signedBy(opts.authorDid, authorKeypair, opts.record);
  const communityKeypair = await getKeypairForDid(opts.communityDid);
  const result = await new RepoEngine(opts.communityDid).putRecord(communityKeypair, opts.collection, rkey, record);
  return { uri: result.uri, cid: result.cid, rkey, repo: opts.communityDid, record };
}

/** Delete a member's record from whichever repository its URI says it is in. */
export async function deleteMemberContent(uri: string): Promise<void> {
  const [, , repo, collection, rkey] = uri.split('/');
  await new RepoEngine(repo).deleteRecord(await getKeypairForDid(repo), collection, rkey);
}

/**
 * Move a community's existing member content out of its authors' public
 * repositories and into the community's own. Run when a community becomes
 * private: until then its threads, posts and RSVPs were, correctly, public.
 *
 * Threads move first, because posts refer to their thread (and to the post
 * they answer) by address, and those addresses change. Each moved record is
 * re-signed by its author. Copies anyone fetched while the community was
 * public cannot be recalled; this stops the server serving them.
 */
export async function relocateMemberContent(communityDid: string): Promise<{ threads: number; posts: number; rsvps: number; votes: number; objections: number }> {
  const moved = new Map<string, { uri: string; cid: string }>();
  const counts = { threads: 0, posts: 0, rsvps: 0, votes: 0, objections: 0 };
  const elsewhere = `at://${communityDid}/%`;

  const sourceRecord = async (uri: string): Promise<Record<string, unknown> | null> => {
    const [, , repo, collection, rkey] = uri.split('/');
    const row = await query<{ record: Record<string, unknown> }>(
      'SELECT record FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3',
      [repo, collection, rkey],
    );
    return row.rows[0]?.record ?? null;
  };
  const reference = (ref: unknown): unknown => {
    const uri = (ref as { uri?: unknown } | null)?.uri;
    const to = typeof uri === 'string' ? moved.get(uri) : undefined;
    return to ? { uri: to.uri, cid: to.cid } : ref;
  };

  const threads = await query<{ uri: string; author_did: string }>(
    'SELECT uri, author_did FROM forum_threads WHERE community_did = $1 AND uri NOT LIKE $2 ORDER BY created_at ASC',
    [communityDid, elsewhere],
  );
  for (const thread of threads.rows) {
    const record = await sourceRecord(thread.uri);
    if (!record) continue;
    const stored = await writeMemberContent({
      communityDid, authorDid: thread.author_did, collection: FORUM_THREAD, record, private: true,
    });
    moved.set(thread.uri, stored);
    await query('UPDATE forum_threads SET uri = $2, cid = $3 WHERE uri = $1', [thread.uri, stored.uri, stored.cid]);
    await query('UPDATE forum_posts SET thread_root_uri = $2 WHERE thread_root_uri = $1', [thread.uri, stored.uri]);
    await deleteMemberContent(thread.uri);
    counts.threads++;
  }

  const posts = await query<{ uri: string; author_did: string }>(
    'SELECT uri, author_did FROM forum_posts WHERE community_did = $1 AND uri NOT LIKE $2 ORDER BY created_at ASC, uri ASC',
    [communityDid, elsewhere],
  );
  for (const post of posts.rows) {
    const source = await sourceRecord(post.uri);
    if (!source) continue;
    const record: Record<string, unknown> = {
      ...source,
      root: reference(source.root),
      ...(source.parent ? { parent: reference(source.parent) } : {}),
    };
    const stored = await writeMemberContent({
      communityDid, authorDid: post.author_did, collection: FORUM_POST, record, private: true,
    });
    moved.set(post.uri, stored);
    await query(
      'UPDATE forum_posts SET uri = $2, cid = $3, record = $4 WHERE uri = $1',
      [post.uri, stored.uri, stored.cid, JSON.stringify(stored.record)],
    );
    await query('UPDATE forum_posts SET parent_uri = $2 WHERE parent_uri = $1', [post.uri, stored.uri]);
    await deleteMemberContent(post.uri);
    counts.posts++;
  }

  const rsvps = await query<{ uri: string; attendee_did: string }>(
    `SELECT uri, attendee_did FROM event_rsvps WHERE event_uri LIKE $1 AND uri NOT LIKE $2`,
    [`at://${communityDid}/%`, elsewhere],
  );
  for (const rsvp of rsvps.rows) {
    const record = await sourceRecord(rsvp.uri);
    if (!record) continue;
    const stored = await writeMemberContent({
      communityDid, authorDid: rsvp.attendee_did, collection: CALENDAR_RSVP, record, private: true,
    });
    await query('UPDATE event_rsvps SET uri = $2 WHERE uri = $1', [rsvp.uri, stored.uri]);
    await deleteMemberContent(rsvp.uri);
    counts.rsvps++;
  }

  // Votes and objections. A vote for a proposal that is still open (not yet
  // decided; `pending-application` is decided and waiting) moves: it
  // has not been cited by anything yet, and the tally finds it in either
  // place. A vote for a proposal already decided stays where it is, because
  // the community's signed decision record cites it at that address and an
  // offline verifier must still find it there.
  const openVotes = await query<{ repo: string; rkey: string; record: Record<string, unknown> }>(
    `SELECT v.community_did AS repo, v.rkey, v.record
     FROM records_index v
     JOIN records_index p
       ON p.community_did = $1 AND p.collection = $3 AND p.rkey = v.record->>'proposalRkey'
     WHERE v.collection = $2 AND v.record->>'community' = $1 AND v.community_did <> $1
       AND p.record->>'status' = 'open'`,
    [communityDid, VOTE_COLLECTION, PROPOSAL_COLLECTION],
  );
  // Objections are raised against a decision, never cited by one, and the
  // objection count finds them in either place, so all of them move.
  const objections = await query<{ repo: string; rkey: string; record: Record<string, unknown> }>(
    `SELECT community_did AS repo, rkey, record FROM records_index
     WHERE collection = $2 AND record->>'community' = $1 AND community_did <> $1`,
    [communityDid, OBJECTION_COLLECTION],
  );
  for (const [rows, collection] of [[openVotes.rows, VOTE_COLLECTION], [objections.rows, OBJECTION_COLLECTION]] as const) {
    for (const row of rows) {
      await writeMemberContent({
        communityDid, authorDid: row.repo, collection, record: row.record, rkey: row.rkey, private: true,
      });
      await deleteMemberContent(`at://${row.repo}/${collection}/${row.rkey}`);
      if (collection === VOTE_COLLECTION) counts.votes++; else counts.objections++;
    }
  }

  return counts;
}

/**
 * After anything writes a community's settings: if the community is now
 * private, make sure what its members wrote is in its repository and not in
 * their public ones. Settings change through `community.update`, the generic
 * record endpoints and the application of an approved proposal; every one
 * of those calls this, so a community made private by a vote is treated the
 * same as one made private by its owner.
 *
 * Idempotent: only records still outside the community's repository move.
 * Never throws. The settings change has already been committed; a failure
 * here is logged, and the next settings write (or a call to
 * `community.update`) moves whatever is left.
 */
export async function placeMemberContentForVisibility(communityDid: string): Promise<void> {
  try {
    if (!(await isPrivateCommunity(communityDid))) return;
    const moved = await relocateMemberContent(communityDid);
    const total = moved.threads + moved.posts + moved.rsvps + moved.votes + moved.objections;
    if (total > 0) {
      console.log(`community ${communityDid} is private: moved ${total} member record(s) into its repository`, moved);
    }
  } catch (err) {
    console.error(`community ${communityDid}: could not move member content into its repository:`, err);
  }
}
