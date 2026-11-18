# Ghost at ghost.opennewsrooms.com

Ghost 6 with self-hosted ActivityPub, the Open Newsrooms theme, and sign-in for readers and
staff with any AT Protocol account (Bluesky, OpenFederation, …) through pds.openfederation.net's
OpenID Connect provider ([docs/OIDC.md](../../docs/OIDC.md)).

| Piece | Where |
|---|---|
| VM | Google Compute Engine `ghost-opennewsrooms`, project `n8n-automations-491912`, `europe-west4-a`, e2-medium, static IP `ghost-opennewsrooms-ip` (34.178.125.173), firewall `ghost-web-allow-http-https` (tag `ghost-web`) |
| Stack | `/opt/ghost`: a checkout of [TryGhost/ghost-docker](https://github.com/TryGhost/ghost-docker) plus this folder's `compose.override.yml` and `Caddyfile`, and `openfederation/` (bridge, SSO adapter, theme) |
| DNS | Cloudflare, `A ghost → 34.178.125.173`, DNS only (Caddy gets the certificate) |
| Mail | Resend, `noreply@opennewsrooms.com` (SMTP 465). The Resend key may send from `opennewsrooms.com` only, so Ghost's **member support address** (Settings → Portal) and the **newsletter sender** must be `noreply@opennewsrooms.com`: their default is `noreply@ghost.opennewsrooms.com`, and reader sign-in emails then fail with "550 not authorized" |
| OIDC client | `ghost-opennewsrooms` on pds.openfederation.net, redirect `https://ghost.opennewsrooms.com/auth/openfederation/callback` |

## How sign-in works

- **Readers** click "Sign in" (`/auth/openfederation/signin?for=member`). The bridge
  (`bridges/ghost`) signs them in at the PDS, finds or creates the Ghost member (DID in the
  member's note), and redirects to Ghost's own one-time sign-in link. An account with no
  verified email (Bluesky) is asked for one once; Ghost's emailed link proves it, and a
  typed address never signs anyone in directly.
- **Staff** use "Staff sign-in" (`?for=staff`). The bridge leaves the PDS's ID token in a
  2-minute cookie on `/ghost`; the `openfederation` SSO adapter in Ghost verifies it
  (signature, issuer, audience `ghost-opennewsrooms`, expiry, verified email) and signs in
  the **existing, active** staff user with that email. Invite staff in Ghost as usual; they
  sign in with an AT Protocol account whose verified email matches.

## Deploying a change

```bash
# from the repo root
tar -czf /tmp/ghost-deploy.tgz --exclude node_modules --exclude dist \
  -C bridges/ghost src package.json package-lock.json tsconfig.json Dockerfile .dockerignore sso-adapter theme \
  -C ../../deploy/ghost compose.override.yml Caddyfile
gcloud compute scp /tmp/ghost-deploy.tgz ghost-opennewsrooms:/tmp/ --zone europe-west4-a --project n8n-automations-491912
gcloud compute ssh ghost-opennewsrooms --zone europe-west4-a --project n8n-automations-491912
# on the VM: unpack into /opt/ghost/openfederation/{bridge,sso-adapter,theme}, then
cd /opt/ghost && sudo docker compose up -d --build bridge && sudo docker compose restart ghost
```

The theme is uploaded through Ghost Admin → Settings → Design → Change theme → Upload (a zip of
`bridges/ghost/theme`).

## `.env` on the VM (mode 600, not in git)

ghost-docker's keys (`DOMAIN`, database passwords, `mail__*`), `COMPOSE_PROFILES=activitypub`,
`ACTIVITYPUB_TARGET=activitypub:8080`, and for OpenFederation: `OIDC_ISSUER`,
`OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `BRIDGE_COOKIE_SECRET`, `GHOST_ADMIN_API_KEY`
(custom integration "OpenFederation sign-in"), `SITE_NAME`.
