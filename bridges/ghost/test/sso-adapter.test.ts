/**
 * The staff SSO adapter accepts only ID tokens this provider signed for the
 * Ghost bridge's client, unexpired, with a verified email, and only signs in
 * an active staff user with that email.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';

const require = createRequire(import.meta.url);
const Adapter = require('../sso-adapter/index.js');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as object), kid: 'k1', alg: 'RS256', use: 'sig' };
let issuer = '';
let server: http.Server;

before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/oidc/.well-known/openid-configuration') res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
    else if (req.url === '/oidc/jwks') res.end(JSON.stringify({ keys: [jwk] }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/oidc`;
});
after(() => new Promise((r) => server.close(r)));

function sign(claims: Record<string, unknown>, key = privateKey, kid = 'k1'): string {
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const s = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url');
  return `${h}.${p}.${s}`;
}

const now = () => Math.floor(Date.now() / 1000);
const good = () => ({ iss: issuer, aud: 'ghost-client', sub: 'did:plc:abc', exp: now() + 300, email: 'Misa@Example.com', email_verified: true });

function adapter(users: Record<string, { id: string; email: string; status?: string }> = {}) {
  const a = new Adapter({ issuer, clientId: 'ghost-client', cookieName: 'of_ghost_sso' });
  a.setUserRepository({ getByEmail: async (e: string) => users[e] ?? null, getOwner: async () => null });
  return a;
}

test('reads the token from its cookie only', async () => {
  const a = adapter();
  assert.equal(await a.getRequestCredentials({ headers: { cookie: 'x=1; of_ghost_sso=a.b.c' } }), 'a.b.c');
  assert.equal(await a.getRequestCredentials({ headers: { cookie: 'other=a.b.c' } }), null);
  assert.equal(await a.getRequestCredentials({ headers: {} }), null);
});

test('a valid token gives the DID and the lower-cased verified email', async () => {
  assert.deepEqual(await adapter().getIdentityFromCredentials(sign(good())), { did: 'did:plc:abc', email: 'misa@example.com' });
});

test('refuses tokens that are not exactly right', async () => {
  const a = adapter();
  const cases: Array<[string, string]> = [
    ['wrong key', sign(good(), other.privateKey)],
    ['unknown kid', sign(good(), privateKey, 'nope')],
    ['other issuer', sign({ ...good(), iss: 'https://evil.example/oidc' })],
    ['other client (e.g. Mastodon\'s token)', sign({ ...good(), aud: 'mastodon-demo' })],
    ['expired', sign({ ...good(), exp: now() - 600 })],
    ['email not verified', sign({ ...good(), email_verified: false })],
    ['no email', sign({ ...good(), email: undefined })],
    ['not a DID', sign({ ...good(), sub: 'alice' })],
  ];
  for (const [why, token] of cases) {
    assert.equal(await a.getIdentityFromCredentials(token), null, why);
  }
  const h = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  assert.equal(await a.getIdentityFromCredentials(`${h}.${Buffer.from(JSON.stringify(good())).toString('base64url')}.`), null, 'alg none');
});

test('only an active staff user with that email signs in', async () => {
  const a = adapter({
    'misa@example.com': { id: 'u1', email: 'misa@example.com', status: 'active' },
    'locked@example.com': { id: 'u2', email: 'locked@example.com', status: 'locked' },
    'warned@example.com': { id: 'u3', email: 'warned@example.com', status: 'warn-2' },
  });
  assert.equal((await a.getUserForIdentity({ did: 'd', email: 'misa@example.com' }))?.id, 'u1');
  assert.equal((await a.getUserForIdentity({ did: 'd', email: 'warned@example.com' }))?.id, 'u3');
  assert.equal(await a.getUserForIdentity({ did: 'd', email: 'locked@example.com' }), null);
  assert.equal(await a.getUserForIdentity({ did: 'd', email: 'nobody@example.com' }), null);
});
