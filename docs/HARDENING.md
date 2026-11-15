# Hardening an OpenFederation PDS

What an operator should set, switch off, rotate and remove. Deployment steps are in `DEPLOYMENT.md` and `RAILWAY.md`; reporting a vulnerability is in `SECURITY.md`.

## Updates

- Security fixes ship in new releases and are marked **Security** in `CHANGELOG.md`. Watch the repository's releases and [security advisories](https://github.com/athlon-misa/openfederation-pds/security/advisories). The PDS is in development (0.x): security fixes go into the latest 0.x release only. From 1.0.0 on, each major version will be supported for at least five years from its release.
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

## When the operator is the risk

In AT Protocol the PDS holds the repo signing key, so whoever runs it can write records as any of its users, `self` custody accounts included ([ADR-003](adr/ADR-003-custody-modes.md)). The exception is device signing (#240, ADR-003 decision 14): an `assisted` or `self` account that turns it on keeps the repo signing key on its device, points its DID's `atproto` key at it, and every server-side write for the account is refused, so the PDS can no longer sign records as that person. It needs `DEVICE_SIGNING_ALLOWED=true` (the default under `OPENFEDERATION_PROFILE=privacy`); people turn it on for themselves in the dashboard under Your account → Identity & keys. What a hostile operator can still do: refuse the person's writes (censorship, not forgery; they leave with `leavePds`), and, for `assisted` only, switch the key back with its backup rotation key. That switch is a public PLC operation signed by a lower key: the dashboard shows it with its deadline, an honest server emails when it notices it, and the person's 12 words cancel it for 72 hours, after which device signing turns back on and the device refuses to sign on top of anything the server wrote in between until the person has looked (`trustedHeadKeys`). A lost device loses nothing: the 12 words, or the recovery key (#238), name a new device key.

What device signing covers, and what it does not:

- **Covered: everything signed with the `atproto` key.** Records and commits in the person's repository (profile, contacts, forum posts, RSVPs, votes, objections, any record), the author signature on what they write in a private community (kept in the community's repository, checked against the DID's *current* key only, so a key the server once held for them no longer vouches for anything), service-auth tokens and SIWOF `didToken`s. The server prepares, the device checks what it is asked to sign and signs, the server verifies against the key PLC names now. A server that changes what it shows the device gets no signature.
- **Not covered: records about the person that others sign.** A community's own records (its member list, proposals and the tallies in them, decisions) are signed with the community's key, as before. A delegate's vote is not counted for a delegator who uses device signing: nothing can sign it for them.
- **Unavailable while it is on** (refused or left out rather than signed by the server): external-key claims, the proof in `getPrimaryWallet`, and activity from communities on other servers in the timeline (the server would have to sign a token as the person to ask them).

For every other account, four protections make a forged write detectable, attributable and short-lived (#241):

1. **Run the PDS yourself.** A newsroom that hosts its own PDS keeps the trust in-house. Use the checklist below.
2. **Watch the repository.** The person's app records every commit its device makes and checks the public repository for writes it did not make: `RepoWatcher` in `@open-federation/sdk/custody` ([guide](sdk-integration-guide.md#watching-the-repository)). Repositories are public, so this works against any PDS. A hostile PDS can show the person a different repository from the one it shows everyone else, so check a relay or mirror as well as the PDS itself.
3. **Leave quickly.** An `assisted` or `self` account holds the top rotation key of its DID. With the phrase, the person signs a PLC update that points the DID at another PDS and its signing key, without the old PDS: `leavePds` ([guide](sdk-integration-guide.md#leaving-a-pds-without-its-help)). From then on the old operator's key no longer signs for the account. Another OpenFederation PDS then takes the account in on the phrase alone, as `self`, with the repository and blobs from the person's own backup: `moveIn` ([guide](sdk-integration-guide.md#moving-into-another-openfederation-pds-with-the-phrase-alone), [ADR-004](adr/ADR-004-self-custody-move-in.md)). It needs `MIGRATION_ACCOUNTS=open` or `invite` there, and `self` in its `IDENTITY_CUSTODY_ALLOWED`.
4. **Keep the evidence.** Forged commits stay in the public history, signed by the PDS's key. A record the person signed carries `ownerSig` ([decision 11](adr/ADR-003-custody-modes.md)); a forged one doesn't, and never can ([guide](sdk-integration-guide.md#evidence-of-a-forged-record)).

`custodial` accounts get only the first two: the PDS also holds their rotation key, so the person cannot leave without it.

### Newsroom self-hosting checklist

Settings of this server are named as they are. Settings of other products (nginx, Cloudflare, Postgres, Tor, your hosting platform) are marked with the product; check its own documentation for your version.

**Identity policy**

- [ ] `OPENFEDERATION_PROFILE=privacy`: new accounts default to `self` custody and pseudonyms are on. Or set `IDENTITY_CUSTODY_ALLOWED` / `IDENTITY_CUSTODY_DEFAULT` / `PSEUDONYMS_ENABLED` yourself.
- [ ] Decide whether journalists may be `custodial` at all; leave `custodial` out of `IDENTITY_CUSTODY_ALLOWED` if not.
- [ ] `DEVICE_SIGNING_ALLOWED=true` (set by the `privacy` profile), so `self` and `assisted` journalists can keep their repo signing key on their device and this server cannot write as them. Tell them that while it is on nothing can be posted when the device is offline, that some features stop working until they can be signed on the device (the dashboard lists which, as the server reports them), and that their 12 words (or recovery) put a new device in charge if they lose this one. For the strongest guarantee they choose `self`: in `assisted` your backup key could switch it off, publicly and cancellably.
- [ ] Everything under [Secrets](#secrets), [Smallest useful attack surface](#smallest-useful-attack-surface) and [Network](#network) above.
- [ ] Recovery for journalists on `self`: tell them that losing the phrase is final unless they set up recovery (dashboard: Your account → Recovery), and that it is their choice: a backup phrase on paper, a split among people they trust, or a split in which the newsroom holds one share and can never recover alone. Agree who in the newsroom keeps its shares, offline and apart from the server, and that the newsroom hands its share back only to the journalist in person. Read the threat model in [ADR-003](adr/ADR-003-custody-modes.md), decision 13, before recommending one; under coercion risk, none may be the right answer.

**Proxy and CDN logs.** Every hop that terminates TLS sees client IP addresses and request paths.

- [ ] nginx (or your reverse proxy): `access_log off;` for the PDS, or a `log_format` without `$remote_addr` and `$http_x_forwarded_for`. `error_log` lines carry the client address too: keep its level at `error` and its retention short.
- [ ] nginx: overwrite, don't append, the client address you pass on (`proxy_set_header X-Forwarded-For $remote_addr;`), and set `EXPRESS_TRUST_PROXY` to the exact number of proxies.
- [ ] Cloudflare or another CDN: it sees every request in clear text and keeps its own logs, which you cannot fully switch off. Leave it out for a journalist installation, or treat it as a party that knows who called when.
- [ ] Your hosting platform's request logs (on Railway, the HTTP logs of each service): find out what they record and for how long. They are outside this server's configuration.

**This server's own records.** There is no switch for these; they serve lockout and abuse handling.

- [ ] The PDS logs no IP or email addresses in production, but stores client IP addresses in `audit_log` (failed logins, password reset requests), `recovery_attempts` and `disclosure_audit_log`. Decide a retention period and delete older rows on a schedule.
- [ ] Pseudonyms are not audited at all (by design).

**PLC directory** (only if you run `plc-server/` yourself)

- [ ] Leave `LOG_ENABLED` unset. It is read by `@did-plc/server`, the library `plc-server/` wraps; when set to `true`, `t` or `1` it logs every request (pino-http: address, path, headers). Off is its default. `LOG_LEVEL` and `LOG_DESTINATION` only matter when it is on. `plc-server/server.js` itself logs only start-up and fatal errors.
- [ ] Remember that every PLC operation is public by design, with the time the directory received it (`/<did>/log/audit`). Changing a DID cannot be hidden, which is also what makes a move or a forged change visible.

**Postgres** (settings of Postgres, in `postgresql.conf` or `ALTER SYSTEM`; a managed database may not let you change all of them)

- [ ] `track_commit_timestamp = off` (Postgres's default): no commit time is kept per row beyond the timestamp columns the schema already has.
- [ ] `log_statement = 'none'` and `log_min_duration_statement = -1` (both defaults): statements, and with them handles, emails and record contents, stay out of the database log.
- [ ] `log_connections = off` and `log_disconnections = off` (defaults).
- [ ] `DB_SSL=true` unless the database is on the same host or a private network.

**Backups**

- [ ] Back up the database and `KEY_ENCRYPTION_SECRET` separately, as under [Backups](#backups). A backup together with the secret holds every account's repo signing key: whoever has both can write as your journalists, exactly like the operator. Encrypt backups and limit who can restore them.
- [ ] Set a retention period for backups; old copies keep the IP addresses above after you deleted them from the live tables.
- [ ] `self` accounts' rotation keys are not in any backup: the PDS never holds them. Losing the phrase is not something a backup fixes (ADR-003, decision 10).

**Tor**

- [ ] Offer an onion service for calls that should not reveal the caller (Tor: a `HiddenServicePort` pointing at your reverse proxy, not straight at the PDS, so `X-Forwarded-For` is set by the proxy and a caller can't forge it).
- [ ] Behind Tor every caller shares one address, so the per-IP rate limits (`AUTH_RATE_LIMIT`, `REGISTRATION_RATE_LIMIT`, `GLOBAL_RATE_LIMIT`) apply to all Tor users together. Raise `GLOBAL_RATE_LIMIT` if needed; never loosen the auth or registration limits.
- [ ] Clients that need anonymity also send their repository checks (`RepoWatcher`, which takes a `fetch`) and PLC calls through Tor: the PDS, the relay and the PLC directory all see who asks.

**For each journalist**

- [ ] A `self` (or `assisted`) account, with the phrase on paper and away from the device.
- [ ] The app runs `RepoWatcher` against the PDS and against a relay or mirror, and keeps the CAR of any check that reports unknown changes.
- [ ] Records that matter are person-signed (`signRecord`), so readers can tell them from anything the PDS writes.
- [ ] The person knows the way out: another PDS that will accept the account (`MIGRATION_ACCOUNTS` not `closed`, `self` allowed), and `leavePds` / `moveIn` with the phrase.
- [ ] The app downloads a backup regularly (`downloadBackup`: the repository and every blob) and keeps it off the server. If the PDS turns hostile or disappears, blobs not in a backup are lost.

## Decommissioning

1. Close registration and tell users; they can export their data and move their account or community to another PDS (`docs/API.md`, migration endpoints).
2. Revoke partner keys and OAuth clients; rotate or delete the secrets above.
3. Delete the database, its backups and blob storage, and destroy `KEY_ENCRYPTION_SECRET` last: without it the keys in any remaining copy cannot be decrypted.
4. Remove the DNS records and any `did:web` documents that point at the instance.
