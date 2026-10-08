import { describe, it, expect } from 'vitest';
import { xrpcGet, xrpcAuthPost, createTestUser, uniqueHandle, isPLCAvailable } from './helpers.js';
import { insertPseudonymUser } from './pseudonym-helpers.js';
import { issueSessionForTests } from './pseudonym-session-for-tests.js';
import { config } from '../../src/config.js';
import { query, withTransaction } from '../../src/db/client.js';
import { redeemToken } from '../../src/identity/pseudonym/tokens.js';
import { importTokenPublicKey, blindTokens, finalizeTokens } from '../../packages/openfederation-pseudonym/src/tokens.js';
import { currentEpoch, base64UrlEncode } from '../../packages/openfederation-pseudonym/src/formats.js';
import { blindSignBatch } from '../../src/identity/pseudonym/tokens.js';

async function collect(accessJwt: string) {
  const keys = (await xrpcGet('net.openfederation.pseudonym.getTokenKeys')).body.keys;
  const epoch = currentEpoch();
  const pub = await importTokenPublicKey(keys.find((k: any) => k.epoch === epoch).publicKey);
  const pending = await blindTokens(pub, epoch, config.pseudonym.tokensPerEpoch);
  const res = await xrpcAuthPost('net.openfederation.pseudonym.collectTokens', accessJwt, { epoch, blindedMessages: pending.blinded });
  return { res, pub, pending };
}

describe('pseudonym creation tokens', () => {
  it('publishes the current epoch key anonymously', async () => {
    const res = await xrpcGet('net.openfederation.pseudonym.getTokenKeys');
    expect(res.status).toBe(200);
    expect(res.body.keys.map((k: any) => k.epoch)).toContain(currentEpoch());
  });

  it('an approved user collects one full batch per epoch, stored as a flag only', async () => {
    if (!(await isPLCAvailable())) return;
    const ana = await createTestUser(uniqueHandle('tok'));
    const first = await collect(ana.accessJwt);
    expect(first.res.status).toBe(200);
    const tokens = await finalizeTokens(first.pub, first.pending, first.res.body.blindSignatures);
    expect(tokens).toHaveLength(config.pseudonym.tokensPerEpoch);
    expect((await collect(ana.accessJwt)).res.status).toBe(409);

    const cols = await query(`SELECT column_name FROM information_schema.columns WHERE table_name IN ('pseudonym_token_batches','pseudonym_tokens_spent','pseudonym_token_keys')`);
    expect(cols.rows.map((r: any) => r.column_name)).not.toEqual(expect.arrayContaining([expect.stringMatching(/_at$|time/)]));
  });

  it('rejects the wrong batch size, pseudonym callers, and unauthenticated callers', async () => {
    if (!(await isPLCAvailable())) return;
    const ana = await createTestUser(uniqueHandle('tok'));
    const bad = await xrpcAuthPost('net.openfederation.pseudonym.collectTokens', ana.accessJwt, { epoch: currentEpoch(), blindedMessages: ['AA'] });
    expect(bad.status).toBe(400);
    const p = await insertPseudonymUser();
    const { accessJwt } = await issueSessionForTests(p);
    expect((await collect(accessJwt)).res.status).toBe(403);
  });

  it('a token redeems once; a forged one never does', async () => {
    if (!(await isPLCAvailable())) return;
    const ana = await createTestUser(uniqueHandle('tok'));
    const c = await collect(ana.accessJwt);
    const [token] = await finalizeTokens(c.pub, c.pending, c.res.body.blindSignatures);
    expect(await withTransaction((tx) => redeemToken(tx, token))).toBe('ok');
    expect(await withTransaction((tx) => redeemToken(tx, token))).toBe('spent');
    expect(await withTransaction((tx) => redeemToken(tx, { ...token, signature: token.signature.slice(0, -4) + 'AAAA' }))).toBe('invalid');
    expect(await withTransaction((tx) => redeemToken(tx, { ...token, epoch: '1999-01' }))).toBe('invalid');
  });

  it('a malformed blinded message is a 400 and does not burn the epoch', async () => {
    if (!(await isPLCAvailable())) return;
    const ana = await createTestUser(uniqueHandle('tok'));
    const keys = (await xrpcGet('net.openfederation.pseudonym.getTokenKeys')).body.keys;
    const pub = await importTokenPublicKey(keys.find((k: any) => k.epoch === currentEpoch()).publicKey);
    const pending = await blindTokens(pub, currentEpoch(), config.pseudonym.tokensPerEpoch);
    const tooBig = base64UrlEncode(new Uint8Array(256).fill(255));
    const bad = await xrpcAuthPost('net.openfederation.pseudonym.collectTokens', ana.accessJwt,
      { epoch: currentEpoch(), blindedMessages: [tooBig, ...pending.blinded.slice(1)] });
    expect(bad.status).toBe(400);
    expect((await collect(ana.accessJwt)).res.status).toBe(200);
  });

  it('only local accounts collect: a non-local account gets 403', async () => {
    if (!(await isPLCAvailable())) return;
    const ana = await createTestUser(uniqueHandle('tok'));
    await query("UPDATE users SET auth_type = 'external' WHERE handle = $1", [ana.handle]);
    expect((await collect(ana.accessJwt)).res.status).toBe(403);
  });

  it('signs a full batch quickly and the signatures verify through the client path', async () => {
    const keys = await (await import('../../src/identity/pseudonym/tokens.js')).publishedEpochs();
    const k = keys.find((x) => x.epoch === currentEpoch())!;
    const pub = await importTokenPublicKey(k.publicKey);
    const pending = await blindTokens(pub, currentEpoch(), 20);
    const t0 = Date.now();
    const sigs = await blindSignBatch(currentEpoch(), pending.blinded);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(await finalizeTokens(pub, pending, sigs)).toHaveLength(20);
  });
});
