import { describe, it, expect, vi, afterEach } from 'vitest';
import { loginWithPhrase, createPseudonym } from '../../packages/openfederation-pseudonym/src/client.js';
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
