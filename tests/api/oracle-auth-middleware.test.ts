/**
 * Oracle auth as module-mounted middleware (#193) — integration coverage.
 *
 * Uses a real credential row and the real verification path (no mocks), so
 * these assertions distinguish "the key is genuinely valid" from "the chain
 * module refuses to authenticate it". With the module disabled, a fully valid
 * Oracle key must authenticate nothing, on any route.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query } from '../../src/db/client.js';
import { setChainModuleEnabledForTests } from '../../src/config.js';
import { generateOracleKey } from '../../src/modules/chain/oracle-keys.js';
import {
  getOracleContext,
  oracleAuthMiddleware,
  oracleRequestAuthority,
  requireOracleAuth,
} from '../../src/modules/chain/oracle-auth.js';
import { api, xrpcPost } from './helpers.js';

const COMMUNITY_DID = `did:plc:oracleauth${Date.now().toString(36)}`;

let rawKey: string;
let credentialId: string;

function mockRes(): any {
  const r: any = { statusCode: 200, body: null };
  r.status = (code: number) => { r.statusCode = code; return r; };
  r.json = (data: unknown) => { r.body = data; return r; };
  return r;
}

async function runMiddleware(headers: Record<string, string>): Promise<any> {
  const req: any = { headers, body: {} };
  await oracleAuthMiddleware(req, mockRes(), () => {});
  return req;
}

beforeAll(async () => {
  const key = generateOracleKey();
  rawKey = key.rawKey;
  credentialId = randomUUID();
  await query(
    `INSERT INTO oracle_credentials (id, community_did, key_prefix, key_hash, name, status)
     VALUES ($1, $2, $3, $4, $5, 'active')`,
    [credentialId, COMMUNITY_DID, key.keyPrefix, key.keyHash, 'Middleware test Oracle'],
  );
});

afterAll(async () => {
  await query('DELETE FROM oracle_credentials WHERE id = $1', [credentialId]);
  setChainModuleEnabledForTests(undefined);
});

afterEach(() => {
  setChainModuleEnabledForTests(undefined);
});

describe('Oracle middleware — chain module enabled', () => {
  it('authenticates a valid key and attributes a chain-oracle context', async () => {
    setChainModuleEnabledForTests(true);
    const req = await runMiddleware({ 'x-oracle-key': rawKey });

    expect(getOracleContext(req)).toEqual({
      credentialId,
      communityDid: COMMUNITY_DID,
      name: 'Middleware test Oracle',
    });
    expect(oracleRequestAuthority.contextFor(req)).toEqual({
      source: 'chain-oracle',
      credentialId,
      communityDid: COMMUNITY_DID,
      name: 'Middleware test Oracle',
    });
    expect(requireOracleAuth(req, mockRes())).not.toBeNull();
  });

  it('rejects a revoked credential', async () => {
    setChainModuleEnabledForTests(true);
    await query('UPDATE oracle_credentials SET status = $2 WHERE id = $1', [credentialId, 'revoked']);
    try {
      const req = await runMiddleware({ 'x-oracle-key': rawKey });
      expect(getOracleContext(req)).toBeNull();
    } finally {
      await query('UPDATE oracle_credentials SET status = $2 WHERE id = $1', [credentialId, 'active']);
    }
  });

  it('reaches the submitProof handler over HTTP with the key attached', async () => {
    setChainModuleEnabledForTests(true);
    const res = await api
      .post('/xrpc/net.openfederation.oracle.submitProof')
      .set('X-Oracle-Key', rawKey)
      .send({ chainId: 'eip155:31337', transactionHash: `0x${randomUUID().replace(/-/g, '')}` });

    // The route-mounted middleware authenticated the key: the handler ran and
    // fell back to oracle-trust (no attestor registered for this chain).
    expect(res.status).toBe(200);
    expect(res.body.verificationMethod).toBe('oracle-trust');
  });

  it('still 401s the same route without a key', async () => {
    setChainModuleEnabledForTests(true);
    const res = await xrpcPost('net.openfederation.oracle.submitProof', {
      chainId: 'eip155:31337',
      transactionHash: '0xabc',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('AuthRequired');
  });
});

describe('Oracle middleware — chain module disabled', () => {
  it('authenticates nothing, even with a genuinely valid key', async () => {
    setChainModuleEnabledForTests(false);
    const req = await runMiddleware({ 'x-oracle-key': rawKey });

    expect(getOracleContext(req)).toBeNull();
    expect(oracleRequestAuthority.contextFor(req)).toBeNull();
  });

  it('a valid key stashed while enabled becomes unreadable once disabled', async () => {
    setChainModuleEnabledForTests(true);
    const req = await runMiddleware({ 'x-oracle-key': rawKey });
    expect(getOracleContext(req)).not.toBeNull();

    setChainModuleEnabledForTests(false);
    expect(getOracleContext(req)).toBeNull();
    expect(oracleRequestAuthority.contextFor(req)).toBeNull();
  });

  it('the oracle route itself is not implemented', async () => {
    setChainModuleEnabledForTests(false);
    const res = await api
      .post('/xrpc/net.openfederation.oracle.submitProof')
      .set('X-Oracle-Key', rawKey)
      .send({ chainId: 'eip155:31337', transactionHash: '0xabc' });

    expect(res.status).toBe(501);
    expect(res.body.error).toBe('MethodNotImplemented');
  });

  it('a valid key on a core repo write route grants no authority', async () => {
    setChainModuleEnabledForTests(false);
    const res = await api
      .post('/xrpc/com.atproto.repo.createRecord')
      .set('X-Oracle-Key', rawKey)
      .send({
        repo: COMMUNITY_DID,
        collection: 'net.openfederation.community.settings',
        record: { governanceModel: 'on-chain' },
      });

    // No user session and no Oracle standing in for one: plain 401.
    expect(res.status).toBe(401);
  });
});
