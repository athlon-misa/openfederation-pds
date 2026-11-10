import { query } from '../src/db/client.js';
import {
  indexThread, indexPost, indexRsvp,
  FORUM_THREAD, FORUM_POST, CALENDAR_RSVP,
} from '../src/forum/forum-index.js';

export async function backfillForumIndex(): Promise<{ threads: number; posts: number; rsvps: number }> {
  let threads = 0, posts = 0, rsvps = 0;

  // records_index.community_did holds the DID of the repository the record is
  // in. For a public community that is the author's own repo. For a private
  // community it is the community's repo, and the record names its `author`
  // (see src/forum/member-content.ts). The record's `community` field holds
  // the community DID either way.
  const threadRows = await query<{ community_did: string; rkey: string; cid: string; record: Record<string, unknown> }>(
    'SELECT community_did, rkey, cid, record FROM records_index WHERE collection = $1', [FORUM_THREAD]
  );
  for (const r of threadRows.rows) {
    const rec = r.record as { community: string; title: string; tags?: string[]; createdAt: string; author?: string };
    await indexThread({
      uri: `at://${r.community_did}/${FORUM_THREAD}/${r.rkey}`, cid: r.cid,
      communityDid: rec.community, authorDid: rec.author ?? r.community_did,
      title: rec.title, tags: rec.tags ?? [], createdAt: rec.createdAt,
    });
    threads++;
  }

  const postRows = await query<{ community_did: string; rkey: string; cid: string; record: Record<string, unknown> }>(
    'SELECT community_did, rkey, cid, record FROM records_index WHERE collection = $1 ORDER BY created_at ASC', [FORUM_POST]
  );
  for (const r of postRows.rows) {
    const rec = r.record as { community: string; root: { uri: string }; parent?: { uri: string }; createdAt: string; author?: string };
    await indexPost({
      uri: `at://${r.community_did}/${FORUM_POST}/${r.rkey}`, cid: r.cid,
      communityDid: rec.community, authorDid: rec.author ?? r.community_did,
      threadRootUri: rec.root.uri, parentUri: rec.parent ? rec.parent.uri : null,
      record: r.record, createdAt: rec.createdAt,
    });
    posts++;
  }

  // For CALENDAR_RSVP the attendee is the record's `author`, or the repo owner when there is none.
  // The event URI comes from rec.subject.uri.
  const rsvpRows = await query<{ community_did: string; rkey: string; record: Record<string, unknown> }>(
    'SELECT community_did, rkey, record FROM records_index WHERE collection = $1', [CALENDAR_RSVP]
  );
  for (const r of rsvpRows.rows) {
    const rec = r.record as { subject: { uri: string }; status: string; createdAt: string; author?: string };
    await indexRsvp({
      uri: `at://${r.community_did}/${CALENDAR_RSVP}/${r.rkey}`,
      eventUri: rec.subject.uri, attendeeDid: rec.author ?? r.community_did,
      status: rec.status, createdAt: rec.createdAt,
    });
    rsvps++;
  }

  return { threads, posts, rsvps };
}

// Allow running directly: `npx tsx scripts/backfill-forum-index.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  backfillForumIndex()
    .then((r) => { console.log('Backfill complete:', r); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
