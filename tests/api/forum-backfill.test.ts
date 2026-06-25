import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, isPLCAvailable, uniqueHandle, xrpcAuthPost, xrpcGet } from './helpers.js';
import { query } from '../../src/db/client.js';
import { backfillForumIndex } from '../../scripts/backfill-forum-index.js';

describe('forum backfill', () => {
  let plc: boolean;
  beforeAll(async () => { plc = await isPLCAvailable(); });

  it('rebuilds the index from records_index after the index is cleared', async () => {
    if (!plc) return;
    const owner = await createTestUser(uniqueHandle('bf-owner'));
    const create = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('bf-comm'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    const communityDid = create.body.did;
    const thread = await xrpcAuthPost('net.openfederation.forum.createThread', owner.accessJwt, { community: communityDid, title: 'bf' });
    await xrpcAuthPost('net.openfederation.forum.createPost', owner.accessJwt, {
      community: communityDid, root: { uri: thread.body.uri, cid: thread.body.cid }, text: 'x',
    });

    // Simulate index loss
    await query('DELETE FROM forum_posts WHERE thread_root_uri = $1', [thread.body.uri]);
    await query('DELETE FROM forum_threads WHERE uri = $1', [thread.body.uri]);

    await backfillForumIndex();

    const view = await xrpcGet('net.openfederation.forum.getThread', { uri: thread.body.uri });
    expect(view.status).toBe(200);
    expect(view.body.posts).toHaveLength(1);
  });
});
