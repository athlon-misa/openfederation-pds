import { describe, it, expect } from 'vitest';
import { randomBytes } from 'crypto';
import { Secp256k1Keypair } from '@atproto/crypto';
import { Repo, WriteOpAction } from '@atproto/repo';
import { RepoEngine } from '../../src/repo/repo-engine.js';

const COLLECTION = 'net.openfederation.test.record';

async function freshRepo(initial: number) {
  const did = `did:plc:${randomBytes(12).toString('hex')}`;
  const keypair = await Secp256k1Keypair.create();
  const engine = new RepoEngine(did);
  const writes = Array.from({ length: initial }, (_, i) => ({
    collection: COLLECTION,
    rkey: `seed${String(i).padStart(4, '0')}`,
    record: { $type: COLLECTION, n: i },
  }));
  await engine.createRepo(keypair, writes);
  return { did, keypair, engine, seedKeys: writes.map((w) => w.rkey) };
}

/** Every key must be reachable through the signed tree, not just the index. */
async function expectAllInTree(engine: RepoEngine, rkeys: string[]) {
  const repo = await Repo.load(engine.getStorage());
  for (const rkey of rkeys) {
    const record = await repo.getRecord(COLLECTION, rkey);
    expect(record, `record ${rkey} missing from MST`).not.toBeNull();
  }
  // The whole repo must still be walkable (no dangling MST nodes).
  let bytes = 0;
  for await (const chunk of await engine.exportAsCAR()) bytes += chunk.length;
  expect(bytes).toBeGreaterThan(0);
}

describe('RepoEngine concurrent writes', () => {
  it('keeps every record when many writes to one repo run in parallel', async () => {
    const { keypair, engine, seedKeys } = await freshRepo(300);
    const newKeys = Array.from({ length: 25 }, (_, i) => `par${String(i).padStart(4, '0')}`);

    await Promise.all(
      newKeys.map((rkey, i) => engine.putRecord(keypair, COLLECTION, rkey, { $type: COLLECTION, p: i })),
    );

    await expectAllInTree(engine, [...seedKeys, ...newKeys]);
    const indexed = await engine.exportAllRecords();
    expect(indexed.length).toBe(seedKeys.length + newKeys.length);
  });

  it('keeps the tree intact when writes, updates and deletes interleave', async () => {
    const { did, keypair, engine, seedKeys } = await freshRepo(120);
    const other = new RepoEngine(did); // a second engine instance for the same repo
    const deleted = seedKeys.slice(0, 10);
    const added = Array.from({ length: 10 }, (_, i) => `mix${i}`);

    await Promise.all([
      ...deleted.map((rkey) => other.deleteRecord(keypair, COLLECTION, rkey)),
      ...added.map((rkey) => engine.putRecord(keypair, COLLECTION, rkey, { $type: COLLECTION, m: rkey })),
      engine.applyWrites(keypair, [
        { action: 'write', collection: COLLECTION, rkey: seedKeys[50], record: { $type: COLLECTION, n: -1 } },
        { action: 'write', collection: COLLECTION, rkey: 'batch0', record: { $type: COLLECTION, b: 0 } },
      ]),
    ]);

    await expectAllInTree(engine, [...seedKeys.slice(10), ...added, 'batch0']);
    const repo = await Repo.load(engine.getStorage());
    for (const rkey of deleted) expect(await repo.getRecord(COLLECTION, rkey)).toBeNull();
  });

  it('refuses a commit built on a root that is no longer current', async () => {
    const { keypair, engine } = await freshRepo(5);
    const storage = engine.getStorage();
    const repoA = await Repo.load(storage);
    const repoB = await Repo.load(storage);
    const commitA = await repoA.formatCommit(
      { action: WriteOpAction.Create, collection: COLLECTION, rkey: 'a', record: { $type: COLLECTION } },
      keypair,
    );
    const commitB = await repoB.formatCommit(
      { action: WriteOpAction.Create, collection: COLLECTION, rkey: 'b', record: { $type: COLLECTION } },
      keypair,
    );
    await storage.applyCommit(commitA);
    await expect(storage.applyCommit(commitB)).rejects.toThrow(/concurrent/i);
    expect((await storage.getRoot())?.toString()).toBe(commitA.cid.toString());
  });
});
