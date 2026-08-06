/**
 * Consent operations are bound to the browser Origin (issue #101).
 *
 * Two attacks, not one. The reported issue is the replay: declare another
 * dApp's origin and sign under the consent that dApp received. But
 * `grantConsent` took its origin from the body too, so an attacker holding a
 * user bearer token never needed an existing consent — they could mint one for
 * any origin and sign immediately. Guarding only the signing endpoints would
 * have moved the attack one step earlier instead of stopping it, so both paths
 * are covered here.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcAuthGet,
  xrpcAuthPost,
  xrpcAuthPostFromOrigin,
  xrpcPost,
  getAdminToken,
  isPLCAvailable,
  uniqueHandle,
} from './helpers.js';
import { query } from '../../src/db/client.js';

const VICTIM_APP = 'https://game.example.com';
const ATTACKER_APP = 'https://evil.example.com';

async function registerAndApproveUser(handle: string) {
  const adminToken = await getAdminToken();
  const invite = await xrpcAuthPost('net.openfederation.invite.create', adminToken, { maxUses: 1 });
  const reg = await xrpcPost('net.openfederation.account.register', {
    handle,
    email: `${handle}@test.local`,
    password: 'TestPassword123!',
    inviteCode: invite.body.code,
  });
  await xrpcAuthPost('net.openfederation.account.approve', adminToken, {
    userId: reg.body.id || reg.body.userId,
  });
  const login = await xrpcPost('com.atproto.server.createSession', {
    identifier: handle,
    password: 'TestPassword123!',
  });
  return { accessJwt: login.body.accessJwt as string, did: login.body.did as string };
}

describe('wallet consent origin binding (#101)', () => {
  let plcAvailable = false;
  let user: { accessJwt: string; did: string };
  let ethWallet: string;

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;
    user = await registerAndApproveUser(uniqueHandle('origin-bind'));
    const prov = await xrpcAuthPost('net.openfederation.wallet.provision', user.accessJwt, {
      chain: 'ethereum',
    });
    ethWallet = prov.body.walletAddress;
    // The victim app holds a legitimate consent, granted from its own origin.
    await xrpcAuthPostFromOrigin('net.openfederation.wallet.grantConsent', user.accessJwt, VICTIM_APP, {
      dappOrigin: VICTIM_APP,
      chain: 'ethereum',
      walletAddress: ethWallet,
    });
  });

  describe('the reported replay', () => {
    it('refuses to sign when the attacker declares the victim origin', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPostFromOrigin(
        'net.openfederation.wallet.sign',
        user.accessJwt,
        ATTACKER_APP, // where the request really came from
        {
          chain: 'ethereum',
          walletAddress: ethWallet,
          message: 'signed on behalf of someone else',
          dappOrigin: VICTIM_APP, // what the attacker claims
        },
      );
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('OriginMismatch');
      expect(res.body.signature).toBeUndefined();
    });

    it('refuses signTransaction the same way', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPostFromOrigin(
        'net.openfederation.wallet.signTransaction',
        user.accessJwt,
        ATTACKER_APP,
        {
          chain: 'ethereum',
          walletAddress: ethWallet,
          dappOrigin: VICTIM_APP,
          tx: { to: '0x' + '11'.repeat(20), value: '0x0', chainId: 1 },
        },
      );
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('OriginMismatch');
      expect(res.body.signedTx).toBeUndefined();
    });

    it('still signs for the app the consent actually belongs to', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPostFromOrigin(
        'net.openfederation.wallet.sign',
        user.accessJwt,
        VICTIM_APP,
        { chain: 'ethereum', walletAddress: ethWallet, message: 'legitimate', dappOrigin: VICTIM_APP },
      );
      expect(res.status).toBe(200);
      expect(res.body.signature).toMatch(/^0x[0-9a-f]+$/);
    });
  });

  describe('the mint path the issue does not mention', () => {
    it('refuses to grant a consent for an origin the request did not come from', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPostFromOrigin(
        'net.openfederation.wallet.grantConsent',
        user.accessJwt,
        ATTACKER_APP,
        { dappOrigin: VICTIM_APP, chain: 'ethereum', walletAddress: ethWallet },
      );
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('OriginMismatch');
    });

    it('grants only for the calling origin, so a minted consent cannot unlock another app', async () => {
      if (!plcAvailable) return;
      // Attacker legitimately grants consent to itself...
      const grant = await xrpcAuthPostFromOrigin(
        'net.openfederation.wallet.grantConsent',
        user.accessJwt,
        ATTACKER_APP,
        { dappOrigin: ATTACKER_APP, chain: 'ethereum', walletAddress: ethWallet },
      );
      expect(grant.status).toBe(200);
      expect(grant.body.dappOrigin).toBe(ATTACKER_APP);

      // ...which still does not let it sign while claiming to be the victim.
      const res = await xrpcAuthPostFromOrigin(
        'net.openfederation.wallet.sign',
        user.accessJwt,
        ATTACKER_APP,
        { chain: 'ethereum', walletAddress: ethWallet, message: 'x', dappOrigin: VICTIM_APP },
      );
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('OriginMismatch');
    });
  });

  describe('requests with no usable Origin', () => {
    it('refuses to sign without an Origin header', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.wallet.sign', user.accessJwt, {
        chain: 'ethereum',
        walletAddress: ethWallet,
        message: 'from a server, not a browser',
        dappOrigin: VICTIM_APP,
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('OriginRequired');
    });

    it('refuses an opaque "null" Origin', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPostFromOrigin('net.openfederation.wallet.sign', user.accessJwt, 'null', {
        chain: 'ethereum',
        walletAddress: ethWallet,
        message: 'sandboxed frame',
        dappOrigin: VICTIM_APP,
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('OriginRequired');
    });

    it('refuses to grant consent without an Origin header', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.wallet.grantConsent', user.accessJwt, {
        dappOrigin: VICTIM_APP,
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('OriginRequired');
    });
  });

  describe('origin canonicalisation', () => {
    it('accepts a differently-cased host as the same origin', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPostFromOrigin(
        'net.openfederation.wallet.sign',
        user.accessJwt,
        'https://GAME.example.com',
        { chain: 'ethereum', walletAddress: ethWallet, message: 'case', dappOrigin: VICTIM_APP },
      );
      expect(res.status).toBe(200);
    });

    it('treats a different port as a different origin', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPostFromOrigin(
        'net.openfederation.wallet.sign',
        user.accessJwt,
        'https://game.example.com:8443',
        { chain: 'ethereum', walletAddress: ethWallet, message: 'port', dappOrigin: VICTIM_APP },
      );
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('OriginMismatch');
    });
  });

  describe('audit trail', () => {
    it('records the refused impersonation', async () => {
      if (!plcAvailable) return;
      await xrpcAuthPostFromOrigin('net.openfederation.wallet.sign', user.accessJwt, ATTACKER_APP, {
        chain: 'ethereum',
        walletAddress: ethWallet,
        message: 'audit me',
        dappOrigin: VICTIM_APP,
      });
      const rows = await query<{ meta: any }>(
        `SELECT meta FROM audit_log
          WHERE action = 'wallet.sign.originRejected' AND target_id = $1
          ORDER BY created_at DESC LIMIT 1`,
        [user.did],
      );
      expect(rows.rows.length).toBe(1);
      expect(rows.rows[0].meta.reason).toBe('OriginMismatch');
      expect(rows.rows[0].meta.declaredOrigin).toBe(VICTIM_APP);
      expect(rows.rows[0].meta.requestOrigin).toBe(ATTACKER_APP);
    });
  });
});
