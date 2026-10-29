/**
 * The old PDS's side of a custodial move (#266): it signs the PLC update
 * with the rotation key it holds, after an emailed code and the password.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Secp256k1Keypair } from '@atproto/crypto';
import { xrpcAuthPost, createTestUser, uniqueHandle, isPLCAvailable, testServer } from './helpers.js';
import { config } from '../../src/config.js';
import { setEmailSenderForTests } from '../../src/email/email-service.js';
import { fetchTokenKeys, collectTokens, createPseudonym, loginWithPhrase, cidForPlcOp } from '../../packages/openfederation-pseudonym/src/index.js';

const PASSWORD = 'TestPassword123!';
const mails: { to: string; html: string }[] = [];
const codeFor = (email: string) => [...mails].reverse().find((m) => m.to === email && /[0-9A-F]{5}-[0-9A-F]{5}/.test(m.html))?.html.match(/[0-9A-F]{5}-[0-9A-F]{5}/)?.[0];

describe('com.atproto.identity.{request,sign,submit}PlcOperation', () => {
  let plc = false;
  let pdsUrl: string;
  beforeAll(async () => {
    plc = await isPLCAvailable();
    pdsUrl = `http://127.0.0.1:${(testServer.address() as AddressInfo).port}`;
    setEmailSenderForTests(async (to, _subject, html) => { mails.push({ to, html }); });
  });
  afterAll(() => setEmailSenderForTests(null));

  it('signs the move only with the emailed code and the password, once, and submits it', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const user = await createTestUser(uniqueHandle('mover'));
    const email = `${user.handle}@test.local`;
    expect((await xrpcAuthPost('com.atproto.identity.requestPlcOperationSignature', user.accessJwt, {})).status).toBe(200);
    const code = codeFor(email);
    expect(code).toBeDefined();

    const newRotation = (await Secp256k1Keypair.create()).did();
    const newSigning = (await Secp256k1Keypair.create()).did();
    const change = {
      rotationKeys: [newRotation], verificationMethods: { atproto: newSigning },
      alsoKnownAs: ['at://mover.new-pds.example.test'],
      services: { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: 'https://new-pds.example.test' } },
    };
    const wrongPassword = await xrpcAuthPost('com.atproto.identity.signPlcOperation', user.accessJwt, { token: code, password: 'not-it', ...change });
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.body.error).toBe('AuthenticationRequired');
    const wrongCode = await xrpcAuthPost('com.atproto.identity.signPlcOperation', user.accessJwt, { token: 'AAAAA-BBBBB', password: PASSWORD, ...change });
    expect(wrongCode.status).toBe(400);
    expect(wrongCode.body.error).toBe('InvalidToken');

    const signed = await xrpcAuthPost('com.atproto.identity.signPlcOperation', user.accessJwt, { token: code, password: PASSWORD, ...change });
    expect(signed.status).toBe(200);
    const op = signed.body.operation;
    const log = await (await fetch(`${config.plc.directoryUrl}/${user.did}/log`)).json();
    expect(op).toMatchObject({ type: 'plc_operation', prev: cidForPlcOp(log[log.length - 1]), ...change });
    expect(typeof op.sig).toBe('string');

    // The code is spent.
    const reuse = await xrpcAuthPost('com.atproto.identity.signPlcOperation', user.accessJwt, { token: code, password: PASSWORD, ...change });
    expect(reuse.status).toBe(400);

    // A tampered operation does not continue the chain; the real one does.
    const stale = await xrpcAuthPost('com.atproto.identity.submitPlcOperation', user.accessJwt, { operation: { ...op, prev: 'bafyreinotthechain' } });
    expect(stale.status).toBe(400);
    expect((await xrpcAuthPost('com.atproto.identity.submitPlcOperation', user.accessJwt, { operation: op })).status).toBe(200);
    const doc = await (await fetch(`${config.plc.directoryUrl}/${user.did}`)).json();
    expect(doc.service[0].serviceEndpoint).toBe('https://new-pds.example.test');
    const data = await (await fetch(`${config.plc.directoryUrl}/${user.did}/data`)).json();
    expect(data.rotationKeys).toEqual([newRotation]);
  });

  it('a pseudonym holds its own key: nothing to sign here', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const owner = await createTestUser(uniqueHandle('plc-owner'));
    const keys = await fetchTokenKeys(pdsUrl);
    const [token] = await collectTokens({ pdsUrl, accessJwt: owner.accessJwt, keys, count: config.pseudonym.tokensPerEpoch });
    const p = await createPseudonym({
      pdsUrl, plcUrl: config.plc.directoryUrl, pdsServiceUrl: config.pds.serviceUrl,
      handle: `${uniqueHandle('plc-p')}${config.handleSuffix}`, ownerDid: owner.did, token,
    });
    const session = await loginWithPhrase({ pdsUrl, phrase: p.phrase, expectedServiceDid: config.pds.serviceDid });
    const res = await xrpcAuthPost('com.atproto.identity.requestPlcOperationSignature', session.accessJwt, {});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NotCustodial');
    expect((await xrpcAuthPost('com.atproto.identity.signPlcOperation', session.accessJwt, { token: 'x', password: 'y' })).body.error).toBe('NotCustodial');
  });
});
