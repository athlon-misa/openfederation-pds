/**
 * Sign in to Ghost with an AT Protocol account (Bluesky, OpenFederation, any
 * PDS) through an OpenFederation PDS's OpenID Connect provider.
 *
 *   GET  {base}/signin?for=member|staff&return=/path
 *   GET  {base}/callback          the PDS sends the browser back here
 *   POST {base}/email             a reader without an email in their claims gives one
 *   GET  {base}/health
 *
 * Readers become Ghost members (found by email, or by the DID in their note)
 * and are signed in with Ghost's own one-time link. Staff are signed in by
 * the OpenFederation SSO adapter in Ghost, which verifies the ID token this
 * bridge leaves in a short-lived cookie (sso-adapter/).
 */
import express, { type Request, type Response } from 'express';
import { loadConfig } from './config.js';
import { OidcClient, type Identity } from './oidc.js';
import { GhostAdmin, didNote } from './ghost.js';
import { seal, unseal, parseCookies, cookie } from './cookies.js';
import { page, esc } from './pages.js';

const cfg = loadConfig();
const oidc = new OidcClient(cfg);
const ghost = new GhostAdmin(cfg);
const secure = cfg.ghostUrl.startsWith('https://');
const FLOW = 'ofg_flow';
const PENDING = 'ofg_pending';

type Purpose = 'member' | 'staff';
interface Flow { state: string; verifier: string; nonce: string; purpose: Purpose; returnTo: string }
interface Pending { did: string; handle: string | null; name: string | null; returnTo: string }

/** Only paths on the Ghost site: never an absolute or protocol-relative URL. */
function safeReturn(raw: unknown): string {
  return typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\') ? raw : '/';
}

const app = express();
app.disable('x-powered-by');
const router = express.Router();
router.use(express.urlencoded({ extended: false, limit: '8kb' }));

router.get('/health', (_req, res) => { res.type('text/plain').send('ok'); });

router.get('/signin', async (req: Request, res: Response) => {
  const purpose: Purpose = req.query.for === 'staff' ? 'staff' : 'member';
  try {
    const start = await oidc.start();
    const flow: Flow = { state: start.state, verifier: start.verifier, nonce: start.nonce, purpose, returnTo: safeReturn(req.query.return) };
    res.append('Set-Cookie', cookie(FLOW, seal(cfg.cookieSecret, flow, 600), { path: cfg.basePath, maxAge: 600, secure }));
    res.redirect(303, start.url);
  } catch (err) {
    console.error('signin start failed:', err);
    page(res, 502, cfg.siteName, 'Sign-in is not available', '<p>The sign-in service could not be reached. Try again in a moment.</p>');
  }
});

router.get('/callback', async (req: Request, res: Response) => {
  const flow = unseal<Flow>(cfg.cookieSecret, parseCookies(req.headers.cookie)[FLOW]);
  res.append('Set-Cookie', cookie(FLOW, '', { path: cfg.basePath, maxAge: 0, secure }));
  if (!flow || typeof req.query.state !== 'string' || req.query.state !== flow.state) {
    page(res, 400, cfg.siteName, 'This sign-in has expired', `<p><a class="btn" href="${esc(cfg.basePath)}/signin">Start again</a></p>`);
    return;
  }
  if (typeof req.query.error === 'string') {
    const msg = req.query.error === 'access_denied' && typeof req.query.error_description === 'string'
      ? req.query.error_description : 'Signing in was cancelled.';
    page(res, 403, cfg.siteName, 'Not signed in', `<p>${esc(msg)}</p><p><a class="btn btn--ghost" href="${esc(cfg.ghostUrl)}/">Back to the site</a></p>`);
    return;
  }
  let id: Identity;
  try {
    id = await oidc.finish(String(req.query.code ?? ''), flow.verifier, flow.nonce);
  } catch (err) {
    console.error('signin finish failed:', err);
    page(res, 400, cfg.siteName, 'Sign-in failed', '<p>Your account could not be confirmed. Start again from the site.</p>');
    return;
  }
  try {
    if (flow.purpose === 'staff') return staffSignin(res, id);
    return await memberSignin(res, id, flow.returnTo);
  } catch (err) {
    console.error('signin failed:', err);
    page(res, 500, cfg.siteName, 'Sign-in failed', '<p>Something went wrong on our side. Try again in a moment.</p>');
  }
});

/** Staff: leave the verified ID token for the SSO adapter and open Ghost admin. */
function staffSignin(res: Response, id: Identity): void {
  if (!id.email || !id.emailVerified) {
    page(res, 403, cfg.siteName, 'Staff sign-in needs a verified email',
      '<p>Your AT Protocol account did not share a verified email address. Staff are matched to their Ghost account by email: sign in with an account whose verified email is the one on your Ghost staff profile.</p>');
    return;
  }
  res.append('Set-Cookie', cookie(cfg.staffCookie, id.idToken, { path: '/ghost', maxAge: 120, secure }));
  res.redirect(303, `${cfg.ghostUrl}/ghost/`);
}

/** Readers: find or create the member, then Ghost's own one-time sign-in link. */
async function memberSignin(res: Response, id: Identity, returnTo: string): Promise<void> {
  const verifiedEmail = id.email && id.emailVerified ? id.email : null;
  // 1. A verified email from the person's PDS: that member, created if new.
  if (verifiedEmail) {
    const member = (await ghost.findByEmail(verifiedEmail))
      ?? await ghost.createMember({ email: verifiedEmail, name: id.name ?? id.handle, note: didNote(id.did, id.handle, true) });
    await ghost.attachDid(member, didNote(id.did, id.handle, true));
    return redirectSignedIn(res, member.id, returnTo);
  }
  // 2. No email in the claims (e.g. Bluesky), but this DID is known.
  const known = await ghost.findByDid(id.did);
  if (known?.confirmed) return redirectSignedIn(res, known.member.id, returnTo);
  if (known) {
    // The address was typed, never proven by the PDS: only an emailed link.
    await ghost.sendSigninEmail(known.member.email);
    page(res, 200, cfg.siteName, 'Check your email', `<p class="lede">We sent a sign-in link to <strong>${esc(maskEmail(known.member.email))}</strong>, the address you gave last time.</p>`);
    return;
  }
  // 3. Unknown and no email: ask once; Ghost's emailed link proves it.
  const pending: Pending = { did: id.did, handle: id.handle, name: id.name, returnTo };
  res.append('Set-Cookie', cookie(PENDING, seal(cfg.cookieSecret, pending, 900), { path: cfg.basePath, maxAge: 900, secure }));
  emailForm(res, pending);
}

async function redirectSignedIn(res: Response, memberId: string, returnTo: string): Promise<void> {
  const url = new URL(await ghost.signinUrl(memberId));
  if (returnTo !== '/') url.searchParams.set('r', `${cfg.ghostUrl}${returnTo}`);
  res.redirect(303, url.toString());
}

export function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  return `${user.slice(0, 1)}${'•'.repeat(Math.max(1, Math.min(user.length - 1, 6)))}@${domain}`;
}

function emailForm(res: Response, p: Pending, error?: string): void {
  page(res, error ? 400 : 200, cfg.siteName, 'One more step', `
<p class="lede">You are signed in as <strong>${esc(p.handle ? `@${p.handle}` : p.did)}</strong>. ${esc(cfg.siteName)} sends newsletters and sign-in links by email, and your account did not share one.</p>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="${esc(cfg.basePath)}/email">
  <label for="email">Your email address</label>
  <input id="email" name="email" type="email" autocomplete="email" required autofocus>
  <button class="btn" type="submit">Email me a sign-in link</button>
</form>
<p class="hint">We email you a link to confirm the address. Next time you sign in with the same account, you go straight in.</p>`);
}

router.post('/email', async (req: Request, res: Response) => {
  const p = unseal<Pending>(cfg.cookieSecret, parseCookies(req.headers.cookie)[PENDING]);
  if (!p) {
    page(res, 400, cfg.siteName, 'This sign-in has expired', `<p><a class="btn" href="${esc(cfg.basePath)}/signin">Start again</a></p>`);
    return;
  }
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    emailForm(res, p, 'Enter a valid email address.');
    return;
  }
  try {
    const existing = await ghost.findByEmail(email);
    if (existing) {
      // An existing member is never given this DID on a typed address: they
      // just get Ghost's sign-in email, which only the address's owner reads.
      await ghost.sendSigninEmail(email);
    } else {
      await ghost.createMember({ email, name: p.name ?? p.handle, note: didNote(p.did, p.handle, false), sendEmail: true });
    }
    res.append('Set-Cookie', cookie(PENDING, '', { path: cfg.basePath, maxAge: 0, secure }));
    page(res, 200, cfg.siteName, 'Check your email', `<p class="lede">We sent a sign-in link to <strong>${esc(email)}</strong>. Open it on this device to finish signing in.</p>`);
  } catch (err) {
    console.error('email step failed:', err);
    emailForm(res, p, 'That did not work. Try again in a moment.');
  }
});

app.use(cfg.basePath, router);
app.listen(cfg.port, () => {
  console.log(`Ghost bridge on :${cfg.port}${cfg.basePath} for ${cfg.ghostUrl}, issuer ${cfg.issuer}, client ${cfg.clientId}`);
});
