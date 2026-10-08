import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { xrpcPost, xrpcAuthPost, xrpcAuthGet, getAdminToken } from './helpers.js';
import { insertPseudonymUser } from './pseudonym-helpers.js';
import { query } from '../../src/db/client.js';
import { auditLog } from '../../src/db/audit.js';
import { insertDisclosureAuditLog } from '../../src/attestation/lifecycle.js';
import { issueSessionForTests } from './pseudonym-session-for-tests.js';

describe('audit suppression', () => {
  it('drops entries whose actor or target is a pseudonym, by id or did', async () => {
    const p = await insertPseudonymUser();
    const marker = crypto.randomUUID();
    await auditLog('account.approve', p.id, null, { marker });
    await auditLog('account.approve', null, p.id, { marker });
    await auditLog('account.approve', null, p.did, { marker });
    await auditLog('account.approve', null, 'someone-else', { marker });
    const rows = await query(`SELECT target_id FROM audit_log WHERE meta->>'marker' = $1`, [marker]);
    expect(rows.rows).toEqual([{ target_id: 'someone-else' }]);
  });
});

describe('pseudonym-safe existing paths', () => {
  it('refreshSession keeps a pseudonym signed in (null email)', async () => {
    const p = await insertPseudonymUser();
    const { refreshJwt } = await issueSessionForTests(p);
    const res = await xrpcAuthPost('com.atproto.server.refreshSession', refreshJwt, {});
    expect(res.status).toBe(200);
    const who = await xrpcAuthGet('com.atproto.server.getSession', res.body.accessJwt);
    expect(who.status).toBe(200);
    expect(who.body.did).toBe(p.did);
  });

  it('password reset for a pseudonym handle behaves exactly like an unknown identifier', async () => {
    const p = await insertPseudonymUser();
    const a = await xrpcPost('net.openfederation.account.requestPasswordReset', { identifier: p.handle });
    const b = await xrpcPost('net.openfederation.account.requestPasswordReset', { identifier: 'nobody-here.example' });
    expect(a.status).toBe(b.status);
    expect(a.body).toEqual(b.body);
    const tokens = await query('SELECT 1 FROM password_reset_tokens WHERE user_id = $1', [p.id]);
    expect(tokens.rows).toHaveLength(0);
  });

  it('confirmEmail and admin verification challenge refuse pseudonyms without a 500', async () => {
    const p = await insertPseudonymUser();
    const { accessJwt } = await issueSessionForTests(p);
    const confirm = await xrpcAuthPost('com.atproto.server.confirmEmail', accessJwt, { email: 'x@example.com', token: 'abc' });
    expect(confirm.status).toBe(400);
    expect(confirm.body.error).toBe('NoEmail');
    const challenge = await xrpcAuthPost('net.openfederation.admin.createVerificationChallenge', await getAdminToken(), { did: p.did });
    expect(challenge.status).toBe(400);
    expect(challenge.body.error).toBe('NoEmail');
  });

  it('changePassword refuses a pseudonym', async () => {
    const p = await insertPseudonymUser();
    const { accessJwt } = await issueSessionForTests(p);
    const res = await xrpcAuthPost('net.openfederation.account.changePassword', accessJwt, { currentPassword: 'x', newPassword: 'Another-Password-123!' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('This account type cannot change password');
  });

  it('requestEmailConfirmation refuses a pseudonym without a 500', async () => {
    const p = await insertPseudonymUser();
    const { accessJwt } = await issueSessionForTests(p);
    const res = await xrpcAuthPost('com.atproto.server.requestEmailConfirmation', accessJwt, {});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NoEmail');
  });

  it('initiateRecovery never starts recovery for a pseudonym, even one holding an email', async () => {
    const p = await insertPseudonymUser();
    const email = `ps-${crypto.randomUUID()}@example.com`;
    await query('UPDATE users SET email = $1 WHERE id = $2', [email, p.id]);
    const a = await xrpcPost('net.openfederation.account.initiateRecovery', { handle: p.handle, email });
    const b = await xrpcPost('net.openfederation.account.initiateRecovery', { handle: 'nobody-here-xyz', email: 'nobody@example.com' });
    expect(a.status).toBe(b.status);
    expect(a.body).toEqual(b.body);
    const attempts = await query('SELECT 1 FROM recovery_attempts WHERE user_did = $1', [p.did]);
    expect(attempts.rows).toHaveLength(0);
  });
});

describe('disclosure audit IP suppression', () => {
  it('records no IP for a pseudonym requester, keeps it for a regular one', async () => {
    const p = await insertPseudonymUser();
    const regularDid = `did:plc:${crypto.randomBytes(12).toString('hex')}`;
    const base = { grantId: crypto.randomUUID(), communityDid: 'did:plc:community', rkey: 'r1', action: 'redeem' as const, ipAddress: '203.0.113.9', metadata: {} };
    await insertDisclosureAuditLog({ ...base, requesterDid: p.did });
    await insertDisclosureAuditLog({ ...base, requesterDid: regularDid });
    const ps = await query('SELECT ip_address FROM disclosure_audit_log WHERE requester_did = $1', [p.did]);
    const reg = await query('SELECT ip_address FROM disclosure_audit_log WHERE requester_did = $1', [regularDid]);
    expect(ps.rows).toEqual([{ ip_address: '' }]);
    expect(reg.rows).toEqual([{ ip_address: '203.0.113.9' }]);
  });
});
