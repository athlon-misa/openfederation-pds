/**
 * A wallet's key must not be destroyed by doing something ordinary with
 * another wallet, or by unlinking the wallet while the server is the only
 * place its key lives.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { xrpcAuthPost, xrpcAuthGet, createTestUser, isPLCAvailable, uniqueHandle } from './helpers.js';
import { query } from '../../src/db/client.js';

type User = { accessJwt: string; did: string; handle: string };
const A = '0x00000000000000000000000000000000000000a1';
const B = '0x00000000000000000000000000000000000000b2';

describe('wallet key loss', () => {
  let plc: boolean;
  beforeAll(async () => { plc = await isPLCAvailable(); });

  describe('user-encrypted secrets', () => {
    let user: User;
    beforeAll(async () => { if (plc) user = await createTestUser(uniqueHandle('wkl')); });

    const store = (walletAddress: string, encryptedBlob: string) =>
      xrpcAuthPost('net.openfederation.vault.storeCustodialSecret', user.accessJwt, {
        secretType: 'bip39-mnemonic-wrapped', chain: 'ethereum', encryptedBlob, walletAddress,
      });
    const get = (walletAddress?: string) =>
      xrpcAuthGet('net.openfederation.vault.getCustodialSecret', user.accessJwt,
        walletAddress ? { chain: 'ethereum', walletAddress } : { chain: 'ethereum' });

    it('a second wallet on the same chain does not overwrite the first wallet\'s secret', async () => {
      if (!plc) return;
      expect((await store(A, 'blob-for-A')).status).toBe(200);
      expect((await store(B, 'blob-for-B')).status).toBe(200);

      const a = await get(A);
      expect(a.status).toBe(200);
      expect(a.body.encryptedBlob).toBe('blob-for-A');
      const b = await get(B);
      expect(b.body.encryptedBlob).toBe('blob-for-B');
    });

    it('storing again for the same wallet replaces that wallet\'s secret only', async () => {
      if (!plc) return;
      expect((await store(A, 'blob-for-A-v2')).status).toBe(200);
      expect((await get(A)).body.encryptedBlob).toBe('blob-for-A-v2');
      expect((await get(B)).body.encryptedBlob).toBe('blob-for-B');
    });

    it('asks which wallet when a chain has several and none is named', async () => {
      if (!plc) return;
      const res = await get();
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('WalletAddressRequired');
    });

    it('still answers without an address when the chain has exactly one', async () => {
      if (!plc) return;
      const single = await createTestUser(uniqueHandle('wkl'));
      await xrpcAuthPost('net.openfederation.vault.storeCustodialSecret', single.accessJwt, {
        secretType: 'bip39-mnemonic-wrapped', chain: 'ethereum', encryptedBlob: 'only-one', walletAddress: A,
      });
      const res = await xrpcAuthGet('net.openfederation.vault.getCustodialSecret', single.accessJwt, { chain: 'ethereum' });
      expect(res.status).toBe(200);
      expect(res.body.encryptedBlob).toBe('only-one');
    });
  });

  it('a custodial wallet cannot be unlinked while the server holds its only key', async () => {
    if (!plc) return;
    const user = await createTestUser(uniqueHandle('wkl'));
    const provisioned = await xrpcAuthPost('net.openfederation.wallet.provision', user.accessJwt, { chain: 'ethereum', label: 'main' });
    expect(provisioned.status).toBe(200);

    const res = await xrpcAuthPost('net.openfederation.identity.unlinkWallet', user.accessJwt, { label: 'main' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CustodialWallet');
    const link = await query('SELECT 1 FROM wallet_links WHERE user_did = $1 AND label = $2', [user.did, 'main']);
    expect(link.rows.length).toBe(1);
  });
});
