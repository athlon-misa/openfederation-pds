# Sign-in for other apps (OpenID Connect)

This server can sign people in to other apps: Mastodon, Lemmy 1.0+, GoToSocial, Discourse,
Forgejo, Nextcloud or anything that speaks OpenID Connect. The app sends people here; they
sign in with their account on this server (password) or with any other AT Protocol account
(Bluesky, another OpenFederation server, a self-hosted PDS) on its own server; the app gets
their permanent identifier, handle and display name. Design: [ADR-005](adr/ADR-005-oidc-provider.md).

OpenFederation is the identity layer here, not a content bridge: posts stay in the app.

## 1. Turn it on

Admin → Server settings → **Sign-in for other apps** (or `OIDC_PROVIDER_ENABLED=true`, or the
setup wizard's Options step). Off, every `/oidc` route answers 404.

The provider:

| | |
|---|---|
| Issuer | `{PDS_SERVICE_URL}/oidc`, e.g. `https://pds.openfederation.net/oidc` |
| Discovery | `{issuer}/.well-known/openid-configuration` |
| Signing | RS256, key made on first use, stored encrypted (`KEY_ENCRYPTION_SECRET` required) |
| Client auth | `client_secret_basic`, `client_secret_post`; PKCE `S256` when the app sends it |
| Scopes | `openid` (required), `profile`, `email` |
| Sign-out | `{issuer}/end_session` (RP-initiated logout): back to the app, nothing else to end |

## 2. Register the app

```bash
ofc auth login -u <admin>
ofc oidc add --preset mastodon --app-url https://mastodon.example --name "Our Mastodon"
# limited to one community's members:
ofc oidc add --preset mastodon --app-url https://mastodon.example --name "Our Mastodon" --community did:plc:…
```

Presets: `mastodon`, `lemmy`, `gotosocial`, `generic` (then pass `--redirect-uri`). The command
prints the client secret **once**, inside ready-to-paste configuration for the app. Later:
`ofc oidc list`, `ofc oidc setup <clientId>` (configuration without the secret),
`ofc oidc rotate-secret <clientId>`, `ofc oidc remove <clientId>`. The same is in the
dashboard under Admin → Sign-in for other apps, and in the XRPC API
(`net.openfederation.oidc.*`, [API.md](API.md)).

## 3. Configure the app

### Mastodon (4.x)

Add the printed block to `.env.production` and restart web and sidekiq:

```
OIDC_ENABLED=true
OIDC_DISPLAY_NAME=Our Mastodon
OIDC_ISSUER=https://pds.example/oidc
OIDC_DISCOVERY=true
OIDC_SCOPE=openid,profile,email
OIDC_UID_FIELD=did_slug
OIDC_CLIENT_ID=…
OIDC_CLIENT_SECRET=…
OIDC_REDIRECT_URI=https://mastodon.example/auth/auth/openid_connect/callback
OIDC_IDP_LOGOUT_REDIRECT_URI=https://mastodon.example/
OIDC_USE_PKCE=true
OIDC_SECURITY_ASSUME_EMAIL_IS_VERIFIED=false
```

- **`OIDC_UID_FIELD=did_slug`, not `sub`.** Mastodon makes the username, and without an email a
  placeholder address, from its uid. A DID's colons make that address invalid and sign-up
  fails with "Error creating an account for this identity". `did_slug`
  (`plc_svyqejp7a6te7uuouvt3leqb`) is the same DID in a usable form; usernames are therefore
  DID-derived, and Mastodon does not let people rename.
- People from other servers bring the email their server shares (see below); when it is
  missing or unverified, Mastodon asks for one or sends a confirmation, so Mastodon needs
  working SMTP. Accounts of this server bring theirs, marked verified when it was verified
  here.
- `OMNIAUTH_ONLY=true` makes this the only way in (no Mastodon passwords). Mastodon then sends every sign-out to the provider's `end_session_endpoint`, which sends the person back to `OIDC_IDP_LOGOUT_REDIRECT_URI` (it must be on the same origin as the app's redirect URI).
- Mastodon allows one OpenID Connect provider per instance.

### Lemmy (1.0 or later)

Admin → Settings → OAuth providers: issuer, the three endpoints, `ID claim: sub`, `Name claim:
did_slug`, client ID and secret, scopes `openid profile email`. Lemmy 0.19 has no OpenID
Connect sign-in.

### GoToSocial

`oidc-*` keys in `config.yaml` (printed by the preset). GoToSocial requires an email claim, so
only people whose server shares their email can sign up there.

### Anything else

Discovery URL, client ID and secret; uid `sub` (the DID), or `did_slug` where the uid becomes a
username.

## What the app receives

| Claim | Scope | Value |
|---|---|---|
| `sub` | always | The DID. Never changes, even when the handle does |
| `did`, `did_slug` | profile | The DID, and the DID as `[A-Za-z0-9_]` |
| `handle`, `preferred_username` | profile | The full handle; for other servers only when it resolves back to the DID |
| `name` | profile | Display name (accounts here), else the handle |
| `email`, `email_verified` | email | Accounts of this server; for other servers the address they shared (below) |

### Email from other servers

When the app asks for `email`, the sign-in at the person's own server also asks for
`transition:email`, so they see and approve sharing it there. The provider reads it once
(`com.atproto.server.getSession`), keeps it on the pending sign-in only (gone once the app has
its tokens) and revokes the access. Plain sign-in to the dashboard and the SDK does not ask.

`email_verified` is `true` only when that server confirmed the address **and** is listed in
`OIDC_TRUSTED_EMAIL_ISSUERS` (https origins of the authorization server; default
`https://bsky.social`, `none` for no server). Anyone can run a server and say any address is
confirmed, and apps match staff and existing accounts by verified email, so an address from any
other server is passed on unverified and the app confirms it itself.

## Who can sign in

- **Accounts of this server** with a password: same lockout, status and email-verification
  rules as signing in to the dashboard.
- **Any other AT Protocol account**: sent to its own server through this PDS's AT Protocol
  OAuth client; its DID is read from every directory in `PLC_RESOLVER_URLS` (by default this
  server's own, then plc.directory). No account is created here for them.
- **Not pen names** (in this version).
- With a community set on the app: members only; others are sent back to the app with
  `access_denied`.

Every sign-in is asked for again (there is no single sign-on session yet). Each completed
sign-in is audited as `oidc.signIn`; registering, rotating and removing apps as
`oidc.client.*`.

## Limits

Sign-in pages and the token endpoint: `DISCOVERY_RATE_LIMIT` per minute per IP. Password
attempts: `AUTH_RATE_LIMIT` per 15 minutes per IP, plus the per-account lockout.
