import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import {
  MultiPlcResolver,
  PUBLIC_PLC_DIRECTORY,
  parsePlcResolverUrls,
} from '../../src/identity/plc-directories.js';

const OWN = 'https://plc.example.net';

describe('parsePlcResolverUrls', () => {
  it('defaults to this server\'s own directory, then plc.directory', () => {
    expect(parsePlcResolverUrls(undefined, OWN)).toEqual([OWN, PUBLIC_PLC_DIRECTORY]);
    expect(parsePlcResolverUrls('  ', OWN)).toEqual([OWN, PUBLIC_PLC_DIRECTORY]);
  });

  it('does not list plc.directory twice when it is the own directory', () => {
    expect(parsePlcResolverUrls(undefined, 'https://plc.directory/')).toEqual([PUBLIC_PLC_DIRECTORY]);
  });

  it('keeps the listed order and puts the own directory first when it is missing', () => {
    expect(parsePlcResolverUrls('https://a.example, https://b.example/', OWN))
      .toEqual([OWN, 'https://a.example', 'https://b.example']);
    expect(parsePlcResolverUrls(`https://a.example,${OWN}`, OWN))
      .toEqual(['https://a.example', OWN]);
  });

  it('"none" means the own directory only', () => {
    expect(parsePlcResolverUrls('none', OWN)).toEqual([OWN]);
    expect(parsePlcResolverUrls('NONE', OWN)).toEqual([OWN]);
  });

  it('refuses anything that is not a plain http(s) URL', () => {
    expect(() => parsePlcResolverUrls('plc.directory', OWN)).toThrow(/PLC_RESOLVER_URLS/);
    expect(() => parsePlcResolverUrls('ftp://plc.example', OWN)).toThrow(/http\(s\)/);
    expect(() => parsePlcResolverUrls('https://plc.example/?x=1', OWN)).toThrow(/query/);
  });
});

describe('MultiPlcResolver', () => {
  const docFor = (did: string, from: string) => ({
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: did,
    alsoKnownAs: [`at://${from}.example`],
  });

  // Two fake directories: "own" knows did:plc:own, "public" knows
  // did:plc:public and did:plc:both (as does "own"), "broken" always fails.
  let own: http.Server;
  let pub: http.Server;
  let broken: http.Server;
  const url = (s: http.Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

  function directory(known: Record<string, string>): http.Server {
    return http.createServer((req, res) => {
      const did = decodeURIComponent((req.url ?? '').slice(1));
      const from = known[did];
      if (!from) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: `DID not registered: ${did}` }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/did+ld+json' });
      res.end(JSON.stringify(docFor(did, from)));
    });
  }

  beforeAll(async () => {
    own = directory({ 'did:plc:own': 'own', 'did:plc:both': 'own' });
    pub = directory({ 'did:plc:public': 'public', 'did:plc:both': 'public' });
    broken = http.createServer((_req, res) => { res.writeHead(500); res.end(); });
    await Promise.all([own, pub, broken].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
  });

  afterAll(async () => {
    await Promise.all([own, pub, broken].map((s) => new Promise((r) => s.close(r))));
  });

  it('finds a DID in whichever directory holds it', async () => {
    const r = new MultiPlcResolver([url(own), url(pub)], 2000);
    expect(await r.resolveNoCheck('did:plc:own')).toMatchObject({ alsoKnownAs: ['at://own.example'] });
    expect(await r.resolveNoCheck('did:plc:public')).toMatchObject({ alsoKnownAs: ['at://public.example'] });
  });

  it('the first directory that knows a DID answers for it', async () => {
    expect(await new MultiPlcResolver([url(own), url(pub)], 2000).resolveNoCheck('did:plc:both'))
      .toMatchObject({ alsoKnownAs: ['at://own.example'] });
    expect(await new MultiPlcResolver([url(pub), url(own)], 2000).resolveNoCheck('did:plc:both'))
      .toMatchObject({ alsoKnownAs: ['at://public.example'] });
  });

  it('returns null only when every directory says the DID is not there', async () => {
    expect(await new MultiPlcResolver([url(own), url(pub)], 2000).resolveNoCheck('did:plc:nowhere')).toBeNull();
  });

  it('a failing directory does not hide a DID another one has', async () => {
    const r = new MultiPlcResolver([url(broken), url(pub)], 2000);
    expect(await r.resolveNoCheck('did:plc:public')).toMatchObject({ id: 'did:plc:public' });
  });

  it('an outage is reported as a failure, not as "no such DID"', async () => {
    const r = new MultiPlcResolver([url(own), url(broken)], 2000);
    await expect(r.resolveNoCheck('did:plc:nowhere')).rejects.toThrow();
  });
});
