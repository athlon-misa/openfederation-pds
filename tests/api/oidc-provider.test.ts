/**
 * The PDS as an OpenID Connect provider for fediverse apps (ADR-005).
 *
 * Walks what Mastodon does: discovery, authorization request, the person
 * signing in on this server's pages, code → tokens at the token endpoint,
 * userinfo, and the ID token checked against the published key.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { importJWK, jwtVerify, decodeJwt } from 'jose';
import { api, createTestUser, getAdminToken, isPLCAvailable, uniqueHandle, xrpcAuthGet, xrpcAuthPost } from './helpers.js';
import { query } from '../../src/db/client.js';
import { refreshRuntimeSettings } from '../../src/settings/runtime-settings.js';
import { config } from '../../src/config.js';
import { completeAtprotoSignIn, OIDC_STATE_PREFIX, oidcIssuer } from '../../src/oidc/routes.js';
import { didSlug } from '../../src/oidc/claims.js';

const APP = 'https://mastodon.example.test';
const REDIRECT = `${APP}/auth/auth/openid_connect/callback`;
const PASSWORD = 'TestPassword123!';

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  return list.map((c) => String(c).split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

const authorizeUrl = (clientId: string, extra: Record<string, string> = {}) =>
  `/oidc/authorize?${new URLSearchParams({
    client_id: clientId, redirect_uri: REDIRECT, response_type: 'code',
    scope: 'openid profile email', state: 'st-1', nonce: 'n-1', ...extra,
  })}`;

/** Start a sign-in; returns the request id and the browser cookie. */
async function start(clientId: string, extra: Record<string, string> = {}) {
  const res = await api.get(authorizeUrl(clientId, extra));
  expect(res.status).toBe(303);
  const location = String(res.headers.location);
  const id = new URL(location, 'http://x').searchParams.get('request')!;
  return { id, cookie: cookieFrom(res), location };
}

async function signInWithPassword(clientId: string, handle: string, extra: Record<string, string> = {}) {
  const { id, cookie } = await start(clientId, extra);
  const identify = await api.post('/oidc/authorize/identify').set('Cookie', cookie).type('form').send({ request: id, handle });
  expect(identify.status).toBe(200);
  expect(identify.text).toContain('name="password"');
  const pw = await api.post('/oidc/authorize/password').set('Cookie', cookie).type('form').send({ request: id, handle, password: PASSWORD });
  expect(pw.status).toBe(303);
  const cont = await api.get(String(pw.headers.location)).set('Cookie', cookie);
  return { id, cookie, cont };
}

describe('OpenID Connect provider (ADR-005)', () => {
  let plc = false;
  let adminToken: string;
  let user: { did: string; handle: string; fullHandle: string; accessJwt: string };
  let clientId: string;
  let clientSecret: string;

  beforeAll(async () => {
    plc = await isPLCAvailable();
    adminToken = await getAdminToken();
    await query("DELETE FROM server_settings WHERE name = 'OIDC_PROVIDER_ENABLED'");
    delete process.env.OIDC_PROVIDER_ENABLED;
    await refreshRuntimeSettings();
    if (plc) user = await createTestUser(uniqueHandle('oidc'));
  });

  afterAll(async () => {
    await query("DELETE FROM server_settings WHERE name = 'OIDC_PROVIDER_ENABLED'");
    await query('DELETE FROM oidc_clients');
    await refreshRuntimeSettings();
  });

  it('is off by default: every /oidc route is 404', async () => {
    expect((await api.get('/oidc/.well-known/openid-configuration')).status).toBe(404);
    expect((await api.get('/oidc/authorize?client_id=x')).status).toBe(404);
    expect((await api.post('/oidc/token')).status).toBe(404);
  });

  it('an admin turns it on with the server setting', async () => {
    const res = await xrpcAuthPost('net.openfederation.admin.updateServerSettings', adminToken, { changes: { oidcProviderEnabled: true } });
    expect(res.status).toBe(200);
    const disc = await api.get('/oidc/.well-known/openid-configuration');
    expect(disc.status).toBe(200);
    expect(disc.body.issuer).toBe(oidcIssuer());
    expect(disc.body.issuer).toBe(`${config.pds.serviceUrl}/oidc`);
    expect(disc.body.authorization_endpoint).toBe(`${oidcIssuer()}/authorize`);
    expect(disc.body.id_token_signing_alg_values_supported).toEqual(['RS256']);
    expect(disc.body.code_challenge_methods_supported).toEqual(['S256']);
    expect(disc.body.end_session_endpoint).toBe(`${oidcIssuer()}/end_session`);
    const jwks = await api.get('/oidc/jwks');
    expect(jwks.body.keys).toHaveLength(1);
    expect(jwks.body.keys[0]).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' });
    expect(jwks.body.keys[0].d).toBeUndefined();
  });

  it('only an admin registers apps; a Mastodon preset returns its configuration', async () => {
    if (!plc) return;
    const refused = await xrpcAuthPost('net.openfederation.oidc.createClient', user.accessJwt, { name: 'x', preset: 'mastodon', appUrl: APP });
    expect(refused.status).toBe(403);

    const res = await xrpcAuthPost('net.openfederation.oidc.createClient', adminToken, { name: 'Test Mastodon', preset: 'mastodon', appUrl: APP });
    expect(res.status).toBe(201);
    clientId = res.body.client.clientId;
    clientSecret = res.body.clientSecret;
    expect(res.body.client.redirectUris).toEqual([REDIRECT]);
    expect(res.body.client.scopes).toEqual(['openid', 'profile', 'email']);
    expect(res.body.configuration).toContain('OIDC_UID_FIELD=did_slug');
    expect(res.body.configuration).toContain(`OIDC_CLIENT_SECRET=${clientSecret}`);
    expect(res.body.configuration).toContain(`OIDC_ISSUER=${oidcIssuer()}`);
    expect(res.body.configuration).toContain(`OIDC_IDP_LOGOUT_REDIRECT_URI=${APP}/`);

    // The secret is only ever stored hashed and never listed.
    const stored = await query<{ secret_hash: string }>('SELECT secret_hash FROM oidc_clients WHERE client_id = $1', [clientId]);
    expect(stored.rows[0].secret_hash).not.toContain(clientSecret);
    const list = await xrpcAuthGet('net.openfederation.oidc.listClients', adminToken);
    expect(list.status).toBe(200);
    expect(list.body.enabled).toBe(true);
    expect(JSON.stringify(list.body)).not.toContain(clientSecret);
    const setup = await xrpcAuthGet('net.openfederation.oidc.getClientSetup', adminToken, { clientId });
    expect(setup.body.configuration).not.toContain(clientSecret);
  });

  it('refuses unknown apps and unregistered return addresses without redirecting', async () => {
    if (!plc) return;
    const unknown = await api.get(authorizeUrl('no-such-app'));
    expect(unknown.status).toBe(400);
    expect(unknown.headers.location).toBeUndefined();
    const wrong = await api.get(authorizeUrl(clientId, { redirect_uri: 'https://evil.example/cb' }));
    expect(wrong.status).toBe(400);
    expect(wrong.headers.location).toBeUndefined();
    expect(wrong.headers['x-frame-options']).toBe('DENY');
  });

  it('sends protocol errors back to the registered address', async () => {
    if (!plc) return;
    const noOpenid = await api.get(authorizeUrl(clientId, { scope: 'profile' }));
    expect(noOpenid.status).toBe(303);
    const loc = new URL(String(noOpenid.headers.location));
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get('error')).toBe('invalid_scope');
    expect(loc.searchParams.get('state')).toBe('st-1');
    const plain = await api.get(authorizeUrl(clientId, { code_challenge: 'a'.repeat(43), code_challenge_method: 'plain' }));
    expect(new URL(String(plain.headers.location)).searchParams.get('error')).toBe('invalid_request');
  });

  it('a sign-in belongs to the browser that started it', async () => {
    if (!plc) return;
    const { id } = await start(clientId);
    const stranger = await api.post('/oidc/authorize/identify').type('form').send({ request: id, handle: user.fullHandle });
    expect(stranger.status).toBe(400);
    expect(stranger.text).toContain('expired');
  });

  it('a wrong password is refused and counted', async () => {
    if (!plc) return;
    const { id, cookie } = await start(clientId);
    const res = await api.post('/oidc/authorize/password').set('Cookie', cookie).type('form')
      .send({ request: id, handle: user.fullHandle, password: 'not-it' });
    expect(res.status).toBe(401);
    const row = await query<{ n: number }>('SELECT failed_login_attempts AS n FROM users WHERE did = $1', [user.did]);
    expect(row.rows[0].n).toBeGreaterThan(0);
    await query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE did = $1', [user.did]);
  });

  it('password sign-in → code → tokens → userinfo, with PKCE and nonce', async () => {
    if (!plc) return;
    const { verifier, challenge } = pkce();
    const { cont } = await signInWithPassword(clientId, user.fullHandle, { code_challenge: challenge, code_challenge_method: 'S256' });
    expect(cont.status).toBe(303);
    const back = new URL(String(cont.headers.location));
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('st-1');
    expect(back.searchParams.get('iss')).toBe(oidcIssuer());
    const code = back.searchParams.get('code')!;

    const wrongSecret = await api.post('/oidc/token').type('form')
      .send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, client_secret: 'nope', code_verifier: verifier });
    expect(wrongSecret.status).toBe(401);
    expect(wrongSecret.body.error).toBe('invalid_client');

    const token = await api.post('/oidc/token')
      .set('Authorization', `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`)
      .type('form').send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier });
    // The wrong-secret attempt above did not consume the code: client authentication comes first.
    expect(token.status).toBe(200);
    expect(token.headers['cache-control']).toBe('no-store');
    expect(token.body.token_type).toBe('Bearer');

    const jwks = await api.get('/oidc/jwks');
    const key = await importJWK(jwks.body.keys[0], 'RS256');
    const { payload, protectedHeader } = await jwtVerify(token.body.id_token, key, { issuer: oidcIssuer(), audience: clientId });
    expect(protectedHeader.kid).toBe(jwks.body.keys[0].kid);
    expect(payload.sub).toBe(user.did);
    expect(payload.nonce).toBe('n-1');
    expect(payload.did_slug).toBe(didSlug(user.did));
    expect(payload.preferred_username).toBe(user.fullHandle);
    expect(payload.email).toBe(`${user.handle}@test.local`);
    expect(typeof payload.email_verified).toBe('boolean');
    expect(typeof payload.auth_time).toBe('number');

    const info = await api.get('/oidc/userinfo').set('Authorization', `Bearer ${token.body.access_token}`);
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ sub: user.did, did_slug: didSlug(user.did), handle: user.fullHandle });

    // The ID token is not an access token.
    expect((await api.get('/oidc/userinfo').set('Authorization', `Bearer ${token.body.id_token}`)).status).toBe(401);

    // A code works once.
    const again = await api.post('/oidc/token').type('form')
      .send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, client_secret: clientSecret, code_verifier: verifier });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('invalid_grant');

    const audit = await query<{ n: string }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'oidc.signIn' AND actor_id = $1", [user.did]);
    expect(Number(audit.rows[0].n)).toBeGreaterThan(0);
  });

  it('a code sent with a PKCE challenge needs the matching verifier', async () => {
    if (!plc) return;
    const { challenge } = pkce();
    const { cont } = await signInWithPassword(clientId, user.fullHandle, { code_challenge: challenge, code_challenge_method: 'S256' });
    const code = new URL(String(cont.headers.location)).searchParams.get('code')!;
    const res = await api.post('/oidc/token').type('form')
      .send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, client_secret: clientSecret, code_verifier: pkce().verifier });
    expect(res.body.error).toBe('invalid_grant');
  });

  it('no email claim without the email scope', async () => {
    if (!plc) return;
    const { cont } = await signInWithPassword(clientId, user.fullHandle, { scope: 'openid profile' });
    const code = new URL(String(cont.headers.location)).searchParams.get('code')!;
    const token = await api.post('/oidc/token').type('form')
      .send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, client_secret: clientSecret });
    expect(token.status).toBe(200);
    const claims = decodeJwt(token.body.id_token);
    expect(claims.email).toBeUndefined();
    expect(claims.did_slug).toBe(didSlug(user.did));
  });

  it('an account signed in at its own server comes back through the AT Protocol callback', async () => {
    if (!plc) return;
    const { id, cookie } = await start(clientId);
    // What /oauth/external/callback does once the person's own server answered.
    const next = await completeAtprotoSignIn(`${OIDC_STATE_PREFIX}${id}`, user.did);
    expect(next).toBe(`/oidc/authorize/continue?request=${id}`);
    // Only once.
    expect(await completeAtprotoSignIn(`${OIDC_STATE_PREFIX}${id}`, user.did)).toBeNull();
    const cont = await api.get(next!).set('Cookie', cookie);
    expect(cont.status).toBe(303);
    const code = new URL(String(cont.headers.location)).searchParams.get('code')!;
    const token = await api.post('/oidc/token').type('form')
      .send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, client_secret: clientSecret });
    expect(token.status).toBe(200);
    const claims = decodeJwt(token.body.id_token);
    expect(claims.sub).toBe(user.did);
    // No email when the account's own server shared none.
    expect(claims.email).toBeUndefined();
  });

  async function tokensFor(id: string, cookie: string, next: string) {
    const cont = await api.get(next).set('Cookie', cookie);
    expect(cont.status).toBe(303);
    const code = new URL(String(cont.headers.location)).searchParams.get('code')!;
    const token = await api.post('/oidc/token').type('form')
      .send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, client_secret: clientSecret });
    expect(token.status).toBe(200);
    return decodeJwt(token.body.id_token);
  }

  it('the email an account\'s own server shared reaches the app, with its verified flag (#461)', async () => {
    if (!plc) return;
    const { id, cookie } = await start(clientId);
    const next = await completeAtprotoSignIn(`${OIDC_STATE_PREFIX}${id}`, user.did, { email: 'reader@bsky.example', emailVerified: true });
    const claims = await tokensFor(id, cookie, next!);
    expect(claims.email).toBe('reader@bsky.example');
    expect(claims.email_verified).toBe(true);
    // Held on the request only: the row is gone once the code is redeemed.
    const left = await query('SELECT 1 FROM oidc_requests WHERE id = $1', [id]);
    expect(left.rowCount).toBe(0);
  });

  it('an unconfirmed shared address is passed on as unverified', async () => {
    if (!plc) return;
    const { id, cookie } = await start(clientId);
    const next = await completeAtprotoSignIn(`${OIDC_STATE_PREFIX}${id}`, user.did, { email: 'new@bsky.example', emailVerified: false });
    const claims = await tokensFor(id, cookie, next!);
    expect(claims.email).toBe('new@bsky.example');
    expect(claims.email_verified).toBe(false);
  });

  it('an app that did not ask for email never gets the shared address', async () => {
    if (!plc) return;
    const { id, cookie } = await start(clientId, { scope: 'openid profile' });
    const next = await completeAtprotoSignIn(`${OIDC_STATE_PREFIX}${id}`, user.did, { email: 'reader@bsky.example', emailVerified: true });
    const stored = await query<{ remote_email: string | null }>('SELECT remote_email FROM oidc_requests WHERE id = $1', [id]);
    expect(stored.rows[0].remote_email).toBeNull();
    const claims = await tokensFor(id, cookie, next!);
    expect(claims.email).toBeUndefined();
  });

  it('an app limited to a community admits its members only', async () => {
    if (!plc) return;
    const owner = await createTestUser(uniqueHandle('oidcown'));
    const c = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('oidc-c'), didMethod: 'plc', displayName: 'OIDC gated',
    });
    expect(c.status).toBe(201);
    const gated = await xrpcAuthPost('net.openfederation.oidc.createClient', adminToken, {
      name: 'Members only', preset: 'mastodon', appUrl: APP, communityDid: c.body.did, clientId: `gated-${Date.now()}`,
    });
    expect(gated.status).toBe(201);
    const outsider = await signInWithPassword(gated.body.client.clientId, user.fullHandle);
    const loc = new URL(String(outsider.cont.headers.location));
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('code')).toBeNull();

    // The owner is a member.
    await query('UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE did = $1) WHERE did = $2', [user.did, owner.did]);
    const member = await signInWithPassword(gated.body.client.clientId, owner.fullHandle);
    expect(new URL(String(member.cont.headers.location)).searchParams.get('code')).toBeTruthy();
  });

  it('sign-out sends the person back to the app, and only to the app', async () => {
    if (!plc) return;
    // An ID token from this provider identifies the app (Mastodon sends one).
    const { cont } = await signInWithPassword(clientId, user.fullHandle, { scope: 'openid profile' });
    const code = new URL(String(cont.headers.location)).searchParams.get('code')!;
    const token = await api.post('/oidc/token').type('form')
      .send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, client_secret: clientSecret });
    const hint = token.body.id_token as string;

    const back = await api.get(`/oidc/end_session?${new URLSearchParams({ id_token_hint: hint, post_logout_redirect_uri: `${APP}/`, state: 's9' })}`);
    expect(back.status).toBe(303);
    expect(back.headers.location).toBe(`${APP}/?state=s9`);

    // By client_id, too.
    const byId = await api.get(`/oidc/end_session?${new URLSearchParams({ client_id: clientId, post_logout_redirect_uri: `${APP}/bye` })}`);
    expect(byId.headers.location).toBe(`${APP}/bye`);

    // Never somewhere the app did not register.
    const evil = await api.get(`/oidc/end_session?${new URLSearchParams({ id_token_hint: hint, post_logout_redirect_uri: 'https://evil.example/' })}`);
    expect(evil.status).toBe(200);
    expect(evil.headers.location).toBeUndefined();
    expect(evil.text).toContain('signed out');

    // A forged hint names no app.
    const forged = `${hint.split('.').slice(0, 2).join('.')}.AAAA`;
    const noApp = await api.get(`/oidc/end_session?${new URLSearchParams({ id_token_hint: forged, post_logout_redirect_uri: `${APP}/` })}`);
    expect(noApp.status).toBe(200);
    expect(noApp.headers.location).toBeUndefined();

    // No parameters at all (what Mastodon sends without OIDC_IDP_LOGOUT_REDIRECT_URI).
    const bare = await api.get('/oidc/end_session');
    expect(bare.status).toBe(200);
    expect(bare.text).toContain('signed out');
  });

  // ---- Remembered sign-in for apps (#462) ----

  function sessionCookieFrom(res: { headers: Record<string, unknown> }): string | null {
    const raw = res.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
    const c = list.map(String).find((v) => v.startsWith('ofd_oidcsession=') && !v.startsWith('ofd_oidcsession=;'));
    return c ? c.split(';')[0] : null;
  }

  async function codeToClaims(location: string) {
    const code = new URL(location).searchParams.get('code')!;
    const token = await api.post('/oidc/token').type('form')
      .send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, client_secret: clientSecret });
    expect(token.status).toBe(200);
    return decodeJwt(token.body.id_token);
  }

  /** Sign in with the password once; returns the remembered-session cookie. */
  async function signInOnceAndRemember(): Promise<{ session: string; authTime: unknown }> {
    const { cont } = await signInWithPassword(clientId, user.fullHandle);
    expect(cont.status).toBe(303);
    const session = sessionCookieFrom(cont);
    expect(session).toBeTruthy();
    const claims = await codeToClaims(String(cont.headers.location));
    return { session: session!, authTime: claims.auth_time };
  }

  it('after one sign-in, the next app offers "Continue as …" and one click signs in', async () => {
    if (!plc) return;
    const { session, authTime } = await signInOnceAndRemember();
    const auth = await api.get(authorizeUrl(clientId, { state: 'st-2', nonce: 'n-2' })).set('Cookie', session);
    expect(auth.status).toBe(303);
    expect(String(auth.headers.location)).toMatch(/^\/oidc\/authorize\/session\?request=/);
    const id = new URL(String(auth.headers.location), 'http://x').searchParams.get('request')!;
    const cookie = `${cookieFrom(auth)}; ${session}`;

    const page = await api.get(String(auth.headers.location)).set('Cookie', cookie);
    expect(page.status).toBe(200);
    expect(page.text).toContain(`Continue as ${user.fullHandle}`);
    expect(page.text).toContain('Use a different account');

    const go = await api.post('/oidc/authorize/session').set('Cookie', cookie).type('form').send({ request: id });
    expect(go.status).toBe(303);
    const cont = await api.get(String(go.headers.location)).set('Cookie', cookie);
    expect(cont.status).toBe(303);
    const claims = await codeToClaims(String(cont.headers.location));
    expect(claims.sub).toBe(user.did);
    expect(claims.nonce).toBe('n-2');
    // auth_time is when the person actually signed in, not now.
    expect(claims.auth_time).toBe(authTime);
    // The browser already remembers this account: no second session.
    expect(sessionCookieFrom(cont)).toBeNull();
  });

  it('the remembered sign-in only works in the browser that holds it', async () => {
    if (!plc) return;
    const { session } = await signInOnceAndRemember();
    const auth = await api.get(authorizeUrl(clientId)).set('Cookie', session);
    const id = new URL(String(auth.headers.location), 'http://x').searchParams.get('request')!;
    // The request cookie without the session cookie: back to the normal sign-in.
    const go = await api.post('/oidc/authorize/session').set('Cookie', cookieFrom(auth)).type('form').send({ request: id });
    expect(go.status).toBe(303);
    expect(String(go.headers.location)).toMatch(/^\/oidc\/authorize\/signin\?/);
    // A made-up session cookie is ignored.
    const forged = await api.get(authorizeUrl(clientId)).set('Cookie', 'ofd_oidcsession=not-a-real-token');
    expect(String(forged.headers.location)).toMatch(/^\/oidc\/authorize\/signin\?/);
  });

  it('prompt=login asks again; prompt=none answers from the remembered sign-in or says login_required', async () => {
    if (!plc) return;
    const { session } = await signInOnceAndRemember();
    const login = await api.get(authorizeUrl(clientId, { prompt: 'login' })).set('Cookie', session);
    expect(String(login.headers.location)).toMatch(/^\/oidc\/authorize\/signin\?/);
    // Opening the "Continue as" step by hand does not get around it.
    const loginId = new URL(String(login.headers.location), 'http://x').searchParams.get('request')!;
    const loginCookie = `${cookieFrom(login)}; ${session}`;
    const byHand = await api.post('/oidc/authorize/session').set('Cookie', loginCookie).type('form').send({ request: loginId });
    expect(String(byHand.headers.location)).toMatch(/^\/oidc\/authorize\/signin\?/);
    const page = await api.get(`/oidc/authorize/session?request=${loginId}`).set('Cookie', loginCookie);
    expect(String(page.headers.location)).toMatch(/^\/oidc\/authorize\/signin\?/);

    const none = await api.get(authorizeUrl(clientId, { prompt: 'none' })).set('Cookie', session);
    expect(String(none.headers.location)).toMatch(/^\/oidc\/authorize\/continue\?/);
    const cont = await api.get(String(none.headers.location)).set('Cookie', `${cookieFrom(none)}; ${session}`);
    expect((await codeToClaims(String(cont.headers.location))).sub).toBe(user.did);

    const noSession = await api.get(authorizeUrl(clientId, { prompt: 'none' }));
    const back = new URL(String(noSession.headers.location));
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('error')).toBe('login_required');
  });

  it('max_age asks again when the sign-in is older', async () => {
    if (!plc) return;
    const { session } = await signInOnceAndRemember();
    await new Promise((r) => setTimeout(r, 1100));
    const auth = await api.get(authorizeUrl(clientId, { max_age: '0' })).set('Cookie', session);
    expect(String(auth.headers.location)).toMatch(/^\/oidc\/authorize\/signin\?/);
  });

  it('signing out of an app ends the remembered sign-in', async () => {
    if (!plc) return;
    const { session } = await signInOnceAndRemember();
    const out = await api.get(`/oidc/end_session?client_id=${encodeURIComponent(clientId)}`).set('Cookie', session);
    expect(out.status).toBe(200);
    expect(String(out.headers['set-cookie'])).toContain('ofd_oidcsession=;');
    const auth = await api.get(authorizeUrl(clientId)).set('Cookie', session);
    expect(String(auth.headers.location)).toMatch(/^\/oidc\/authorize\/signin\?/);
  });

  it('signing out everywhere (token_version) or a suspension ends it', async () => {
    if (!plc) return;
    const first = await signInOnceAndRemember();
    const rows = async () => (await query('SELECT 1 FROM oidc_sessions WHERE did = $1', [user.did])).rowCount ?? 0;
    const before = await rows();
    await query('UPDATE users SET token_version = token_version + 1 WHERE did = $1', [user.did]);
    const after = await api.get(authorizeUrl(clientId)).set('Cookie', first.session);
    expect(String(after.headers.location)).toMatch(/^\/oidc\/authorize\/signin\?/);
    // And the stale remembered sign-in is deleted.
    expect(await rows()).toBe(before - 1);

    const second = await signInOnceAndRemember();
    await query("UPDATE users SET status = 'suspended' WHERE did = $1", [user.did]);
    try {
      const suspended = await api.get(authorizeUrl(clientId)).set('Cookie', second.session);
      expect(String(suspended.headers.location)).toMatch(/^\/oidc\/authorize\/signin\?/);
    } finally {
      await query("UPDATE users SET status = 'approved' WHERE did = $1", [user.did]);
    }
  });

  it('an account from another server is offered again, but not to an app wanting an email it never shared', async () => {
    if (!plc) return;
    const { id, cookie } = await start(clientId, { scope: 'openid profile' });
    const next = await completeAtprotoSignIn(`${OIDC_STATE_PREFIX}${id}`, user.did);
    const cont = await api.get(next!).set('Cookie', cookie);
    const session = sessionCookieFrom(cont)!;
    expect(session).toBeTruthy();
    await codeToClaims(String(cont.headers.location));

    const profileOnly = await api.get(authorizeUrl(clientId, { scope: 'openid profile' })).set('Cookie', session);
    expect(String(profileOnly.headers.location)).toMatch(/^\/oidc\/authorize\/session\?/);
    // Wants an email: the person's own server is asked again.
    const withEmail = await api.get(authorizeUrl(clientId)).set('Cookie', session);
    expect(String(withEmail.headers.location)).toMatch(/^\/oidc\/authorize\/signin\?/);
  });

  it('a shared email is remembered with the sign-in for the next app', async () => {
    if (!plc) return;
    const { id, cookie } = await start(clientId);
    const next = await completeAtprotoSignIn(`${OIDC_STATE_PREFIX}${id}`, user.did, { email: 'reader@bsky.example', emailVerified: true });
    const cont = await api.get(next!).set('Cookie', cookie);
    const session = sessionCookieFrom(cont)!;
    await codeToClaims(String(cont.headers.location));

    const none = await api.get(authorizeUrl(clientId, { prompt: 'none' })).set('Cookie', session);
    const again = await api.get(String(none.headers.location)).set('Cookie', `${cookieFrom(none)}; ${session}`);
    const claims = await codeToClaims(String(again.headers.location));
    expect(claims.email).toBe('reader@bsky.example');
    expect(claims.email_verified).toBe(true);
  });

  it('OIDC_SESSION_DAYS=0 remembers nothing', async () => {
    if (!plc) return;
    const was = config.oidc.sessionDays;
    (config.oidc as { sessionDays: number }).sessionDays = 0;
    try {
      const { cont } = await signInWithPassword(clientId, user.fullHandle);
      expect(sessionCookieFrom(cont)).toBeNull();
    } finally {
      (config.oidc as { sessionDays: number }).sessionDays = was;
    }
  });

  it('rotating the secret retires the old one; deleting the app stops sign-in', async () => {
    if (!plc) return;
    const rot = await xrpcAuthPost('net.openfederation.oidc.rotateClientSecret', adminToken, { clientId });
    expect(rot.status).toBe(200);
    expect(rot.body.clientSecret).not.toBe(clientSecret);
    const old = await api.post('/oidc/token').type('form')
      .send({ grant_type: 'authorization_code', code: 'x', redirect_uri: REDIRECT, client_id: clientId, client_secret: clientSecret });
    expect(old.body.error).toBe('invalid_client');

    const del = await xrpcAuthPost('net.openfederation.oidc.deleteClient', adminToken, { clientId });
    expect(del.status).toBe(200);
    expect((await api.get(authorizeUrl(clientId))).status).toBe(400);
  });

  it('turned off again, the routes are gone and the apps are kept', async () => {
    await xrpcAuthPost('net.openfederation.admin.updateServerSettings', adminToken, { changes: { oidcProviderEnabled: false } });
    expect((await api.get('/oidc/.well-known/openid-configuration')).status).toBe(404);
    const list = await xrpcAuthGet('net.openfederation.oidc.listClients', adminToken);
    expect(list.body.enabled).toBe(false);
  });
});
