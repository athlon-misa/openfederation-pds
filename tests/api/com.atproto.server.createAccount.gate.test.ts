/**
 * The gate for accounts moving in (#265). A refusal happens at
 * createAccount, before anything has changed anywhere, so the account
 * keeps working where it was.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { xrpcGet, isPLCAvailable, createTestUser, uniqueHandle, testServer } from './helpers.js';
import { runtimeSettings } from '../../src/settings/runtime-settings.js';
import { query } from '../../src/db/client.js';
import { fetchTokenKeys, collectTokens } from '../../packages/openfederation-pseudonym/src/index.js';
import { pseudonymElsewhere, createAccount, proofFor, newHandle } from './migration-helpers.js';

const original = { ...runtimeSettings().migration };

describe('migration gate (createAccount)', () => {
  let plc = false;
  let pdsUrl: string;
  beforeAll(async () => {
    plc = await isPLCAvailable();
    pdsUrl = `http://127.0.0.1:${(testServer.address() as AddressInfo).port}`;
  });
  afterEach(() => { Object.assign(runtimeSettings().migration, original); });

  it('is published in getPublicConfig', async () => {
    runtimeSettings().migration.pseudonyms = 'token';
    runtimeSettings().migration.accounts = 'closed';
    const res = await xrpcGet('net.openfederation.server.getPublicConfig');
    expect(res.status).toBe(200);
    expect(res.body.migration).toEqual({ accounts: 'closed', pseudonyms: 'token', communities: runtimeSettings().migration.communities });
  });

  it('closed: refuses before anything is stored', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    runtimeSettings().migration.pseudonyms = 'closed';
    const p = await pseudonymElsewhere();
    const res = await createAccount({ did: p.did, handle: newHandle() }, proofFor(p));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('MigrationNotAllowed');
    expect((await query('SELECT 1 FROM users WHERE did = $1', [p.did])).rows).toHaveLength(0);
    expect((await query('SELECT 1 FROM repo_roots WHERE did = $1', [p.did])).rows).toHaveLength(0);
  });

  it('token: asks for a blind creation token and spends it once', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    runtimeSettings().migration.pseudonyms = 'token';
    const p = await pseudonymElsewhere();
    const without = await createAccount({ did: p.did, handle: newHandle() }, proofFor(p));
    expect(without.status).toBe(400);
    expect(without.body.error).toBe('InvalidToken');

    const owner = await createTestUser(uniqueHandle('gate-owner'));
    const keys = await fetchTokenKeys(pdsUrl);
    const [token] = await collectTokens({ pdsUrl, accessJwt: owner.accessJwt, keys, count: runtimeSettings().pseudonym.tokensPerEpoch });
    const forged = { ...token, signature: token.signature.replace(/[A-Za-z]/, (c) => (c === 'A' ? 'B' : 'A')) };
    const bad = await createAccount({ did: p.did, handle: newHandle(), token: forged }, proofFor(p));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('InvalidToken');

    const ok = await createAccount({ did: p.did, handle: newHandle(), token }, proofFor(p));
    expect(ok.status).toBe(200);

    const other = await pseudonymElsewhere();
    const spent = await createAccount({ did: other.did, handle: newHandle(), token }, proofFor(other));
    expect(spent.status).toBe(400);
    expect(spent.body.error).toBe('TokenSpent');
    expect((await query('SELECT 1 FROM users WHERE did = $1', [other.did])).rows).toHaveLength(0);
  });

  it('token: a pseudonym moving back to the copy it left here is not asked for one', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    runtimeSettings().migration.pseudonyms = 'open';
    const p = await pseudonymElsewhere();
    expect((await createAccount({ did: p.did, handle: newHandle() }, proofFor(p))).status).toBe(200);
    // The policy changed since; the copy is still here, so the mover signs in to it (moveAccount does, on AlreadyExists).
    runtimeSettings().migration.pseudonyms = 'token';
    const again = await createAccount({ did: p.did, handle: newHandle() }, proofFor(p));
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('AlreadyExists');
  });

  it('open: a token is not needed and is ignored when sent', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    runtimeSettings().migration.pseudonyms = 'open';
    const p = await pseudonymElsewhere();
    const res = await createAccount({ did: p.did, handle: newHandle(), token: { epoch: 'x', prepared: 'y', signature: 'z' } }, proofFor(p));
    expect(res.status).toBe(200);
  });

  it('never asks a pseudonym for an invite code', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    runtimeSettings().migration.accounts = 'closed';
    runtimeSettings().migration.pseudonyms = 'open';
    const p = await pseudonymElsewhere();
    const res = await createAccount({ did: p.did, handle: newHandle(), inviteCode: 'ABCD-EFGH' }, proofFor(p));
    // The user policy does not apply to pseudonyms, and the code is not part of the contract.
    expect([200, 400]).toContain(res.status);
    if (res.status === 400) expect(res.body.error).toBe('InvalidRequest');
  });
});
