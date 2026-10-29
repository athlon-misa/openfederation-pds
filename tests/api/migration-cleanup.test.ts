/**
 * Clean-up of unfinished incoming migrations (#265). Only a copy that never
 * activated here goes, and only after two sweeps found its DID elsewhere.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { xrpcAuthPost, createTestUser, uniqueHandle, isPLCAvailable } from './helpers.js';
import { query } from '../../src/db/client.js';
import { sweepUnfinishedMigrations } from '../../src/scheduler/migration-cleanup.js';
import { pseudonymElsewhere, openHere, pointHere } from './migration-helpers.js';

async function row(did: string) {
  return (await query<{ migrating_in: boolean; seen_elsewhere: boolean; status: string }>(
    'SELECT migrating_in, seen_elsewhere, status FROM users WHERE did = $1', [did])).rows[0];
}

describe('migration clean-up sweep', () => {
  let plc = false;
  beforeAll(async () => { plc = await isPLCAvailable(); });

  it('removes a never-activated copy whose DID points elsewhere, on the second sweep', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const p = await pseudonymElsewhere();
    await openHere(p);

    await sweepUnfinishedMigrations();
    expect(await row(p.did)).toMatchObject({ migrating_in: true, seen_elsewhere: true, status: 'deactivated' });

    await sweepUnfinishedMigrations();
    expect(await row(p.did)).toBeUndefined();
    expect((await query('SELECT 1 FROM user_signing_keys WHERE user_did = $1', [p.did])).rows).toHaveLength(0);
    expect((await query('SELECT 1 FROM repo_roots WHERE did = $1', [p.did])).rows).toHaveLength(0);
    expect((await query('SELECT 1 FROM repo_blocks WHERE community_did = $1', [p.did])).rows).toHaveLength(0);
  });

  it('forgets the flag once the DID points here, and never deletes while it does', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const p = await pseudonymElsewhere();
    const { accessJwt } = await openHere(p);
    await sweepUnfinishedMigrations();
    expect((await row(p.did)).seen_elsewhere).toBe(true);

    await pointHere(p, accessJwt);
    await sweepUnfinishedMigrations();
    expect(await row(p.did)).toMatchObject({ migrating_in: true, seen_elsewhere: false, status: 'deactivated' });
    await sweepUnfinishedMigrations();
    expect(await row(p.did)).toBeDefined();
  });

  it('leaves a deactivated local account alone', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const user = await createTestUser(uniqueHandle('sweep-local'));
    expect((await xrpcAuthPost('com.atproto.server.deactivateAccount', user.accessJwt, {})).status).toBe(200);
    await sweepUnfinishedMigrations();
    await sweepUnfinishedMigrations();
    expect(await row(user.did)).toMatchObject({ migrating_in: false, seen_elsewhere: false, status: 'deactivated' });
  });
});
