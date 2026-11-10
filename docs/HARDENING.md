# Hardening an OpenFederation PDS

What an operator should set, switch off, rotate and remove. Deployment steps are in `DEPLOYMENT.md` and `RAILWAY.md`; reporting a vulnerability is in `SECURITY.md`.

## Updates

- Security fixes ship in new releases of the current major version and are marked **Security** in `CHANGELOG.md`. Watch the repository's releases and [security advisories](https://github.com/athlon-misa/openfederation-pds/security/advisories). 1.x is supported until at least 11 November 2031.
- Each release carries a CycloneDX SBOM per component, so you can check what you run against new advisories.
- Migrations run once at start and are recorded in `schema_migrations`. Take a database backup before upgrading.

## Secrets

Production refuses to start without `AUTH_JWT_SECRET` (32+ random characters, not a known placeholder), `KEY_ENCRYPTION_SECRET`, `OAUTH_SIGNING_KEY` while OAuth is on, and SMTP unless `ALLOW_NO_EMAIL=true`. Keep secrets in the platform's secret store, never in the repository or a container image.

| Secret | Generate | Rotating it means |
| --- | --- | --- |
| `AUTH_JWT_SECRET` | `openssl rand -hex 32` | Every access token is invalid at once; clients refresh. |
| `KEY_ENCRYPTION_SECRET` | `openssl rand -hex 32` | See below. Losing it loses every stored key. |
| `OAUTH_SIGNING_KEY` | command in `.env.example` | Every OAuth token is invalid; users sign in again in OAuth apps. |
| `OAUTH_DPOP_SECRET` | `openssl rand -hex 32` | DPoP nonces restart; clients retry. |
| `EMAIL_WEBHOOK_TOKEN` | `openssl rand -hex 32` | Update the URL at your email provider. |
| `SMTP_PASSWORD` | at your provider | Use a sending-only key. |
| Partner keys | dashboard or `ofc partner` | Revoke and re-issue; prefer keys with a ticket key. |

### Rotating `KEY_ENCRYPTION_SECRET`

Every signing, recovery, wallet, vault, attestation and pseudonym key at rest is encrypted under this secret (AES-256-GCM, PBKDF2-SHA512, bound to the key's purpose).

1. Back up the database.
2. Set `KEY_ENCRYPTION_SECRET_PREVIOUS` to the current secret and `KEY_ENCRYPTION_SECRET` to a new one. Redeploy. Both secrets now open keys; new keys use the new one.
3. With the same two variables, report and then re-encrypt:
   ```
   node --import ./scripts/register-ts-node.mjs scripts/rotate-key-encryption-secret.ts
   node --import ./scripts/register-ts-node.mjs scripts/rotate-key-encryption-secret.ts --apply
   ```
   It exits non-zero and lists any key neither secret opens; nothing it cannot open is changed. Run it again if it reports rows changed during the run.
4. Remove `KEY_ENCRYPTION_SECRET_PREVIOUS` and redeploy. Destroy the old secret.

## Smallest useful attack surface

Switch off what you do not use:

| Feature | Switch | Default |
| --- | --- | --- |
| Partner registration API | `PARTNER_API_ENABLED=false` | on |
| ActivityPub actor endpoints | `ACTIVITYPUB_ENABLED=false` | on |
| Federation peer discovery | `FEDERATION_PEERS_ENABLED=false` | on |
| ATProto OAuth server | `OAUTH_ENABLED=false` | on |
| Chain (governance proofs) module | leave `CHAIN_ADAPTERS` unset | off |
| Email bounce webhooks | leave `EMAIL_WEBHOOK_TOKEN` unset | off |
| Accounts, pseudonyms, communities moving here | `MIGRATION_ACCOUNTS` / `MIGRATION_PSEUDONYMS` / `MIGRATION_COMMUNITIES=closed` | invite / open / invite |
| Open registration | keep `INVITE_REQUIRED` on | invite only |

Keep `ORACLE_TRUST_UNVERIFIED_PROOFS` off. Create the bootstrap admin with a strong unique password and remove the `BOOTSTRAP_ADMIN_*` variables once it exists if you prefer not to keep them.

## Network

- Terminate TLS in front of the server. Set `EXPRESS_TRUST_PROXY` to the exact number of proxies in front of it (1 for one proxy, 2 for Cloudflare plus a platform proxy). Too high lets clients forge their IP address and get around rate limits.
- `DB_SSL=true` unless the database is on the same host or a private platform network; production warns otherwise.
- Set `REDIS_URL` before running more than one instance; without it OAuth replay protection is per process.
- Rate limits are on by default (`GLOBAL_RATE_LIMIT`, `AUTH_RATE_LIMIT`, `REGISTRATION_RATE_LIMIT`, ...). Raise `GLOBAL_RATE_LIMIT` only if many clients share one IP; never loosen the auth or registration limits.
- Set `CORS_ORIGINS` to the origins that should call the API from a browser.
- Set `SECURITY_CONTACT` so `/.well-known/security.txt` names your contact.

## Logs and personal data

The server logs no email addresses, IP addresses, email bodies or links in production. Email delivery history, including recipients, is in the `email_deliveries` table; security events are in `audit_log` (pseudonyms are deliberately not audited). Decide how long you keep platform logs and these tables, and say so in your privacy notice.

## Backups

Back up the database (keys at rest are only as safe as the backup) and `KEY_ENCRYPTION_SECRET` separately; one without the other is useless. Blob storage (`BLOB_STORAGE_PATH` or your object store) needs its own backup.

## Decommissioning

1. Close registration and tell users; they can export their data and move their account or community to another PDS (`docs/API.md`, migration endpoints).
2. Revoke partner keys and OAuth clients; rotate or delete the secrets above.
3. Delete the database, its backups and blob storage, and destroy `KEY_ENCRYPTION_SECRET` last: without it the keys in any remaining copy cannot be decrypted.
4. Remove the DNS records and any `did:web` documents that point at the instance.
