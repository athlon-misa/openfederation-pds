/**
 * The bridge as an OpenID Connect client of the PDS: authorization code with
 * PKCE (S256) and a nonce, client_secret_basic at the token endpoint, the ID
 * token verified against the provider's published keys.
 */
import crypto from 'crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { BridgeConfig } from './config.js';

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface Identity {
  did: string;
  handle: string | null;
  name: string | null;
  email: string | null;
  emailVerified: boolean;
  idToken: string;
}

const b64url = (buf: Buffer) => buf.toString('base64url');

export class OidcClient {
  private discovery: Promise<Discovery> | null = null;
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(private readonly cfg: BridgeConfig) {}

  get redirectUri(): string {
    return `${this.cfg.ghostUrl}${this.cfg.basePath}/callback`;
  }

  private async meta(): Promise<Discovery> {
    if (!this.discovery) {
      this.discovery = fetch(`${this.cfg.issuer}/.well-known/openid-configuration`)
        .then(async (r) => {
          if (!r.ok) throw new Error(`OIDC discovery: ${r.status}`);
          const d = (await r.json()) as Discovery;
          if (d.issuer !== this.cfg.issuer) throw new Error(`OIDC discovery: issuer ${d.issuer} is not ${this.cfg.issuer}`);
          return d;
        })
        .catch((err) => { this.discovery = null; throw err; });
    }
    return this.discovery;
  }

  /** A new sign-in: where to send the browser, and what to remember until it comes back. */
  async start(): Promise<{ url: string; state: string; verifier: string; nonce: string }> {
    const d = await this.meta();
    const verifier = b64url(crypto.randomBytes(32));
    const state = b64url(crypto.randomBytes(16));
    const nonce = b64url(crypto.randomBytes(16));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    return { url: url.toString(), state, verifier, nonce };
  }

  /** Exchange the code and verify the ID token. */
  async finish(code: string, verifier: string, nonce: string): Promise<Identity> {
    const d = await this.meta();
    const res = await fetch(d.token_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${encodeURIComponent(this.cfg.clientId)}:${encodeURIComponent(this.cfg.clientSecret)}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, code_verifier: verifier }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
    if (!res.ok || !body.id_token) throw new Error(`token endpoint: ${body.error ?? res.status} ${body.error_description ?? ''}`.trim());
    if (!this.jwks) this.jwks = createRemoteJWKSet(new URL(d.jwks_uri));
    const { payload } = await jwtVerify(body.id_token, this.jwks, { issuer: d.issuer, audience: this.cfg.clientId, algorithms: ['RS256'] });
    if (payload.nonce !== nonce) throw new Error('ID token nonce does not match');
    return toIdentity(payload, body.id_token);
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function toIdentity(p: JWTPayload, idToken: string): Identity {
  if (typeof p.sub !== 'string' || !p.sub.startsWith('did:')) throw new Error('ID token has no DID subject');
  return {
    did: p.sub,
    handle: str(p.handle) ?? str(p.preferred_username),
    name: str(p.name),
    email: str(p.email),
    emailVerified: p.email_verified === true,
    idToken,
  };
}
