/**
 * A private community must look exactly like a DID that does not exist to
 * anyone outside it: every endpoint that takes a community or repo DID answers
 * an outsider with the same status and error for both. A different answer
 * (403 NotMember, 410 taken down, a status error) confirms the community
 * exists.
 *
 * The endpoint list comes from the lexicons, so a new endpoint is covered
 * without touching this file.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, xrpcAuthPost, createTestUser, isPLCAvailable, uniqueHandle } from './helpers.js';

const DID_KEYS = ['communityDid', 'did', 'repo'];

/** Endpoints where telling the DID exists is the point (with the reason). */
const EXEMPT: Record<string, string> = {
  'net.openfederation.community.join': 'joining by DID (from an invite) must reach the community',
  'net.openfederation.community.migrateIn': 'creates a community here; not a read of an existing one',
  'com.atproto.server.createAccount': 'not a community endpoint',
  'net.openfederation.pseudonym.createAccount': 'not a community endpoint',
};

type Endpoint = { nsid: string; type: 'query' | 'procedure'; didKey: string; required: Record<string, unknown> };

function dummy(schema: any): unknown {
  switch (schema?.type) {
    case 'integer': return 1;
    case 'boolean': return false;
    case 'array': return [];
    case 'object': case 'ref': case 'union': return {};
    default: return schema?.knownValues?.[0] ?? schema?.enum?.[0] ?? 'x';
  }
}

function endpoints(): Endpoint[] {
  const dir = join(process.cwd(), 'src/lexicon');
  const out: Endpoint[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const doc = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const main = doc.defs?.main;
    if (main?.type !== 'query' && main?.type !== 'procedure') continue;
    const schema = main.type === 'query' ? main.parameters : main.input?.schema;
    const props = schema?.properties ?? {};
    const didKey = DID_KEYS.find((k) => k in props);
    if (!didKey || doc.id in EXEMPT) continue;
    const required: Record<string, unknown> = {};
    for (const key of schema.required ?? []) if (key !== didKey) required[key] = dummy(props[key]);
    out.push({ nsid: doc.id, type: main.type, didKey, required });
  }
  return out;
}

async function call(e: Endpoint, did: string, token: string) {
  const input = { ...e.required, [e.didKey]: did };
  const res = e.type === 'query'
    ? await api.get(`/xrpc/${e.nsid}`).set('Authorization', `Bearer ${token}`)
        .query(Object.fromEntries(Object.entries(input).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])))
    : await xrpcAuthPost(e.nsid, token, input);
  return { status: res.status, error: res.body?.error as string | undefined };
}

describe('a private community is indistinguishable from a missing DID to outsiders', () => {
  let plc = false;
  let privateDid: string;
  let outsider: string;
  const missingDid = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';

  beforeAll(async () => {
    plc = await isPLCAvailable();
    if (!plc) return;
    const owner = await createTestUser(uniqueHandle('pnf-owner'));
    const created = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('pnf'), didMethod: 'plc', visibility: 'private', joinPolicy: 'approval',
    });
    expect(created.status).toBe(201);
    privateDid = created.body.did;
    outsider = (await createTestUser(uniqueHandle('pnf-out'))).accessJwt;
  });

  it('every community-DID endpoint gives an outsider the same answer for both', async () => {
    if (!plc) return;
    const leaks: string[] = [];
    for (const e of endpoints()) {
      const [priv, missing] = [await call(e, privateDid, outsider), await call(e, missingDid, outsider)];
      // 501: the feature is switched off here, the same for every DID.
      if ((priv.status >= 500 && priv.status !== 501) || (missing.status >= 500 && missing.status !== 501)) {
        leaks.push(`${e.nsid}: server error (private ${priv.status}, missing ${missing.status})`);
      } else if (priv.status !== missing.status || priv.error !== missing.error) {
        leaks.push(`${e.nsid}: private ${priv.status} ${priv.error ?? ''} vs missing ${missing.status} ${missing.error ?? ''}`);
      }
    }
    expect(leaks).toEqual([]);
  }, 120_000);
});
