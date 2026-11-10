/**
 * Consent to sign with a custodial wallet comes from the user, on a page this
 * PDS serves, never from the dApp's own script. And a consent says what it
 * allows: which contracts, how much value, for how long.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Transaction } from 'ethers';
import {
  api, xrpcAuthPost, xrpcAuthPostFromOrigin, xrpcAuthGet, createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { config } from '../../src/config.js';

type User = { accessJwt: string; did: string; handle: string };
const DAPP = 'https://dapp.example.com';
const ALLOWED = '0x00000000000000000000000000000000000000a1';
const OTHER = '0x00000000000000000000000000000000000000b2';
const PASSWORD = 'TestPassword123!';
const pdsOrigin = () => new URL(config.pds.serviceUrl).origin;

describe('wallet consent approval', () => {
  let plc: boolean;
  let user: User;
  let wallet: string;

  beforeAll(async () => {
    plc = await isPLCAvailable();
    if (!plc) return;
    user = await createTestUser(uniqueHandle('wca'));
    const provisioned = await xrpcAuthPost('net.openfederation.wallet.provision', user.accessJwt, { chain: 'ethereum' });
    expect(provisioned.status).toBe(200);
    wallet = provisioned.body.walletAddress;
  });

  const request = (scope: Record<string, unknown> = {}) =>
    xrpcAuthPostFromOrigin('net.openfederation.wallet.requestConsent', user.accessJwt, DAPP, {
      dappOrigin: DAPP, chain: 'ethereum', walletAddress: wallet, ...scope,
    });
  const approve = (requestId: string, password = PASSWORD, origin = pdsOrigin()) =>
    api.post('/xrpc/net.openfederation.wallet.approveConsentRequest').set('Origin', origin)
      .send({ requestId, password, approve: true });
  const sign = (message: string) => xrpcAuthPostFromOrigin('net.openfederation.wallet.sign', user.accessJwt, DAPP, {
    chain: 'ethereum', walletAddress: wallet, message, dappOrigin: DAPP,
  });
  const signTx = (tx: Record<string, unknown>) => xrpcAuthPostFromOrigin('net.openfederation.wallet.signTransaction', user.accessJwt, DAPP, {
    chain: 'ethereum', walletAddress: wallet, dappOrigin: DAPP, tx: { gasLimit: '21000', chainId: 1, nonce: 0, ...tx },
  });

  it('a dApp can no longer grant itself consent', async () => {
    if (!plc) return;
    const res = await xrpcAuthPostFromOrigin('net.openfederation.wallet.grantConsent', user.accessJwt, DAPP, {
      dappOrigin: DAPP, chain: 'ethereum', walletAddress: wallet,
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('UserApprovalRequired');
    expect((await sign('hello')).status).toBe(403);
  });

  it('a request gives the dApp a link to a page on this PDS, and grants nothing until the user approves there', async () => {
    if (!plc) return;
    const req = await request({ allowedContracts: [ALLOWED] });
    expect(req.status).toBe(200);
    expect(req.body.approveUrl.startsWith(`${config.pds.serviceUrl.replace(/\/+$/, '')}/wallet/consent/`)).toBe(true);
    expect((await sign('hello')).status).toBe(403);

    const page = await api.get(new URL(req.body.approveUrl).pathname);
    expect(page.status).toBe(200);
    expect(page.text).toContain(DAPP);
    expect(page.text).toContain(ALLOWED);
    expect(page.headers['content-security-policy'] ?? '').toContain("frame-ancestors 'none'");
    expect(page.headers['x-frame-options']).toBe('DENY');

    const status = await xrpcAuthGet('net.openfederation.wallet.getConsentRequest', user.accessJwt, { requestId: req.body.requestId });
    expect(status.body.status).toBe('pending');
  });

  it('approval needs the account password, and cannot be made from the dApp\'s own page', async () => {
    if (!plc) return;
    const req = await request();
    expect((await approve(req.body.requestId, 'WrongPassword999!')).status).toBe(401);
    expect((await approve(req.body.requestId, PASSWORD, DAPP)).status).toBe(403);
    const ok = await approve(req.body.requestId);
    expect(ok.status).toBe(200);
    const status = await xrpcAuthGet('net.openfederation.wallet.getConsentRequest', user.accessJwt, { requestId: req.body.requestId });
    expect(status.body.status).toBe('approved');
    expect(status.body.consentId).toBeTruthy();
    expect((await sign('hello')).status).toBe(200);
    // A request is approved once.
    expect((await approve(req.body.requestId)).status).toBe(409);
  });

  it('lasts an hour by default, and no longer than the operator allows', async () => {
    if (!plc) return;
    const long = await request({ ttlSeconds: 30 * 24 * 3600 });
    expect(long.status).toBe(400);
    const req = await request();
    await approve(req.body.requestId);
    const consents = await xrpcAuthGet('net.openfederation.wallet.listConsents', user.accessJwt);
    const latest = consents.body.consents[0];
    const lifetime = new Date(latest.expiresAt).getTime() - new Date(latest.grantedAt).getTime();
    expect(lifetime).toBeLessThanOrEqual(3600 * 1000 + 5000);
  });

  it('signs transactions only to the contracts the consent names', async () => {
    if (!plc) return;
    const req = await request({ allowedContracts: [ALLOWED] });
    await approve(req.body.requestId);
    expect((await signTx({ to: ALLOWED, value: '0' })).status).toBe(200);
    const refused = await signTx({ to: OTHER, value: '0' });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('OutsideConsentScope');
  });

  it('a consent that names no contracts signs no transactions', async () => {
    if (!plc) return;
    const req = await request();
    await approve(req.body.requestId);
    expect((await signTx({ to: ALLOWED, value: '0' })).status).toBe(403);
  });

  it('enforces the per-transaction and total value limits', async () => {
    if (!plc) return;
    const req = await request({ allowedContracts: [ALLOWED], maxValuePerTx: '100', maxTotalValue: '150' });
    await approve(req.body.requestId);
    expect((await signTx({ to: ALLOWED, value: '101' })).status).toBe(403);
    const first = await signTx({ to: ALLOWED, value: '100' });
    expect(first.status).toBe(200);
    expect(Transaction.from(first.body.signedTx).value).toBe(100n);
    expect((await signTx({ to: ALLOWED, value: '60' })).status).toBe(403);
    expect((await signTx({ to: ALLOWED, value: '50' })).status).toBe(200);
  });

  it('without a value limit, a consent moves no value', async () => {
    if (!plc) return;
    const req = await request({ allowedContracts: [ALLOWED] });
    await approve(req.body.requestId);
    expect((await signTx({ to: ALLOWED, value: '1' })).status).toBe(403);
  });

  it('will not sign a sign-in message for a site other than the consenting dApp', async () => {
    if (!plc) return;
    const req = await request();
    await approve(req.body.requestId);
    const siwe = (domain: string) => [
      `${domain} wants you to sign in with your Ethereum account:`, wallet, '', 'Sign in', '',
      `URI: https://${domain}`, 'Version: 1', 'Chain ID: 1', 'Nonce: abcdef12', `Issued At: ${new Date().toISOString()}`,
    ].join('\n');
    const foreign = await sign(siwe('bank.example.org'));
    expect(foreign.status).toBe(403);
    expect(foreign.body.error).toBe('OutsideConsentScope');
    expect((await sign(siwe('dapp.example.com'))).status).toBe(200);
    expect((await sign('just a message')).status).toBe(200);
  });
});
