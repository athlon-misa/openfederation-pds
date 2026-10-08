import { describe, it, expect } from 'vitest';
import { verifySignature } from '@atproto/crypto';
import { xrpcAuthPost, createTestUser, uniqueHandle, isPLCAvailable } from './helpers.js';
import { insertPseudonymUser } from './pseudonym-helpers.js';
import { issueSessionForTests } from './pseudonym-session-for-tests.js';
import { query } from '../../src/db/client.js';
import { buildLinkStatement, base64UrlDecode } from '../../packages/openfederation-pseudonym/src/formats.js';

describe('net.openfederation.pseudonym.signLink', () => {
  it('signs only statements naming the caller, and leaves no audit trace', async () => {
    if (!(await isPLCAvailable())) return;
    const ana = await createTestUser(uniqueHandle('ana'));
    const before = (await query('SELECT COUNT(*)::int AS n FROM audit_log')).rows[0].n;
    const statement = buildLinkStatement({ pseudonymDid: 'did:plc:nightdesknightdesknightd', ownerDid: ana.did, issuedAt: new Date().toISOString() });
    const res = await xrpcAuthPost('net.openfederation.pseudonym.signLink', ana.accessJwt, { statement });
    expect(res.status).toBe(200);
    expect(await verifySignature(res.body.signingKey, new TextEncoder().encode(statement), base64UrlDecode(res.body.sig))).toBe(true);
    expect((await query('SELECT COUNT(*)::int AS n FROM audit_log')).rows[0].n).toBe(before);

    const notMine = buildLinkStatement({ pseudonymDid: 'did:plc:nightdesknightdesknightd', ownerDid: 'did:plc:someoneelsesomeoneelseso', issuedAt: new Date().toISOString() });
    expect((await xrpcAuthPost('net.openfederation.pseudonym.signLink', ana.accessJwt, { statement: notMine })).status).toBe(403);
    expect((await xrpcAuthPost('net.openfederation.pseudonym.signLink', ana.accessJwt, { statement: 'sign me' })).status).toBe(400);
  });

  it('a pseudonym cannot act as an owner', async () => {
    const p = await insertPseudonymUser();
    const { accessJwt } = await issueSessionForTests(p);
    const statement = buildLinkStatement({ pseudonymDid: 'did:plc:nightdesknightdesknightd', ownerDid: p.did, issuedAt: new Date().toISOString() });
    expect((await xrpcAuthPost('net.openfederation.pseudonym.signLink', accessJwt, { statement })).status).toBe(403);
  });
});
