import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import bs58 from 'bs58';
import { readFileSync } from 'node:fs';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { createClient } from '../../packages/openfederation-sdk/src/index.js';
import type { OpenFederationClient } from '../../packages/openfederation-sdk/src/client.js';
import type { OFSolanaSigner } from '../../packages/openfederation-sdk/src/wallet/solana-adapter.js';
import type { WalletSession } from '../../packages/openfederation-sdk/src/wallet/wallet-session.js';
import { config } from '../../src/config.js';
import { createTestUser, grantWalletConsent, isPLCAvailable, uniqueHandle } from './helpers.js';

// Issue #78: `asSolanaSigner()` signs Solana transactions the public devnet
// accepts. Opt-in (SOLANA_DEVNET_TEST=1): it talks to a public network and
// needs devnet funding, so the normal suite never runs it.
//
//   SOLANA_DEVNET_TEST=1 TEST_DB_NAME=... npx vitest run tests/api/wallet-solana-devnet.test.ts
//   SOLANA_DEVNET_FUNDER_KEYPAIR=/path/to/devnet-only-keypair.json bypasses
//   the RPC faucet by funding the fresh SDK wallet from that account.
//
// Devnet only, fresh keys only: the wallets are made here through the SDK — a
// Tier 2 wallet that signs client-side, and a Tier 1 wallet the PDS signs for
// under an approved consent.
//
// Two levels of evidence:
//   1. Signature acceptance (no faucet needed): devnet's sendTransaction
//      checks signatures before it looks at balances. A transfer from an
//      unfunded wallet is refused only for having no funds; the same
//      transaction with one signature byte changed is refused as a
//      signature failure.
//   2. Confirmation (needs funding): the Tier 2 wallet is funded from
//      SOLANA_DEVNET_FUNDER_KEYPAIR or an RPC airdrop, sends a self-transfer,
//      and funds the Tier 1 wallet, which sends a self-transfer of its own.
//      Each is confirmed on devnet. Missing funds or a refused airdrop fail
//      the tests explicitly.
//
// Needs the PLC directory.

const DEVNET_RPC = 'https://api.devnet.solana.com';
/** Devnet's genesis hash: the file refuses to run against any other cluster. */
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const PASSWORD = 'TestPassword123!';
const DAPP_ORIGIN = 'https://devnet-dapp.example.com';
const enabled = process.env.SOLANA_DEVNET_TEST === '1';

/** Ask the devnet faucet for `lamports`, retrying with backoff; throws if it keeps refusing. */
async function airdrop(connection: Connection, to: PublicKey, lamports: number): Promise<string> {
  const errors: string[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const signature = await connection.requestAirdrop(to, lamports);
      const latest = await connection.getLatestBlockhash('confirmed');
      await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
      return signature;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      await new Promise((r) => setTimeout(r, 3000 * 2 ** attempt));
    }
  }
  throw new Error(`devnet airdrop refused after ${errors.length} attempts: ${errors.join(' | ')}`);
}

describe.skipIf(!enabled)('asSolanaSigner against Solana devnet (opt-in)', () => {
  const connection = new Connection(DEVNET_RPC, 'confirmed');
  let plcAvailable = false;
  let user: { accessJwt: string; handle: string };
  let client: OpenFederationClient;
  let session: WalletSession;
  let tier2: { key: PublicKey; signer: OFSolanaSigner };
  let tier1: { key: PublicKey; signer: OFSolanaSigner };

  beforeAll(async () => {
    expect(await connection.getGenesisHash()).toBe(DEVNET_GENESIS);

    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) throw new Error('Solana devnet verification requires a running PLC directory (npm run plc:dev)');
    user = await createTestUser(uniqueHandle('sol-devnet'));
    client = createClient({ serverUrl: config.pds.serviceUrl, partnerKey: 'ofp_unused', storage: 'memory', autoRefresh: false });
    await client.login({ identifier: user.handle, password: PASSWORD });

    const t2 = await client.wallet.createTier2({ chain: 'solana', passphrase: 'devnet-tier2-pass' });
    session = await client.wallet.unlockTier2({ chain: 'solana', passphrase: 'devnet-tier2-pass', walletAddress: t2.walletAddress });
    tier2 = { key: new PublicKey(t2.walletAddress), signer: client.wallet.asSolanaSigner({ walletAddress: t2.walletAddress, session }) };
    expect(tier2.signer.tier).toBe('user_encrypted');

    const t1 = await client.wallet.createTier1({ chain: 'solana' });
    const consent = await grantWalletConsent(user.accessJwt, DAPP_ORIGIN, {
      dappOrigin: DAPP_ORIGIN,
      chain: 'solana',
      walletAddress: t1.walletAddress,
      allowedContracts: [SystemProgram.programId.toBase58()],
    });
    expect(consent.status).toBe(200);
    tier1 = { key: new PublicKey(t1.walletAddress), signer: client.wallet.asSolanaSigner({ walletAddress: t1.walletAddress }) };
    expect(tier1.signer.tier).toBe('custodial');

    // Custodial signing is bound to the browser's Origin (#101). The SDK runs
    // in a browser, where `location` and the Origin header come for free; in
    // Node both are supplied here, for requests to the PDS only.
    vi.stubGlobal('location', { origin: DAPP_ORIGIN });
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (!String(input).startsWith(config.pds.serviceUrl)) return realFetch(input, init);
      const headers = new Headers(init.headers);
      headers.set('Origin', DAPP_ORIGIN);
      return realFetch(input, { ...init, headers });
    });
  }, 120_000);

  afterAll(() => {
    vi.unstubAllGlobals();
    session?.destroy();
  });

  /** A System Program transfer from `from`, signed through `signer`. */
  async function signedTransfer(signer: OFSolanaSigner, from: PublicKey, to: PublicKey, lamports: number) {
    const latest = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: from, ...latest }).add(
      SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports }),
    );
    const signature = await signer.signTransactionMessage(tx);
    tx.addSignature(from, Buffer.from(bs58.decode(signature)));
    expect(tx.verifySignatures()).toBe(true);
    return { tx, signature, latest };
  }

  /** The RPC's reason for refusing a transaction, as text. */
  async function refusal(raw: Buffer): Promise<string> {
    try {
      await connection.sendRawTransaction(raw);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    throw new Error('devnet accepted a transaction it was expected to refuse');
  }

  async function sendAndConfirm(signer: OFSolanaSigner, from: PublicKey, to: PublicKey, lamports: number): Promise<string> {
    const { tx, signature, latest } = await signedTransfer(signer, from, to, lamports);
    const sent = await connection.sendRawTransaction(tx.serialize());
    // The transaction id is the fee payer's signature.
    expect(sent).toBe(signature);
    const confirmation = await connection.confirmTransaction({ signature: sent, ...latest }, 'confirmed');
    expect(confirmation.value.err).toBeNull();
    return sent;
  }

  for (const tierName of ['Tier 2', 'Tier 1'] as const) {
    it(`${tierName}: devnet verifies the signature (an unfunded transfer is refused for funds, a tampered one for its signature)`, async () => {
      if (!plcAvailable) return;
      const wallet = tierName === 'Tier 2' ? tier2 : tier1;
      if ((await connection.getBalance(wallet.key)) > 0) return; // funded by a later test on a rerun: nothing to show here

      const { tx } = await signedTransfer(wallet.signer, wallet.key, wallet.key, 1000);
      const raw = tx.serialize();
      expect(await refusal(raw)).toMatch(/no record of a prior credit/);

      // Signatures follow the 1-byte signature count; flip a byte of the first.
      const tampered = Buffer.from(raw);
      tampered[1] ^= 0xff;
      expect(await refusal(tampered)).toMatch(/did not pass signature verification/);
    }, 60_000);
  }

  it('Tier 2: a self-transfer signed client-side is confirmed on devnet (needs funding)', async () => {
    if (!plcAvailable) return;
    const keypairFile = process.env.SOLANA_DEVNET_FUNDER_KEYPAIR;
    let funding: string;
    if (keypairFile) {
      const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairFile, 'utf8'))));
      const lamports = 20_000_000;
      const balance = await connection.getBalance(funder.publicKey, 'confirmed');
      if (balance < lamports + 5000) {
        throw new Error(`Fund devnet account ${funder.publicKey.toBase58()} via https://faucet.solana.com/ (needs at least 0.020005 devnet SOL)`);
      }
      funding = await sendAndConfirmTransaction(connection, new Transaction().add(
        SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: tier2.key, lamports }),
      ), [funder], { commitment: 'confirmed' });
    } else {
      funding = await airdrop(connection, tier2.key, LAMPORTS_PER_SOL / 10);
    }
    // eslint-disable-next-line no-console
    console.log(`[#78] devnet funding to Tier 2 wallet ${tier2.key.toBase58()}: ${funding}`);

    const signature = await sendAndConfirm(tier2.signer, tier2.key, tier2.key, 1000);
    const confirmed = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    expect(confirmed?.meta?.err).toBeNull();
    expect(confirmed!.transaction.message.staticAccountKeys[0].toBase58()).toBe(tier2.key.toBase58());
    // eslint-disable-next-line no-console
    console.log(`[#78] Tier 2 Solana self-transfer confirmed on devnet: ${signature}`);
  }, 120_000);

  it('Tier 1: the PDS signs a self-transfer under an approved consent, confirmed on devnet (needs funding)', async () => {
    if (!plcAvailable) return;
    if ((await connection.getBalance(tier2.key)) === 0) {
      throw new Error('The Tier 2 wallet was not funded; nothing to fund the Tier 1 wallet from');
    }
    // Funded from the Tier 2 wallet (above the rent-exempt minimum) rather
    // than asking the rate-limited faucet twice.
    const funding = await sendAndConfirm(tier2.signer, tier2.key, tier1.key, 5_000_000);
    // eslint-disable-next-line no-console
    console.log(`[#78] Tier 2 -> Tier 1 funding transfer on devnet: ${funding}`);

    const signature = await sendAndConfirm(tier1.signer, tier1.key, tier1.key, 1000);
    // eslint-disable-next-line no-console
    console.log(`[#78] Tier 1 Solana self-transfer confirmed on devnet: ${signature}`);
  }, 120_000);
});
