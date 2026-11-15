# Demo servers

Public demo servers where anyone can try OpenFederation without asking: create an account in any custody mode, make pen names, publish, prove, and move accounts and pen names between two servers. **Everything on them is deleted every night**, on all three services, so each day starts empty.

This page covers the layout on Railway, every variable each service needs, DNS, how the nightly reset works and what protects other servers from it, and what to tell visitors.

## Layout

One Railway project, separate from production:

| Service | Root directory | Public address | Notes |
|---|---|---|---|
| **Postgres** | — | none | One database server holding three databases: `pds_openfederation`, `pds_opennewsrooms`, `plc` |
| **PLC directory (demo)** | `plc-server` | `plc-demo.openfederation.net` | Its own directory. Never `plc.openfederation.net` |
| **PDS openfederation (demo)** | `/` (root `Dockerfile`) | `demo.openfederation.net` and `*.demo.openfederation.net` | |
| **PDS opennewsrooms (demo)** | `/` (root `Dockerfile`) | `demo.opennewsrooms.com` and `*.demo.opennewsrooms.com` | |
| Dashboards | `web-interface` | optional | Visitors arrive from the demo page on opennewsrooms.com and use the SDKs; add a dashboard per PDS only to show the admin side |

Why the demo needs its own PLC directory: every identity a demo PDS creates is registered in the directory it uses, and Self accounts and pen names hold their own rotation keys there. If the demo used the production directory, those identities would stay there after the demo PDSes forgot them, and nobody could clear them. A demo directory is wiped with the PDSes.

The maintainers' own demo project is described as code in `deploy/demo/.railway/railway.ts` (Railway project `openfederation-demo`): run `railway config plan` from `deploy/demo/` with that project linked. Variables are unmanaged there (secrets are set on Railway), and custom domains are added with `railway domain`, because Railway's configuration cannot register them.

Create the three databases once, from Railway's Postgres console (or `psql` with the service's connection string):

```sql
CREATE DATABASE pds_openfederation;
CREATE DATABASE pds_opennewsrooms;
CREATE DATABASE plc;
```

Each service resets only the database it is connected to (the PDS lists the tables of its own database's `public` schema; the PLC directory of its own).

**Restart policy.** The reset ends with the process exiting with code **75**, so the platform starts it again on an empty database. On every one of the three services set **Settings → Deploy → Restart Policy** to **Always** (or **On Failure** with enough retries; Railway counts failed restarts, so Always is the safer choice). With **Never**, a service stays down after its first reset.

## Variables

Generate secrets with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`, and the OAuth key with the command in `.env.example`. Give each PDS its own secrets.

### PLC directory (demo)

```
DATABASE_URL=postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/plc
DEMO_MODE=true
DEMO_RESET_SCHEDULE=0 3 * * *        # optional, this is the default (03:00 UTC daily)
PLC_PUBLIC_URL=https://plc-demo.openfederation.net
# DEMO_ALLOWED_HOSTNAME=...          # only for a public host without "demo" in its name
```

Do not set `PORT`. `PLC_PUBLIC_URL` is used only by demo mode's guard: it is the directory's own public address, and must contain `demo` (or be `DEMO_ALLOWED_HOSTNAME`).

### PDS openfederation (demo)

```
NODE_ENV=production
DEMO_MODE=true
DEMO_RESET_SCHEDULE=0 3 * * *        # optional; keep all three services on the same schedule

PDS_HOSTNAME=demo.openfederation.net
PDS_SERVICE_URL=https://demo.openfederation.net
HANDLE_SUFFIX=.demo.openfederation.net
PLC_DIRECTORY_URL=https://plc-demo.openfederation.net
FEDERATION_PEERS=https://demo.opennewsrooms.com

DB_HOST=${{Postgres.PGHOST}}
DB_PORT=${{Postgres.PGPORT}}
DB_NAME=pds_openfederation
DB_USER=${{Postgres.PGUSER}}
DB_PASSWORD=${{Postgres.PGPASSWORD}}
DB_SSL=true                          # or leave unset on the private network (*.railway.internal)

AUTH_JWT_SECRET=<random>
KEY_ENCRYPTION_SECRET=<random>
OAUTH_SIGNING_KEY=<one-line ES256 JWK>

CORS_ORIGINS=https://opennewsrooms.com   # the demo page's origin (OAuth and other non-XRPC paths); add a dashboard's
DEFAULT_APPEARANCE=openfederation

# Optional: an admin, recreated after every reset (bootstrap runs on each start).
# BOOTSTRAP_ADMIN_EMAIL=admin@demo.openfederation.net
# BOOTSTRAP_ADMIN_HANDLE=admin
# BOOTSTRAP_ADMIN_PASSWORD=<strong password>

# Behind Cloudflare's proxy as well as Railway's:
# EXPRESS_TRUST_PROXY=2
```

### PDS opennewsrooms (demo)

The same, with:

```
PDS_HOSTNAME=demo.opennewsrooms.com
PDS_SERVICE_URL=https://demo.opennewsrooms.com
HANDLE_SUFFIX=.demo.opennewsrooms.com
FEDERATION_PEERS=https://demo.openfederation.net
DB_NAME=pds_opennewsrooms
DEFAULT_APPEARANCE=opennewsrooms
```

and its own `AUTH_JWT_SECRET`, `KEY_ENCRYPTION_SECRET` and `OAUTH_SIGNING_KEY`.

`FEDERATION_PEERS` points each PDS only at the other, so community discovery stays between the two demos. Both use the same `PLC_DIRECTORY_URL`: that is what lets an account or pen name move from one to the other.

### What demo mode sets for you

With `DEMO_MODE=true` these settings default to a server anyone can try; set the variable to override one:

| Setting | Demo default |
|---|---|
| `INVITE_REQUIRED` | `false` |
| `ACCOUNT_APPROVAL` | `automatic` |
| `COMMUNITY_OWNER_INVITES` | `true` |
| `EMAIL_VERIFICATION_POLICY` | `off` |
| `IDENTITY_CUSTODY_ALLOWED` | `custodial,assisted,self` |
| `PSEUDONYMS_ENABLED` | `true` |
| `DEVICE_SIGNING_ALLOWED` | `true` |
| `MIGRATION_ACCOUNTS`, `MIGRATION_PSEUDONYMS`, `MIGRATION_COMMUNITIES` | `open` |
| SMTP | not required: production starts without it, as with `ALLOW_NO_EMAIL=true` |

They are defaults, at the level of `OPENFEDERATION_PROFILE`: an environment variable, an admin's change on Admin → Server settings and the setup wizard's choice all win over them (and an admin's change is wiped at the next reset). `DEMO_MODE` itself is read from the environment only; nothing on the dashboard can turn it on or off.

Without SMTP no mail is sent: no verification email, no password reset. Configure SMTP as usual if the demo should send mail.

Blobs are stored on the service's disk (`BLOB_STORAGE=local`, the default). Demo mode refuses S3 storage. A Railway volume is optional: without one, uploads also disappear at each deploy.

## DNS

Records in Cloudflare (Railway shows the exact target and any verification record when you add each custom domain):

| Name | Type | Target |
|---|---|---|
| `demo.openfederation.net` | CNAME | the openfederation demo PDS's Railway target |
| `*.demo.openfederation.net` | CNAME | the same (people's handles, `alice.demo.openfederation.net`) |
| `plc-demo.openfederation.net` | CNAME | the PLC service's Railway target |
| `demo.opennewsrooms.com` | CNAME | the opennewsrooms demo PDS's Railway target |
| `*.demo.opennewsrooms.com` | CNAME | the same |

Add both the bare name and the wildcard as custom domains on each PDS service in Railway; for a wildcard, Railway asks for an extra `_acme-challenge` CNAME so it can issue the certificate. Keep the records DNS-only (grey cloud) unless the whole chain is set up for Cloudflare's proxy (then `EXPRESS_TRUST_PROXY=2`).

The PLC directory is at `plc-demo.…`, not `plc.demo.…`, so it does not sit under a handle wildcard (where a visitor could pick the handle `plc`).

## The nightly reset

At `DEMO_RESET_SCHEDULE` (five-field cron, UTC; default `0 3 * * *`, 03:00 every day) each service:

1. answers every request with **503 `DemoResetting`** (with `Retry-After`; the PDS still answers `/health`) and gives requests already running a few seconds;
2. empties every table: the PDS every table in its database's `public` schema except `schema_migrations` (`TRUNCATE … RESTART IDENTITY CASCADE`), the PLC directory every table except its migration ledger (`kysely_migration`, `kysely_migration_lock`). The schema stays, so nothing is migrated again;
3. the PDS deletes everything inside its blob directory (`BLOB_STORAGE_PATH`; the directory itself stays, it may be a volume) and drops the signing keys it holds in memory;
4. logs one line and **exits with code 75**. Nothing is written to the audit log: it is emptied with everything else.

The platform starts the service again (restart policy above); it starts as on any other day, recreating the bootstrap admin when one is configured. Expect each service to be unavailable for a minute or two around the scheduled time.

If emptying the tables fails, nothing was deleted (it is one statement); the service logs it, keeps serving and tries again at the next scheduled time.

`getPublicConfig` on a demo PDS says so: `demo: { enabled: true, resetSchedule, nextResetAt }` (`{ enabled: false }` everywhere else). The dashboard shows "Demo server — everything is deleted every night at HH:MM UTC" on every page when it is set; the demo page on opennewsrooms.com can read the same field.

### Guards

The wipe runs only when `DEMO_MODE=true` and every guard passes. Each service checks them when it starts, and refuses to start, with the reason, when `DEMO_MODE=true` and one fails; the reset checks them again right before it deletes anything.

**PDS**

- `PLC_DIRECTORY_URL` is a valid http(s) URL and not a production directory: `plc.openfederation.net` or `plc.directory` (or a subdomain of either).
- `PDS_HOSTNAME` and the host of `PDS_SERVICE_URL` contain `demo`, or equal `DEMO_ALLOWED_HOSTNAME`. `pds.openfederation.net` is refused whatever `DEMO_ALLOWED_HOSTNAME` says. (The service URL is checked too because every DID created here points at it.)
- `BLOB_STORAGE` is `local` (S3 is refused), and `BLOB_STORAGE_PATH` is not the filesystem root, the working directory, the home directory or a parent of one of them.
- `DEMO_MODE` is `true`, `false` or unset, and `DEMO_RESET_SCHEDULE` is a cron expression that matches at least once; anything else stops the server.
- `NODE_ENV=production` is allowed: a demo is a real deployment.

**PLC directory**

- `PLC_PUBLIC_URL` is set to the directory's public http(s) address, is not `plc.openfederation.net` or `plc.directory`, and its host contains `demo` or equals `DEMO_ALLOWED_HOSTNAME`.
- The same rule for `DEMO_MODE` and `DEMO_RESET_SCHEDULE`.

Without `DEMO_MODE` none of this runs: no timer, no gate, and the PLC wrapper behaves as before.

Code: `src/demo/` (PDS), `plc-server/demo-reset.js` (PLC directory). Tests: `tests/unit/demo-mode.test.ts`, `tests/api/demo-reset.test.ts`, `tests/unit/plc-demo-reset.test.ts`, `tests/web/demo-banner.test.tsx`.

## What to tell visitors

Put this, or something like it, on the demo page:

- **Everything is deleted every night at 03:00 UTC**: accounts, pen names, posts, communities, uploads and proofs, on both servers and in the demo identity directory. There is no backup and nothing can be restored.
- **Demo identities exist only here.** They are registered in the demo directory, not the public one, so other AT Protocol services cannot resolve them, and after the reset they resolve nowhere. Recovery phrases, the 12 words of a pen name and downloaded backups stop working at the reset.
- **Do not use real data**: no real names you need to protect, no password you use elsewhere, nothing you want to keep. Anything you publish is public until the reset.
- **No email is sent**, so there is no password reset and no email verification. Write the password down for the day.
- Handles are free again after the reset; someone else may take yours the next day.
- Proof links and QR codes made today stop verifying after the reset.
- Around the reset each server is unavailable for a minute or two ("This demo server is deleting everything for its nightly fresh start").
