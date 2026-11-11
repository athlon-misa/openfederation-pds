/**
 * The vault, validated end to end (#77).
 *
 * Registration splits the user's PLC rotation key 2-of-3 with Shamir. This
 * walks what the code actually does with the shares: where they are stored
 * and how, that two of them rebuild the very key the PLC directory lists for
 * the DID, the identity-verified release and export of share 2, escrow
 * registration, the security level each step reports, and the vault audit
 * trail.
 *
 * Custody is honest (#239): every tier is custodial — this PDS holds shares 2
 * and 3, a quorum — and says so. "Export" hands the user the rotation key
 * itself (a working backup: with it they can sign PLC operations and leave),
 * not a share that needs a device share nobody has. Escrow records a
 * provider while the share stays here, and the API says that too. Real
 * self-custody, where the PDS holds no rotation key, is the separate `self`
 * custody mode.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Secp256k1Keypair } from '@atproto/crypto';
import {
  xrpcPost, xrpcAuthPost, xrpcAuthGet, getAdminToken, createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { query } from '../../src/db/client.js';
import { getShare } from '../../src/vault/vault-store.js';
import { combineShares } from '../../src/vault/shamir.js';
import { decryptKeyBytes } from '../../src/auth/encryption.js';
import { setEmailSenderForTests } from '../../src/email/email-service.js';
import { config } from '../../src/config.js';
import { rotateKeyEncryption } from '../../src/crypto/rotate-key-encryption.js';

type User = { accessJwt: string; did: string; handle: string };

const PLC_URL = process.env.PLC_DIRECTORY_URL || 'http://localhost:2582';
const inbox: Array<{ to: string; subject: string; html: string }> = [];

function verificationCode(email: string): string {
  const mail = [...inbox].reverse().find((m) => m.to === email && m.subject.includes('Identity Verification'));
  const code = mail?.html.match(/letter-spacing: 2px;">([0-9a-f]{64})</)?.[1];
  if (!code) throw new Error(`no verification code captured for ${email}`);
  return code;
}

async function plcRotationKeys(did: string): Promise<string[]> {
  const res = await fetch(`${PLC_URL}/${did}/data`);
  expect(res.ok).toBe(true);
  return (await res.json()).rotationKeys;
}

async function didKeyOf(privateKey: Buffer): Promise<string> {
  return (await Secp256k1Keypair.import(privateKey)).did();
}

async function shareRows(did: string) {
  return (await query<{
    share_index: number; share_holder: string; escrow_provider_did: string | null;
    recovery_tier: number; encrypted_share: Buffer;
  }>(
    `SELECT share_index, share_holder, escrow_provider_did, recovery_tier, encrypted_share
     FROM vault_shares WHERE user_did = $1 ORDER BY share_index`, [did],
  )).rows;
}

async function vaultActions(did: string) {
  return (await query<{ action: string; actor_did: string | null; share_index: number | null; metadata: any }>(
    'SELECT action, actor_did, share_index, metadata FROM vault_audit_log WHERE user_did = $1 ORDER BY created_at, action',
    [did],
  )).rows;
}

describe('vault & recovery end to end (#77)', () => {
  let plc: boolean;
  let adminToken: string;
  let user: User;
  let email: string;

  async function verifyIdentity(u: User, mail: string) {
    const created = await xrpcAuthPost('net.openfederation.admin.createVerificationChallenge', adminToken, { did: u.did });
    expect(created.status).toBe(200);
    const verified = await xrpcAuthPost('net.openfederation.admin.verifyChallenge', adminToken, {
      did: u.did, nonce: verificationCode(mail),
    });
    expect(verified.status).toBe(200);
    expect(verified.body.verified).toBe(true);
  }

  beforeAll(async () => {
    plc = await isPLCAvailable();
    if (!plc) return;
    setEmailSenderForTests(async (to, subject, html) => { inbox.push({ to, subject, html }); });
    adminToken = await getAdminToken();
    const handle = uniqueHandle('vx-user');
    user = await createTestUser(handle);
    email = `${handle}@test.local`;
  });
  afterAll(() => setEmailSenderForTests(null));

  describe('split and storage', () => {
    it('stores shares 2 and 3 for the DID, both held by the vault at tier 1', async () => {
      if (!plc) return;
      const rows = await shareRows(user.did);
      expect(rows.map((r) => [r.share_index, r.share_holder, r.recovery_tier])).toEqual([
        [2, 'vault', 1],
        [3, 'vault', 1],
      ]);
    });

    it('stores each share encrypted at rest, bound to the vault.share purpose', async () => {
      if (!plc) return;
      for (const row of await shareRows(user.did)) {
        const plain = await getShare(user.did, row.share_index);
        expect(plain).toMatch(/^[0-9a-f]+$/);
        expect(row.encrypted_share.toString('utf-8')).not.toContain(plain);
        expect(row.encrypted_share.toString('hex')).not.toContain(plain);
        // Decrypts only under its own purpose.
        expect((await decryptKeyBytes(row.encrypted_share, 'vault.share')).toString('utf-8')).toBe(plain);
        await expect(decryptKeyBytes(row.encrypted_share, 'identity.signing-key')).rejects.toThrow();
      }
    });

    it('audits the split', async () => {
      if (!plc) return;
      const created = (await vaultActions(user.did)).filter((a) => a.action === 'shares.created');
      expect(created).toHaveLength(1);
      expect(created[0].actor_did).toBe(user.did);
      expect(created[0].metadata).toEqual({ numShares: 3, threshold: 2, holders: { 2: 'vault', 3: 'vault' } });
    });
  });

  describe('recovery from shares', () => {
    it('shares 2 + 3 rebuild the rotation key the PLC directory lists for this DID', async () => {
      if (!plc) return;
      const s2 = (await getShare(user.did, 2))!;
      const s3 = (await getShare(user.did, 3))!;
      const key = combineShares([s2, s3]);
      expect(key).toHaveLength(32);
      expect(await plcRotationKeys(user.did)).toContain(await didKeyOf(key));
      // Order does not matter.
      expect(combineShares([s3, s2]).equals(key)).toBe(true);
    });

    it('one share alone does not', async () => {
      if (!plc) return;
      const rotationKeys = await plcRotationKeys(user.did);
      const s2 = (await getShare(user.did, 2))!;
      let rebuilt: string | null = null;
      try { rebuilt = await didKeyOf(combineShares([s2])); } catch { /* not a valid key: also fine */ }
      expect(rebuilt === null || !rotationKeys.includes(rebuilt)).toBe(true);
    });

    it('the rotation key itself is stored nowhere in the clear', async () => {
      if (!plc) return;
      const key = combineShares([(await getShare(user.did, 2))!, (await getShare(user.did, 3))!]);
      // Neither the raw bytes nor their base64 text appear in any stored key column for this DID.
      const needles = [`%${key.toString('hex')}%`, `%${Buffer.from(key.toString('base64')).toString('hex')}%`];
      const hits = await query(
        `SELECT 1 FROM vault_shares WHERE user_did = $1 AND (encode(encrypted_share, 'hex') LIKE ANY($2))
         UNION ALL SELECT 1 FROM user_signing_keys WHERE user_did = $1 AND (encode(signing_key_bytes, 'hex') LIKE ANY($2))`,
        [user.did, needles],
      );
      expect(hits.rows).toHaveLength(0);
    });
  });

  describe('survives a KEY_ENCRYPTION_SECRET rotation', () => {
    it('shares re-encrypted under a new secret still rebuild the rotation key, and the old secret no longer opens them', async () => {
      if (!plc) return;
      const original = { current: config.keyEncryptionSecret, previous: config.keyEncryptionSecretPrevious };
      const NEXT = 'vault-validation-next-secret-0123456789abcdef';
      const ids = (await query<{ id: string }>('SELECT id FROM vault_shares WHERE user_did = $1', [user.did])).rows.map((r) => r.id);
      const only = { vault_shares: ids };
      const before = (await shareRows(user.did)).map((r) => r.encrypted_share.toString('hex'));
      try {
        config.keyEncryptionSecret = NEXT;
        config.keyEncryptionSecretPrevious = original.current;
        const rotated = await rotateKeyEncryption({ apply: true, only });
        expect(rotated.rotated).toBe(2);
        expect(rotated.failed).toEqual([]);

        // Only the new secret now: no fallback to the old one.
        config.keyEncryptionSecretPrevious = '';
        const after = (await shareRows(user.did)).map((r) => r.encrypted_share.toString('hex'));
        expect(after).not.toEqual(before);
        const key = combineShares([(await getShare(user.did, 2))!, (await getShare(user.did, 3))!]);
        expect(await plcRotationKeys(user.did)).toContain(await didKeyOf(key));

        config.keyEncryptionSecret = original.current;
        await expect(getShare(user.did, 2)).rejects.toThrow();
      } finally {
        // Put the shares back under the suite's secret.
        config.keyEncryptionSecret = original.current;
        config.keyEncryptionSecretPrevious = NEXT;
        await rotateKeyEncryption({ apply: true, only });
        config.keyEncryptionSecretPrevious = original.previous;
      }
      expect(await getShare(user.did, 2)).toMatch(/^[0-9a-f]+$/);
    });
  });

  describe('identity-verified release (tier 1, email code)', () => {
    it('refuses to release share 2 without a recent verification', async () => {
      if (!plc) return;
      const res = await xrpcAuthPost('net.openfederation.vault.requestShareRelease', user.accessJwt, {});
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('VerificationRequired');
    });

    it('after the emailed code is verified, releases share 2 exactly, and audits it', async () => {
      if (!plc) return;
      await verifyIdentity(user, email);
      const res = await xrpcAuthPost('net.openfederation.vault.requestShareRelease', user.accessJwt, {});
      expect(res.status).toBe(200);
      expect(res.body.share).toBe(await getShare(user.did, 2));

      const released = (await vaultActions(user.did)).filter((a) => a.action === 'share.released');
      expect(released).toHaveLength(1);
      expect(released[0]).toMatchObject({ actor_did: user.did, share_index: 2 });
    });

    it('a verification of one user does not release another user\'s share', async () => {
      if (!plc) return;
      const other = await createTestUser(uniqueHandle('vx-other'));
      const res = await xrpcAuthPost('net.openfederation.vault.requestShareRelease', other.accessJwt, {});
      expect(res.status).toBe(403);
    });
  });

  describe('security level and escrow', () => {
    it('getSecurityLevel reports tier 1 "custodial": the PDS holds the rotation key', async () => {
      if (!plc) return;
      const res = await xrpcAuthGet('net.openfederation.account.getSecurityLevel', user.accessJwt);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        recoveryTier: 1, tierName: 'custodial', pdsHoldsRotationKey: true,
        checklist: { vaultShares: true, escrowRegistered: false, keyExported: false },
      });
    });

    it('registerEscrow records the provider for share 3, reaches tier 2 "escrow-recorded", and says the share stays here', async () => {
      if (!plc) return;
      const providerDid = `did:web:escrow-${Date.now()}.example.test`;
      const res = await xrpcAuthPost('net.openfederation.vault.registerEscrow', user.accessJwt, {
        escrowProviderDid: providerDid, escrowProviderName: 'Validation Escrow',
        verificationUrl: 'https://escrow.example.test/verify',
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, recoveryTier: 2, escrowProviderDid: providerDid, shareStoredHere: true });

      const provider = await query<{ name: string; verification_url: string; registered_by: string }>(
        'SELECT name, verification_url, registered_by FROM escrow_providers WHERE did = $1', [providerDid],
      );
      expect(provider.rows).toEqual([{
        name: 'Validation Escrow', verification_url: 'https://escrow.example.test/verify', registered_by: user.did,
      }]);

      const rows = await shareRows(user.did);
      expect(rows.map((r) => [r.share_index, r.share_holder, r.escrow_provider_did, r.recovery_tier])).toEqual([
        [2, 'vault', null, 2],
        [3, 'escrow', providerDid, 2],
      ]);

      const level = await xrpcAuthGet('net.openfederation.account.getSecurityLevel', user.accessJwt);
      expect(level.body).toMatchObject({ recoveryTier: 2, tierName: 'escrow-recorded', pdsHoldsRotationKey: true, checklist: { escrowRegistered: true } });

      const audit = (await vaultActions(user.did)).filter((a) => a.action === 'escrow.registered');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_did: user.did, share_index: 3 });
      expect(audit[0].metadata).toEqual({
        escrowProviderDid: providerDid, escrowProviderName: 'Validation Escrow', previousHolder: 'vault',
      });
    });

    it('exportRecoveryKey hands over the rotation key itself (the one PLC lists), and audits it', async () => {
      if (!plc) return;
      // The verification from the release above is still within its 30 minutes.
      const res = await xrpcAuthPost('net.openfederation.vault.exportRecoveryKey', user.accessJwt, {});
      expect(res.status).toBe(200);
      expect(res.body.share).toBeUndefined();
      expect(await plcRotationKeys(user.did)).toContain(await didKeyOf(Buffer.from(res.body.rotationKey, 'base64')));
      expect(res.body).toMatchObject({ recoveryTier: 3, pdsHoldsRotationKey: true });

      const rows = await shareRows(user.did);
      expect(rows.every((r) => r.recovery_tier === 3)).toBe(true);
      const account = await query<{ recovery_tier: number }>('SELECT recovery_tier FROM users WHERE did = $1', [user.did]);
      expect(account.rows[0].recovery_tier).toBe(3);
      const level = await xrpcAuthGet('net.openfederation.account.getSecurityLevel', user.accessJwt);
      expect(level.body).toMatchObject({ recoveryTier: 3, tierName: 'key-exported', pdsHoldsRotationKey: true, checklist: { keyExported: true } });

      const audit = (await vaultActions(user.did)).filter((a) => a.action === 'key.exported');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_did: user.did, metadata: { newRecoveryTier: 3, exported: 'rotation-key' } });
    });

    it('the vault audit log, through its endpoint, holds every operation in order', async () => {
      if (!plc) return;
      const res = await xrpcAuthGet('net.openfederation.vault.auditLog', user.accessJwt);
      expect(res.status).toBe(200);
      const actions = res.body.entries.map((e: any) => e.action).reverse();
      expect(actions).toEqual(['shares.created', 'share.released', 'escrow.registered', 'key.exported']);
      for (const e of res.body.entries) expect(e.userDid).toBe(user.did);
    });
  });

  describe('custody, honestly (#239)', () => {
    it('registration keeps shares 2 and 3 here and no longer claims a device share', async () => {
      if (!plc) return;
      const invite = await xrpcAuthPost('net.openfederation.invite.create', adminToken, { maxUses: 1 });
      const handle = uniqueHandle('vx-reg');
      const reg = await xrpcPost('net.openfederation.account.register', {
        handle, email: `${handle}@test.local`, password: 'TestPassword123!', inviteCode: invite.body.code,
      });
      expect([200, 201]).toContain(reg.status);
      const did = reg.body.did as string;
      expect(JSON.stringify(reg.body)).not.toMatch(/deviceShare|share/i);
      expect((await shareRows(did)).map((r) => r.share_index)).toEqual([2, 3]);
      const created = (await vaultActions(did)).find((a) => a.action === 'shares.created');
      expect(created?.metadata.holders).toEqual({ 2: 'vault', 3: 'vault' });
    });

    it('the PDS still holds a rebuilding quorum after escrow and export, and the API says so', async () => {
      if (!plc) return;
      const key = combineShares([(await getShare(user.did, 2))!, (await getShare(user.did, 3))!]);
      expect(await plcRotationKeys(user.did)).toContain(await didKeyOf(key));
      const level = await xrpcAuthGet('net.openfederation.account.getSecurityLevel', user.accessJwt);
      expect(level.body.pdsHoldsRotationKey).toBe(true);
      expect(JSON.stringify(level.body)).not.toMatch(/self-custod/i);
    });

    it('one verification allows one export', async () => {
      if (!plc) return;
      const exportAgain = await xrpcAuthPost('net.openfederation.vault.exportRecoveryKey', user.accessJwt, {});
      expect(exportAgain.status).toBe(403);
      expect(exportAgain.body.error).toBe('VerificationRequired');
    });
  });
});
