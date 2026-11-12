import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import request from 'supertest';
import { JsonRpcProvider, Wallet } from 'ethers';
import { query } from '../../src/db/client.js';
import {
  createTestUser,
  getAdminToken,
  isPLCAvailable,
  uniqueHandle,
  xrpcAuthPost,
} from './helpers.js';
import { ANVIL_DEV_PRIVATE_KEY, findAnvil, freePort, startAnvil, type AnvilNode } from './anvil.js';

// Issue #76: on-chain governance against a real RPC endpoint.
//
// The PDS is started the way an operator starts it — its real entry point,
// `src/index.ts`, in a child process — with `CHAIN_ADAPTERS` pointing at an
// anvil node this file starts. That variable alone switches the chain module
// on and registers the EVM adapter. Against that server: a community moves to
// `on-chain` governance with a contract deployed on the chain, an admin
// issues it an Oracle credential, and the Oracle reports transactions through
// `net.openfederation.oracle.submitProof`, which the EVM adapter checks
// against the node (receipt status, target contract, block number,
// confirmation depth). The result is cached in `proof_verifications`.
// Finally the Oracle writes a protected record under the community's
// governance, citing the verified transaction.
//
// Users and the community are set up through this process's in-memory app;
// both servers share the test database and secrets.
//
// Needs Foundry's `anvil` (skipped without it) and the PLC directory.

const anvilBin = findAnvil();
const CHAIN_ID = 'eip155:31337';
const GOVERNED_COLLECTION = 'net.openfederation.community.auditNote';

/**
 * A stand-in governance contract. Called with calldata it logs the calldata
 * (LOG0) and succeeds; called with none it reverts — so one contract gives
 * both a successful and a reverted transaction to the same address.
 *
 *   CALLDATASIZE PUSH1 08 JUMPI  PUSH1 00 DUP1 REVERT
 *   JUMPDEST CALLDATASIZE PUSH1 00 PUSH1 00 CALLDATACOPY CALLDATASIZE PUSH1 00 LOG0 STOP
 */
const RUNTIME = '36600857600080fd5b366000600037366000a000';
/** Copies the 20-byte runtime (at offset 12) into memory and returns it. */
const INITCODE = `0x6014600c60003960146000f3${RUNTIME}`;

interface PdsProcess {
  url: string;
  output(): string;
  stop(): Promise<void>;
}

/** Start the PDS entry point with `env` added, and wait until it is serving. */
async function startPds(env: Record<string, string>): Promise<PdsProcess> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const ready = 'OpenFederation PDS is running';
  let output = '';
  const child: ChildProcess = spawn(process.execPath, ['--import', './scripts/register-ts-node.mjs', 'src/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, ...env, PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => { output += d; });
  child.stderr!.on('data', (d) => { output += d; });
  let exited = false;
  child.once('exit', () => { exited = true; });

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && !exited && !output.includes(ready)) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (exited || !output.includes(ready)) {
    child.kill('SIGKILL');
    throw new Error(`PDS did not start: ${output.slice(-2000)}`);
  }
  return {
    url,
    output: () => output,
    stop: () => new Promise<void>((resolve) => {
      if (exited) return resolve();
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
      setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 5000).unref();
    }),
  };
}

describe.skipIf(!anvilBin)('on-chain governance against anvil (CHAIN_ADAPTERS)', () => {
  let anvil: AnvilNode;
  let provider: JsonRpcProvider;
  let funder: Wallet;
  let plcAvailable = false;
  let pds: PdsProcess;
  let api: ReturnType<typeof request>;
  let ownerToken: string;
  let adminToken: string;
  let communityDid: string;
  let contractAddress: string;
  let credentialId: string;
  let oracleKey: string;
  let verifiedTx: { hash: string; blockNumber: number };

  beforeAll(async () => {
    anvil = await startAnvil(anvilBin!);
    provider = new JsonRpcProvider(anvil.rpcUrl, anvil.chainId, { staticNetwork: true, pollingInterval: 100, cacheTimeout: -1 });
    funder = new Wallet(ANVIL_DEV_PRIVATE_KEY, provider);

    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;

    pds = await startPds({ CHAIN_ADAPTERS: `${CHAIN_ID}=${anvil.rpcUrl}` });
    api = request(pds.url);

    const deploy = await funder.sendTransaction({ data: INITCODE });
    const deployed = await deploy.wait();
    contractAddress = deployed!.contractAddress!;
    expect(await provider.getCode(contractAddress)).toBe(`0x${RUNTIME}`);

    const owner = await createTestUser(uniqueHandle('anvil-gov'));
    ownerToken = owner.accessJwt;
    adminToken = await getAdminToken();
    const created = await xrpcAuthPost('net.openfederation.community.create', ownerToken, {
      handle: uniqueHandle('anvil-gov-c'),
      didMethod: 'plc',
      visibility: 'public',
      joinPolicy: 'open',
    });
    expect(created.status).toBe(201);
    communityDid = created.body.did;

    const governance = await xrpcAuthPost('net.openfederation.community.setGovernanceModel', ownerToken, {
      communityDid,
      governanceModel: 'on-chain',
      governanceConfig: {
        chainId: CHAIN_ID,
        contractAddress,
        protectedCollections: [GOVERNED_COLLECTION],
      },
    });
    expect(governance.status).toBe(200);

    const credential = await api.post('/xrpc/net.openfederation.oracle.createCredential')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ communityDid, name: 'Anvil governance oracle' });
    expect(credential.status).toBe(201);
    credentialId = credential.body.id;
    oracleKey = credential.body.key;
  }, 120_000);

  afterAll(async () => {
    await pds?.stop();
    provider?.destroy();
    await anvil?.stop();
  });

  /** Send a call to `to` from the anvil dev account and wait for it to be mined. */
  async function sendTx(to: string, data: string): Promise<{ hash: string; blockNumber: number; status: number }> {
    const tx = await funder.sendTransaction({ to, data, gasLimit: 100_000n });
    const receipt = await provider.waitForTransaction(tx.hash);
    return { hash: receipt!.hash, blockNumber: receipt!.blockNumber, status: receipt!.status! };
  }

  async function submitProof(body: Record<string, unknown>) {
    // The adapter's ethers provider caches identical RPC calls for 250ms, so a
    // proof submitted right after the previous one would be measured against
    // the block number that one read. A real Oracle is not that fast; wait it out.
    await new Promise((r) => setTimeout(r, 300));
    return api.post('/xrpc/net.openfederation.oracle.submitProof').set('X-Oracle-Key', oracleKey).send(body);
  }

  it('CHAIN_ADAPTERS is parsed at startup and registers an EVM adapter for anvil', () => {
    expect(anvil.chainId).toBe(31337);
    if (!plcAvailable) return;
    // The RPC URL is masked to its host in the log.
    expect(pds.output()).toContain(`Registered chain adapter: EVM ${CHAIN_ID} (127.0.0.1)`);
    expect(pds.output()).not.toContain(anvil.rpcUrl);
  });

  it('issues an ofo_ Oracle credential that is listed for the community', async () => {
    if (!plcAvailable) return;
    expect(oracleKey.startsWith('ofo_')).toBe(true);
    const listed = await api.get('/xrpc/net.openfederation.oracle.listCredentials')
      .query({ communityDid })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(listed.status).toBe(200);
    const mine = listed.body.credentials.find((c: { id: string }) => c.id === credentialId);
    expect(mine).toMatchObject({ communityDid, status: 'active', keyPrefix: oracleKey.slice(0, 16) });
  });

  it('refuses a transaction that is mined but not yet 6 blocks deep', async () => {
    if (!plcAvailable) return;
    const tx = await sendTx(contractAddress, '0x01');
    expect(tx.status).toBe(1);

    const res = await submitProof({ chainId: CHAIN_ID, transactionHash: tx.hash });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ verified: false, confirmations: 1, cached: false, verificationMethod: 'on-chain' });
    expect(res.body.error).toMatch(/1 confirmation\(s\); 6 required/);
  });

  it('verifies a confirmed transaction on the community contract and writes proof_verifications', async () => {
    if (!plcAvailable) return;
    const tx = await sendTx(contractAddress, '0x5ca1ab1e');
    expect(tx.status).toBe(1);
    await anvil.mine(5);
    verifiedTx = tx;
    const block = await provider.getBlock(tx.blockNumber);

    const res = await submitProof({ chainId: CHAIN_ID, transactionHash: tx.hash, blockNumber: tx.blockNumber });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      verified: true,
      blockTimestamp: block!.timestamp,
      confirmations: 6,
      cached: false,
      verificationMethod: 'on-chain',
    });

    const rows = await query<{
      verified: boolean; error: string | null; block_number: number; contract_address: string;
      block_timestamp: string; confirmations: number; oracle_credential_id: string; chain_id: string;
    }>(
      `SELECT verified, error, block_number, contract_address, block_timestamp, confirmations, oracle_credential_id, chain_id
       FROM proof_verifications WHERE community_did = $1 AND transaction_hash = $2`,
      [communityDid, tx.hash],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      verified: true,
      error: null,
      chain_id: CHAIN_ID,
      block_number: tx.blockNumber,
      confirmations: 6,
      oracle_credential_id: credentialId,
    });
    expect(rows.rows[0].contract_address.toLowerCase()).toBe(contractAddress.toLowerCase());
    expect(Number(rows.rows[0].block_timestamp)).toBe(block!.timestamp);
    // eslint-disable-next-line no-console
    console.log(`[#76] proof verified on anvil: ${tx.hash} (block ${tx.blockNumber}, contract ${contractAddress})`);

    const audit = await query<{ meta: Record<string, unknown> }>(
      `SELECT meta FROM audit_log WHERE action = 'oracle.proofApplied' AND target_id = $1 AND meta->>'transactionHash' = $2`,
      [communityDid, tx.hash],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].meta).toMatchObject({ verified: true, verificationMethod: 'on-chain', adapterName: `EVM ${CHAIN_ID}` });

    // The same proof again is answered from the cache, without the chain.
    const again = await submitProof({ chainId: CHAIN_ID, transactionHash: tx.hash, blockNumber: tx.blockNumber });
    expect(again.body).toMatchObject({ verified: true, cached: true, verificationMethod: 'cache' });
  });

  it('records the Oracle credential as used', async () => {
    if (!plcAvailable) return;
    // last_used_at / proofs_submitted are updated without awaiting the request.
    await new Promise((r) => setTimeout(r, 200));
    const row = await query<{ proofs_submitted: number; last_used_at: string | null }>(
      'SELECT proofs_submitted, last_used_at FROM oracle_credentials WHERE id = $1',
      [credentialId],
    );
    expect(row.rows[0].proofs_submitted).toBeGreaterThanOrEqual(3);
    expect(row.rows[0].last_used_at).not.toBeNull();
  });

  it('refuses a reverted transaction on the community contract', async () => {
    if (!plcAvailable) return;
    const tx = await sendTx(contractAddress, '0x');
    expect(tx.status).toBe(0);
    await anvil.mine(5);
    const res = await submitProof({ chainId: CHAIN_ID, transactionHash: tx.hash });
    expect(res.body).toMatchObject({ verified: false, verificationMethod: 'on-chain' });
    expect(res.body.error).toMatch(/reverted/);
  });

  it('refuses a successful transaction sent to some other address', async () => {
    if (!plcAvailable) return;
    const tx = await sendTx('0x00000000000000000000000000000000000b0b00', '0x');
    expect(tx.status).toBe(1);
    await anvil.mine(5);
    const res = await submitProof({ chainId: CHAIN_ID, transactionHash: tx.hash });
    expect(res.body.verified).toBe(false);
    expect(res.body.error).toMatch(/Contract address mismatch/);
  });

  it('refuses a block number that does not match the chain', async () => {
    if (!plcAvailable) return;
    const res = await submitProof({ chainId: CHAIN_ID, transactionHash: verifiedTx.hash, blockNumber: verifiedTx.blockNumber + 1 });
    expect(res.body.verified).toBe(false);
    expect(res.body.error).toMatch(/Block number mismatch/);
  });

  it('refuses a transaction hash the chain does not know', async () => {
    if (!plcAvailable) return;
    const res = await submitProof({ chainId: CHAIN_ID, transactionHash: `0x${'ab'.repeat(32)}` });
    expect(res.body).toMatchObject({ verified: false, error: 'Transaction not found on chain' });
  });

  it('the Oracle writes a protected record under on-chain governance, citing the verified transaction', async () => {
    if (!plcAvailable) return;
    const record = { $type: GOVERNED_COLLECTION, text: 'written under on-chain governance' };

    // Without the Oracle the owner is sent to the proposal flow.
    const direct = await api.post('/xrpc/com.atproto.repo.putRecord')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ repo: communityDid, collection: GOVERNED_COLLECTION, rkey: 'anvil-direct', record });
    expect(direct.status).toBe(403);
    expect(direct.body.error).toBe('GovernanceDenied');

    const governed = await api.post('/xrpc/com.atproto.repo.putRecord')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-Oracle-Key', oracleKey)
      .send({
        repo: communityDid,
        collection: GOVERNED_COLLECTION,
        rkey: 'anvil-governed',
        record,
        governanceProof: { chainId: CHAIN_ID, transactionHash: verifiedTx.hash, blockNumber: verifiedTx.blockNumber },
      });
    expect(governed.status).toBe(200);
    expect(governed.body.uri).toBe(`at://${communityDid}/${GOVERNED_COLLECTION}/anvil-governed`);

    const audit = await query<{ actor_id: string; meta: Record<string, any> }>(
      `SELECT actor_id, meta FROM audit_log
       WHERE action = 'oracle.proofApplied' AND target_id = $1 AND meta->>'rkey' = 'anvil-governed'`,
      [communityDid],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor_id).toBe(credentialId);
    expect(audit.rows[0].meta).toMatchObject({
      status: 'applied',
      collection: GOVERNED_COLLECTION,
      proof: { chainId: CHAIN_ID, transactionHash: verifiedTx.hash.toLowerCase() },
    });
  });
});
