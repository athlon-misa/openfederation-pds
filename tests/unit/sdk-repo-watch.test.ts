/**
 * Repo monitoring and leaving a PDS (#241), against a fake PDS whose
 * repository is a real @atproto/repo MST: the watcher notices writes this
 * device did not make; leavePds moves the DID with the person's own key;
 * copyRepo imports into a new PDS.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryBlockstore, Repo, WriteOpAction, getFullRepo, cidForRecord } from '@atproto/repo';
import { Secp256k1Keypair } from '@atproto/crypto';
import { TID } from '@atproto/common-web';
import {
  RepoWatcher, MemoryStorageAdapter, readRepoCar, readCar, verifyRepoCommit, revToTime,
  buildLeaveOp, leavePds, copyRepo, generateCustodyPhrase, deriveCustodyKeys, buildCustodyGenesisOp,
  signPlcOperation, didForGenesisOp, submitPlcOperation, cidForPlcOp, plcOperationSigner,
  type SignedPlcOperation,
} from '../../packages/openfederation-sdk/src/custody/index.js';

const PLC = process.env.PLC_DIRECTORY_URL || 'http://localhost:2582';
async function plcUp(): Promise<boolean> {
  try { return (await fetch(`${PLC}/_health`)).ok; } catch { return false; }
}

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';
const POST = 'app.bsky.feed.post';

/** A PDS serving one repository over com.atproto.sync, writable by the "user" and by the "operator". */
class FakePds {
  storage = new MemoryBlockstore();
  repo!: Repo;
  key!: Secp256k1Keypair;
  calls: string[] = [];
  /** What this PDS shows: by default its real repo; a hostile one can freeze an old CAR. */
  served?: Uint8Array;

  static async create(): Promise<FakePds> {
    const pds = new FakePds();
    pds.key = await Secp256k1Keypair.create({ exportable: true });
    pds.repo = await Repo.create(pds.storage, DID, pds.key, [
      { action: WriteOpAction.Create, collection: 'app.bsky.actor.profile', rkey: 'self', record: { displayName: 'Elena' } },
    ]);
    return pds;
  }

  async put(collection: string, rkey: string, record: Record<string, unknown>) {
    const exists = !!(await this.repo.getRecord(collection, rkey));
    this.repo = await this.repo.applyWrites(
      { action: exists ? WriteOpAction.Update : WriteOpAction.Create, collection, rkey, record }, this.key);
    return {
      uri: `at://${DID}/${collection}/${rkey}`, cid: (await cidForRecord(record)).toString(),
      commit: { cid: this.repo.cid.toString(), rev: this.repo.commit.rev },
    };
  }

  async del(collection: string, rkey: string) {
    this.repo = await this.repo.applyWrites({ action: WriteOpAction.Delete, collection, rkey }, this.key);
    return { commit: { cid: this.repo.cid.toString(), rev: this.repo.commit.rev } };
  }

  async car(): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    for await (const c of getFullRepo(this.storage, this.repo.cid)) chunks.push(c);
    return Buffer.concat(chunks);
  }

  /** The SDK client's fetch, as the user's device calls it. */
  client = {
    fetch: async (nsid: string, opts: { body: Record<string, unknown> }) => {
      const b = opts.body as { collection: string; rkey?: string; record?: Record<string, unknown> };
      if (nsid === 'com.atproto.repo.createRecord') return this.put(b.collection, b.rkey ?? TID.nextStr(), b.record!);
      if (nsid === 'com.atproto.repo.putRecord') return this.put(b.collection, b.rkey!, b.record!);
      if (nsid === 'com.atproto.repo.deleteRecord') return this.del(b.collection, b.rkey!);
      throw new Error(`unexpected ${nsid}`);
    },
  };

  fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    this.calls.push(url.pathname);
    const car = this.served ?? await this.car();
    if (url.pathname === '/xrpc/com.atproto.sync.getLatestCommit') {
      const { commit } = readRepoCar(car);
      return Response.json({ cid: commit.cid, rev: commit.rev });
    }
    if (url.pathname === '/xrpc/com.atproto.sync.getRepo') return new Response(car);
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;
}

describe('reading a repository CAR', () => {
  it('lists every record with its CID and checks the commit signature', async () => {
    const pds = await FakePds.create();
    const written = await pds.put(POST, 'p1', { text: 'hello', createdAt: new Date().toISOString() });
    const { commit, records } = readRepoCar(await pds.car());
    expect(commit.did).toBe(DID);
    expect(commit.cid).toBe(pds.repo.cid.toString());
    expect(commit.rev).toBe(pds.repo.commit.rev);
    expect([...records.keys()].sort()).toEqual(['app.bsky.actor.profile/self', `${POST}/p1`]);
    expect(records.get(`${POST}/p1`)).toBe(written.cid);

    expect(verifyRepoCommit(commit, pds.key.did())).toBe(true);
    const other = await Secp256k1Keypair.create();
    expect(verifyRepoCommit(commit, other.did())).toBe(false);

    const t = revToTime(commit.rev)!;
    expect(Math.abs(Date.parse(t) - Date.now())).toBeLessThan(60_000);
    expect(revToTime('not-a-tid')).toBeNull();
  });

  it('refuses a block that does not match its CID', async () => {
    const pds = await FakePds.create();
    const car = await pds.car();
    car[car.length - 1] ^= 0xff;
    expect(() => readCar(car)).toThrow(/does not match its CID/);
  });
});

describe('RepoWatcher', () => {
  let pds: FakePds;
  let watcher: RepoWatcher;
  beforeEach(async () => {
    pds = await FakePds.create();
    watcher = new RepoWatcher({ source: 'https://pds.test', fetch: pds.fetch });
  });

  it('records a baseline first, then stays clean for the device\'s own writes', async () => {
    expect((await watcher.check(DID)).status).toBe('baseline');
    const created = await watcher.write(pds.client, 'com.atproto.repo.createRecord', { repo: DID, collection: POST, record: { text: 'one' } }) as { uri: string };
    const rkey = created.uri.split('/').pop()!;
    await watcher.write(pds.client, 'com.atproto.repo.putRecord', { repo: DID, collection: POST, rkey, record: { text: 'one, edited' } });
    await watcher.write(pds.client, 'com.atproto.repo.putRecord', { repo: DID, collection: POST, rkey: 'two', record: { text: 'two' } });
    await watcher.write(pds.client, 'com.atproto.repo.deleteRecord', { repo: DID, collection: POST, rkey: 'two' });

    const result = await watcher.check(DID);
    expect(result.status).toBe('clean');
    expect(result.unknownCommits).toEqual([]);
    expect(result.latest).toMatchObject({ cid: pds.repo.cid.toString(), rev: pds.repo.commit.rev, own: true });
  });

  it('does not download the repository when nothing changed', async () => {
    await watcher.check(DID);
    await watcher.check(DID);
    pds.calls = [];
    expect((await watcher.check(DID)).status).toBe('clean');
    expect(pds.calls).toEqual(['/xrpc/com.atproto.sync.getLatestCommit']);
  });

  it('reports a record the operator wrote, with rev, cid, time and the signed commit, until acknowledged', async () => {
    await watcher.check(DID);
    const before = { rev: pds.repo.commit.rev, cid: pds.repo.cid.toString() };
    await watcher.write(pds.client, 'com.atproto.repo.putRecord', { repo: DID, collection: POST, rkey: 'mine', record: { text: 'mine' } });
    const forged = await pds.put(POST, 'forged', { text: 'I resign' }); // the operator, not the device

    const result = await watcher.check(DID);
    expect(result.status).toBe('unknown-changes');
    expect(result.latest.own).toBe(false);
    expect(result.unknownCommits).toHaveLength(1);
    const u = result.unknownCommits[0];
    expect(u).toMatchObject({ rev: forged.commit.rev, cid: forged.commit.cid, since: before });
    expect(u.time).toBe(revToTime(forged.commit.rev));
    expect(u.changes).toEqual([
      { path: `${POST}/forged`, collection: POST, rkey: 'forged', action: 'create', cid: forged.cid, expectedCid: null },
    ]);
    expect(verifyRepoCommit(u.commit, pds.key.did())).toBe(true);
    expect(result.car).toBeInstanceOf(Uint8Array);

    expect((await watcher.check(DID)).status).toBe('unknown-changes'); // still reported
    watcher.acknowledge(DID, result);
    expect((await watcher.check(DID)).status).toBe('clean');
  });

  it('reports an operator\'s edit and deletion of the device\'s own records', async () => {
    await watcher.check(DID);
    const a = await watcher.write(pds.client, 'com.atproto.repo.putRecord', { repo: DID, collection: POST, rkey: 'a', record: { text: 'a' } }) as { cid: string };
    const b = await watcher.write(pds.client, 'com.atproto.repo.putRecord', { repo: DID, collection: POST, rkey: 'b', record: { text: 'b' } }) as { cid: string };
    const edited = await pds.put(POST, 'a', { text: 'a, but worse' });
    await pds.del(POST, 'b');

    const { status, unknownCommits } = await watcher.check(DID);
    expect(status).toBe('unknown-changes');
    expect(unknownCommits[0].changes).toEqual([
      { path: `${POST}/a`, collection: POST, rkey: 'a', action: 'update', cid: edited.cid, expectedCid: a.cid },
      { path: `${POST}/b`, collection: POST, rkey: 'b', action: 'delete', cid: null, expectedCid: b.cid },
    ]);
  });

  it('watches only the collections asked for', async () => {
    const posts = new RepoWatcher({ source: 'https://pds.test', fetch: pds.fetch, collections: [POST] });
    await posts.check(DID);
    await pds.put('app.bsky.graph.follow', 'f1', { subject: 'did:plc:someone' });
    expect((await posts.check(DID)).status).toBe('clean');
    await pds.put(POST, 'x', { text: 'x' });
    expect((await posts.check(DID)).status).toBe('unknown-changes');
  });

  it('keeps its state in the storage it is given', async () => {
    const storage = new MemoryStorageAdapter();
    await new RepoWatcher({ source: 'https://pds.test', fetch: pds.fetch, storage }).check(DID);
    await pds.put(POST, 'forged', { text: 'forged' });
    const later = new RepoWatcher({ source: 'https://pds.test', fetch: pds.fetch, storage });
    expect((await later.check(DID)).status).toBe('unknown-changes');
    later.forget(DID);
    expect((await later.check(DID)).status).toBe('baseline');
  });

  it('can check another copy: a hostile PDS shows its own client an old repository', async () => {
    const network = (async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.host === 'pds.test') return pds.fetch(input);
      // relay.test: a mirror serving what everyone else sees
      const car = await pds.car();
      if (url.pathname.endsWith('getLatestCommit')) {
        const { commit } = readRepoCar(car);
        return Response.json({ cid: commit.cid, rev: commit.rev });
      }
      return new Response(car);
    }) as typeof globalThis.fetch;
    const device = new RepoWatcher({ source: 'https://pds.test', fetch: network });
    await device.check(DID);
    pds.served = await pds.car(); // the hostile PDS keeps showing the user this
    await pds.put(POST, 'forged', { text: 'forged' }); // and everyone else this

    expect((await device.check(DID)).status).toBe('clean');
    const viaRelay = await device.check(DID, { source: 'https://relay.test' });
    expect(viaRelay.status).toBe('unknown-changes');
    expect(viaRelay.source).toBe('https://relay.test');
    expect(viaRelay.unknownCommits[0].changes.map((c) => c.rkey)).toEqual(['forged']);
  });

  it('understands applyWrites results', () => {
    const storage = new MemoryStorageAdapter();
    const w = new RepoWatcher({ source: 'https://pds.test', fetch: pds.fetch, storage });
    w.recordOwnCommit(DID, { writes: [{ action: 'create', collection: POST, rkey: 'old', cid: 'bafyold' }] });
    w.recordWriteResult('com.atproto.repo.applyWrites', {
      repo: 'alice.example', writes: [
        { $type: 'com.atproto.repo.applyWrites#create', collection: POST, value: {} },
        { $type: 'com.atproto.repo.applyWrites#delete', collection: POST, rkey: 'old' },
      ],
    }, { commit: { cid: 'bafycommit', rev: '3abc' }, results: [{ uri: `at://${DID}/${POST}/new`, cid: 'bafyrecord' }, {}] });
    w.recordWriteResult('com.atproto.server.getSession', {}, {}); // not a write: ignored
    const state = JSON.parse(storage.get(`of_repo_watch:${DID}`)!);
    expect(state.expected).toEqual({ [`${POST}/new`]: 'bafyrecord' });
    expect(state.own).toEqual(['bafycommit']);
    expect(() => w.recordOwnCommit(DID, { writes: [{ action: 'create', collection: POST, rkey: 'r' }] })).toThrow(/record CID/);
  });
});

describe('leaving a PDS with the person\'s own key', () => {
  async function newAccount(mode: 'self' | 'assisted') {
    const keys = deriveCustodyKeys(generateCustodyPhrase());
    const oldPdsKey = await Secp256k1Keypair.create();
    const pdsRotation = await Secp256k1Keypair.create();
    const genesis = signPlcOperation(buildCustodyGenesisOp({
      mode, userRotationDidKey: keys.rotationDidKey, pdsRotationDidKey: pdsRotation.did(),
      atprotoDidKey: oldPdsKey.did(), ownerDidKey: keys.ownerDidKey,
      handle: `leave${Date.now()}${Math.floor(Math.random() * 1e6)}.old.test`, pdsEndpoint: 'https://old.test',
    }), keys.rotationPrivateKey);
    const did = didForGenesisOp(genesis);
    await submitPlcOperation(PLC, did, genesis);
    return { keys, did, genesis, pdsRotation };
  }

  it('buildLeaveOp changes the PDS and repo key, keeps the owner key', () => {
    const keys = deriveCustodyKeys(generateCustodyPhrase());
    const previous = signPlcOperation(buildCustodyGenesisOp({
      mode: 'self', userRotationDidKey: keys.rotationDidKey, atprotoDidKey: keys.ownerDidKey,
      ownerDidKey: keys.ownerDidKey, handle: 'a.old.test', pdsEndpoint: 'https://old.test',
    }), keys.rotationPrivateKey) as SignedPlcOperation;
    const op = buildLeaveOp({ previous, pdsEndpoint: 'https://new.test', atprotoDidKey: 'did:key:zNew', rotationKeys: [keys.rotationDidKey], handle: 'a.new.test' });
    expect(op.prev).toBe(cidForPlcOp(previous));
    expect(op.services.atproto_pds.endpoint).toBe('https://new.test');
    expect(op.verificationMethods).toEqual({ atproto: 'did:key:zNew', openfederation_owner: keys.ownerDidKey });
    expect(op.alsoKnownAs).toEqual(['at://a.new.test']);
  });

  it('points a self account\'s DID at a new PDS; PLC accepts it without the old PDS', async () => {
    if (!(await plcUp())) return;
    const { keys, did } = await newAccount('self');
    const newKey = await Secp256k1Keypair.create();
    const { operation } = await leavePds({
      plcUrl: PLC, did, rotationPrivateKey: keys.rotationPrivateKey, pdsEndpoint: 'https://new.test', atprotoDidKey: newKey.did(),
    });
    const data = await (await fetch(`${PLC}/${did}/data`)).json();
    expect(data.services.atproto_pds.endpoint).toBe('https://new.test');
    expect(data.verificationMethods).toEqual({ atproto: newKey.did(), openfederation_owner: keys.ownerDidKey });
    expect(data.rotationKeys).toEqual([keys.rotationDidKey]);
    expect(plcOperationSigner(operation, [keys.rotationDidKey])).toBe(keys.rotationDidKey);
  });

  it('drops the PDS\'s rotation key from an assisted account unless asked to keep it', async () => {
    if (!(await plcUp())) return;
    const { keys, did, pdsRotation } = await newAccount('assisted');
    await leavePds({ plcUrl: PLC, did, rotationPrivateKey: keys.rotationPrivateKey, pdsEndpoint: 'https://new.test', atprotoDidKey: pdsRotation.did(), keepOtherRotationKeys: true });
    expect((await (await fetch(`${PLC}/${did}/data`)).json()).rotationKeys).toEqual([keys.rotationDidKey, pdsRotation.did()]);
    await leavePds({ plcUrl: PLC, did, rotationPrivateKey: keys.rotationPrivateKey, pdsEndpoint: 'https://newer.test', atprotoDidKey: pdsRotation.did() });
    expect((await (await fetch(`${PLC}/${did}/data`)).json()).rotationKeys).toEqual([keys.rotationDidKey]);
  });

  it('refuses before submitting when the key is not a rotation key of the DID', async () => {
    if (!(await plcUp())) return;
    const { did } = await newAccount('self');
    const stranger = deriveCustodyKeys(generateCustodyPhrase());
    await expect(leavePds({ plcUrl: PLC, did, rotationPrivateKey: stranger.rotationPrivateKey, pdsEndpoint: 'https://x.test', atprotoDidKey: stranger.ownerDidKey }))
      .rejects.toThrow(/not a rotation key/);
  });
});

describe('copyRepo', () => {
  it('imports a saved CAR into the new PDS and copies the blobs it is missing', async () => {
    const pds = await FakePds.create();
    await pds.put(POST, 'p', { text: 'kept' });
    const car = await pds.car();
    const seen: string[] = [];
    let missing = ['bafkblob1'];
    let imported: Uint8Array | undefined;
    const fake = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push(`${url.host}${url.pathname}`);
      if (url.pathname.endsWith('importRepo')) { imported = init!.body as Uint8Array; return Response.json({}); }
      if (url.pathname.endsWith('listMissingBlobs')) return Response.json({ blobs: missing.map((cid) => ({ cid })) });
      if (url.pathname.endsWith('getBlob')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
      if (url.pathname.endsWith('uploadBlob')) { missing = []; return Response.json({ blob: { ref: { $link: 'bafkblob1' } } }); }
      return new Response('', { status: 404 });
    }) as typeof globalThis.fetch;

    const result = await copyRepo({ did: DID, toUrl: 'https://new.test', accessJwt: 'jwt', fromUrl: 'https://old.test', car, fetch: fake });
    expect(result).toEqual({ commit: { rev: pds.repo.commit.rev, cid: pds.repo.cid.toString() }, blobsCopied: 1 });
    expect(imported).toBe(car);
    expect(seen).not.toContain('old.test/xrpc/com.atproto.sync.getRepo'); // the saved copy was used
    await expect(copyRepo({ did: 'did:plc:someoneelse', toUrl: 'https://new.test', accessJwt: 'jwt', car, fetch: fake }))
      .rejects.toThrow(/is for did:plc:abc/);
  });
});
