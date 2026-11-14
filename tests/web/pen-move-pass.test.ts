/**
 * Dashboard: moving a pen name into a server that asks for one of its own
 * passes (#412). Needs @open-federation/pseudonym 0.4 (moveAccount's
 * creationToken). The pass goes to createAccount as `token`; a refused pass
 * is a MovePassRefused, raised before anything changed.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { generatePseudonymPhrase } from '@open-federation/pseudonym';
import { movePenName, MovePassRefused } from '../../web-interface/src/lib/pen-names/pen-names.js';

afterEach(() => vi.restoreAllMocks());

const entry = { did: 'did:plc:abcdefghijklmnopqrstuvwx', handle: 'ink.a.test', home: { url: 'http://a.test', serviceDid: 'did:web:a.test' } };
const target = { url: 'http://b.test', serviceDid: 'did:web:b.test' };
const pass = { epoch: '2026-11', prepared: 'p', signature: 's', key: 'k' };

function stub(createAccount: () => Response) {
  const bodies: Record<string, unknown>[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes('reserveSigningKey')) return new Response(JSON.stringify({ signingKey: 'did:key:z' }), { status: 200 });
    if (url.includes('com.atproto.server.createAccount')) { bodies.push(JSON.parse(String(init?.body))); return createAccount(); }
    return new Response('{}', { status: 500 });
  });
  return bodies;
}

const move = (p: Partial<Parameters<typeof movePenName>[0]> = {}) => movePenName({
  scope: 'test', entry, phrase: generatePseudonymPhrase(), plcUrl: 'http://plc.test', target, newHandle: 'ink.b.test', onStep: () => {}, ...p,
});

describe('moving a pen name with a pass', () => {
  it('sends the pass (without its key fingerprint) to createAccount as token', async () => {
    const bodies = stub(() => new Response(JSON.stringify({ error: 'TokenSpent', message: 'used' }), { status: 400 }));
    await expect(move({ pass })).rejects.toBeInstanceOf(MovePassRefused);
    expect(bodies[0]).toEqual({ did: entry.did, handle: 'ink.b.test', token: { epoch: '2026-11', prepared: 'p', signature: 's' } });
  });

  it('a refused or missing pass is MovePassRefused, in words', async () => {
    stub(() => new Response(JSON.stringify({ error: 'InvalidToken', message: 'no' }), { status: 400 }));
    await expect(move({ pass })).rejects.toThrow(/did not accept this pass/);
    await expect(move()).rejects.toThrow(/asks for one of its own passes/);
  });

  it('other failures pass through', async () => {
    stub(() => new Response(JSON.stringify({ error: 'MigrationNotAllowed', message: 'closed' }), { status: 403 }));
    const err = await move({ pass }).catch((e) => e);
    expect(err).not.toBeInstanceOf(MovePassRefused);
    expect(String(err.message)).toMatch(/MigrationNotAllowed/);
  });
});
