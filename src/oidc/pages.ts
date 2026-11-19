/**
 * The sign-in pages an app sends people to (ADR-005).
 *
 * Plain server-rendered HTML with no script: a handle form, then either a
 * password form (accounts of this server) or a redirect to the person's own
 * server. Not frameable, not cached, no referrer. There is deliberately no
 * `form-action` restriction: the handle form ends in a redirect to whatever
 * server the account lives on, and browsers check `form-action` against
 * redirects too.
 */
import type { Response } from 'express';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; max-width: 440px; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; color: #1f2328; background: #fff; }
h1 { font-size: 1.35rem; margin-bottom: .25rem; }
.app { color: #59636e; margin-top: 0; }
label { display: block; font-weight: 600; margin: 1rem 0 .35rem; }
input[type=text], input[type=password] { width: 100%; padding: .6rem; box-sizing: border-box; font-size: 1rem; border: 1px solid #d1d9e0; border-radius: 6px; }
button { margin-top: 1rem; padding: .6rem 1.2rem; font-size: 1rem; border-radius: 6px; border: 1px solid #1f883d; background: #1f883d; color: #fff; cursor: pointer; }
button.secondary { background: #fff; color: #1f2328; border-color: #d1d9e0; }
.hint { color: #59636e; font-size: .9rem; }
.error { color: #d1242f; background: #fff1f0; padding: .6rem .8rem; border-radius: 6px; }
ul.shares { padding-left: 1.2rem; }
@media (prefers-color-scheme: dark) {
  body { color: #e6edf3; background: #0d1117; }
  .app, .hint { color: #9198a1; }
  input[type=text], input[type=password] { background: #0d1117; color: #e6edf3; border-color: #3d444d; }
  button.secondary { background: #0d1117; color: #e6edf3; border-color: #3d444d; }
  .error { background: #2d1214; color: #ff8182; }
}`;

export function sendPage(res: Response, status: number, title: string, body: string): void {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.status(status).type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>`);
}

export function errorPage(res: Response, status: number, heading: string, message: string): void {
  sendPage(res, status, heading, `<h1>${escapeHtml(heading)}</h1><p>${escapeHtml(message)}</p>`);
}

function sharesList(scopes: readonly string[], serverName: string): string {
  const items = [
    '<li>your account\'s permanent identifier (DID)</li>',
    ...(scopes.includes('profile') ? ['<li>your handle and display name</li>'] : []),
    ...(scopes.includes('email') ? [`<li>your email address, if your account is on ${escapeHtml(serverName)}</li>`] : []),
  ];
  return `<ul class="shares">${items.join('')}</ul>`;
}

export function signInPage(res: Response, input: {
  requestId: string;
  appName: string;
  appHost: string;
  serverName: string;
  scopes: readonly string[];
  handle?: string;
  error?: string;
  communityName?: string | null;
}): void {
  const body = `
<h1>Sign in to ${escapeHtml(input.appName)}</h1>
<p class="app">${escapeHtml(input.appHost)} uses ${escapeHtml(input.serverName)} to sign you in with your AT Protocol account (Bluesky, OpenFederation or any other).</p>
${input.communityName ? `<p class="hint">Only members of <strong>${escapeHtml(input.communityName)}</strong> can sign in to this app.</p>` : ''}
${input.error ? `<p class="error" role="alert">${escapeHtml(input.error)}</p>` : ''}
<form method="post" action="/oidc/authorize/identify">
  <input type="hidden" name="request" value="${escapeHtml(input.requestId)}">
  <label for="handle">Your handle</label>
  <input type="text" id="handle" name="handle" value="${escapeHtml(input.handle ?? '')}" placeholder="alice.bsky.social" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus>
  <p class="hint">Accounts on other servers continue on their own server.</p>
  <button type="submit">Continue</button>
</form>
<p class="hint">${escapeHtml(input.appName)} will receive:</p>
${sharesList(input.scopes, input.serverName)}
<p class="hint">It does not get your password or anything else.</p>`;
  sendPage(res, input.error ? 400 : 200, `Sign in to ${input.appName}`, body);
}

/** "Continue as …": the remembered sign-in from an earlier app (#462). */
export function continueAsPage(res: Response, input: {
  requestId: string;
  appName: string;
  appHost: string;
  serverName: string;
  handle: string;
  scopes: readonly string[];
}): void {
  const body = `
<h1>Sign in to ${escapeHtml(input.appName)}</h1>
<p class="app">${escapeHtml(input.appHost)} uses ${escapeHtml(input.serverName)} to sign you in.</p>
<form method="post" action="/oidc/authorize/session">
  <input type="hidden" name="request" value="${escapeHtml(input.requestId)}">
  <button type="submit" autofocus>Continue as ${escapeHtml(input.handle)}</button>
</form>
<form method="get" action="/oidc/authorize/signin">
  <input type="hidden" name="request" value="${escapeHtml(input.requestId)}">
  <button type="submit" class="secondary">Use a different account</button>
</form>
<p class="hint">${escapeHtml(input.appName)} will receive:</p>
${sharesList(input.scopes, input.serverName)}
<p class="hint">You signed in to another app earlier in this browser. Signing out of any app ends this.</p>`;
  sendPage(res, 200, `Sign in to ${input.appName}`, body);
}

export function passwordPage(res: Response, input: {
  requestId: string;
  appName: string;
  handle: string;
  error?: string;
  status?: number;
}): void {
  const body = `
<h1>Sign in to ${escapeHtml(input.appName)}</h1>
<p class="app">as <strong>${escapeHtml(input.handle)}</strong></p>
${input.error ? `<p class="error" role="alert">${escapeHtml(input.error)}</p>` : ''}
<form method="post" action="/oidc/authorize/password">
  <input type="hidden" name="request" value="${escapeHtml(input.requestId)}">
  <input type="hidden" name="handle" value="${escapeHtml(input.handle)}">
  <input type="text" name="username" value="${escapeHtml(input.handle)}" autocomplete="username" hidden>
  <label for="password">Password</label>
  <input type="password" id="password" name="password" autocomplete="current-password" required autofocus>
  <button type="submit">Sign in</button>
</form>
<form method="get" action="/oidc/authorize/signin">
  <input type="hidden" name="request" value="${escapeHtml(input.requestId)}">
  <button type="submit" class="secondary">Use a different account</button>
</form>`;
  sendPage(res, input.status ?? (input.error ? 401 : 200), `Sign in to ${input.appName}`, body);
}

export function signedOutPage(res: Response, input: { appName: string | null; appOrigin: string | null; serverName: string }): void {
  const back = input.appOrigin
    ? `<p><a href="${escapeHtml(input.appOrigin)}">Back to ${escapeHtml(input.appName ?? input.appOrigin)}</a></p>`
    : '';
  sendPage(res, 200, 'Signed out', `
<h1>You are signed out${input.appName ? ` of ${escapeHtml(input.appName)}` : ''}</h1>
<p class="app">You are also signed out of ${escapeHtml(input.serverName)} in this browser: the next time you sign in to an app, you will be asked for your account again.</p>
${back}`);
}
