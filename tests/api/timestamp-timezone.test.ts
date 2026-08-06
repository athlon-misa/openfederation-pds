/**
 * Expiries mean the same instant on every clock (#221).
 *
 * `timestamp WITHOUT time zone` columns were being written from two sources
 * that disagreed about which clock they meant: Postgres defaults and
 * comparisons (`CURRENT_TIMESTAMP`, `NOW()`) produce local wall-clock time,
 * while the application passes a JS `Date` that the driver serialises as UTC.
 * Where the application wrote and Postgres compared — `viewing_grants` — a
 * credential's real lifetime became `TTL − UTC offset`: born expired east of
 * UTC, and still redeemable hours past its stated expiry west of it.
 *
 * Testing this needs care, because the bug is invisible on a UTC server and CI
 * may well be one. So the behavioural assertions read the same row from
 * sessions pinned to two different timezones: a `timestamptz` is the same
 * instant in both, and a naive column is not. That holds whatever the server's
 * own zone is, which is the property that makes the test worth having.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcAuthPost,
  createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { getClient, query } from '../../src/db/client.js';

type User = { accessJwt: string; did: string; handle: string };

/** Seconds until `expires_at`, as computed by a session pinned to `zone`. */
async function ttlSecondsIn(zone: string, grantId: string): Promise<number> {
  const client = await getClient();
  try {
    await client.query(`SET TIME ZONE '${zone}'`);
    const res = await client.query<{ seconds: string }>(
      `SELECT EXTRACT(EPOCH FROM (expires_at - NOW()))::text AS seconds
       FROM viewing_grants WHERE id = $1`,
      [grantId],
    );
    return Number(res.rows[0].seconds);
  } finally {
    // The connection goes back to a shared pool; a leaked SET would follow it.
    await client.query('SET TIME ZONE DEFAULT');
    client.release();
  }
}

describe('expiries are timezone-independent (#221)', () => {
  let plcAvailable: boolean;
  let owner: User;
  let subject: User;
  let viewer: User;
  let communityDid: string;
  let rkey: string;
  let grantId: string;

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;

    owner = await createTestUser(uniqueHandle('tz-owner'));
    subject = await createTestUser(uniqueHandle('tz-subject'));
    viewer = await createTestUser(uniqueHandle('tz-viewer'));

    const created = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('tz-comm'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    expect(created.status).toBe(201);
    communityDid = created.body.did;

    await xrpcAuthPost('net.openfederation.community.join', subject.accessJwt, { did: communityDid });
    await xrpcAuthPost('net.openfederation.community.join', viewer.accessJwt, { did: communityDid });

    const attestation = await xrpcAuthPost('net.openfederation.community.issueAttestation', owner.accessJwt, {
      communityDid,
      subjectDid: subject.did,
      subjectHandle: subject.handle,
      type: 'credential',
      claim: { certification: 'Level 5' },
      visibility: 'private',
      accessPolicy: { type: 'community-member', communityDid },
    });
    expect(attestation.status).toBe(200);
    rkey = attestation.body.rkey;

    const grant = await xrpcAuthPost('net.openfederation.attestation.createViewingGrant', subject.accessJwt, {
      communityDid, rkey, grantedToDid: viewer.did, expiresInMinutes: 60,
    });
    expect(grant.status).toBe(200);
    grantId = grant.body.grantId;
  });

  it('issues a grant whose lifetime is the TTL it was asked for', async () => {
    if (!plcAvailable) return;
    // The failure this replaces: a 60-minute grant arriving with a lifetime of
    // minus two hours, because `expires_at` was UTC and `created_at` was local.
    const ttl = await ttlSecondsIn('UTC', grantId);
    expect(ttl).toBeGreaterThan(59 * 60);
    expect(ttl).toBeLessThanOrEqual(60 * 60);
  });

  it('reads the same remaining lifetime from any timezone', async () => {
    if (!plcAvailable) return;
    // The load-bearing assertion, and the one that does not depend on the
    // server's own zone: a naive column read from sessions 8 hours apart
    // reports lifetimes 8 hours apart. A timestamptz reports one instant.
    const [utc, east, west] = await Promise.all([
      ttlSecondsIn('UTC', grantId),
      ttlSecondsIn('Asia/Tokyo', grantId),
      ttlSecondsIn('America/Los_Angeles', grantId),
    ]);

    expect(Math.abs(east - utc)).toBeLessThan(60);
    expect(Math.abs(west - utc)).toBeLessThan(60);
  });

  it('holds for the grant the redeeming path actually reads', async () => {
    if (!plcAvailable) return;
    // `expired` is computed in SQL against NOW(); this is the comparison that
    // decided whether a grant was still redeemable.
    const res = await query<{ expired: boolean }>(
      `SELECT (expires_at < NOW()) AS expired FROM viewing_grants WHERE id = $1`,
      [grantId],
    );
    expect(res.rows[0].expired).toBe(false);

    const redeemed = await xrpcAuthPost('net.openfederation.disclosure.redeemGrant', viewer.accessJwt, {
      grantId,
    });
    expect(redeemed.status).toBe(200);
  });

  it('leaves no naive timestamp columns behind', async () => {
    // The class, not the instance. Every column is on one clock now, so no
    // future writer has to know which of the two conventions a column is on —
    // which is what let this happen.
    const res = await query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND data_type = 'timestamp without time zone'
       ORDER BY table_name, column_name`,
    );
    const naive = res.rows.map(r => `${r.table_name}.${r.column_name}`);
    expect(naive).toEqual([]);
  });
});
