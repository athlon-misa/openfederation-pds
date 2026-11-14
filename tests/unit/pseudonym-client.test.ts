import { describe, it, expect, vi, afterEach } from 'vitest';
import { loginWithPhrase, createPseudonym, publishReveal, revealLinkRecord, type RevealBundleV2 } from '../../packages/openfederation-pseudonym/src/client.js';
import { openAccountForMove } from '../../packages/openfederation-pseudonym/src/migrate.js';
import type { CreationToken } from '../../packages/openfederation-pseudonym/src/tokens.js';
import { derivePseudonymKeys, generatePseudonymPhrase } from '../../packages/openfederation-pseudonym/src/keys.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => vi.restoreAllMocks());

describe('pseudonym client safety checks', () => {
  it('loginWithPhrase refuses a challenge for another service before signing', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('getLoginChallenge')) {
        return jsonResponse({ challengeId: crypto.randomUUID(), challenge: 'ab'.repeat(32), serviceDid: 'did:web:other-pds.example' });
      }
      return jsonResponse({ did: 'did:plc:x', handle: 'x', accessJwt: 'a', refreshJwt: 'r' });
    });
    await expect(loginWithPhrase({ pdsUrl: 'https://pds.test', phrase: generatePseudonymPhrase(), expectedServiceDid: 'did:web:pds.test' }))
      .rejects.toThrow(/refusing to sign/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('createSession'))).toBe(false);
  });

  it('loginWithPhrase requires expectedServiceDid', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(loginWithPhrase({ pdsUrl: 'https://pds.test', phrase: generatePseudonymPhrase(), expectedServiceDid: '' }))
      .rejects.toThrow(/expectedServiceDid/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('createPseudonym throws when the PDS reports a different DID', async () => {
    const signingKey = derivePseudonymKeys(generatePseudonymPhrase()).ownerDidKey;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('reserveSigningKey')) return jsonResponse({ signingKey });
      if (url.includes('pseudonym.createAccount')) return jsonResponse({ did: 'did:plc:someoneelseentirely00', handle: 'nightdesk.pds.test' });
      return new Response('', { status: 200 }); // PLC accepts the genesis op
    });
    await expect(createPseudonym({
      pdsUrl: 'https://pds.test', plcUrl: 'https://plc.test', pdsServiceUrl: 'https://pds.test',
      handle: 'nightdesk.pds.test', ownerDid: 'did:plc:anaanaanaanaanaanaanaana', token: {} as any,
    })).rejects.toThrow(/expected did:plc:/);
  });
});

describe('generatePseudonymPhrase', () => {
  it('never uses crypto- or money-sounding words, and stays a valid phrase', async () => {
    const { PHRASE_AVOID_WORDS } = await import('../../packages/openfederation-pseudonym/src/keys.js');
    const { wordlist } = await import('@scure/bip39/wordlists/english');
    for (const w of PHRASE_AVOID_WORDS) expect(wordlist).toContain(w);
    for (let i = 0; i < 300; i++) {
      const phrase = generatePseudonymPhrase();
      expect(phrase.split(' ')).toHaveLength(12);
      expect(phrase.split(' ').filter((w) => PHRASE_AVOID_WORDS.has(w))).toEqual([]);
      expect(() => derivePseudonymKeys(phrase)).not.toThrow();
    }
  });
});

describe('publishReveal across servers', () => {
  const bundle = {
    version: 2, statement: 's', commitmentSalt: 'ab',
    pseudonym: { did: 'did:plc:pen', sig: 'ps', genesisOp: {} },
    owner: { did: 'did:plc:owner', keyRef: 'atproto', signingKey: 'did:key:z', signature: { format: 'raw', sig: 'os' } },
  } as unknown as RevealBundleV2;

  it('writes each half at its own server, with its own token', async () => {
    const calls: { url: string; auth: string | null; repo: string }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get('Authorization'), repo: JSON.parse(String(init?.body)).repo });
      return jsonResponse({ uri: 'at://x', cid: 'c' });
    });
    await publishReveal({ pdsUrl: 'https://owner.test', pseudonymPdsUrl: 'https://pen.test', bundle, pseudonymAccessJwt: 'pen-jwt', ownerAccessJwt: 'owner-jwt' });
    expect(calls).toEqual([
      { url: 'https://pen.test/xrpc/com.atproto.repo.createRecord', auth: 'Bearer pen-jwt', repo: 'did:plc:pen' },
      { url: 'https://owner.test/xrpc/com.atproto.repo.createRecord', auth: 'Bearer owner-jwt', repo: 'did:plc:owner' },
    ]);
  });

  it('defaults to one server for both', async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => { urls.push(String(input)); return jsonResponse({}); });
    await publishReveal({ pdsUrl: 'https://pds.test', bundle, pseudonymAccessJwt: 'a', ownerAccessJwt: 'b' });
    expect(urls).toEqual(['https://pds.test/xrpc/com.atproto.repo.createRecord', 'https://pds.test/xrpc/com.atproto.repo.createRecord']);
  });

  it('writes the same record in both, as revealLinkRecord builds it', () => {
    expect(revealLinkRecord(bundle, 't')).toEqual({
      $type: 'net.openfederation.pseudonym.link', statement: 's', pseudonymSig: 'ps', ownerSig: 'os',
      ownerSigningKey: 'did:key:z', commitmentSalt: 'ab', genesisOp: {}, createdAt: 't',
      ownerKeyRef: 'atproto', ownerSignature: { format: 'raw', sig: 'os' },
    });
  });
});

describe('openAccountForMove with a creation token', () => {
  async function bodySent(creationToken?: CreationToken) {
    let body: Record<string, unknown> = {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).includes('reserveSigningKey')) return jsonResponse({ signingKey: 'did:key:z' });
      body = JSON.parse(String(init?.body));
      return jsonResponse({ did: 'did:plc:pen', handle: 'pen.b.test', accessJwt: 'a', refreshJwt: 'r' });
    });
    await openAccountForMove({
      newPdsUrl: 'https://b.test', newServiceDid: 'did:web:b.test', phrase: generatePseudonymPhrase(), did: 'did:plc:pen', handle: 'pen.b.test',
      ...(creationToken ? { creationToken } : {}),
    });
    return body;
  }

  it('sends the token to createAccount as `token`', async () => {
    const token = { epoch: '2026-11', prepared: 'p', signature: 's' };
    expect(await bodySent(token)).toEqual({ did: 'did:plc:pen', handle: 'pen.b.test', token });
  });

  it('sends none without one', async () => {
    expect(await bodySent()).toEqual({ did: 'did:plc:pen', handle: 'pen.b.test' });
  });
});
