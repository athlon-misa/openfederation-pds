/**
 * The server in setup mode (#405): the wizard, /health, and nothing else.
 *
 * Every other path answers 503 SetupRequired, so no account, community or
 * XRPC method exists until setup is finished. See src/setup/launcher.ts for
 * how this mode is entered and left, and claim.ts for who may use it.
 */
import express, { type Request, type Response, type NextFunction } from 'express';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { promises as dnsPromises } from 'node:dns';
import nodemailer from 'nodemailer';
import { ClaimGuard } from './claim.js';
import { renderSetupPage, SETUP_CSS } from './page.js';
import { SETUP_SCRIPT } from './page-script.js';
import {
  validateSection, validateAll, resolveSetup, dnsRecords, afterInstallChecklist, defaultOptions, parseOrigin,
  normalizeHandleDomain, DEFAULT_PLC_URL, SECTIONS, type SetupInput, type SetupSection,
} from './settings.js';
import { generateSecrets } from './secrets.js';
import { writeConfigFile, removeConfigFile, probeConfigLocation } from './config-file.js';
import type { SetupStore } from './setup-store.js';
import { hashPassword } from '../auth/password.js';
import { parseCookies } from '../auth/credential-rules.js';

type Env = Record<string, string | undefined>;

export const SESSION_COOKIE = 'of_setup';

/** Variables the wizard writes; one already set in the environment overrides the wizard's choice. */
const WIZARD_VARIABLES = [
  'OPENFEDERATION_PROFILE', 'PDS_SERVICE_URL', 'PDS_HOSTNAME', 'HANDLE_SUFFIX', 'PLC_DIRECTORY_URL', 'WEB_UI_URL',
  'CORS_ORIGINS', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM', 'ALLOW_NO_EMAIL',
  'INVITE_REQUIRED', 'PSEUDONYMS_ENABLED', 'IDENTITY_CUSTODY_ALLOWED', 'IDENTITY_CUSTODY_DEFAULT',
];

export interface SmtpTestSettings { host: string; port: number; secure: boolean; user?: string; password?: string; from: string }

export interface SetupAppOptions {
  env: Env;
  store: SetupStore;
  configPath: string;
  claim: ClaimGuard;
  /** Called once setup is finished and the answer has been sent. */
  onComplete: () => void;
  sendTestEmail?: (smtp: SmtpTestSettings, to: string) => Promise<void>;
  resolveHost?: (host: string) => Promise<string[]>;
  fetchImpl?: typeof fetch;
}

const HEADERS: [string, string][] = [
  ['X-Content-Type-Options', 'nosniff'],
  ['X-Frame-Options', 'DENY'],
  ['Referrer-Policy', 'no-referrer'],
  ['Permissions-Policy', 'camera=(), microphone=(), geolocation=()'],
  ['Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"],
  ['Cache-Control', 'no-store'],
];

function parseTrustProxy(val: string | undefined): string | number | boolean {
  if (!val) return 1;
  if (val === 'true') return true;
  if (val === 'false') return false;
  const num = parseInt(val, 10);
  return Number.isNaN(num) ? val : num;
}

async function defaultSendTestEmail(smtp: SmtpTestSettings, to: string): Promise<void> {
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    auth: smtp.user ? { user: smtp.user, pass: smtp.password ?? '' } : undefined,
  });
  await transport.sendMail({
    from: smtp.from,
    to,
    subject: 'Test email from your OpenFederation server',
    text: 'This is a test email from the setup page of your OpenFederation server. If you are reading it, email works.',
  });
}

async function defaultResolveHost(host: string): Promise<string[]> {
  const resolver = new dnsPromises.Resolver({ timeout: 3000, tries: 2 });
  const out: string[] = [];
  await Promise.all([
    resolver.resolve4(host).then((a) => out.push(...a), () => undefined),
    resolver.resolve6(host).then((a) => out.push(...a), () => undefined),
  ]);
  return out;
}

/** A mail failure in words a non-specialist can act on. */
export function explainSmtpError(err: unknown): string {
  const e = err as { code?: string; responseCode?: number; message?: string; errors?: Array<{ code?: string }> };
  const code = e?.code ?? e?.errors?.[0]?.code;
  switch (code) {
    case 'EAUTH': return 'the mail server did not accept the username or password.';
    case 'ECONNREFUSED': return 'the mail server refused the connection. Check the mail server name and port.';
    case 'ENOTFOUND': case 'EDNS': return 'no mail server has that name. Check the spelling.';
    case 'ETIMEDOUT': case 'ESOCKET': case 'ECONNECTION': return 'the mail server could not be reached. Check the name and port, and the encryption choice (port 465 needs TLS).';
    case 'EENVELOPE': return 'the mail server refused the sender or recipient address. Check "Send emails from".';
  }
  const detail = (e?.message || code || '').trim();
  return detail ? `${detail}. Check the mail server, port, username and password.` : 'Check the mail server, port, username and password.';
}

function sanitizeInput(raw: unknown): Partial<SetupInput> {
  return raw && typeof raw === 'object' ? (raw as Partial<SetupInput>) : {};
}

/** The SMTP part of the input, as transport settings, or the field errors. */
function smtpFrom(input: Partial<SetupInput>, allowLocalHttp: boolean): { smtp: SmtpTestSettings } | { errors: Record<string, string> } {
  const errors = validateSection('email', input, allowLocalHttp);
  if (Object.keys(errors).length > 0) return { errors };
  const e = input.email;
  if (!e || e.mode !== 'smtp') return { errors: { mode: 'Choose "Send email through my provider" to send a test email.' } };
  const port = Number(e.port);
  return {
    smtp: {
      host: e.host.trim(), port, secure: (e.security ?? (port === 465 ? 'tls' : 'starttls')) === 'tls',
      user: e.user?.trim() || undefined, password: e.password, from: e.from.trim(),
    },
  };
}

export function createSetupApp(options: SetupAppOptions) {
  const { env, store, configPath, claim } = options;
  const allowLocalHttp = env.NODE_ENV !== 'production';
  const instanceId = randomBytes(16).toString('hex');
  const sendTestEmail = options.sendTestEmail ?? defaultSendTestEmail;
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  const fetchImpl = options.fetchImpl ?? fetch;
  let finished = false;

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', parseTrustProxy(env.EXPRESS_TRUST_PROXY));
  app.use((_req, res, next) => {
    for (const [k, v] of HEADERS) res.setHeader(k, v);
    if (env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    next();
  });

  /** Setup was finished before, but the settings file it wrote is gone. */
  async function lockedBySettingsLoss(): Promise<boolean> {
    if (existsSync(configPath)) return false;
    const at = await store.completedAt().catch(() => null);
    return at !== null;
  }

  app.get('/health', async (_req, res) => {
    const database = await store.reachable();
    const locked = await lockedBySettingsLoss();
    res.status(locked ? 503 : 200).json({
      status: 'setup',
      setup: locked ? 'settings-file-missing' : finished ? 'finished' : 'required',
      database: database ? 'connected' : 'disconnected',
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/', (_req, res) => res.redirect(302, '/setup'));
  app.get('/setup', (_req, res) => { res.status(200).type('html').send(renderSetupPage()); });
  app.get('/setup/assets/setup.js', (_req, res) => { res.status(200).type('application/javascript').send(SETUP_SCRIPT); });
  app.get('/setup/assets/setup.css', (_req, res) => { res.status(200).type('text/css').send(SETUP_CSS); });
  // Answers with this process's random id, so the wizard can tell that an
  // address really leads here (and not to some other server).
  app.get('/setup/api/ping', (_req, res) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.json({ instance: instanceId }); });

  // JSON only: a cross-site form cannot send it without a preflight, and the
  // session cookie is SameSite=Strict besides.
  const json = express.json({ limit: '32kb' });
  function requireJson(req: Request, res: Response, next: NextFunction) {
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'UnsupportedMediaType', message: 'Send JSON.' });
      return;
    }
    const origin = req.headers.origin;
    if (origin && origin !== `${req.protocol}://${req.get('host')}`) {
      res.status(403).json({ error: 'Forbidden', message: 'Requests must come from the setup page itself.' });
      return;
    }
    next();
  }
  function sessionOf(req: Request): string | undefined {
    return parseCookies(req.headers.cookie)[SESSION_COOKIE];
  }
  function requireClaim(req: Request, res: Response, next: NextFunction) {
    if (finished) {
      res.status(410).json({ error: 'SetupComplete', message: 'Setup is already finished.' });
      return;
    }
    if (!claim.hasSession(sessionOf(req))) {
      res.status(401).json({ error: 'SetupCodeRequired', message: 'Enter the setup code from the server log first.' });
      return;
    }
    next();
  }

  function suggestions(req: Request) {
    const here = `${req.protocol}://${req.get('host')}`;
    const pub = parseOrigin(env.SETUP_PUBLIC_URL || here, allowLocalHttp);
    const publicUrl = 'origin' in pub ? pub.origin : '';
    const host = 'host' in pub ? new URL(pub.origin).hostname : '';
    // pds.example.org suggests names under example.org; a platform address
    // (something.up.railway.app) is not a domain anyone should put names on.
    const labels = host.split('.');
    const handleDomain = env.SETUP_HANDLE_DOMAIN
      || (labels.length >= 3 && !/\.(railway\.app|onrender\.com|fly\.dev|herokuapp\.com)$/.test(host) ? labels.slice(1).join('.') : '');
    return {
      publicUrl,
      handleDomain,
      dashboardUrl: env.SETUP_DASHBOARD_URL || '',
      plcUrl: env.SETUP_PLC_URL || DEFAULT_PLC_URL,
    };
  }

  function warnings(): string[] {
    const list: string[] = [];
    const probe = probeConfigLocation(configPath);
    if (!probe.writable) {
      list.push(`The server cannot save its settings at ${configPath} (${probe.reason}). Finishing will fail until this is fixed. On Railway, attach a volume to the server and set RAILWAY_RUN_UID=0 (see the install guide).`);
    }
    if (env.RAILWAY_ENVIRONMENT && !env.RAILWAY_VOLUME_MOUNT_PATH) {
      list.push('This server does not seem to have a volume (a permanent disk) attached on Railway. Without one, the settings are lost at the next deploy. Attach a volume mounted at /data before you finish.');
    }
    return list;
  }

  app.get('/setup/api/status', async (req, res) => {
    const locked = await lockedBySettingsLoss();
    const claimed = !finished && claim.hasSession(sessionOf(req));
    const database = await store.reachable();
    const base = { locked, claimed, finished, database };
    if (locked) {
      res.json({ ...base, configPath });
      return;
    }
    if (!claimed) {
      res.json(base);
      return;
    }
    res.json({
      ...base,
      configPath,
      suggestions: suggestions(req),
      defaults: { community: defaultOptions('community'), privacy: defaultOptions('privacy') },
      defaultPlcUrl: DEFAULT_PLC_URL,
      overridden: WIZARD_VARIABLES.filter((k) => env[k] !== undefined),
      warnings: [...warnings(), ...(database ? [] : ['The database is not reachable right now, so setup cannot be finished. Check that the database service is running.'])],
    });
  });

  app.post('/setup/api/claim', json, requireJson, async (req, res) => {
    if (finished || (await lockedBySettingsLoss())) {
      res.status(410).json({ error: 'SetupComplete', message: 'Setup is already finished.' });
      return;
    }
    const result = claim.claim(typeof req.body?.code === 'string' ? req.body.code : '', req.ip ?? 'unknown');
    if (!result.ok) {
      if (result.reason === 'too-many-attempts') {
        res.setHeader('Retry-After', String(result.retryAfterSeconds ?? 900));
        res.status(429).json({ error: 'TooManyAttempts', message: 'Too many wrong codes. Wait 15 minutes and try again.' });
        return;
      }
      res.status(403).json({ error: 'WrongCode', message: 'That code is not right. Copy the newest "Setup code" line from the server log.' });
      return;
    }
    res.cookie(SESSION_COOKIE, result.sessionId, { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/setup' });
    res.json({ claimed: true });
  });

  app.post('/setup/api/validate', json, requireJson, requireClaim, (req, res) => {
    const section = req.body?.section as SetupSection;
    if (!SECTIONS.includes(section)) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Unknown step.' });
      return;
    }
    const errors = validateSection(section, sanitizeInput(req.body?.input), allowLocalHttp);
    res.json(Object.keys(errors).length ? { errors } : { ok: true });
  });

  app.post('/setup/api/check-dns', json, requireJson, requireClaim, async (req, res) => {
    const input = { addresses: sanitizeInput({ addresses: req.body?.addresses }).addresses } as Partial<SetupInput>;
    const errors = validateSection('addresses', input, allowLocalHttp);
    if (Object.keys(errors).length) {
      res.status(400).json({ errors });
      return;
    }
    const a = input.addresses!;
    const pub = parseOrigin(a.publicUrl, allowLocalHttp) as { origin: string };
    const publicHost = new URL(pub.origin).hostname;
    const handleDomain = normalizeHandleDomain(a.handleDomain);
    const dashboardOrigin = a.dashboardUrl?.trim() ? (parseOrigin(a.dashboardUrl, allowLocalHttp) as { origin: string }).origin : null;
    const records = dnsRecords({ publicHost, handleDomain, dashboardOrigin }, env.RAILWAY_PUBLIC_DOMAIN || null, env.SETUP_DASHBOARD_HOST || null);

    const checks: Array<{ label: string; ok: boolean | null; detail: string }> = [];
    let reachesHere = false;
    try {
      const ping = await fetchImpl(`${pub.origin}/setup/api/ping`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      const body = (await ping.json().catch(() => ({}))) as { instance?: string };
      reachesHere = body.instance === instanceId;
      checks.push({
        label: 'Server address.',
        ok: reachesHere,
        detail: reachesHere ? `${pub.origin} leads to this server.` : `${pub.origin} answers, but it is a different server. Check the record for ${publicHost}.`,
      });
    } catch {
      checks.push({ label: 'Server address.', ok: false, detail: `${pub.origin} cannot be reached yet. If you just added its record, wait a few minutes and check again.` });
    }

    const serverAddresses = new Set(await resolveHost(publicHost));
    const probeName = `check-${randomBytes(4).toString('hex')}.${handleDomain}`;
    const nameAddresses = await resolveHost(probeName);
    if (nameAddresses.length === 0) {
      checks.push({ label: 'People\'s names.', ok: false, detail: `Names like ${probeName} do not lead anywhere yet. This is optional; add the *.${handleDomain} record when you are ready.` });
    } else {
      const same = nameAddresses.some((ip) => serverAddresses.has(ip));
      checks.push({
        label: 'People\'s names.',
        ok: same,
        detail: same ? `Names like alice.${handleDomain} lead to this server.` : `Names under ${handleDomain} lead somewhere else. Point *.${handleDomain} at ${publicHost}.`,
      });
    }
    if (dashboardOrigin) {
      const dashHost = new URL(dashboardOrigin).hostname;
      const found = (await resolveHost(dashHost)).length > 0;
      checks.push({ label: 'Dashboard address.', ok: found, detail: found ? `${dashHost} is set up.` : `${dashHost} does not lead anywhere yet.` });
    }
    res.json({ records, checks });
  });

  app.post('/setup/api/test-email', json, requireJson, requireClaim, async (req, res) => {
    const input = sanitizeInput({ email: req.body?.email });
    const parsed = smtpFrom(input, allowLocalHttp);
    if ('errors' in parsed) {
      res.status(400).json({ errors: parsed.errors });
      return;
    }
    const to = typeof req.body?.to === 'string' ? req.body.to.trim() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      res.status(400).json({ message: 'Enter the address to send the test email to.' });
      return;
    }
    try {
      await sendTestEmail(parsed.smtp, to);
      res.json({ message: `Sent. Check the inbox of ${to} (and its spam folder).` });
    } catch (err) {
      res.status(502).json({ message: `The email could not be sent: ${explainSmtpError(err)}` });
    }
  });

  app.post('/setup/api/finish', json, requireJson, requireClaim, async (req, res) => {
    if (await lockedBySettingsLoss()) {
      res.status(410).json({ error: 'SetupComplete', message: 'Setup is already finished.' });
      return;
    }
    const input = sanitizeInput(req.body?.input);
    const errors = validateAll(input, allowLocalHttp);
    if (Object.keys(errors).length) {
      res.status(400).json({ errors });
      return;
    }
    let resolved;
    try {
      resolved = resolveSetup(input as SetupInput, allowLocalHttp);
    } catch (err) {
      res.status(400).json({ errors: { options: { custody: err instanceof Error ? err.message : String(err) } } });
      return;
    }
    if (!(await store.reachable())) {
      res.status(503).json({ message: 'The database is not reachable, so setup cannot be saved. Check that the database service is running, then try again.' });
      return;
    }
    if (await store.accountExists(resolved.admin.handle, resolved.admin.email)) {
      res.status(400).json({ errors: { admin: { handle: 'An account with this name or email already exists in the database. Choose another name and email.' } } });
      return;
    }
    const probe = probeConfigLocation(configPath);
    if (!probe.writable) {
      res.status(500).json({ message: `The settings cannot be saved at ${configPath}: ${probe.reason}. On Railway, attach a volume at /data and set RAILWAY_RUN_UID=0, then redeploy.` });
      return;
    }

    const passwordHash = await hashPassword((input as SetupInput).admin.password);
    const values = { ...resolved.env, ...generateSecrets() };
    let settingsFile = '';
    try {
      await store.complete(
        { configFile: configPath, admin: { ...resolved.admin, passwordHash } },
        () => { settingsFile = writeConfigFile(configPath, values); },
        () => removeConfigFile(configPath),
      );
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      console.error(`Setup: could not finish: ${why}`);
      const already = /duplicate key|already exists/i.test(why);
      res.status(already ? 409 : 500).json({
        message: already
          ? 'Setup was already finished, perhaps from another browser. Reload the page.'
          : `Setup could not be saved: ${why}`,
      });
      return;
    }

    finished = true;
    claim.lock();
    console.log(`Setup finished. Settings saved to ${configPath}; restarting with them.`);
    res.on('finish', () => setTimeout(options.onComplete, 250));
    res.json({
      ok: true,
      settingsFile,
      records: dnsRecords(resolved, env.RAILWAY_PUBLIC_DOMAIN || null, env.SETUP_DASHBOARD_HOST || null),
      checklist: afterInstallChecklist(resolved),
      publicUrl: resolved.publicOrigin,
      dashboardUrl: resolved.dashboardOrigin,
      adminHandle: resolved.admin.handle,
    });
  });

  // Everything else waits for setup.
  app.use((req, res) => {
    const wantsHtml = req.method === 'GET' && (req.headers.accept ?? '').includes('text/html');
    if (wantsHtml) {
      res.redirect(302, '/setup');
      return;
    }
    res.status(503).json({ error: 'SetupRequired', message: 'This server is not set up yet. Open /setup in a browser to set it up.' });
  });

  return app;
}

/** In normal mode: /setup says so, and the setup API is gone for good. */
export function createSetupDoneRouter() {
  const router = express.Router();
  router.get('/setup', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).type('html').send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Server is set up</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5">
<h1 style="font-size: 1.4rem">This server is already set up</h1>
<p>Setup can only be done once. To change settings, sign in to the dashboard as an admin, or change the server's settings file or environment variables and restart it.</p>
</body></html>`);
  });
  router.all(/^\/setup\/api\/.*/, (_req, res) => {
    res.status(410).json({ error: 'SetupComplete', message: 'This server is already set up.' });
  });
  return router;
}
