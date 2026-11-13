/**
 * The first-run setup wizard end to end, against a real database (#405):
 * setup mode serves only the wizard and /health; the setup code from the log
 * is needed; finishing writes the settings file with generated secrets and
 * locks setup for good; the next normal start creates the admin account.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync, existsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createSetupApp } from '../../src/setup/setup-app.js';
import { ClaimGuard } from '../../src/setup/claim.js';
import { createSetupPool, createSetupStore } from '../../src/setup/setup-store.js';
import { readConfigFile } from '../../src/setup/config-file.js';
import { completePendingSetupAdmin } from '../../src/auth/setup-admin.js';
import { query } from '../../src/db/client.js';
import { api, xrpcPost } from './helpers.js';

const ADMIN = { handle: `setupadm${Date.now().toString(36)}`, email: `setup-${Date.now()}@example.org`, password: 'Wizard-Pass-2468' };

const dir = mkdtempSync(join(tmpdir(), 'of-setup-it-'));
const configPath = join(dir, 'openfederation.env');
const pool = createSetupPool(process.env);
const store = createSetupStore(pool);
const codes: string[] = [];
const claim = new ClaimGuard({ announce: (c) => codes.push(c) });
const mails: Array<{ to: string; host: string }> = [];
let completed = 0;
let server: Server;
let agent: ReturnType<typeof request.agent>;
let base: string;

const app = createSetupApp({
  env: { NODE_ENV: 'development', SETUP_DASHBOARD_URL: 'http://localhost:3001' },
  store,
  configPath,
  claim,
  onComplete: () => { completed++; },
  sendTestEmail: async (smtp, to) => {
    if (smtp.host === 'smtp.broken.example') throw new Error('connection refused');
    mails.push({ to, host: smtp.host });
  },
  resolveHost: async (host) => (host.endsWith('.example.org') || host === 'localhost' ? ['127.0.0.1'] : []),
});

function wizardInput() {
  return {
    kind: 'privacy',
    addresses: { publicUrl: base, handleDomain: 'example.org', dashboardUrl: 'http://localhost:3001' },
    email: { mode: 'smtp', host: 'smtp.example.com', port: '587', security: 'starttls', user: 'mailer', password: 'mail-secret', from: 'noreply@example.org' },
    admin: { ...ADMIN, repeat: ADMIN.password },
    options: { inviteOnly: true, pseudonyms: true, custody: ['custodial', 'assisted', 'self'], custodyDefault: 'self' },
  };
}

beforeAll(async () => {
  await query('DELETE FROM server_setup');
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const addr = server.address();
  base = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
  agent = request.agent(server);
});

afterAll(async () => {
  server?.close();
  await pool.end();
  await query('DELETE FROM server_setup');
  await query('DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE handle = $1)', [ADMIN.handle]);
  await query('DELETE FROM users WHERE handle = $1', [ADMIN.handle]);
  rmSync(dir, { recursive: true, force: true });
});

describe('setup mode', () => {
  it('serves /health, and refuses everything else until setup is done', async () => {
    const health = await agent.get('/health');
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ status: 'setup', setup: 'required', database: 'connected' });

    const xrpc = await agent.post('/xrpc/com.atproto.server.createSession').send({ identifier: 'a', password: 'b' });
    expect(xrpc.status).toBe(503);
    expect(xrpc.body.error).toBe('SetupRequired');
    expect((await agent.get('/xrpc/com.atproto.server.describeServer')).status).toBe(503);

    const root = await agent.get('/').set('Accept', 'text/html');
    expect(root.status).toBe(302);
    expect(root.headers.location).toBe('/setup');
  });

  it('serves the wizard page and its assets, with a strict content policy and no inline script', async () => {
    const page = await agent.get('/setup');
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.text).toContain('<script src="/setup/assets/setup.js"></script>');
    expect(page.text).not.toMatch(/<script>(?!<\/script>)|\son[a-z]+=/i);
    expect(page.text).toContain('setup code');
    expect((await agent.get('/setup/assets/setup.js')).headers['content-type']).toMatch(/javascript/);
    expect((await agent.get('/setup/assets/setup.css')).headers['content-type']).toMatch(/css/);
  });

  it('tells nothing beyond "not claimed" to someone without the setup code', async () => {
    const status = await request(server).get('/setup/api/status');
    expect(status.body).toEqual({ locked: false, claimed: false, finished: false, database: true });
    for (const path of ['/setup/api/validate', '/setup/api/check-dns', '/setup/api/test-email', '/setup/api/finish']) {
      const r = await request(server).post(path).send({ section: 'kind', input: wizardInput() });
      expect(r.status, path).toBe(401);
    }
  });

  it('refuses a wrong code, a cross-site request, and a form post', async () => {
    const wrong = await agent.post('/setup/api/claim').send({ code: 'AAAAA-AAAAA-AAAAA-AAAAA' });
    expect(wrong.status).toBe(403);
    expect(wrong.body.message).toMatch(/server log/);
    const cross = await agent.post('/setup/api/claim').set('Origin', 'https://evil.example').send({ code: codes[0] });
    expect(cross.status).toBe(403);
    const form = await agent.post('/setup/api/claim').type('form').send({ code: codes[0] });
    expect(form.status).toBe(415);
  });

  it('the code from the log opens a session cookie scoped to /setup', async () => {
    const ok = await agent.post('/setup/api/claim').send({ code: codes[0].toLowerCase() });
    expect(ok.status).toBe(200);
    const cookie = String(ok.headers['set-cookie']);
    expect(cookie).toMatch(/of_setup=[0-9a-f]{64}/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/setup/);

    const status = await agent.get('/setup/api/status');
    expect(status.body.claimed).toBe(true);
    expect(status.body.configPath).toBe(configPath);
    expect(status.body.suggestions).toMatchObject({ publicUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/), dashboardUrl: 'http://localhost:3001', plcUrl: 'https://plc.openfederation.net' });
    expect(status.body.defaults.privacy).toMatchObject({ pseudonyms: true, custodyDefault: 'self' });
  });

  it('checks each step and answers in plain words', async () => {
    const bad = await agent.post('/setup/api/validate').send({ section: 'admin', input: { admin: { handle: 'X', email: 'nope', password: 'short' } } });
    expect(bad.body.errors.handle).toMatch(/lowercase/);
    expect(bad.body.errors.password).toMatch(/10 characters/);
    const good = await agent.post('/setup/api/validate').send({ section: 'kind', input: { kind: 'community' } });
    expect(good.body).toEqual({ ok: true });
  });

  it('shows the DNS records and checks that the address leads to this server', async () => {
    const r = await agent.post('/setup/api/check-dns').send({ addresses: wizardInput().addresses });
    expect(r.status).toBe(200);
    expect(r.body.records.map((x: { name: string }) => x.name)).toContain('*.example.org');
    const server = r.body.checks.find((c: { label: string }) => c.label.startsWith('Server'));
    expect(server.ok).toBe(true);
    const names = r.body.checks.find((c: { label: string }) => c.label.startsWith('People'));
    expect(names.ok).toBe(true);
  });

  it('sends a test email, and explains a failure', async () => {
    const ok = await agent.post('/setup/api/test-email').send({ email: wizardInput().email, to: 'me@example.org' });
    expect(ok.status).toBe(200);
    expect(mails).toEqual([{ to: 'me@example.org', host: 'smtp.example.com' }]);
    const broken = await agent.post('/setup/api/test-email').send({ email: { ...wizardInput().email, host: 'smtp.broken.example' }, to: 'me@example.org' });
    expect(broken.status).toBe(502);
    expect(broken.body.message).toMatch(/connection refused/);
  });

  it('will not finish with a missing answer', async () => {
    const r = await agent.post('/setup/api/finish').send({ input: { ...wizardInput(), email: { mode: '' } } });
    expect(r.status).toBe(400);
    expect(r.body.errors.email).toBeTruthy();
    expect(existsSync(configPath)).toBe(false);
    expect(completed).toBe(0);
  });

  it('finishing writes the settings file with generated secrets, records it, and locks setup', async () => {
    const r = await agent.post('/setup/api/finish').send({ input: wizardInput() });
    expect(r.status).toBe(200);
    expect(r.body.adminHandle).toBe(ADMIN.handle);
    expect(r.body.checklist.length).toBeGreaterThan(3);

    const values = readConfigFile(configPath)!;
    expect(values).toMatchObject({
      OPENFEDERATION_PROFILE: 'privacy', PDS_SERVICE_URL: base, HANDLE_SUFFIX: '.example.org',
      SMTP_HOST: 'smtp.example.com', SMTP_PASSWORD: 'mail-secret', PSEUDONYMS_ENABLED: 'true', IDENTITY_CUSTODY_DEFAULT: 'self',
    });
    expect(values.AUTH_JWT_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(values.KEY_ENCRYPTION_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(values.OAUTH_SIGNING_KEY).alg).toBe('ES256');
    // The admin password is never in the settings file.
    expect(JSON.stringify(values)).not.toContain(ADMIN.password);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(r.body.settingsFile).toContain(values.KEY_ENCRYPTION_SECRET);

    const row = await query('SELECT pending_admin_handle, pending_admin_password_hash FROM server_setup');
    expect(row.rows[0].pending_admin_handle).toBe(ADMIN.handle);
    expect(row.rows[0].pending_admin_password_hash).toMatch(/^\$2[aby]\$/);

    await new Promise((res) => setTimeout(res, 400));
    expect(completed).toBe(1);

    // Locked: the same browser, the same code, a second finish.
    expect((await agent.post('/setup/api/finish').send({ input: wizardInput() })).status).toBe(410);
    expect((await agent.post('/setup/api/claim').send({ code: codes[0] })).status).toBe(410);
    expect((await agent.get('/setup/api/status')).body).toMatchObject({ claimed: false, finished: true });
  });

  it('a lost settings file does not reopen setup: the wizard explains, /health is unhealthy', async () => {
    const saved = readConfigFile(configPath)!;
    unlinkSync(configPath);
    const fresh = createSetupApp({ env: { NODE_ENV: 'development' }, store, configPath, claim: new ClaimGuard({ announce: () => undefined }), onComplete: () => undefined });
    const health = await request(fresh).get('/health');
    expect(health.status).toBe(503);
    expect(health.body.setup).toBe('settings-file-missing');
    const status = await request(fresh).get('/setup/api/status');
    expect(status.body).toMatchObject({ locked: true, configPath });
    expect((await request(fresh).post('/setup/api/claim').send({ code: 'anything' })).status).toBe(410);
    writeFileSync(configPath, Object.entries(saved).map(([k, v]) => `${k}='${v}'`).join('\n'));
  });
});

describe('after setup: the normal server', () => {
  it('creates the admin from the wizard on its first start, once, and the password works', async () => {
    expect(await completePendingSetupAdmin()).toBe('created');
    expect(await completePendingSetupAdmin()).toBe('none');
    const row = await query('SELECT pending_admin_password_hash FROM server_setup');
    expect(row.rows[0].pending_admin_password_hash).toBeNull();

    const roles = await query(`SELECT r.role FROM user_roles r JOIN users u ON u.id = r.user_id WHERE u.handle = $1`, [ADMIN.handle]);
    expect(roles.rows.map((x: { role: string }) => x.role)).toContain('admin');
    const audit = await query(`SELECT meta FROM audit_log WHERE action = 'account.register' AND meta->>'handle' = $1`, [ADMIN.handle]);
    expect(audit.rows[0].meta).toMatchObject({ source: 'setup', actor: 'system/setup' });

    const login = await xrpcPost('com.atproto.server.createSession', { identifier: ADMIN.handle, password: ADMIN.password });
    expect(login.status).toBe(200);
  });

  it('answers /setup with "already set up" and refuses the setup API', async () => {
    const page = await api.get('/setup');
    expect(page.status).toBe(200);
    expect(page.text).toContain('already set up');
    expect((await api.post('/setup/api/finish').send({})).status).toBe(410);
    expect((await api.post('/setup/api/claim').send({ code: 'x' })).status).toBe(410);
  });

  it('serves AT Protocol handle verification for its own names', async () => {
    const user = await query<{ did: string }>('SELECT did FROM users WHERE handle = $1', [ADMIN.handle]);
    const ok = await api.get('/.well-known/atproto-did').set('Host', `${ADMIN.handle}.openfederation.net`);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toMatch(/text\/plain/);
    expect(ok.text).toBe(user.rows[0].did);
    expect((await api.get('/.well-known/atproto-did').set('Host', 'nobody-here.openfederation.net')).status).toBe(404);
    expect((await api.get('/.well-known/atproto-did').set('Host', `${ADMIN.handle}.elsewhere.example`)).status).toBe(404);
    expect((await api.get('/.well-known/atproto-did').set('Host', `a.${ADMIN.handle}.openfederation.net`)).status).toBe(404);
  });
});
