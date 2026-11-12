/**
 * tombstone(): a plc_tombstone signed with the pseudonym's words, checked
 * against a fake PLC directory that validates it the way PLC does
 * (prev = CID of the last operation, signature by a current rotation key).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifySignature } from '@atproto/crypto';
import * as dagCbor from '@ipld/dag-cbor';
import { generatePseudonymPhrase, derivePseudonymKeys } from '../../packages/openfederation-pseudonym/src/keys.js';
import {
  buildPseudonymGenesisOp, signGenesisOp, didForSignedOp, buildMoveOp, signPlcOp, cidForPlcOp,
} from '../../packages/openfederation-pseudonym/src/plc.js';
import { tombstone, buildTombstoneOp, signTombstoneOp } from '../../packages/openfederation-pseudonym/src/tombstone.js';
import { base64UrlDecode } from '../../packages/openfederation-pseudonym/src/formats.js';

type Op = Record<string, any>;

function fakePlc() {
  const logs = new Map<string, Op[]>();
  const posts: Op[] = [];
  const server = http.createServer(async (req, res) => {
    const [, did, tail] = (req.url ?? '').split('/');
    const log = logs.get(did);
    if (req.method === 'GET' && tail === 'log') {
      if (!log) { res.writeHead(404).end('not registered'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(log));
      return;
    }
    if (req.method === 'POST' && !tail) {
      let body = '';
      for await (const chunk of req) body += chunk;
      const op = JSON.parse(body) as Op;
      posts.push(op);
      const last = log?.[log.length - 1];
      const { sig, ...unsigned } = op;
      const ok = !!last && last.type !== 'plc_tombstone' && op.prev === cidForPlcOp(last)
        && (await Promise.all((last.rotationKeys as string[]).map((k) =>
          verifySignature(k, dagCbor.encode(unsigned), base64UrlDecode(sig))))).some(Boolean);
      if (!ok) { res.writeHead(400).end('Invalid signature or prev'); return; }
      log!.push(op);
      res.writeHead(200).end();
      return;
    }
    res.writeHead(404).end();
  });
  return { server, logs, posts };
}

describe('pseudonym tombstone', () => {
  const plc = fakePlc();
  let plcUrl = '';
  beforeAll(async () => {
    await new Promise<void>((r) => plc.server.listen(0, '127.0.0.1', () => r()));
    plcUrl = `http://127.0.0.1:${(plc.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise((r) => plc.server.close(r)); });

  function register(phrase: string, moved = false): string {
    const keys = derivePseudonymKeys(phrase);
    const genesis = signGenesisOp(buildPseudonymGenesisOp({
      ownerDidKey: keys.ownerDidKey, signingDidKey: keys.ownerDidKey, handle: 'nd.a.example',
      pdsEndpoint: 'https://a.example', ownerDid: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', commitmentSaltHex: keys.commitmentSaltHex,
    }), keys.ownerPrivateKey);
    const did = didForSignedOp(genesis);
    const log: Op[] = [genesis];
    if (moved) {
      log.push(signPlcOp(buildMoveOp({ previous: genesis, signingDidKey: keys.ownerDidKey, pdsEndpoint: 'https://b.example', handle: 'nd.b.example' }),
        keys.ownerPrivateKey));
    }
    plc.logs.set(did, log);
    return did;
  }

  it('builds { type, prev } with prev = CID of the last operation, signed over its dag-cbor', async () => {
    const phrase = generatePseudonymPhrase();
    const keys = derivePseudonymKeys(phrase);
    const did = register(phrase);
    const genesis = plc.logs.get(did)![0];
    const op = buildTombstoneOp(genesis);
    expect(op).toEqual({ type: 'plc_tombstone', prev: cidForPlcOp(genesis) });
    const signed = signTombstoneOp(op, keys.ownerPrivateKey);
    expect(Object.keys(signed).sort()).toEqual(['prev', 'sig', 'type']);
    expect(await verifySignature(keys.ownerDidKey, dagCbor.encode(op), base64UrlDecode(signed.sig))).toBe(true);
  });

  it('tombstones a moved pseudonym: prev names the move, not the genesis', async () => {
    const phrase = generatePseudonymPhrase();
    const did = register(phrase, true);
    const [, move] = plc.logs.get(did)!;
    const op = await tombstone({ plcUrl, did, phrase });
    expect(op.prev).toBe(cidForPlcOp(move));
    const log = plc.logs.get(did)!;
    expect(log).toHaveLength(3);
    expect(log[2]).toEqual(op);
  });

  it('refuses other words before posting anything', async () => {
    const did = register(generatePseudonymPhrase());
    const before = plc.posts.length;
    await expect(tombstone({ plcUrl, did, phrase: generatePseudonymPhrase() })).rejects.toThrow(/NotRotationKey/);
    expect(plc.posts.length).toBe(before);
    expect(plc.logs.get(did)).toHaveLength(1);
  });

  it('refuses a DID that is already tombstoned', async () => {
    const phrase = generatePseudonymPhrase();
    const did = register(phrase);
    await tombstone({ plcUrl, did, phrase });
    const before = plc.posts.length;
    await expect(tombstone({ plcUrl, did, phrase })).rejects.toThrow(/AlreadyTombstoned/);
    expect(plc.posts.length).toBe(before);
  });

  it('reports an unknown DID', async () => {
    await expect(tombstone({ plcUrl, did: 'did:plc:unknownunknownunknown12', phrase: generatePseudonymPhrase() }))
      .rejects.toThrow(/PLC log lookup failed \(404\)/);
  });
});
