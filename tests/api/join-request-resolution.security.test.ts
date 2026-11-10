/** A join request is resolved once, and never left half-resolved. */
import { describe, it, expect, beforeAll } from 'vitest';
import { xrpcAuthPost, createTestUser, isPLCAvailable, uniqueHandle } from './helpers.js';
import { query } from '../../src/db/client.js';

type User = { accessJwt: string; did: string; handle: string };

describe('join request resolution', () => {
  let plc: boolean;
  let owner: User;
  let communityDid: string;

  beforeAll(async () => {
    plc = await isPLCAvailable();
    if (!plc) return;
    owner = await createTestUser(uniqueHandle('jr-owner'));
    const created = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('jr'), didMethod: 'plc', visibility: 'public', joinPolicy: 'approval',
    });
    communityDid = created.body.did;
  });

  async function requestFrom(user: User): Promise<string> {
    const join = await xrpcAuthPost('net.openfederation.community.join', user.accessJwt, { did: communityDid });
    expect(join.body.status).toBe('pending');
    const row = await query<{ id: string }>(
      'SELECT id FROM join_requests WHERE community_did = $1 AND user_did = $2', [communityDid, user.did]);
    return row.rows[0].id;
  }
  const memberRecords = async (did: string) => Number((await query<{ c: string }>(
    `SELECT COUNT(*) AS c FROM records_index
     WHERE community_did = $1 AND collection = 'net.openfederation.community.member' AND record->>'did' = $2`,
    [communityDid, did])).rows[0].c);

  it('two approvals at the same moment make one member record', async () => {
    if (!plc) return;
    const applicant = await createTestUser(uniqueHandle('jr-app'));
    const requestId = await requestFrom(applicant);
    const results = await Promise.all([1, 2, 3].map(() =>
      xrpcAuthPost('net.openfederation.community.resolveJoinRequest', owner.accessJwt, { requestId, action: 'approve' })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await memberRecords(applicant.did)).toBe(1);
  });
});
