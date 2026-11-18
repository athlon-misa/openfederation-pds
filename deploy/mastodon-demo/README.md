# Mastodon demo: mastodon.openfederation.net

A Mastodon whose only way in is **sign in with your AT Protocol account** (Bluesky,
OpenFederation or any other PDS) through pds.openfederation.net's OpenID Connect provider
([docs/OIDC.md](../../docs/OIDC.md), [ADR-005](../../docs/adr/ADR-005-oidc-provider.md)).
It shows OpenFederation as the identity layer for ActivityPub apps; posts stay in Mastodon.

Lives in the production Railway project `pds.openfederation.net` as its own partial
(`.railway/railway.ts` here): one `mastodon` service (web + Sidekiq, image
`ghcr.io/mastodon/mastodon:v4.5.8`, media volume), `mastodon-postgres`, `mastodon-redis`.

## 1. Register the app on the PDS

The PDS must run a release with the OIDC provider, with **Sign-in for other apps** on
(Admin → Server settings).

```bash
ofc --server https://pds.openfederation.net auth login -u <admin>
ofc --server https://pds.openfederation.net oidc add \
  --preset mastodon --app-url https://mastodon.openfederation.net \
  --name "OpenFederation Mastodon demo" --client-id mastodon-demo
```

Keep the printed `OIDC_CLIENT_SECRET`.

## 2. Create the services

```bash
cd deploy/mastodon-demo
railway config plan     # read-only: what would be created
railway config apply
```

## 3. Variables (service `mastodon`)

Generate once (any machine with Docker):

```bash
docker run --rm -e RAILS_ENV=production -e SECRET_KEY_BASE=x -e OTP_SECRET=x \
  ghcr.io/mastodon/mastodon:v4.5.8 bin/rails db:encryption:init          # 3 ACTIVE_RECORD_ENCRYPTION_* values
docker run --rm -e RAILS_ENV=production -e SECRET_KEY_BASE=x -e OTP_SECRET=x \
  ghcr.io/mastodon/mastodon:v4.5.8 bin/rails mastodon:webpush:generate_vapid_key   # VAPID_*
openssl rand -hex 64     # SECRET_KEY_BASE, and again for OTP_SECRET
```

| Variable | Value |
|---|---|
| `LOCAL_DOMAIN` | `mastodon.openfederation.net` |
| `RAILS_ENV` / `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `BIND` | `0.0.0.0` |
| `DATABASE_URL` | `${{mastodon-postgres.DATABASE_URL}}` |
| `REDIS_URL` | `${{mastodon-redis.REDIS_URL}}` |
| `SECRET_KEY_BASE`, `OTP_SECRET`, `ACTIVE_RECORD_ENCRYPTION_*`, `VAPID_*` | generated above |
| `TRUSTED_PROXY_IP` | `100.64.0.0/10` (Railway's proxy) |
| `RAILS_SERVE_STATIC_FILES` | `true` |
| `RAILS_LOG_TO_STDOUT` | `enabled` |
| `SMTP_SERVER` / `SMTP_PORT` / `SMTP_LOGIN` | the PDS's mail provider (Resend: `smtp.resend.com`, `587`, `resend`) |
| `SMTP_PASSWORD` | `${{openfederation-pds.SMTP_PASSWORD}}` |
| `SMTP_FROM_ADDRESS` | `Mastodon demo <noreply@openfederation.net>` |
| `OMNIAUTH_ONLY` | `true` (no Mastodon passwords: AT Protocol sign-in only) |
| `OIDC_*` | the block printed in step 1 |

Mail is needed: accounts from Bluesky and other servers bring no email, so Mastodon asks
for one and sends a confirmation.

## 4. DNS (Cloudflare, DNS only)

`railway domain` / the service's Networking tab shows the target for
`mastodon.openfederation.net`; add that CNAME in Cloudflare with the proxy **off**.

## 5. First admin

```bash
railway ssh --service mastodon -- bin/tootctl accounts modify <username> --role Owner
```

after that person has signed in once (their username is their DID as `plc_…`).

## Checking it

- `https://mastodon.openfederation.net/health` → `OK`
- The sign-in page shows only "OpenFederation Mastodon demo"; signing in with a Bluesky
  handle goes to bsky.social and back; with an OpenFederation handle, to the password page
  on pds.openfederation.net.
- `@ap-test@pds.openfederation.net` (the test community) resolves from the search box.
