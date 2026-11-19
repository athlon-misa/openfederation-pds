# ADR-005: The PDS as an OpenID Connect provider for fediverse apps

**Status:** accepted · **Decided:** 2026-11-18 · **Issues:** #80 (ActivityPub identity layer)

OpenFederation is the identity layer, not a content application. ActivityPub servers
(Mastodon, Lemmy 1.0+, GoToSocial, Discourse, PeerTube, Matrix…) cannot use AT Protocol OAuth:
it needs pushed authorization requests, DPoP-bound tokens and client IDs that are URLs, and it
issues no ID token. What they all accept is OpenID Connect (OIDC) with a registered client ID
and secret.

A lab run on 2026-11-17 (local Mastodon 4.5.8, the third-party ATAuth bridge) showed the
shape: a Bluesky account logged in to Mastodon through an AT Protocol → OIDC bridge, and logged
in again to the same account. It also showed what a provider must get right (decisions 4–6).

## Decisions

1. **The PDS is the provider, at its own issuer.** Issuer `{PDS_SERVICE_URL}/oidc`, discovery
   at `{issuer}/.well-known/openid-configuration`. Separate from the AT Protocol OAuth server
   (`/.well-known/oauth-authorization-server`), which is unchanged: no client of one can use
   the other's tokens.
2. **Who can sign in: any AT Protocol account.** The sign-in page asks for a handle.
   - A name of **this server** with a password signs in with the password, with the same
     lockout, status and email-verification checks as `createSession`.
   - **Any other** account is sent to its own PDS through the existing AT Protocol OAuth
     client (`src/oauth/external-client.ts`), the same one "Sign in with ATProto" uses. Its
     DID is read from every directory in `PLC_RESOLVER_URLS`, so Bluesky accounts and accounts
     of other OpenFederation servers both work. No local account is created for them.
   - **Pen names cannot sign in** in this version (they have no password and are never
     audited; signing one in to a third party needs its own design).
3. **Clients are registered by an admin**, never dynamically: name, exact redirect URIs,
   allowed scopes, optionally a community (decision 7). The secret is 32 random bytes, shown
   once, stored as SHA-256. `client_secret_basic` and `client_secret_post`; PKCE (S256) is
   verified whenever the client sends it. Creating, rotating and deleting are audited.
4. **`sub` is the DID.** It never changes when the handle does, and a handle that is given up
   and taken by someone else cannot inherit the account. Handles are claims
   (`preferred_username`, `handle`), not identifiers.
5. **An email-safe identifier for apps that misuse the uid: `did_slug`.** Mastodon turns its
   uid into the username and, with no email, into a placeholder address
   (`change@me-<uid>-openid_connect.com`); a DID's colons make that invalid and sign-up fails
   with "Error creating an account for this identity". `did_slug` is the DID without `did:`,
   with every other non-alphanumeric run replaced by `_` (`plc_svyqejp7…`): stable, unique and
   valid as username and address. The Mastodon setup uses `OIDC_UID_FIELD=did_slug`.
   Usernames are therefore DID-derived; a handle-derived username would be nicer and would
   bring back the reassignment problem of decision 4.
6. **Email only when it is known and asked for.** With the `email` scope, a local account's
   address is given with `email_verified`, true only when it was verified here. An account
   from another server gives none (AT Protocol only shares it under `transition:email`);
   Mastodon then asks the person for one.
7. **A client can be limited to a community's members.** With `communityDid` set, only
   members (`members_unique`, as `verifyMembership`) finish signing in; others see why.
   This is how a community-run Mastodon admits its members and nobody else.
8. **Tokens.** ID token and access token are RS256 JWTs (RS256 is the algorithm every OIDC
   client must support), from a key made on first use and stored encrypted with
   `KEY_ENCRYPTION_SECRET`, published at `{issuer}/jwks`. Codes are single-use, 60 seconds,
   bound to client, redirect URI and PKCE challenge. Access tokens last 10 minutes and are
   only good for userinfo. No refresh tokens: an app keeps its own session, as Mastodon does.
9. **No single sign-on session in this version.** Every authorization asks the person to sign
   in. A remembered session is a later step.
   *Amended 2026-11-19 (#462):* a remembered sign-in, per browser, for `OIDC_SESSION_DAYS`
   (default 7, `0` off). The next app offers "Continue as …" (one click, never silent except
   for `prompt=none`); signing out of any app ends it; an account of this server is checked on
   every use and follows `users.token_version`, so every "end all sessions" event ends it too.
   Details in docs/OIDC.md.
10. **Off by default.** Admin setting "OpenID Connect sign-in for other apps"
    (`OIDC_PROVIDER_ENABLED`, setup wizard and Admin → Server settings). Off, every `/oidc`
    route answers 404 and existing clients are kept.

## Consequences

- One provider per Mastodon instance: the target is community-run instances, not general ones.
- A PDS that is down blocks sign-in to every app that relies on it, like any identity provider.
- Lemmy has OIDC sign-in only from 1.0.
- What it does not do: content stays in the apps; ActivityPub actors stay discovery-only.
