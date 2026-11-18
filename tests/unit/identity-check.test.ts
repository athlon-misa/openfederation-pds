/**
 * `ofc identity check` (docs/ATPROTO-NETWORK.md): which lookups the rest of
 * the AT Protocol network can make for a DID. Fake directories over HTTP.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { checkIdentity } from '../../cli/identity-check.js';

const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';

describe('checkIdentity for a DID', () => {
  let own: http.Server;
  let ownUrl: string;
  beforeAll(async () => {
    own = http.createServer((req, res) => {
      if (req.url === `/${DID}`) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: DID,
          alsoKnownAs: ['at://alice.example.net'],
          service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.example.net' }],
        }));
        return;
      }
      res.writeHead(404); res.end('{}');
    });
    await new Promise<void>((r) => own.listen(0, '127.0.0.1', r));
    ownUrl = `http://127.0.0.1:${(own.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise((r) => own.close(r)); });

  it('reads the handle and PDS from the directory that has the DID', async () => {
    const r = await checkIdentity(DID, { directories: [ownUrl] });
    expect(r.did).toBe(DID);
    expect(r.handle).toBe('alice.example.net');
    expect(r.directories).toEqual([{ url: ownUrl, status: 'found', handle: 'alice.example.net', pds: 'https://pds.example.net' }]);
    expect(r.problems).toEqual([]);
  });

  it('a DID no listed directory knows is a problem', async () => {
    const r = await checkIdentity('did:plc:bbbbbbbbbbbbbbbbbbbbbbbb', { directories: [ownUrl] });
    expect(r.directories[0].status).toBe('missing');
    expect(r.problems.join(' ')).toMatch(/No listed directory knows/);
  });
});
