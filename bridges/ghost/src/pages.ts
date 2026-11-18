/**
 * The bridge's few pages, in the Open Newsrooms style (newsprint, ink,
 * Newsreader and IBM Plex Mono, the red quote mark). Fonts come from the
 * theme (`/assets/fonts/` on the Ghost site); system fallbacks otherwise.
 */
import type { Response } from 'express';

export function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const CSS = `
:root { --ink:#1a1815; --paper:#f5f1e8; --red:#b3261e; --muted:#6b655a; --rule:#d8d3c8;
  --serif:'Newsreader',Georgia,serif; --mono:'IBM Plex Mono',ui-monospace,monospace; }
@media (prefers-color-scheme: dark) { :root { --ink:#f5f1e8; --paper:#1a1815; --muted:#b8b2a6; --rule:#3a3631; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--paper); color:var(--ink); font-family:var(--serif); font-size:19px; line-height:1.5; }
header { display:flex; align-items:center; gap:12px; padding:20px 32px; border-bottom:1px solid var(--ink); }
.mark { width:40px; height:40px; background:var(--red); color:#f5f1e8; display:flex; align-items:center; justify-content:center;
  font-size:64px; line-height:.5; padding-top:20px; font-weight:700; }
.site { font-size:24px; font-weight:500; letter-spacing:-.02em; }
main { max-width:640px; margin:0 auto; padding:48px 20px 80px; }
h1 { font-size:clamp(32px,5vw,48px); line-height:1.05; letter-spacing:-.025em; font-weight:500; margin:0 0 20px; }
p { margin:0 0 16px; } .lede { font-size:21px; }
label { display:block; font-family:var(--mono); font-size:13px; text-transform:uppercase; letter-spacing:.06em; margin:24px 0 8px; }
input { width:100%; padding:12px 14px; font:inherit; background:transparent; color:var(--ink); border:1px solid var(--ink); border-radius:0; }
.btn { display:inline-block; margin-top:16px; padding:14px 22px; border:1px solid var(--ink); background:var(--ink); color:var(--paper);
  font-family:var(--mono); font-size:13px; font-weight:500; text-decoration:none; cursor:pointer; }
.btn:hover { background:var(--red); border-color:var(--red); color:#f5f1e8; }
.btn--ghost { background:transparent; color:var(--ink); }
.hint { color:var(--muted); font-size:16px; margin-top:24px; }
.error { color:var(--red); border-left:3px solid var(--red); padding-left:12px; }
a { color:var(--ink); } a:hover { color:var(--red); }`;

export function page(res: Response, status: number, siteName: string, title: string, body: string): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  res.status(status).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${esc(title)} · ${esc(siteName)}</title>
<style>@font-face{font-family:'Newsreader';src:url('/assets/fonts/newsreader-normal-300-800-latin.woff2') format('woff2');font-weight:300 800;font-display:swap}
@font-face{font-family:'IBM Plex Mono';src:url('/assets/fonts/ibm-plex-mono-normal-500-latin.woff2') format('woff2');font-weight:500;font-display:swap}${CSS}</style>
</head><body><header><span class="mark" aria-hidden="true">“</span><span class="site">${esc(siteName)}</span></header>
<main><h1>${esc(title)}</h1>${body}</main></body></html>`);
}
