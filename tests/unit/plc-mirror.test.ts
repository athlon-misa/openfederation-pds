/**
 * plc-server/mirror.js: one-way, append-only replication of PLC operation
 * logs into another directory (docs/PLC-MIRROR.md). Two fake directories
 * over HTTP stand in for plc.openfederation.net and plc.directory.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const mirror = require('../../plc-server/mirror.js') as {
  planDid: (s: unknown[] | null, t: unknown[] | null) => { status: string; toSend: unknown[] };
  mirrorOnce: (o: Record<string, unknown>) => Promise<{ checked: number; sent: number; same: number; diverged: string[]; failed: { did: string }[]; cursor: string | null }>;
  readMirrorTargets: (env: Record<string, string>) => string[];
  readDidList: (raw: string | undefined, name: string) => string[] | null;
};

const A = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'did:plc:cccccccccccccccccccccccc';
const op = (did: string, n: number) => ({ type: 'plc_operation', did, n, prev: n === 0 ? null : `${did}-${n - 1}` });

/** A directory: logs per DID, /export, /:did/log, and POST /:did that only accepts the next op in order. */
function directory(logs: Map<string, unknown[]>, opts: { refuse?: Set<string> } = {}) {
  const posted: { did: string; op: unknown }[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'GET' && url.pathname === '/export') {
      const lines = [...logs.entries()].flatMap(([did, ops]) => ops.map((o, i) => JSON.stringify({ did, operation: o, createdAt: `2026-01-01T00:00:0${i}.000Z` })));
      res.writeHead(200, { 'content-type': 'application/jsonlines' });
      res.end(lines.join('\n'));
      return;
    }
    const m = url.pathname.match(/^\/(did:plc:[a-z2-7]{24})(\/log)?$/);
    if (!m) { res.writeHead(404); res.end(); return; }
    const did = m[1];
    if (req.method === 'GET' && m[2]) {
      const log = logs.get(did);
      if (!log) { res.writeHead(404); res.end('{}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(log));
      return;
    }
    if (req.method === 'POST' && !m[2]) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const o = JSON.parse(body) as { n: number };
        const log = logs.get(did) ?? [];
        if (opts.refuse?.has(did) || o.n !== log.length) { res.writeHead(400); res.end('{"message":"invalid prev"}'); return; }
        logs.set(did, [...log, o]);
        posted.push({ did, op: o });
        res.writeHead(200); res.end('');
      });
      return;
    }
    res.writeHead(405); res.end();
  });
  return { server, posted, logs };
}

const listen = (s: http.Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

describe('planDid', () => {
  const src = [op(A, 0), op(A, 1), op(A, 2)];
  it('sends everything to a directory that has nothing', () => {
    expect(mirror.planDid(src, null)).toEqual({ status: 'missing', toSend: src });
  });
  it('sends only what a directory that is behind is missing, in order', () => {
    expect(mirror.planDid(src, src.slice(0, 1))).toEqual({ status: 'behind', toSend: src.slice(1) });
  });
  it('nothing for an equal log, whatever the key order', () => {
    const reordered = src.map((o) => Object.fromEntries(Object.entries(o).reverse()));
    expect(mirror.planDid(src, reordered)).toEqual({ status: 'same', toSend: [] });
  });
  it('never overwrites a history that differs', () => {
    expect(mirror.planDid(src, [op(A, 0), { ...op(A, 1), n: 99 }]).status).toBe('diverged');
    expect(mirror.planDid(src.slice(0, 1), src).status).toBe('diverged');
  });
});

describe('mirrorOnce', () => {
  let source: ReturnType<typeof directory>;
  let target: ReturnType<typeof directory>;
  let srcUrl: string;
  let tgtUrl: string;

  beforeAll(async () => {
    source = directory(new Map([[A, [op(A, 0), op(A, 1)]], [B, [op(B, 0)]], [C, [op(C, 0)]]]));
    // The target already has A's genesis and a different history for C.
    target = directory(new Map([[A, [op(A, 0)]], [C, [{ ...op(C, 0), n: 0, other: true }]]]));
    [srcUrl, tgtUrl] = await Promise.all([listen(source.server), listen(target.server)]);
  });
  afterAll(async () => {
    await Promise.all([source.server, target.server].map((s) => new Promise((r) => s.close(r))));
  });

  it('a dry run sends nothing', async () => {
    const s = await mirror.mirrorOnce({ source: srcUrl, target: tgtUrl });
    expect(s.checked).toBe(3);
    expect(s.sent).toBe(0);
    expect(target.posted).toHaveLength(0);
  });

  it('applied: the missing operations arrive in order; a diverged DID is left alone', async () => {
    const s = await mirror.mirrorOnce({ source: srcUrl, target: tgtUrl, apply: true });
    expect(s.sent).toBe(2);
    expect(s.diverged).toEqual([C]);
    expect(target.posted.map((p) => [p.did, (p.op as { n: number }).n])).toEqual([[A, 1], [B, 0]]);
    expect(target.logs.get(A)).toEqual(source.logs.get(A));
    expect(target.logs.get(C)).toEqual([{ ...op(C, 0), n: 0, other: true }]);
    expect(s.cursor).toBeTruthy();
  });

  it('a second pass finds everything there', async () => {
    const s = await mirror.mirrorOnce({ source: srcUrl, target: tgtUrl, apply: true });
    expect(s.sent).toBe(0);
    expect(s.same).toBe(2);
  });

  it('refuses to mirror a directory into itself', async () => {
    await expect(mirror.mirrorOnce({ source: srcUrl, target: `${srcUrl}/` })).rejects.toThrow(/same directory/);
  });
});

describe('a failed operation keeps the cursor, so the next pass retries', () => {
  it('reports the failure and does not move past it', async () => {
    const source = directory(new Map([[A, [op(A, 0)]]]));
    const target = directory(new Map(), { refuse: new Set([A]) });
    const [s1, t1] = await Promise.all([listen(source.server), listen(target.server)]);
    try {
      const s = await mirror.mirrorOnce({ source: s1, target: t1, apply: true, after: '2025-12-31T00:00:00.000Z' });
      expect(s.failed.map((f) => f.did)).toEqual([A]);
      expect(s.cursor).toBe('2025-12-31T00:00:00.000Z');
    } finally {
      await Promise.all([source.server, target.server].map((x) => new Promise((r) => x.close(r))));
    }
  });
});

describe('test accounts stay out of the public directory', () => {
  const tomb = (did: string) => ({ type: 'plc_tombstone', did, prev: `${did}-0` });

  it('a DID removed here is not published to a directory that never had it', () => {
    expect(mirror.planDid([op(A, 0), tomb(A)], null)).toEqual({ status: 'tombstoned', toSend: [] });
  });

  it('a DID the target already has gets its tombstone, so it is deactivated there too', () => {
    expect(mirror.planDid([op(A, 0), tomb(A)], [op(A, 0)])).toEqual({ status: 'behind', toSend: [tomb(A)] });
  });

  it('only the allowed DIDs are mirrored; excluded ones never', async () => {
    const source = directory(new Map([[A, [op(A, 0)]], [B, [op(B, 0)]], [C, [op(C, 0)]]]));
    const target = directory(new Map());
    const [s1, t1] = await Promise.all([listen(source.server), listen(target.server)]);
    try {
      const only = await mirror.mirrorOnce({ source: s1, target: t1, apply: true, only: [A, B], exclude: [B] });
      expect(target.posted.map((p) => p.did)).toEqual([A]);
      expect(only.skipped).toBe(2);
    } finally {
      await Promise.all([source.server, target.server].map((x) => new Promise((r) => x.close(r))));
    }
  });

  it('DID lists accept did:plc only', () => {
    expect(mirror.readDidList(` ${A}, ${B} `, 'X')).toEqual([A, B]);
    expect(mirror.readDidList('', 'X')).toBeNull();
    expect(() => mirror.readDidList('did:web:example.com', 'PLC_MIRROR_ONLY_DIDS')).toThrow(/PLC_MIRROR_ONLY_DIDS/);
  });
});

describe('PLC_MIRROR_TARGETS', () => {
  it('off when unset; a list otherwise; invalid stops the service', () => {
    expect(mirror.readMirrorTargets({})).toEqual([]);
    expect(mirror.readMirrorTargets({ PLC_MIRROR_TARGETS: 'https://plc.directory/, https://plc.directory' })).toEqual(['https://plc.directory']);
    expect(() => mirror.readMirrorTargets({ PLC_MIRROR_TARGETS: 'ftp://x' })).toThrow(/PLC_MIRROR_TARGETS/);
  });
});
