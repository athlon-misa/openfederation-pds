import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcPost, xrpcGet, xrpcAuthPost, xrpcAuthGet,
  createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';

describe('Custodial Secrets', () => {
  let plcAvailable: boolean;
  let user: { accessJwt: string; did: string; handle: string };
  let other: { accessJwt: string; did: string; handle: string };

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;
    user = await createTestUser(uniqueHandle('cust-user'));
    other = await createTestUser(uniqueHandle('cust-other'));
  });

  describe('storeCustodialSecret', () => {
    it('should require authentication', async () => {
      const res = await xrpcPost('net.openfederation.vault.storeCustodialSecret', {
        secretType: 'wallet-mnemonic',
        chain: 'solana',
        encryptedBlob: 'dGVzdA==',
        walletAddress: 'SomeAddress',
      });
      expect(res.status).toBe(401);
    });

    it('should reject missing fields', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.vault.storeCustodialSecret', user.accessJwt, {
        chain: 'solana',
      });
      expect(res.status).toBe(400);
    });

    it('should store a custodial secret', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.vault.storeCustodialSecret', user.accessJwt, {
        secretType: 'wallet-mnemonic',
        chain: 'solana',
        encryptedBlob: 'dGVzdGJsb2I=',
        walletAddress: 'SolAddr123',
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.secretId).toBeTruthy();
    });

    it('should be idempotent (upsert on same chain)', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.vault.storeCustodialSecret', user.accessJwt, {
        secretType: 'wallet-mnemonic',
        chain: 'solana',
        encryptedBlob: 'dXBkYXRlZGJsb2I=',
        walletAddress: 'SolAddr456',
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('getCustodialSecret', () => {
    it('should require authentication', async () => {
      const res = await xrpcGet('net.openfederation.vault.getCustodialSecret', { chain: 'solana' });
      expect(res.status).toBe(401);
    });

    it('should reject missing chain param', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthGet('net.openfederation.vault.getCustodialSecret', user.accessJwt, {});
      expect(res.status).toBe(400);
    });

    it('should retrieve stored secret', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthGet('net.openfederation.vault.getCustodialSecret', user.accessJwt, { chain: 'solana' });
      expect(res.status).toBe(200);
      expect(res.body.secretType).toBe('wallet-mnemonic');
      expect(res.body.chain).toBe('solana');
      expect(res.body.encryptedBlob).toBeTruthy();
      expect(res.body.walletAddress).toBeTruthy();
      expect(res.body.createdAt).toBeTruthy();
    });

    it('should return 404 for unknown chain', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthGet('net.openfederation.vault.getCustodialSecret', user.accessJwt, { chain: 'ethereum' });
      expect(res.status).toBe(404);
    });

    it('should not return another user secret', async () => {
      if (!plcAvailable) return;
      // other user has no solana secret — 404
      const res = await xrpcAuthGet('net.openfederation.vault.getCustodialSecret', other.accessJwt, { chain: 'solana' });
      expect(res.status).toBe(404);
    });
  });
});
