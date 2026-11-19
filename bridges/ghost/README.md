# OpenFederation sign-in for Ghost

Lets a [Ghost](https://ghost.org) site sign in **readers and staff** with any AT Protocol
account (Bluesky, OpenFederation, a self-hosted PDS) through an OpenFederation PDS's
OpenID Connect provider ([docs/OIDC.md](../../docs/OIDC.md), [ADR-005](../../docs/adr/ADR-005-oidc-provider.md)).
Ghost itself has no OpenID Connect sign-in; this folder adds it without patching Ghost.

Live at [ghost.opennewsrooms.com](https://ghost.opennewsrooms.com); deployment in
[deploy/ghost](../../deploy/ghost/README.md).

| Part | What it does |
|---|---|
| `src/` (the bridge) | A small service mounted at `/auth/openfederation/` on the Ghost site. OIDC client of the PDS (authorization code, PKCE, nonce, ID token checked against the provider's keys) |
| `sso-adapter/` | A Ghost SSO adapter ([`@tryghost/adapter-base-sso`](https://github.com/TryGhost/Ghost/tree/main/packages/adapters/sso-base)) for staff sign-in to Ghost admin |
| `theme/` | The Open Newsrooms theme: newsprint, Newsreader and IBM Plex Mono, the red quote mark, AT Protocol sign-in buttons. Passes `gscan` for Ghost 6 |

## Readers

1. "Sign in" → `/auth/openfederation/signin?for=member` → the person signs in at their own server.
2. With a verified email from the PDS (OpenFederation accounts): the bridge finds or creates
   the Ghost member through the Admin API, notes the DID on the member, and redirects to
   Ghost's own one-time sign-in link (`members/:id/signin_urls`).
3. Without one (Bluesky shares no email): the reader gives an email once and Ghost emails
   the sign-in link, which proves the address. Such a member is marked
   `OpenFederation (email entered): <did>`; the DID alone never signs them in, so typing
   somebody else's address gains nothing. Next time they get a link to the same address.

## Staff

1. "Staff sign-in", or opening Ghost admin with no session → `?for=staff`.
2. The bridge leaves the PDS's ID token in a 2-minute cookie on `/ghost`.
3. The SSO adapter verifies it (RS256 via the provider's JWKS, issuer, audience = this
   client, expiry, **verified** email) and Ghost signs in the **existing, active** staff user
   with that email. Nobody is created; invite staff in Ghost as usual.

## Configuration

Bridge (environment): `GHOST_URL`, `GHOST_INTERNAL_URL`, `GHOST_ADMIN_API_KEY` (custom
integration), `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `BRIDGE_COOKIE_SECRET`,
`SITE_NAME`. Register the client on the PDS with
`ofc oidc add --preset generic --redirect-uri https://<site>/auth/openfederation/callback --scope openid profile email`.

SSO adapter (Ghost config): `adapters__sso__active=openfederation`,
`adapters__sso__openfederation__issuer`, `…__clientId`, `…__cookieName`.

Mail: Ghost sends reader sign-in links from its **member support address**; it must be an
address your mail provider may send from.

## Tests

```bash
npm install && npm test
```

The SSO adapter refuses tokens with the wrong key, kid, issuer, audience (e.g. a Mastodon
client's token), expiry, an unverified email or `alg: none`, and only signs in active staff;
the email check stays linear on hostile input.
