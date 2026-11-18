/**
 * Setup for the apps people connect most (ADR-005).
 *
 * Given the app's address, a preset knows the redirect URI the app uses and
 * produces the configuration to paste into it, so neither the dashboard nor
 * the CLI has to explain each app's settings by hand. Used by
 * `net.openfederation.oidc.createClient` / `getClientSetup` and `ofc oidc`.
 */

export const APP_PRESETS = ['mastodon', 'lemmy', 'gotosocial', 'generic'] as const;
export type AppPreset = (typeof APP_PRESETS)[number];

export interface PresetInput {
  preset: AppPreset;
  /** The app's public address, e.g. https://mastodon.example. */
  appUrl: string;
  issuer: string;
  clientId: string;
  /** Shown only right after creating or rotating; otherwise a placeholder. */
  clientSecret: string | null;
  displayName: string;
}

const SECRET_PLACEHOLDER = '<the client secret shown when it was created>';

function base(appUrl: string): string {
  const url = new URL(appUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('appUrl must be an http(s) URL');
  return url.origin;
}

/** The redirect URI each app sends its users back to. */
export function presetRedirectUri(preset: AppPreset, appUrl: string): string | null {
  const origin = base(appUrl);
  switch (preset) {
    case 'mastodon': return `${origin}/auth/auth/openid_connect/callback`;
    case 'lemmy': return `${origin}/oauth/callback`;
    case 'gotosocial': return `${origin}/auth/callback`;
    case 'generic': return null;
  }
}

/** Scopes each app asks for. */
export function presetScopes(preset: AppPreset): string[] {
  return preset === 'generic' ? ['openid', 'profile'] : ['openid', 'profile', 'email'];
}

/** The configuration to paste into the app, as text. */
export function presetConfiguration(input: PresetInput): string {
  const secret = input.clientSecret ?? SECRET_PLACEHOLDER;
  const redirect = presetRedirectUri(input.preset, input.appUrl);
  const discovery = `${input.issuer}/.well-known/openid-configuration`;
  switch (input.preset) {
    case 'mastodon':
      return [
        '# Mastodon: add to .env.production, then restart web and sidekiq.',
        '# "did_slug" is the account\'s DID in a form Mastodon accepts as username',
        '# and email local part; the DID itself would break sign-up.',
        'OIDC_ENABLED=true',
        `OIDC_DISPLAY_NAME=${input.displayName}`,
        `OIDC_ISSUER=${input.issuer}`,
        'OIDC_DISCOVERY=true',
        'OIDC_SCOPE=openid,profile,email',
        'OIDC_UID_FIELD=did_slug',
        `OIDC_CLIENT_ID=${input.clientId}`,
        `OIDC_CLIENT_SECRET=${secret}`,
        `OIDC_REDIRECT_URI=${redirect}`,
        'OIDC_USE_PKCE=true',
        'OIDC_SECURITY_ASSUME_EMAIL_IS_VERIFIED=false',
        '# Optional: only allow this sign-in (no Mastodon passwords).',
        '# OMNIAUTH_ONLY=true',
      ].join('\n');
    case 'lemmy':
      return [
        '# Lemmy 1.0 or later: Admin → Settings → OAuth providers → Add.',
        '# (Lemmy 0.19 has no OpenID Connect sign-in.)',
        `Display name:            ${input.displayName}`,
        `Issuer:                  ${input.issuer}`,
        `Authorization endpoint:  ${input.issuer}/authorize`,
        `Token endpoint:          ${input.issuer}/token`,
        `User info endpoint:      ${input.issuer}/userinfo`,
        'ID claim:                sub',
        'Name claim:              did_slug',
        `Client ID:               ${input.clientId}`,
        `Client secret:           ${secret}`,
        'Scopes:                  openid profile email',
        'Auto-verify email:       off',
        'Account linking:         off',
        `Redirect URI (set here): ${redirect}`,
      ].join('\n');
    case 'gotosocial':
      return [
        '# GoToSocial: config.yaml, then restart.',
        '# GoToSocial needs an email claim: accounts from other servers have none',
        '# and cannot sign up there until GoToSocial allows that.',
        'oidc-enabled: true',
        `oidc-idp-name: "${input.displayName}"`,
        'oidc-skip-verification: false',
        `oidc-issuer: "${input.issuer}"`,
        `oidc-client-id: "${input.clientId}"`,
        `oidc-client-secret: "${secret}"`,
        'oidc-scopes: ["openid", "email", "profile"]',
        'oidc-link-existing: false',
      ].join('\n');
    case 'generic':
      return [
        '# Any OpenID Connect client.',
        `Discovery URL:  ${discovery}`,
        `Issuer:         ${input.issuer}`,
        `Client ID:      ${input.clientId}`,
        `Client secret:  ${secret}`,
        'Scopes:         openid profile (add email for this server\'s own accounts)',
        'Subject (uid):  sub (the DID). Use did_slug where the uid becomes a username.',
        'Client auth:    client_secret_basic or client_secret_post; PKCE S256 supported.',
      ].join('\n');
  }
}
