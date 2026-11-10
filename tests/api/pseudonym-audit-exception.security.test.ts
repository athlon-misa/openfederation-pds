/**
 * "No audit trail for pseudonyms" has to hold wherever a pseudonym's DID could
 * be written down with a timestamp, and must not become a way to hand a
 * pseudonym privileges without any record.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes, randomUUID } from 'crypto';
import { xrpcAuthPost, getAdminToken } from './helpers.js';
import { query } from '../../src/db/client.js';
import { auditLog } from '../../src/db/audit.js';
import { logVaultAudit } from '../../src/vault/vault-store.js';

async function pseudonymRow(): Promise<{ id: string; did: string }> {
  const id = randomUUID();
  const did = `did:plc:${randomBytes(12).toString('hex')}`;
  await query(
    `INSERT INTO users (id, handle, email, password_hash, status, did, auth_type)
     VALUES ($1, $2, NULL, NULL, 'approved', $3, 'pseudonym')`,
    [id, `pseud-${id.slice(0, 8)}`, did],
  );
  return { id, did };
}

describe('pseudonym audit exception', () => {
  let adminToken: string;
  beforeAll(async () => { adminToken = await getAdminToken(); });

  it('does not record a pseudonym DID that appears in an entry\'s metadata', async () => {
    const pseudonym = await pseudonymRow();
    const marker = `did:plc:community${randomBytes(6).toString('hex')}`;
    // The shape community.removeMember / updateMember / setDelegation write.
    await auditLog('community.removeMember', null, marker, { memberDid: pseudonym.did });
    const rows = await query('SELECT 1 FROM audit_log WHERE target_id = $1', [marker]);
    expect(rows.rows.length).toBe(0);
  });

  it('still records entries whose metadata names ordinary accounts', async () => {
    const marker = `did:plc:community${randomBytes(6).toString('hex')}`;
    await auditLog('community.removeMember', null, marker, { memberDid: 'did:plc:someordinaryaccount' });
    const rows = await query('SELECT 1 FROM audit_log WHERE target_id = $1', [marker]);
    expect(rows.rows.length).toBe(1);
  });

  it('writes no vault audit row for a pseudonym', async () => {
    const pseudonym = await pseudonymRow();
    await logVaultAudit(pseudonym.did, 'custody_accessed', pseudonym.did, undefined, { chain: 'ethereum' });
    const rows = await query('SELECT 1 FROM vault_audit_log WHERE user_did = $1 OR actor_did = $1', [pseudonym.did]);
    expect(rows.rows.length).toBe(0);
  });

  it('still writes vault audit rows for ordinary accounts', async () => {
    const did = `did:plc:ordinary${randomBytes(6).toString('hex')}`;
    await logVaultAudit(did, 'custody_accessed', did);
    const rows = await query('SELECT 1 FROM vault_audit_log WHERE user_did = $1', [did]);
    expect(rows.rows.length).toBe(1);
  });

  it('refuses to grant instance roles to a pseudonym, since the grant could not be recorded', async () => {
    const pseudonym = await pseudonymRow();
    const res = await xrpcAuthPost('net.openfederation.account.updateRoles', adminToken, {
      did: pseudonym.did, addRoles: ['admin'],
    });
    expect(res.status).toBe(400);
    const roles = await query('SELECT 1 FROM user_roles WHERE user_id = $1', [pseudonym.id]);
    expect(roles.rows.length).toBe(0);
  });
});
