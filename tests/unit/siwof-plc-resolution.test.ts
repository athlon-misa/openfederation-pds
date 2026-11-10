/**
 * Resolving a did:plc issuer when verifying a SIWOF assertion.
 */
import { describe, it, expect } from 'vitest';
import { resolveAtprotoKey, defaultPlcDirectories } from '../../packages/openfederation-sdk/src/siwof/verify.js';
import { isBlockedAddress } from '../../packages/openfederation-sdk/src/siwof/net-guard.js';

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';
const doc = JSON.stringify({ verificationMethod: [{ id: `${DID}#atproto`, publicKeyMultibase: 'zQ3shTestKey' }] });

describe('SIWOF did:plc resolution', () => {
  it('by default looks in the directory OpenFederation accounts are registered in, not only the public one', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(String(url));
      return String(url).startsWith('https://plc.openfederation.net/')
        ? new Response(doc, { status: 200 })
        : new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    const key = await resolveAtprotoKey(DID, defaultPlcDirectories(), { fetchImpl });
    expect(key).toBe('did:key:zQ3shTestKey');
    expect(asked.some((u) => u.startsWith('https://plc.openfederation.net/'))).toBe(true);
  });

  it('uses only the directory the integrator names, when one is given', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => { asked.push(String(url)); return new Response(doc, { status: 200 }); }) as unknown as typeof fetch;
    await resolveAtprotoKey(DID, 'https://plc.internal.example', { fetchImpl });
    expect(asked).toEqual([`https://plc.internal.example/${DID}`]);
  });

  it('gives up on a directory that does not answer in time', async () => {
    const fetchImpl = ((_url: string, init?: { signal?: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as unknown as typeof fetch;
    await expect(resolveAtprotoKey(DID, 'https://plc.slow.example', { fetchImpl, timeoutMs: 50 }))
      .rejects.toThrow(/DID document/i);
  });
});

describe('SDK address guard', () => {
  it('blocks IPv4-mapped IPv6 in the hex spelling URLs are normalised to', () => {
    for (const host of ['::ffff:7f00:1', '[::ffff:7f00:1]', '::ffff:a9fe:a9fe', '::ffff:0a00:0005']) {
      expect(isBlockedAddress(host), host).toBe(true);
    }
    expect(isBlockedAddress('::ffff:0808:0808')).toBe(false);
  });
});
