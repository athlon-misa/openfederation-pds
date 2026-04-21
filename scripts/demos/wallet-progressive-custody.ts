/**
 * Progressive-custody wallet demo.
 *
 * Creates a fresh user, provisions one wallet at each tier, signs a message
 * with each, and independently verifies every signature using chain-native
 * libraries (ethers for ETH, tweetnacl for Solana).
 *
 * Prerequisites:
 *   - PDS running on PDS_URL (default http://localhost:8080)
 *   - PLC directory running (npm run plc:dev) so registration can create did:plc
 *   - Bootstrap admin credentials in .env
 *
 * Run:
 *   npx ts-node --loader ts-node/esm scripts/demos/wallet-progressive-custody.ts
 * or after `npm run build`:
 *   node dist/scripts/demos/wallet-progressive-custody.js
 */

import 'dotenv/config';
import { verifyMessage as verifyEthMessage, Transaction as EthersTransaction } from 'ethers';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  generateMnemonic,
  deriveWallet,
  wrapMnemonic,
  unwrapMnemonic,
  signMessage,
  signEthereumTransaction,
} from '../../packages/openfederation-sdk/src/wallet/index.js';
import { mnemonicToSeed } from '../../packages/openfederation-sdk/src/wallet/mnemonic.js';

const PDS = (process.env.PDS_URL || 'http://localhost:8080').replace(/\/$/, '');
const ADMIN_HANDLE = process.env.BOOTSTRAP_ADMIN_HANDLE || 'admin';
const ADMIN_PASSWORD = process.env.BOOTSTRAP_ADMIN_PASSWORD || 'AdminPass1234';

type Response<T = any> = { status: number; body: T };

async function xrpc<T>(method: 'GET' | 'POST', nsid: string, opts: { token?: string; body?: unknown; params?: Record<string, string> } = {}): Promise<Response<T>> {
  const qs = opts.params ? '?' + new URLSearchParams(opts.params).toString() : '';
  const url = `${PDS}/xrpc/${nsid}${qs}`;
  const res = await fetch(url, {
    method,
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body: body as T };
}

function log(stage: string, ...rest: unknown[]) {
  console.log(`\n── ${stage} ${'─'.repeat(Math.max(0, 60 - stage.length))}`);
  for (const r of rest) console.log(r);
}

async function main() {
  log('Logging in as bootstrap admin');
  const adminLogin = await xrpc<{ accessJwt: string }>('POST', 'com.atproto.server.createSession', {
    body: { identifier: ADMIN_HANDLE, password: ADMIN_PASSWORD },
  });
  if (adminLogin.status !== 200) throw new Error(`admin login failed: ${adminLogin.status}`);
  const adminToken = adminLogin.body.accessJwt;
  console.log('  ✓ admin token acquired');

  log('Creating invite + registering a fresh user');
  const invite = await xrpc<{ code: string }>('POST', 'net.openfederation.invite.create', {
    token: adminToken,
    body: { maxUses: 1 },
  });
  if (invite.status !== 201) throw new Error(`invite creation failed: ${invite.status}`);

  const handle = `demo-${Date.now().toString(36)}`;
  const reg = await xrpc<{ id: string }>('POST', 'net.openfederation.account.register', {
    body: {
      handle,
      email: `${handle}@demo.local`,
      password: 'DemoPassword123!',
      inviteCode: invite.body.code,
    },
  });
  if (reg.status !== 201 && reg.status !== 200) throw new Error(`register failed: ${reg.status}`);
  await xrpc('POST', 'net.openfederation.account.approve', { token: adminToken, body: { userId: reg.body.id } });
  const session = await xrpc<{ accessJwt: string; did: string }>('POST', 'com.atproto.server.createSession', {
    body: { identifier: handle, password: 'DemoPassword123!' },
  });
  if (session.status !== 200) throw new Error(`user login failed: ${session.status}`);
  const token = session.body.accessJwt;
  const did = session.body.did;
  console.log(`  ✓ registered ${handle} with DID ${did}`);

  // ── Tier 1: PDS-custodial ───────────────────────────────────────────────

  log('Tier 1 (Custodial) — PDS generates key, signs on user\'s behalf');
  const t1 = await xrpc<{ walletAddress: string; custodyTier: string }>('POST', 'net.openfederation.wallet.provision', {
    token,
    body: { chain: 'ethereum', label: 'demo-t1-eth' },
  });
  if (t1.status !== 200) throw new Error(`t1 provision failed: ${t1.status} ${JSON.stringify(t1.body)}`);
  console.log(`  ✓ ETH address: ${t1.body.walletAddress}`);
  console.log(`  ✓ custody tier: ${t1.body.custodyTier}`);

  const dappOrigin = 'https://demo-game.example.com';
  const grant = await xrpc<{ id: string; expiresAt: string }>('POST', 'net.openfederation.wallet.grantConsent', {
    token,
    body: { dappOrigin, chain: 'ethereum', walletAddress: t1.body.walletAddress },
  });
  if (grant.status !== 200) throw new Error(`t1 consent failed: ${grant.status}`);
  console.log(`  ✓ consent granted to ${dappOrigin} until ${grant.body.expiresAt}`);

  const t1Msg = `Hello from ${handle} at Tier 1`;
  const t1Sign = await xrpc<{ signature: string }>('POST', 'net.openfederation.wallet.sign', {
    token,
    body: { chain: 'ethereum', walletAddress: t1.body.walletAddress, message: t1Msg, dappOrigin },
  });
  if (t1Sign.status !== 200) throw new Error(`t1 sign failed: ${t1Sign.status}`);
  const t1Recovered = verifyEthMessage(t1Msg, t1Sign.body.signature).toLowerCase();
  console.log(`  ✓ signature verified — recovered ${t1Recovered} === ${t1.body.walletAddress} (${t1Recovered === t1.body.walletAddress})`);

  // Sign a real EIP-1559 transaction via the new signTransaction endpoint.
  const t1TxRes = await xrpc<{ signedTx: string }>('POST', 'net.openfederation.wallet.signTransaction', {
    token,
    body: {
      chain: 'ethereum',
      walletAddress: t1.body.walletAddress,
      dappOrigin,
      tx: {
        to: '0x000000000000000000000000000000000000bEEF',
        value: '1000000000000',       // 0.000001 ETH (wei as string)
        gasLimit: '21000',
        maxFeePerGas: '30000000000',  // 30 gwei
        maxPriorityFeePerGas: '1000000000', // 1 gwei
        nonce: 0,
        chainId: 137,                  // Polygon
      },
    },
  });
  if (t1TxRes.status !== 200) throw new Error(`t1 signTransaction failed: ${t1TxRes.status} ${JSON.stringify(t1TxRes.body)}`);
  const t1SignedTx = EthersTransaction.from(t1TxRes.body.signedTx);
  console.log(`  ✓ signed EIP-1559 tx (chainId ${t1SignedTx.chainId}) — 'from' recovers to ${t1SignedTx.from?.toLowerCase()}`);

  // ── Tier 2: User-encrypted ──────────────────────────────────────────────

  log('Tier 2 (User-encrypted) — SDK generates mnemonic, wraps with passphrase');
  const passphrase = 'my-strong-passphrase';
  const t2Mnemonic = generateMnemonic();
  const t2Seed = mnemonicToSeed(t2Mnemonic);
  const t2Wallet = deriveWallet('solana', t2Seed);
  console.log(`  ✓ derived Solana address: ${t2Wallet.address}`);

  const t2Wrapped = await wrapMnemonic(t2Mnemonic, passphrase);
  const t2Store = await xrpc('POST', 'net.openfederation.vault.storeCustodialSecret', {
    token,
    body: {
      secretType: 'bip39-mnemonic-wrapped',
      chain: 'solana',
      encryptedBlob: JSON.stringify(t2Wrapped),
      walletAddress: t2Wallet.address,
    },
  });
  if (t2Store.status !== 200) throw new Error(`t2 store failed: ${t2Store.status}`);
  console.log('  ✓ wrapped mnemonic uploaded (PDS cannot decrypt)');

  const t2Ch = await xrpc<{ challenge: string }>('GET', 'net.openfederation.identity.getWalletLinkChallenge', {
    token,
    params: { chain: 'solana', walletAddress: t2Wallet.address },
  });
  const t2Sig = signMessage('solana', t2Ch.body.challenge, t2Wallet.privateKey);
  const t2Link = await xrpc('POST', 'net.openfederation.identity.linkWallet', {
    token,
    body: {
      chain: 'solana',
      walletAddress: t2Wallet.address,
      challenge: t2Ch.body.challenge,
      signature: t2Sig,
      label: 'demo-t2-sol',
    },
  });
  if (t2Link.status !== 200) throw new Error(`t2 link failed: ${t2Link.status}`);
  console.log('  ✓ wallet linked to DID (proof-of-control via client-side signature)');

  // Unlock + sign
  const t2Get = await xrpc<{ encryptedBlob: string }>('GET', 'net.openfederation.vault.getCustodialSecret', {
    token,
    params: { chain: 'solana' },
  });
  const t2Unwrapped = await unwrapMnemonic(JSON.parse(t2Get.body.encryptedBlob), passphrase);
  if (t2Unwrapped !== t2Mnemonic) throw new Error('Tier 2 mnemonic did not round-trip!');
  console.log('  ✓ mnemonic round-tripped correctly under passphrase');

  const t2Msg = `Hola from ${handle} at Tier 2`;
  const t2Recovered = deriveWallet('solana', mnemonicToSeed(t2Unwrapped));
  const t2Sig2 = signMessage('solana', t2Msg, t2Recovered.privateKey);
  const t2Valid = nacl.sign.detached.verify(
    new TextEncoder().encode(t2Msg),
    bs58.decode(t2Sig2),
    bs58.decode(t2Wallet.address)
  );
  console.log(`  ✓ signed '${t2Msg}' — verification: ${t2Valid}`);

  // ── Tier 3: Self-custody ────────────────────────────────────────────────

  log('Tier 3 (Self-custody) — client keeps mnemonic, PDS stores nothing');
  const t3Mnemonic = generateMnemonic();
  const t3Seed = mnemonicToSeed(t3Mnemonic);
  const t3Wallet = deriveWallet('ethereum', t3Seed);
  const t3Ch = await xrpc<{ challenge: string }>('GET', 'net.openfederation.identity.getWalletLinkChallenge', {
    token,
    params: { chain: 'ethereum', walletAddress: t3Wallet.address },
  });
  const t3LinkSig = signMessage('ethereum', t3Ch.body.challenge, t3Wallet.privateKey);
  const t3Link = await xrpc('POST', 'net.openfederation.identity.linkWallet', {
    token,
    body: {
      chain: 'ethereum',
      walletAddress: t3Wallet.address,
      challenge: t3Ch.body.challenge,
      signature: t3LinkSig,
      label: 'demo-t3-eth',
    },
  });
  if (t3Link.status !== 200) throw new Error(`t3 link failed: ${t3Link.status}`);
  console.log(`  ✓ ETH address: ${t3Wallet.address}`);
  console.log(`  ✓ linked to DID — user keeps mnemonic (${t3Mnemonic.split(' ').slice(0, 3).join(' ')} …)`);

  // Sign using the same mnemonic the caller holds.
  const t3Msg = `Cold-storage signature from ${handle}`;
  const t3SigResult = signMessage('ethereum', t3Msg, t3Wallet.privateKey);
  const t3Recovered = verifyEthMessage(t3Msg, t3SigResult).toLowerCase();
  console.log(`  ✓ offline-signed and verified — ${t3Recovered} === ${t3Wallet.address} (${t3Recovered === t3Wallet.address})`);

  // And a real transaction, signed entirely client-side using the same mnemonic.
  const t3SignedTx = await signEthereumTransaction(t3Wallet.privateKey, {
    to: '0x0000000000000000000000000000000000C0FFEE',
    value: '5000000000000000',
    gasLimit: '21000',
    maxFeePerGas: '20000000000',
    maxPriorityFeePerGas: '1000000000',
    nonce: 0,
    chainId: 1,
  });
  const t3Parsed = EthersTransaction.from(t3SignedTx);
  console.log(`  ✓ client-signed mainnet tx — 'from' ${t3Parsed.from?.toLowerCase()} === ${t3Wallet.address} (${t3Parsed.from?.toLowerCase() === t3Wallet.address})`);

  // ── Summary ─────────────────────────────────────────────────────────────

  // ── Sign-In With OpenFederation ─────────────────────────────────────────

  log('Sign-In With OpenFederation — dApp gets offline-verifiable tokens');
  const siwofAudience = 'https://siwof-demo.example.com/login';
  // Tier 1 signing requires a consent grant for the dApp origin.
  await xrpc('POST', 'net.openfederation.wallet.grantConsent', {
    token,
    body: { dappOrigin: siwofAudience, chain: 'ethereum', walletAddress: t1.body.walletAddress },
  });
  const chRes = await xrpc<{ message: string; nonce: string; chainIdCaip2: string }>(
    'POST',
    'net.openfederation.identity.signInChallenge',
    {
      token,
      body: {
        chain: 'ethereum',
        walletAddress: t1.body.walletAddress,
        audience: siwofAudience,
        statement: `Welcome, ${handle}. Sign to continue.`,
      },
    }
  );
  if (chRes.status !== 200) throw new Error(`siwof challenge failed: ${chRes.status}`);
  console.log(`  ✓ CAIP-122 challenge issued (${chRes.body.chainIdCaip2}, nonce=${chRes.body.nonce.slice(0, 8)}…)`);

  const siwofSig = await xrpc<{ signature: string }>('POST', 'net.openfederation.wallet.sign', {
    token,
    body: {
      chain: 'ethereum',
      walletAddress: t1.body.walletAddress,
      message: chRes.body.message,
      dappOrigin: siwofAudience,
    },
  });
  const assertRes = await xrpc<{ didToken: string; walletProof: any; did: string }>(
    'POST',
    'net.openfederation.identity.signInAssert',
    {
      token,
      body: {
        chain: 'ethereum',
        walletAddress: t1.body.walletAddress,
        message: chRes.body.message,
        walletSignature: siwofSig.body.signature,
      },
    }
  );
  if (assertRes.status !== 200) throw new Error(`siwof assert failed: ${assertRes.status}`);

  const header = JSON.parse(Buffer.from(assertRes.body.didToken.split('.')[0], 'base64url').toString('utf-8'));
  const payload = JSON.parse(Buffer.from(assertRes.body.didToken.split('.')[1], 'base64url').toString('utf-8'));
  console.log(`  ✓ didToken minted — alg=${header.alg}, iss=${payload.iss}, aud=${payload.aud}`);
  console.log(`  ✓ sub=${payload.sub} (CAIP-10), nonce=${payload.nonce.slice(0, 8)}…`);
  console.log(`  → Any dApp can verify this didToken + walletProof offline via DID resolution.`);

  // ── Public resolver + DID augmentation ─────────────────────────────────

  log('Public resolver + DID augmentation — anyone can look up DID → wallet');

  // Mark primary wallet per chain so the resolver has a canonical answer.
  await xrpc('POST', 'net.openfederation.identity.setPrimaryWallet', {
    token, body: { chain: 'ethereum', walletAddress: t1.body.walletAddress },
  });
  await xrpc('POST', 'net.openfederation.identity.setPrimaryWallet', {
    token, body: { chain: 'solana', walletAddress: t2Wallet.address },
  });

  // Unauthenticated resolver — any dApp can hit this for any DID.
  const resolved = await xrpc<any>('GET', 'net.openfederation.identity.getPrimaryWallet', {
    params: { did, chain: 'ethereum' },
  });
  console.log(`  ✓ getPrimaryWallet(${did}, ethereum) → ${resolved.body.walletAddress} (${resolved.body.custodyTier})`);
  if (resolved.body.proof) {
    const [, p] = resolved.body.proof.split('.');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf-8'));
    console.log(`  ✓ proof JWT: iss=${claims.iss}, sub=${claims.sub} (dApps verify via DID resolution)`);
  }

  const aug = await xrpc<any>('GET', 'net.openfederation.identity.getDidAugmentation', {
    params: { did },
  });
  console.log(`  ✓ getDidAugmentation → ${aug.body.verificationMethod.length} W3C verification method(s):`);
  for (const vm of aug.body.verificationMethod) {
    console.log(`     ${vm.type.padEnd(40)} ${vm.blockchainAccountId}`);
  }

  // ── Tier upgrade: 1 → 2 → 3 on the same address ────────────────────────

  log('Tier upgrade — one address climbs the security ladder');
  const ut1 = await xrpc<any>('POST', 'net.openfederation.wallet.provision', {
    token, body: { chain: 'ethereum', label: 'upgrade-demo' },
  });
  if (ut1.status !== 200) throw new Error(`upgrade provision failed: ${ut1.status} ${JSON.stringify(ut1.body)}`);
  const upgradeAddr = ut1.body.walletAddress;
  console.log(`  ✓ fresh Tier 1 wallet at ${upgradeAddr}`);

  // Tier 1 → Tier 2: retrieve plaintext, wrap under passphrase, finalize.
  const ret = await xrpc<any>('POST', 'net.openfederation.wallet.retrieveForUpgrade', {
    token, body: { chain: 'ethereum', walletAddress: upgradeAddr, currentPassword: 'DemoPassword123!' },
  });
  if (ret.status !== 200) throw new Error(`retrieve failed: ${ret.status}`);
  const upgradePass = 'upgrade-passphrase-987';
  const wrappedUpgrade = await wrapMnemonic(ret.body.privateKeyBase64, upgradePass);
  const fin12 = await xrpc<any>('POST', 'net.openfederation.wallet.finalizeTierChange', {
    token, body: {
      chain: 'ethereum', walletAddress: upgradeAddr,
      newTier: 'user_encrypted',
      newEncryptedBlob: JSON.stringify(wrappedUpgrade),
      currentPassword: 'DemoPassword123!',
    },
  });
  if (fin12.status !== 200) throw new Error(`1→2 finalize failed: ${fin12.status}`);
  console.log(`  ✓ Tier 1 → Tier 2: ${upgradeAddr} (same address — PDS now holds only the encrypted blob)`);

  // Tier 2 → Tier 3: drop the server blob entirely.
  const fin23 = await xrpc<any>('POST', 'net.openfederation.wallet.finalizeTierChange', {
    token, body: {
      chain: 'ethereum', walletAddress: upgradeAddr,
      newTier: 'self_custody',
      currentPassword: 'DemoPassword123!',
    },
  });
  if (fin23.status !== 200) throw new Error(`2→3 finalize failed: ${fin23.status}`);
  console.log(`  ✓ Tier 2 → Tier 3: ${upgradeAddr} (same address — PDS now holds only the public link)`);

  log('Summary — one DID, three wallets, three custody tiers');
  const list = await xrpc<{ walletLinks: Array<{ chain: string; walletAddress: string; label: string | null }> }>(
    'GET',
    'net.openfederation.identity.listWalletLinks',
    { token }
  );
  for (const w of list.body.walletLinks) {
    console.log(`  ${w.chain.padEnd(10)} ${w.walletAddress}  (${w.label})`);
  }
  console.log(`\nAll three tiers belong to DID ${did}.`);
  console.log('Same identity, different custody postures — that\'s progressive custody.');
}

main().catch((err) => {
  console.error('demo failed:', err);
  process.exit(1);
});
