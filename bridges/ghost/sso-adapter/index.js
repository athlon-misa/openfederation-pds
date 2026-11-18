/**
 * Ghost SSO adapter: staff sign in to Ghost admin with their AT Protocol
 * account, through an OpenFederation PDS's OpenID Connect provider.
 *
 * The Ghost bridge (bridges/ghost) runs the sign-in and leaves the provider's
 * ID token in a short-lived cookie scoped to /ghost. On the next admin
 * request Ghost asks this adapter for the user:
 *
 *   getRequestCredentials   the ID token from that cookie
 *   getIdentityFromCredentials
 *                           verified: RS256 signature against the provider's
 *                           JWKS, issuer, audience (the bridge's client), not
 *                           expired, and a verified email
 *   getUserForIdentity      the Ghost staff user with that email, if active;
 *                           nobody is created here
 *
 * Install at content/adapters/sso/openfederation/ (with its package.json, so
 * @tryghost/adapter-base-sso is installed next to it) and configure:
 *
 *   "adapters": { "sso": { "active": "openfederation", "openfederation": {
 *     "issuer": "https://pds.openfederation.net/oidc",
 *     "clientId": "ghost-opennewsrooms",
 *     "cookieName": "of_ghost_sso" } } }
 *
 * (as environment: adapters__sso__active=openfederation,
 *  adapters__sso__openfederation__issuer=…, …).
 */
'use strict';

const crypto = require('crypto');
const { SSOBase } = require('@tryghost/adapter-base-sso');

const JWKS_TTL_MS = 10 * 60 * 1000;
// Ghost's signed-in user states (warn-N: active, with failed-login warnings).
const ACTIVE_STATUSES = new Set(['active', 'warn-1', 'warn-2', 'warn-3', 'warn-4']);

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf-8'));
}

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

class OpenFederationSSO extends SSOBase {
  constructor(config = {}) {
    super();
    if (!config.issuer || !config.clientId) {
      throw new Error('openfederation SSO adapter: "issuer" and "clientId" are required');
    }
    this.issuer = String(config.issuer).replace(/\/+$/, '');
    this.clientId = String(config.clientId);
    this.cookieName = config.cookieName || 'of_ghost_sso';
    this.jwks = null;
    this.jwksAt = 0;
  }

  async getRequestCredentials(request) {
    const token = readCookie(request.headers && request.headers.cookie, this.cookieName);
    return token && token.split('.').length === 3 ? token : null;
  }

  async keys(force) {
    if (!force && this.jwks && Date.now() - this.jwksAt < JWKS_TTL_MS) return this.jwks;
    const disc = await fetch(`${this.issuer}/.well-known/openid-configuration`).then((r) => r.json());
    if (disc.issuer !== this.issuer) throw new Error('openfederation SSO: issuer mismatch in discovery');
    const set = await fetch(disc.jwks_uri).then((r) => r.json());
    this.jwks = Array.isArray(set.keys) ? set.keys : [];
    this.jwksAt = Date.now();
    return this.jwks;
  }

  async getIdentityFromCredentials(token) {
    try {
      const [h, p, s] = token.split('.');
      const header = b64urlJson(h);
      if (header.alg !== 'RS256') return null;
      let jwk = (await this.keys(false)).find((k) => k.kid === header.kid);
      if (!jwk) jwk = (await this.keys(true)).find((k) => k.kid === header.kid);
      if (!jwk) return null;
      const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
      const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
      if (!ok) return null;
      const claims = b64urlJson(p);
      const now = Math.floor(Date.now() / 1000);
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (claims.iss !== this.issuer) return null;
      if (!aud.includes(this.clientId)) return null;
      if (typeof claims.exp !== 'number' || claims.exp < now - 30) return null;
      if (typeof claims.sub !== 'string' || !claims.sub.startsWith('did:')) return null;
      // Staff are matched by email, so only an address the PDS verified counts.
      if (claims.email_verified !== true || typeof claims.email !== 'string') return null;
      return { did: claims.sub, email: claims.email.toLowerCase() };
    } catch (err) {
      return null;
    }
  }

  async getUserForIdentity(identity) {
    const user = await this.getUserByEmail(identity.email);
    // Older Ghost omits status; when present only an active user signs in
    // (not the inactive placeholder owner of first-run setup, not suspended).
    if (!user || (user.status !== undefined && !ACTIVE_STATUSES.has(user.status))) return null;
    return user;
  }
}

module.exports = OpenFederationSSO;
