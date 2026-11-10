# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- **Key claims need proof on every route**: `setExternalKey` keeps the claim's proof in the record; `importRepo` indexes only claims whose proof verifies for that DID (claims made before this change are dropped on import and must be made again); key claims can no longer be written into a community repository.
- **Vulnerability reporting**: `SECURITY.md` names the maintainer (Resonator Foundation), both reporting channels (private GitHub advisory form, now enabled, and security@openfederation.net), response and fix timelines, the support period (1.x until at least 11 November 2031) and scope including dependencies. Each PDS serves `/.well-known/security.txt` (RFC 9116); `SECURITY_CONTACT` adds the operator's own contacts.
- **No recipient addresses in failure logs**: a failed or retried send is logged by purpose and the SMTP error, with any email address in the error text replaced by `<redacted>`; the recipient stays in the deliveries table only.
- **No personal data or live links in logs**: with no SMTP configured in production (`ALLOW_NO_EMAIL=true`), an unsent email is logged by purpose only, not recipient, subject and the start of its body (which could hold a working reset or verification link); development still prints the message. OAuth sign-in is logged by account DID only, without the IP address.
- **Production start-up checks**: with OAuth on, production refuses to start without `OAUTH_SIGNING_KEY` (a generated key changed on every restart, invalidating every OAuth token and differing between instances); it warns when `REDIS_URL` is unset (OAuth replay protection per process) and when `DB_SSL` is off for a database that is not local or on a private `*.internal` network. The error prints a command that generates the key.
- **Access tokens no longer carry the email address.** The email in a request's auth context now comes from the account row that is already read on every request (for the token version), so it is also current after a change. Tokens issued before still verify; their `email` claim is ignored.
- **Build pinning**: GitHub Actions are pinned by commit SHA (Dependabot proposes security fixes for them); Railway installs with `npm ci` from the lockfile instead of `npm install`.
- **Repository integrity**: writes to one repository are serialised, a commit only lands if the root it was built on is still current, and `records_index` is updated in the commit's own transaction. Two parallel writes could previously leave the tree pointing at deleted blocks.
- **Admin identity-verification codes** can no longer be redeemed as password-reset tokens (`password_reset_tokens.purpose`, migration 046).
- **Community roles**: a member with `community.member.write` cannot assign a role whose permissions they do not hold, nor the owner role by `roleRkey`; owner checks use `communities.owner_did` everywhere (membership endpoints still read `created_by`, which is NULL for a community that moved here).
- **Suspension and takedown are enforced**: a taken-down repository (account or community) is not served to anyone but a PDS admin (`RepoTakendown`, `CommunityTakenDown`); a suspended or taken-down community accepts no writes (`CommunitySuspended`), including through the generic `com.atproto.repo.*` endpoints, and cannot be deleted by its owner; marking a copy `moved` no longer overwrites either status; lifting a suspension restores the status it replaced (`prior_status`, migration 047). A suspended or taken-down account is refused on every XRPC method whatever credential it presents.
- **Refresh tokens**: replaying any token a session has rotated away, however long ago, revokes every session (`session_rotated_tokens`, migration 048). Previously only the immediate predecessor was recognised.
- **Sessions are ended everywhere they should be**: password change, password reset, recovery, "revoke all sessions", suspension, takedown and detected refresh-token replay now also end OAuth grants.
- **Login lockout** counts an attempt before verifying the password, so a burst of parallel guesses no longer gets one try each; it applies to every endpoint that asks for the password (`changePassword`, `wallet.finalizeTierChange`, `signPlcOperation`, new error `AccountLocked`) and to the OAuth sign-in. The OAuth provider's sign-in, sign-up and reset forms get the auth and registration rate limits. The global rate limiter now runs before authentication work.
- **Service auth**: an inbound token must name the method it is for (`lxm`), may not be valid for more than an hour, and cannot be replayed by re-encoding its signature. `getServiceAuth` no longer mints tokens addressed to this PDS. A caller from another PDS cannot upload blobs without a community here, store custodial secrets, or create a community.
- **Community migration**: blobs pulled from the old PDS are stored only if they hash to their CID; pulls are size-limited as they are read, time out, refuse redirects and (in production) require a public HTTPS host; a junk key bundle from the old PDS no longer blocks activation; a repeat `migrateIn` re-checks the handle; `checkMigration` answers for a live community only to those who may read it.
- **Governance**: role create/update/delete go through governance; vote, objection and decision records cannot be hand-written into a community repo; an imported repository's votes and objections against a community the importer is not a member of are not indexed; `importRepo` refuses a repository older than the one already here (`RepoRollback`); a delegation stops counting when the delegator can no longer vote; a PDS admin who is not a member can no longer propose, vote, object, amend or delegate.
- **Private communities**: `getDelegation`, `listApplications`, `verifyAttestation`, `listMembers` and `myCapabilities` answer outsiders with `NotFound`; a private community created without `joinPolicy` defaults to `approval`; `community.create` validates `visibility` and `joinPolicy`; an RSVP must be for an event of the community the caller was checked against.
- `net.openfederation.identity.externalKey` records can only be written by `setExternalKey`, which demands proof of the key.
- **External sign-in**: an account that is not `approved` here cannot sign in through its home PDS; the handle from the DID document is used only if it is a real domain, resolves back to the DID, is not under this PDS's handle suffix and is free. The SDK login redirect accepts `code_challenge`, and the SDK sends one, so a callback code can only be redeemed by the tab that started the login.
- **Outbound requests**: handle resolution only fetches real domain names, checks the resolved addresses and refuses redirects; `partner.verifyKey` does the same in production and no longer returns low-level fetch errors; the private-address check recognises hex-form IPv4-mapped IPv6.
- **Pseudonyms**: no audit entry is written when a pseudonym is named in an entry's metadata, nor in `vault_audit_log`; instance roles cannot be granted to a pseudonym.
- Viewing grants: `grantedFields` must be a non-empty list when given, and an unreadable restriction discloses nothing. The EVM proof adapter no longer reports a transaction verified when its confirmation depth could not be read, and never includes the RPC URL in an error.
- **Partner keys** no longer stand in for the partner. A key with a registered ticket key (`partner.createKey { ticketPublicKey }`) requires a single-use registration ticket signed by the partner's backend and naming the account (`createPartnerTicket` in `@open-federation/sdk`; errors `TicketRequired`, `TicketInvalid`; migration 052). A key without one still registers accounts, but they are `pending` with no session until their email address is verified, which approves them.
- **Private community content**: forum threads, forum posts and RSVPs of a private community are stored in the community's own (member-only) repository, carrying `author` and the author's signature (`authorSig`), not in the author's public repository. A community that becomes private takes its existing member content with it. Votes and objections in a private community are kept there too, and so are the votes of a community's open proposals when it becomes private; votes on proposals already decided stay where they were. Public communities are unchanged.
- **Commitment salt** is no longer returned by the public `attestation.verifyCommitment`; it comes with a full disclosure as `disclosure.redeemGrant().commitmentSalt`, so a guessable private claim cannot be confirmed by trying each possibility.
- **Attestation issuance policy**: a role may carry `attestationTypes`, limiting which kinds of attestation its holders may issue and revoke (`AttestationTypeNotAllowed`). Roles are governed, so in a community that decides by vote the policy changes by proposal while issuing within it needs none; attestations are accordingly no longer on the default protected list.
- A governance proof for a chain with no configured adapter is answered `verified: false` (`verificationMethod: 'none'`) unless the operator sets `ORACLE_TRUST_UNVERIFIED_PROOFS=true`.
- **Wallet signing consent is the user's**: `wallet.grantConsent` no longer grants anything (`UserApprovalRequired`). A dApp calls `wallet.requestConsent` and sends the user to `approveUrl`, a page on this PDS that cannot be framed, where they approve with their password (`approveConsentRequest`, same lockout as login); the dApp polls `getConsentRequest`. A consent lasts 1 hour by default, at most `WALLET_CONSENT_MAX_HOURS` (24). It names what it covers: `signTransaction` signs only to its `allowedContracts` (Solana: programs), moves no value unless it sets `maxValuePerTx`, and stops at `maxTotalValue`; `wallet.sign` refuses a sign-in message for any domain but the dApp's (`OutsideConsentScope`). Migration 053; consents granted before it keep signing messages and sign no transactions. SDK: `wallet.requestConsent`, `getConsentRequest`, `waitForConsent` replace `grantConsent`.
- A governance proof is bound to the community's own contract: `submitProof` needs `governanceConfig.contractAddress`, refuses a proof for another chain or contract, and records the community's address.
- An author signature on community content verifies against any signing key the author's DID has used, so rotating a key no longer invalidates earlier posts.
- The SDK's ATProto login must now be bound to the browser that starts it: `/auth/atproto` refuses a request without `code_challenge`.
- Dependencies: express 5.3, body-parser 2.4, path-to-regexp 8.4, proxy-addr 2.0.8, express-rate-limit 8.7, nodemailer 10.4; web UI on Next.js 16.4.6.

### Fixed (review follow-up)

- An `OAUTH_SIGNING_KEY` with a `"use": "sig"` member no longer triggers the OAuth library's "private JWK with a use property will be rejected" warning: `use` is dropped before the key is loaded. Same key, so no OAuth session is invalidated.
- `wallet.listConsents` failed (500) for any user with a consent: it returned a `revokedAt` field its lexicon does not declare.
- A second "Sign in with ATProto" account could not be created (`users.email` stored `''` under a UNIQUE constraint; now NULL, migration 049) (#274).
- Password-reset and recovery emails linked to pages that did not exist; the PDS now serves `/reset-password` and `/recover` (#275). SMTP connections have timeouts.
- Migrations are applied once and recorded in `schema_migrations`, under a lock, where every start used to re-run all of them (#276). `migrate-038` no longer shifts timestamps when re-applied.
- The server drains in-flight requests on SIGTERM/SIGINT before closing the database pool (`SHUTDOWN_TIMEOUT_SECONDS`, default 20) (#277).
- Background jobs keep their schedule in the database (`scheduler_runs`, migration 050) and run one at a time across processes; `MIGRATION_CLEANUP_DAYS` of 25 or more no longer turns the sweep into a tight loop (#278).
- Registration refuses a taken handle, taken email or bad invite before registering a DID, and removes the account again if its keys or repository could not be created (#279). Account deletion also removes rotation-key shares, wallet links, custody rows and OAuth grants.
- Wallets: a wrapped secret is stored per wallet, not per chain (migration 051; `getCustodialSecret` takes `walletAddress`, new error `WalletAddressRequired`); a custodial wallet cannot be unlinked while the server holds its only key (`CustodialWallet`) (#273).
- `listProposals`, notification and friend-of-friends pagination skipped or repeated items (#283). A malformed notification cursor is a 400.
- Forum thread and post lists failed on the second page outside UTC and skipped items sharing a timestamp; cursors are now exact. `calendar.listEvents` and `calendar.listRsvps` take `limit` and `cursor` (the first used to stop at 200 with no way to continue; the second was unbounded) (#283).
- Contacts: accepting a request several times at once, or again after an interrupted attempt, creates one contact record per side; blocking someone already blocked writes nothing; a contact request must name an account on this server (`NotFound`) (#282).
- `@open-federation/sdk` SIWOF verification looks up `did:plc` issuers in OpenFederation's directory as well as the public one when `plcUrl` is not given, and no longer waits indefinitely on a directory that does not answer (#286).
- `account.approve` / `account.reject` given several identifiers act only if they name the same account; visibility and join-policy changes are audited; a failed `admin.deleteAccount` is recorded as failed (#287).
- Governance settings: `quorum` must be an integer, `proposalTtlDays` 1–365, `timelockHours` at most one year (#281). Concurrent approvals of one join request create one member record (#282).
- XRPC router: unknown names such as `constructor` are 404, not 500; a procedure is refused on GET (405); a query's parameters are validated whichever verb carries them (#288).
- Four lexicons that were not valid AT Protocol lexicons (inline nested objects) are, so `npm run build:lexicon` works again; the removed `community.transfer` is gone from the CLI and the lexicon package (#280).
- Deploy: the container runs as `node`; `docker-compose.yml` passes the variables production startup requires; the PLC server refuses to run in memory on a deployment unless `PLC_ALLOW_IN_MEMORY=true` (#285).

### Changed (review follow-up)

- `refreshSession`: two requests presenting the same current token within `REFRESH_REUSE_GRACE_SECONDS` (default 10, `0` disables) both succeed, the second with a session of its own, so two tabs no longer log each other out (#272).
- `com.atproto.server.getSession`, `net.openfederation.server.getPublicConfig`, `federation.listPeers`, `federation.listPeerCommunities`, `partner.listKeys` and `account.export` are declared as queries (they were declared as procedures and called with GET).
- `@open-federation/sdk` `register()` returns `RegisterResult`: with no ticket the user is not signed in and `emailVerificationRequired` is true. `calendar.rsvp` replaces a person's earlier RSVP for the same event where it used to add another record.
- `@open-federation/sdk`: refresh is coordinated across tabs and a transient failure no longer signs the user out; `wallet.unlockTier2` unlocks wallets upgraded from Tier 1 and takes `walletAddress`; `wallet.upgradeToTier` to Tier 3 requires `tier2Passphrase` and returns the unwrapped secret; the ethers signer signs bytes as bytes; `resolveWallet` works signed out. The admin dashboard and `ofc` likewise keep the session on a transient refresh failure, and `ofc` always writes its session file with mode 0600.

### Added

- **Pseudonyms**: anonymous accounts the owner can reveal later (public link record, private file, or in person). Creation uses blind tokens collected monthly (`net.openfederation.pseudonym.getTokenKeys`, `collectTokens`, `createAccount`, plus `com.atproto.server.reserveSigningKey`), so the PDS cannot link a pseudonym to its owner. Phrase login via `getLoginChallenge` + `createSession`; owner-side `signLink`. New record lexicons `net.openfederation.pseudonym.link` and `net.openfederation.authorship.claim`.
- `@open-federation/pseudonym` package (`packages/openfederation-pseudonym`) and `ofc pseudonym verify | presence-challenge | verify-presence` (offline verification; exit code 2 means signatures are valid but the owner key was not confirmed).
- Env vars `PSEUDONYM_TOKENS_PER_EPOCH` (20), `PSEUDONYM_PROBATION_DAYS` (7, `0` disables), `PSEUDONYM_PROBATION_DAILY_WRITES` (20).
- Migration `scripts/migrate-041-pseudonyms.sql`.
- **Account migration, first step** (#261): `com.atproto.server.createAccount` imports an existing DID as a deactivated account, with proof of control by a JWT signed by one of the DID's PLC rotation keys (so far pseudonyms only); `com.atproto.server.checkAccountStatus` reports import progress. `reserveSigningKey` binds a reservation to `did` when given. `@open-federation/pseudonym` adds `openAccountForMove` and `signOwnerJwt`. Migration `scripts/migrate-042-account-migration.sql` (`users.migrating_in`, `reserved_signing_keys.did`). E2E tests can start a second PDS (`tests/e2e/second-pds.ts`).
- **Account migration, repository import** (#262): `com.atproto.repo.importRepo` lets an account that is moving here load its own repository. The CAR is fully verified first (DID, commit signature against the DID's current atproto key, complete record tree) and stored in one transaction with batched inserts, replacing the placeholder repo.
- **Account migration, activation** (#263): `com.atproto.identity.getRecommendedDidCredentials`; `com.atproto.server.activateAccount` (revision 2) activates an account that moved here once its DID points here (`IncompatibleDidDoc` otherwise). `@open-federation/pseudonym` adds `moveAccount` (the whole move in the standard order, refusing to change the DID until the new PDS holds the exported repository) and `buildMoveOp({ handle })`. The stage demo moves Night Desk this way and then publishes from the new home; the admin import route is gone.
- **Account migration, blobs** (#264): `com.atproto.sync.listBlobs` (the blobs a repo's records reference) and `com.atproto.repo.listMissingBlobs` (the ones this PDS does not hold yet); `uploadBlob` works for an account that is moving here before activation; `checkAccountStatus` reports `expectedBlobs` / `importedBlobs`. `moveAccount` copies missing blobs (`copyMissingBlobs`) and will not change the DID until all of them arrived. In the stage demo Night Desk gets a profile picture when it first publishes, and it moves with the account.
- **Account migration, the gate and safety rules** (#265): `MIGRATION_ACCOUNTS` (`open`/`invite`/`closed`) and `MIGRATION_PSEUDONYMS` (`open`/`token`/`closed`, never invite codes) decide whether accounts may move here; refusal happens at `createAccount` before anything changes; the policy is in `getPublicConfig`. `createAccount` (revision 2) takes a blind `token` in `token` mode. A deactivated account keeps a limited session (`createSession`, pseudonym `createSession` revision 2, `refreshSession` return `active: false, status: 'deactivated'`; other endpoints answer `AccountDeactivated`), so nobody is locked out; `activateAccount` switches an account on only where its DID points, so a copy left behind by a move is reactivated by pointing the DID back, and `moveAccount` moves back into such a copy. Automatic clean-up (`MIGRATION_CLEANUP_DAYS`) removes only copies that never activated here and whose DID named another PDS on two sweeps in a row, keeping a flag rather than a timestamp. Migration `scripts/migrate-043-migration-cleanup.sql`.
- **Account migration, user accounts** (#266): a user account moves with the old PDS's help, in the standard AT Protocol shape. New PDS: `createAccount` (revision 3) accepts service auth from the old PDS plus `email`, `password` and `inviteCode`, makes a custodial rotation key for the account (2-of-3 shares, share 1 returned as `rotationDeviceShare`), and `getRecommendedDidCredentials` (revision 2) recommends it. Old PDS: `com.atproto.identity.requestPlcOperationSignature` emails a one-time code, `signPlcOperation` signs the update with the rotation key it holds after the code and the password, `submitPlcOperation` posts it. Two-PDS E2E (`tests/e2e/custodial-migration.e2e.test.ts`) with the client flow in `tests/e2e/custodial-move.ts`. Migration `scripts/migrate-044-custodial-migration.sql`.
- **Community migration** (#267, ADR-002): a community moves with the owner's primary rotation key. New PDS: `net.openfederation.community.migrateIn` (proof JWT; pulls the repository and blobs from the DID's current home, rebuilds member and attestation indexes, fresh signing and recovery keys), `checkMigration`, `activate` (once the DID points here; fetches the attestation keys). Old PDS: `getMovedKeys` hands the private attestations' keys over sealed to the DID's new signing key (ECIES), and marks the copy `moved`; `markMoved`. Ownership is by DID (`communities.owner_did`), so the owner may live on any PDS. Gate `MIGRATION_COMMUNITIES`. Migration `scripts/migrate-045-community-migration.sql`.

### Fixed

- A deactivated account could not sign in again once its access token expired (`createSession` and `refreshSession` refused it, and `activateAccount` needs a session), so self-deactivation was a lockout until an admin stepped in. Deactivated accounts now get a limited session (#265).

- `net.openfederation.admin.importRepo` (revision 4) now verifies the backup before storing it (new errors `UnresolvableDid`, `InvalidSignature`, `InvalidRepo`), writes it in one transaction instead of leaving a half-imported repo on failure, keeps only the blocks of the verified repo, and stores records in AT Protocol JSON form (blob references as `{ $type: 'blob', ref: { $link } }`) (#262).
- `net.openfederation.community.transfer` no longer returns 500 on success: the package carried an undeclared `$type` field, which output validation refused. The web dashboard now asks for the password (#260).

### Removed

- `net.openfederation.community.transfer` and the dashboard's Transfer action: a community moves with `community.migrateIn` and friends (#267).

### Changed

- Community ownership is decided by DID (`communities.owner_did`, backfilled from `created_by`) everywhere: guards, `community.get`/`update`/`delete`/`export`, attestation disclosure and its audit log (#267).
- `communities.status` gains `importing` and `moved`; writes to such a community answer `CommunityImporting` / `CommunityMoved` (declared on every write lexicon that goes through the community guards, revisions bumped).

- `com.atproto.server.activateAccount` and `deactivateAccount` record no status timestamps for pseudonyms.
- New error `NoEmail` on `com.atproto.server.confirmEmail`, `requestEmailConfirmation` and `net.openfederation.admin.createVerificationChallenge` (accounts without an email).
- `net.openfederation.account.list` (revision 2): `email` is optional and omitted for accounts without one (pseudonyms); previously such an account made the endpoint return 500.
- New error `ProbationLimit` (429) on `com.atproto.repo.createRecord`, `putRecord`, `uploadBlob`, `net.openfederation.forum.createThread`, `forum.createPost` and `calendar.createEvent` for pseudonyms in their probation period.
- `auditLog()` drops entries whose actor or target is a pseudonym; disclosure audit stores no IP for pseudonym requesters.
- `net.openfederation.community.transfer` (revision 2) declares the `password` it has always required, plus the `Unauthorized` error for a wrong one. Before, the runtime refused the field and no request could succeed (#260).
- Requirements note: `@cloudflare/blindrsa-ts` (used by the pseudonym package) declares `engines.node >= 24`, while this repo's root declares `>=22 <25`.

## [1.3.0] - 2026-08-07

Everything below shipped since the 1.2.0 heading. **Versioning note:** the
1.x line carries no semver stability guarantee — this project is
pre-production, and 2.0 is reserved for the first release validated against
a real downstream use case. Breaking changes in 1.x are called out inline
(this release: Tier 1 wallet signing now requires a browser `Origin`, so
server-to-server callers of `wallet.sign`/`signTransaction`/`grantConsent`
are cut off; production deployments must configure SMTP or set
`ALLOW_NO_EMAIL=true` to boot).

### ATProto blob compliance: getBlob and profile avatars (#82)

The blob layer already existed — `com.atproto.repo.uploadBlob`, local/S3
stores, ownership tracking. What #82 still needed was the standard way to
read the bytes back and a way to put an uploaded blob on a profile.

- **`com.atproto.sync.getBlob`**: raw bytes by (did, cid), with the binding
  enforced — a blob is fetched from the repo that references it, never from a
  global content store keyed by hash alone. Unauthenticated like upstream,
  which is compatible with ADR-001: the CID is the capability, published only
  inside records, and records are where the membership gate lives. Gating the
  bytes would break every browser `<img>` tag instead.
- **`updateProfile` accepts `avatar` and `banner`** as the exact blob object
  `uploadBlob` returned, validated against `blob_owners` so a profile can
  only reference blobs its own DID uploaded (`InvalidBlobRef` otherwise, now
  declared); `null` removes the image. `avatarUrl` strings keep working.
- Lexicons: `com.atproto.sync.getBlob` new; `account.updateProfile` 1→2.

### Security: private communities are PDS-local, decided and enforced (#85)

ADR-001 records the decision issue #85 asked for: private communities do not
federate (option 1), with a trusted-peer allowlist (option 2) named as the
upgrade path and encrypted repos (option 3) deferred to its own ADR if ever
needed. Discovery is existence-visible, content-stripped — a `did:plc`
community's existence and handle are in the public PLC directory by design,
so hiding them here would be theater; everything past existence is protected.

The audit behind the ADR found the posture already implemented on every repo
and read surface, and **two live leaks on the ActivityPub side**, both closed:

- **`/ap/actor/:did` served a private community's display name, description
  and linked application instances to anyone holding the DID** — which PLC
  hands out. The actor still exists (the owner deliberately linked AP
  instances that need it for addressing and signature verification) but is
  now stripped: identity and public key only.
- **`/.well-known/webfinger` advertised a private community's profile page.**
  It still resolves the handle — existence is public regardless — but carries
  no content links.

Both leaks survived because the AP router was mounted inside `main()`, which
never runs under the test harness — the routes were untestable, so nothing
could pin them. The router is now always mounted and gates itself on
`ACTIVITYPUB_ENABLED` per request, like the chain module, so tests exercise
what production runs.

- `src/federation/privacy.ts` is the single predicate, and ADR-001 carries
  the standing rule: **any future firehose, `subscribeRepos`, `listRepos` or
  relay surface MUST exclude private DIDs**. That sentence is the issue's
  actual payload — the moment a relay surface ships without it, "private"
  silently regresses to "public".
- `tests/api/federation-privacy.test.ts` walks one real private community
  across every row of the ADR's enforcement map: sync/repo endpoints,
  listAll, listMembers, the stripped actor, webfinger — plus the inverse
  (a public community keeps everything) and the member view.

### Email verification on registration (#83)

Registration now issues a 24-hour, single-use verification token and emails a
link; redeeming it sets `users.email_verified_at`. Token mechanics mirror
`password_reset_tokens` — hashed at rest, burned on any redemption attempt —
and the token records the address it was issued for, so an email change
between issue and confirm invalidates the link rather than verifying an
address the user no longer claims.

- **ATProto-compatible endpoints**: `com.atproto.server.confirmEmail` and
  `com.atproto.server.requestEmailConfirmation` (resend; rate-limited;
  idempotent once verified; surfaces delivery failure — the caller is asking
  precisely because the last email did not arrive). `confirmEmail`
  deliberately works without a session, diverging from upstream: the token is
  the proof of mailbox ownership, and under `require-for-login` an unverified
  user cannot create the session upstream assumes. A presented session must
  belong to the account being verified.
- **A human-readable landing page** at `/verify-email` — the emailed link
  works in a browser, logged out, with no web-UI dependency.
- **Enforcement is the operator's decision** (`EMAIL_VERIFICATION_POLICY`):
  `off`, `advisory` (default — surfaced in `getSession.emailConfirmed`,
  gates nothing), `require-for-write` (acting endpoints refuse with
  `EmailNotVerified`, enforced in `requireApprovedUser`), or
  `require-for-login` (`createSession` refuses unverified local accounts).
  An unrecognized value warns and falls back to advisory: a typo must
  neither lock users out nor silently disable verification.
- **The gating policies cannot deadlock or lock out the operator**: the
  confirm path needs no session, and the bootstrap admin is marked verified
  at startup — the operator configured that address themselves, which is the
  attestation verification exists to obtain.
- Verified state is read fresh from the database when a gating policy needs
  it (and surfaced fresh in `getSession`), never from a JWT claim — a claim
  would keep reading "unverified" after the user verifies mid-session. Under
  `off`/`advisory` the lookup does not run at all.
- `EmailNotVerified` joins the standard XRPC error set alongside
  `AccountSuspended`/`AccountNotApproved` — the account-state family that can
  surface on any authenticated endpoint. Lexicons: `createSession` 1→2
  (declares `EmailNotVerified`), `getSession` 1→2 (`emailConfirmed` in
  output), plus the two new endpoint schemas.

### Email: delivery tells the truth (#83, part A)

Groundwork for email verification, and a fix for a live hazard: `sendEmail`
could not fail. With no SMTP configured it logged to the console and returned;
a rejected send was caught and swallowed. Password reset reported success
while delivering nothing — and since no SMTP has ever been configured on this
deployment, no email has ever actually been sent, and nothing said so.

- **`sendEmail` returns a discriminated outcome** (`sent`, `not-configured`,
  `suppressed`, `failed-transient`, `failed-permanent`) and still never
  throws. Callers judge for themselves: an unsendable password-changed
  *notification* is a log line; an unsendable admin verification challenge is
  now a 502 telling the admin the code never went out. The
  enumeration-resistant endpoints (`requestPasswordReset`, `initiateRecovery`)
  deliberately do NOT surface delivery failure to the caller — "delivery
  failed" implies the account exists — it goes to the audit log and the
  deliveries table instead.
- **Every send lands in `email_deliveries`** (recipient, purpose, outcome,
  error, provider message id) — the operator's ground truth for "did my mail
  go out". Bodies are never stored: reset/recovery emails carry live secret
  URLs, the same tokens the database deliberately holds only as hashes.
  For that reason retry is bounded and in-process (SMTP 4xx and connection
  errors, two backoff attempts), not a durable outbox.
- **The transport is verified at boot.** Production without SMTP refuses to
  start — matching `AUTH_JWT_SECRET` — unless `ALLOW_NO_EMAIL=true` states
  the choice. A configured-but-unreachable transport logs loudly and shows in
  `/health` (`email: ok | unreachable | not-configured`) but does not kill
  the server: the mail host being down must not take the PDS with it.
- **Bounce and complaint webhooks** (`/webhooks/email/{postmark,resend,ses}`,
  enabled by `EMAIL_WEBHOOK_TOKEN`, routes absent otherwise). Hard bounces and
  complaints suppress the address — `sendEmail` refuses it before contacting
  the server — soft bounces are recorded but never suppress. SES/SNS
  subscription handshakes are logged for manual confirmation rather than
  auto-fetched (fetching a URL from an inbound body is SSRF).
- `docs/EMAIL.md`: operator guide for all three supported paths —
  transactional provider, Google Workspace, self-hosted MTA — with the
  operational costs of each stated rather than implied.
- `admin.createVerificationChallenge` lexicon revision 1→2 for the declared
  `EmailDeliveryFailed` error.

### Testing: the suite stops failing at random, and runs twice as fast

The full suite failed one or more unrelated tests per run — a different test
each time, every one passing in isolation (issue #222). Two independent causes,
found by instrumenting supertest rather than by reading code.

**Requests were sometimes answered by other software on the machine.**
`request(app)` makes supertest call `app.listen(0)` for *every request*, so a
full run cycled through thousands of OS-assigned ephemeral ports — the same
49152–65535 range every other local daemon uses. A captured failure shows an
XRPC request answered by `server: CCLibrary/4.18.2` (Adobe Creative Cloud) with
`405 MethodNotAllowed`; others arrived as `ECONNRESET` or `socket hang up` from
ports with nothing listening. That explains every property of the bug: a
different test each run, because the failure belonged to whichever request drew
a contended port; passing in isolation, because one file draws far fewer ports;
and a `405` no code in this repository can emit, because none did.

The helpers now hand supertest one already-listening server, so the churn — and
the collision window — stops existing.

**`beforeAll` hooks could exceed their 30s budget under load.** `bcryptjs` is a
pure-JS implementation, costing ~284ms to hash and ~276ms to verify at 12
rounds, all of it on the event loop. Every `createTestUser` does a register plus
a login, so a file creating four accounts spent ~2.2s in bcrypt before touching
PLC or the repo. Failures tracked wall-clock exactly: runs at ~300s passed,
runs at 575s and 919s timed out.

The work factor is now test-only configurable and defaults to 4 under
`NODE_ENV=test`. **The floor is enforced in code, not in configuration**:
outside `NODE_ENV=test` it is 12 whatever the environment says, so a stray
`TEST_BCRYPT_ROUNDS` in a deployment cannot weaken password hashing. Hashes
already written at 12 rounds keep verifying.

- **Verification: 6 consecutive clean full-suite runs**, against 3-of-5 with the
  port fix alone and roughly half before either. Suite wall-clock fell from
  ~310s to ~145s.
- A guard test pins the property the bug violated — every response carries a
  header only this application sets, and a burst of requests uses one address.
  Reverting the helper change fails it immediately (60 ports instead of 1).
  It checks *who answered*, not *what status came back*, because a foreign
  daemon returning a plausible 200 would corrupt a test silently — the case a
  retry-on-error workaround could never have covered.

### Testing: the global rate limit is configurable

Found while investigating #222, which it does **not** close: the suite still
fails intermittently without it, so this is a real bug that was masking nothing.

`globalLimiter` applies to every request at 120/minute per IP and its ceiling was
written in code. It was therefore the one limiter `tests/api/setup.ts` could not
raise, though that file raises the other four for precisely this reason and says
so. Every test file drives the same long-lived app from `127.0.0.1`, so the suite
exhausts 120 requests inside its first minute; whichever test is running when the
budget runs out gets a 429. A single file stays under the cap, which is why every
failure looked spurious when re-run alone.

- `GLOBAL_RATE_LIMIT` now sets it, defaulting to the same 120 — **no change to
  production behaviour**. It is also a knob operators wanted anyway: a
  deployment whose clients share an egress IP (a corporate NAT, a mobile
  carrier, a proxy that does not forward the real address) was rate-limiting
  them collectively with no way to say otherwise.
- Documented in `.env.example` and the `CLAUDE.md` environment table.
- A regression test pins both halves: the ceiling comes from the environment,
  and a burst above the production default draws no 429. Hard-coding `max: 120`
  again fails it immediately.

### Security: time-limited disclosure grants expire when they say they do

Fifteen columns were `timestamp WITHOUT time zone`, and the two things written
into them disagreed about which clock they meant. Postgres defaults and
comparisons (`CURRENT_TIMESTAMP`, `NOW()`) produce local wall-clock time; the
application passes a JS `Date`, which the driver serialises as UTC. Where the
application wrote and Postgres compared, a credential's real lifetime became
`TTL − UTC offset` (issue #221).

One column was actually affected: **`viewing_grants.expires_at`**, written from
a JS `Date` and compared against `NOW()` in four places. West of UTC a
time-limited attestation disclosure grant stayed redeemable for the offset —
4–5 hours at US timezones — past the expiry it was issued with, which defeats
the point of the feature. East of UTC it was born expired, which is why the
disclosure suites failed on a developer machine and passed in CI.

Railway runs UTC, where the offset is zero, so no deployed grant was ever
mis-scoped. This is a latent bug being closed, not an incident.

- All 15 naive columns are now `TIMESTAMPTZ` (`migrate-038`), removing the class
  rather than the instance: no future writer has to know which of the two
  conventions a column is on, which is what allowed this.
- The migration states the source zone **per column**. A plain
  `ALTER ... TYPE timestamptz` reads existing naive values as the *server's*
  zone — correct for the columns Postgres wrote, and wrong by the offset for the
  ones the application wrote, which would silently shift every stored instant.
  The application-written columns use `USING … AT TIME ZONE 'UTC'` explicitly.
  Verified against pre-existing data: a grant reading −120 minutes of remaining
  life before the migration reads +60 after it.
- `disclosure_sessions.expires_at` had the same mismatch but nothing compared it
  against `NOW()`, so it was latent rather than live. Converted with the rest.
- The convention is now recorded at the top of `schema.sql`.
- **Not affected, contrary to the issue as first written**: `sessions`,
  `password_reset_tokens`, `recovery_attempts`, `wallet_dapp_consents`,
  `invites` and `oauth_requests` were already `TIMESTAMPTZ`. Nor were the naive
  columns Postgres both wrote and compared (`wallet_link_challenges.expires_at`,
  and every `DEFAULT CURRENT_TIMESTAMP` column) — both sides were on the same
  clock. The correction is recorded on the issue.

### Governance: resolution is crash-atomic

Resolving a proposal wrote three separate signed commits — the decision record,
the proposal's terminal state, then the change the proposal authorized. A crash
between the second and the third left a durable `approved` proposal whose change
had never happened, and nothing would ever revisit it, because the proposal was
no longer `pending-application`. #205 made that window observable (the failure is
audited) and reachable from a read (lazy application runs on `getProposal`), but
not impossible (issue #188).

The three writes are now **one** signed commit. `PgBlockstore.applyCommit`
already wrote its blocks and its new root inside a single Postgres transaction,
so batching through `Repo.applyWrites` makes the whole resolution atomic without
an outbox, a durable intermediate status, or a retry path: either the repo holds
the decision, the closed proposal and the change, or it holds none of them.

It is also the more faithful reading of the protocol — a decision and the change
it authorizes are one act, and a repo revision is what ATProto has to say "these
happened together".

- `RepoEngine.applyWrites(keypair, ops)` writes and deletes several records in
  one commit. `deleteRecord` now shares its cache cleanup, so a delete means the
  same thing whichever way it was issued.
- `ensureDecisionRecord` becomes `prepareDecisionRecord`, returning the decision
  reference plus a write op for the caller to batch instead of committing. Reuse
  of an existing decision — an override round's supersession (#199), or a
  pre-#188 crash — is unchanged, and is now expressed as the absence of an op.
- `proposalWriteOp` and `proposedChangeOps` expose the proposal write and the
  authorized change as ops. Both the immediate path (`voteOnProposal`) and the
  lazy timelock path (`applyIfDue`) commit once.
- **An ordering rule disappears rather than being managed.** The decision was
  written first specifically so a proposal could never be closed citing a
  decision that did not exist; one commit makes that impossible by construction.
- **Applicability is settled before the commit on every path.** A settings
  proposal that would leave the community ungoverned is refused while the
  proposal record is still being built, so a refused change can never leave a
  record asserting an `appliedAt` that did not happen. Previously only the
  timelock and override paths did this.
- **A delete of a record that is already gone is dropped rather than issued.**
  Idempotence is what makes a retry after a crash safe, and `applyWrites` would
  reject a delete of a missing rkey — failing on exactly the path that exists to
  recover.
- Fault-injection tests inject at the blockstore transaction, where a real
  process death would land, and sweep how many commits survive: the invariant
  (a proposal is open/pending, or closed with its change applied — never closed
  without it) is asserted at each. Failing *every* commit would have proved
  nothing, since the old code's first commit would have failed too.

### Governance: an objection no longer ends the matter

PRD #189 specified "objection → application held pending **re-review per
community rules**". The hold shipped; the re-review did not. `objected` was
terminal — `applyDueProposals` only looked at `pending-application`,
`objectToProposal` refused an already-held proposal, and `voteOnProposal`
required `status === 'open'` — so at the default threshold of 1, any single
member holding `community.governance.write` could permanently veto any decision
of a majority-governed community. That is not a contest window, it is unanimity
(issue #199).

A hold now opens **one** override round (`objection-override`): the same
electorate votes again against a higher bar, inside a time-boxed window.
Reaching it applies the change; the round expiring short of it rejects the
proposal, so the objection stands. An objection therefore raises the bar a
decision must clear rather than replacing the decision.

The asymmetry with the `did:plc` rotation-recovery idiom this mechanism mirrors
is what forces the round to exist: there the contester is the account owner
recovering their own identity, and permanence is right because nobody else has a
claim; here the contester is one of N peers overriding N−1.

- **`overrideQuorum` is votes *for*, and only votes for.** The round asks whether
  a stronger mandate exists than the one that was objected to; abstention and
  opposition answer that the same way. Absent an explicit
  `governanceConfig.objectionOverrideQuorum` it is two-thirds of the electorate,
  floored at `quorum + 1` and **capped at the electorate itself** — without the
  cap, a community whose quorum already equals its membership would face a bar no
  vote could clear, reinstating the permanent veto in exactly the small
  communities most exposed to it.
- **The bar and the electorate are frozen onto the proposal when the round
  opens**, never recomputed. A bar that moved with the membership could be
  cleared by adding or removing members mid-round rather than by winning the
  argument.
- **The round starts from zero votes.** The vote cache is cleared and
  `overrideOpenedAt` becomes the tally epoch (`tallyEpoch`), because counting the
  first round's votes towards the higher bar would clear it with the very mandate
  that was objected to.
- **A carried override applies immediately** — no second contest window. The
  change already served one, and that window is what produced the objection;
  objecting again is refused, so another window would be a delay nobody could
  use.
- **Expiry rejects.** A round nobody answered is a mandate nobody has. Closing is
  lazy, exactly as application is, so the window is a floor on the delay rather
  than a promise of an instant.
- **Opt out, not opt in.** `governanceConfig.objectionReview: 'none'` restores
  the terminal `objected` state for a community that deliberately wants a hold to
  be final. Anything unrecognized is the default: a typo must not silently hand
  one member a veto, so `objectionReview` is validated and an unknown value is
  rejected outright.
- New config: `objectionReview`, `objectionOverrideQuorum`,
  `objectionOverrideDays` (default 7). Lexicon revisions:
  `setGovernanceModel` 5→6, `getProposal` 5→6, `listProposals` 3→4,
  `objectToProposal` 1→2, `voteOnProposal` 6→7 — the last four had descriptions
  asserting the permanence that is no longer true.
- The offline verifier gains `override-round` and `override-round-due`, both
  pending rather than faults, and corroborates a round's objections exactly as it
  corroborates a terminal hold.

### Governance: the application half of the evidence chain is verifiable offline

`verifyDecision` answers whether a decision was soundly *reached*, and
deliberately ignores objections — an objection contests the application, not the
votes cited, and treating one as a defect would make a sound decision verify as
unsound because someone disagreed. That left the other half unanswerable
offline: a decision can be perfectly sound and still have been applied a day
early, or applied over a hold that should have stopped it (issue #201).

`verifyApplication` is the sibling that answers it, under the same constraints —
no database, no network, no clock — reusing `checkObjectionRecord` and
`objectionThreshold` from `decision-rules.ts` so the online and offline rules
cannot drift. Exposed as `ofc governance verify-application`.

- **Application is lazy, and the verdict respects that.** There is no scheduler:
  a proposal whose window has elapsed is applied by the next interaction that
  touches it, so the timelock is a floor on the delay rather than a promise of
  an instant. An unapplied proposal past its `applyAt` is `application-due` — a
  state, not a defect. Only the inverse is provable dishonesty:
  `early-application`, a change applied before the window it published closed.
- **Distinct codes rather than a boolean**: `applied`, `held`,
  `nothing-to-apply`, `window-open`, `application-due`, `pending-application`,
  `closed-unapplied`, `early-application`, `applied-over-objection`,
  `unevidenced-hold`, plus the structural `malformed-proposal` /
  `missing-evidence` / `forged-signature` / `tampered-evidence`. Only
  illegitimate verdicts exit 1.
- **Time enters only where it must.** `--as-of` is optional; every clock-free
  verdict renders without it, and only the open/due distinction is left
  unevaluated rather than resolved against an invented now. A verdict that
  silently depended on when it was run would not be reproducible.
- **`closed-unapplied` is its own verdict** because the signed record genuinely
  does not separate a passed change refused as unapplicable — which the PDS
  records exactly this way — from an application silently skipped.
- **What it cannot decide, it says.** An objection record carries no membership
  evidence (unlike a vote record since #200), so objector entitlement rests on
  the community's word: `objector-eligibility-unverified` travels with every
  verdict that counts one. Symmetrically, a hold whose objector's repo was not
  supplied is the `hold-unverified` note, never an accusation; it becomes
  `unevidenced-hold` only when that repo *is* supplied, verifies, and contains
  no countable objection.
- `loadRepo` / `locateRecord` are now exported from `verify-decision.ts` and
  shared, so both verifiers mean the same thing by "in the signed repo".
- Corrects a stale claim in `cli/README.md` that voter eligibility is unchecked;
  #200 made it checked, as of the moment each vote was cast.

### Governance: decision records are reproducible

`votes` on a decision record was emitted in Map insertion order, which followed
an unordered SQL scan. Nothing downstream noticed — the offline verifier compares
CID sets and the tests normalised the sequence away — but it meant two PDSes
replaying the same history produced records with different CIDs, and every
decision comparison had to be lossy (issue #204).

The tally now sorts by `voteOrderKey`: the same earliest-`createdAt`,
rkey-as-tiebreak ordering the one-vote-per-voter rule already applies, so no new
notion of order is introduced. `for` and `against` remain grouped, each side
chronological. The underlying query is ordered too, so the intermediate state is
reproducible as well.

No lexicon change — the record's shape is unchanged, only the sequence within an
existing array. Decisions written before this keep whatever order they were
written with; nothing rewrites them.

### Governance: residuals from the verifiable-decisions branch

Three small items carried past #189, grouped (issue #202).

- **`governanceConfig` merges a level deeper.** Replacing it whole meant a
  proposal to change only `quorum` also reset `timelockHours` to 24 and
  `objectionThreshold` to 1 — governance changes nobody voted for, arriving as a
  side effect of the one that was. A decision now changes exactly what it
  proposed. Merge semantics follow JSON Merge Patch (RFC 7386): omitting a key
  leaves it alone, and `null` removes it — removal has to stay expressible,
  since dropping `anchoring` is how a community stops anchoring.
- **A standing objection is visible before it holds.** Below
  `objectionThreshold` the proposal's `objections` cache is deliberately not
  written, so an objection that had been raised but not yet taken effect existed
  only in the audit log and the objector's repo. `getProposal` now reports
  `objectionCount` and `objectionThreshold` while any objection stands, counted
  from the objectors' signed records rather than the cache.
  `net.openfederation.community.getProposal` revision 4→5.
- **Three lexicon descriptions corrected.** `governance.decision`,
  `governance.vote` and `governance.objection` each claimed records could be
  verified "without trusting the community's PDS". They now state the real
  property — tamper-evidence and public consistency, with independence complete
  only for externally-hosted accounts — matching what the verifier docstring and
  `cli/README.md` already say. Revisions 1→2, 2→3 and 1→2 respectively.

### Security: external-login handoff codes are bound to the initiating browser

The 60-second code that hands an external ATProto login back to the dashboard was
a bare bearer value: whoever held it could redeem it. An attacker could complete
OAuth as themselves, withhold the code, and send `/callback?code=...` to a
victim, whose browser would silently become signed in as the attacker — login
CSRF / session swapping (issue #146).

- The dashboard now generates a random verifier per login attempt, keeps it in
  `sessionStorage` (tab-scoped, so a code opened in another tab cannot borrow
  it), and sends only its SHA-256 as `codeChallenge` on
  `net.openfederation.account.resolveExternal`. The challenge rides in the OAuth
  `state` the ATProto client persists, so it survives the round-trip through the
  external PDS without a cookie — which matters because SDK consumers are
  cross-site and a `SameSite=None` cookie would have been required otherwise.
- `/oauth/external/complete` requires the matching `codeVerifier` for any
  web-flow code, compared in constant time. Codes are burned on **any**
  redemption attempt, so a failed try cannot be retried.
- Fails closed on downgrade: a web-flow code that carries no challenge is
  rejected rather than treated as unbound. Without this, an attacker could force
  the SDK branch (the dashboard origin is an allowed redirect target) and obtain
  a code the dashboard would still redeem.
- The dashboard also refuses to present a code when the tab holds no verifier,
  so an unbound code is never even sent.
- Refusals are audited as `auth.external.handoffRejected`.
- **SDK consumers are unaffected.** The redirect flow keeps working without a
  verifier, since consumers supply and validate their own `state` on their own
  callback. `net.openfederation.account.resolveExternal` revision 1→2 for the new
  optional `codeChallenge` input.

### Governance: voter eligibility is evidence, not an assumption

Nothing checked that a counted vote came from someone entitled to cast it.
Neither the online tally nor the offline verifier looked at membership, so a
decision citing five authentic, well-formed votes from five DIDs that were never
members verified as `valid` — the largest remaining gap in the evidence chain
(issue #200).

A vote record now carries the community-signed member and role records consulted
when it was cast, plus the permission they resolved to, and the offline verifier
rechecks them against the community's own repo.

- **Judged as cast, not at resolution.** A signed act is not unmade by a later
  removal, and tying eligibility to resolution-time membership would let an owner
  flip a result by removing voters mid-vote. No live outcome changes.
- Evidence that *disproves* entitlement — a cited role record without
  `community.governance.write`, a member record naming a different role, a
  citation pointing at another community — is `ineligible-vote`.
- Evidence that can no longer be resolved is the new `membership-unverified`
  note, never a pass and never an accusation: repo exports prune superseded
  blocks, so an honest decision becomes uncheckable with time. Votes written
  before this existed carry no evidence and verify with the note.
- Permission resolution mirrors `getCallerCommunityCapabilities` exactly,
  including the `roleRkey` indirection — a member record can name role "member"
  while being assigned moderator, and resolving by name would have read the wrong
  permission set. `LEGACY_ROLE_PERMISSIONS` moved into `decision-rules.ts` so the
  live check and the verifier share one table; tests assert the shared constants
  equal the auth layer's.
- `net.openfederation.governance.vote` revision 1→2 for the new `eligibility`
  block.

### Security: Tier 1 wallet consent is bound to the browser Origin

**Breaking for server-side callers of Tier 1 signing.** A `wallet_dapp_consents`
row authorizes one dApp origin, but that origin arrived only as a caller-declared
body field or `X-dApp-Origin` header. Anyone holding a user bearer token could
therefore declare another application's origin and sign under the consent that
application received — and, because `grantConsent` took its origin the same way,
could equally mint a consent for any origin and sign under it without one
existing first. Guarding only the signing endpoints would have moved the attack
one step earlier rather than stopping it, so all three are bound (issue #101).

- `wallet.grantConsent`, `wallet.sign` and `wallet.signTransaction` now require
  the browser's `Origin` header to match the declared `dappOrigin`. Mismatch is
  `OriginMismatch` (403); an absent or opaque `null` Origin is `OriginRequired`
  (403).
- **Browsers are unaffected** — the SDK already sends `dappOrigin` as
  `location.origin`, which is what the browser puts in `Origin`.
- **Server-to-server callers can no longer use Tier 1 signing.** Accepting a
  missing `Origin` would let any non-browser client opt out of the guard
  entirely. Backends that need to sign should hold their own keys with a Tier 2
  or Tier 3 wallet.
- Refusals are audited as `wallet.sign.originRejected`,
  `wallet.signTransaction.originRejected` and `wallet.consent.originRejected`,
  recording both the declared and the actual origin.
- Lexicon revisions: `wallet.sign` 2→3, `wallet.signTransaction` 1→2,
  `wallet.grantConsent` 1→2.

### Governance: verifiable decisions, a contest window, and no chain authority

Community governance is now decided from voter-signed records and published as
evidence a third party can recheck offline. The chain, where a community uses
one, is a notary that witnesses a decision — never an authority that makes one.
No outcome anywhere depends on a chain read.

#### Added
- **`net.openfederation.governance.vote`** (new lexicon): every counted vote is a
  record in the *voter's own* repo, signed with the voter's key. The proposal's
  `votesFor`/`votesAgainst` arrays are now a non-authoritative read cache.
- **`net.openfederation.governance.decision`** (new lexicon): written to the
  community repo when a proposal resolves, citing the proposal CID, the CID of
  every counted vote record, the quorum rule applied, the outcome, and any
  disclosed gap (`uncountedVotes` / `evidenceComplete`).
- **`net.openfederation.governance.objection`** (new lexicon): an objector-signed
  record in the objector's own repo contesting the *application* of a decision.
- **`net.openfederation.community.objectToProposal`** (new endpoint): raise such
  an objection inside a proposal's timelock window. Eligibility is the same
  `community.governance.write` permission that gates voting.
- **`ofc governance verify-decision`** (new CLI command): verifies a decision
  offline from CAR exports and DID documents — no server, no database, no
  network DID resolution. Exit status is the verdict in both output modes.
  `src/governance/decision-rules.ts` is the single rule implementation shared by
  online resolution and this verifier, so the two cannot drift.
- `governanceConfig.timelockHours` and `governanceConfig.objectionThreshold`
  settings.

#### Changed — behaviour changes for existing communities

1. **`setGovernanceModel` now enforces governance.** Changing the governance
   model is a write to the protected settings record, so under `simple-majority`
   or `on-chain` it requires a proposal and a quorum. An owner with
   `community.settings.write` can no longer change the model directly; the
   endpoint answers `403 GovernanceDenied` with `requiresProposal: true`. The
   old `on-chain` downgrade ratchet and its "PDS admin override" are gone —
   a community leaves a model by the same route it decides anything else.
2. **A passed proposal no longer applies immediately.** It resolves into
   `pending-application` and waits `governanceConfig.timelockHours`, which
   defaults to **24 hours** when the settings record does not state it. To keep
   the previous behaviour a community must set `timelockHours: 0` explicitly —
   and, under a voting model, must do so through a proposal. During the window
   any member who could have voted may object; once
   `governanceConfig.objectionThreshold` (**default 1**) countable objections
   exist the change is held. **A hold is permanent**: there is no expiry, no
   re-review, and no automatic re-vote, so at the default threshold a single
   eligible member can veto a passed proposal indefinitely. Raise
   `objectionThreshold` if that is not what the community wants.
3. **A voter with no repository can no longer vote.** `voteOnProposal` answers
   `400 VoteNotRecordable` for accounts that cannot sign a vote record
   (external accounts, the bootstrap admin). Counting them would put a
   permanently unevidenced name in the tally and deadlock resolution, which
   requires the records and the cache to agree.

Proposals created before this change carry no `evidenceModel` marker and
continue to resolve under the old array arithmetic; nothing is rewritten
retroactively.

#### Upgrade note
`ensureSchema()` only runs `schema.sql` when the `users` table is absent, so the
indexes added for this work do **not** apply to an existing database. Run
`scripts/migrate-035-governance-vote-record-index.sql`,
`scripts/migrate-036-governance-objection-index.sql`, and
`scripts/migrate-037-governance-anchor-audit-index.sql` by hand on upgrade — see
`DEPLOYMENT.md`.

#### Known limits
Verification establishes tamper-evidence and public consistency, not
independence from a PDS that holds its users' signing keys; and voter
*eligibility* (that a counted DID was a member with `community.governance.write`
at the time) is not checked online or offline. Both are stated in
`src/governance/verify-decision.ts` and `cli/README.md`.

## [1.2.0] - 2026-06-25

### Added
- **Community Forum** (`net.openfederation.forum.*`): native threaded discussions as ATProto records — threads and posts stored in author repos, aggregated into `forum_threads`/`forum_posts` index tables; moderation via hide/delete; 8 XRPC endpoints
- **Community Events & RSVPs** (`community.lexicon.calendar.*`): calendar events stored in community repos, RSVPs stored in attendee repos with `subject.uri` linking; RSVP counts aggregated in `event_rsvps` index table; 3 XRPC endpoints
- **Forum index backfill** (`scripts/backfill-forum-index.ts`): `backfillForumIndex()` reconstructs all index tables from `records_index` without touching the underlying repos — runnable standalone via `npx tsx scripts/backfill-forum-index.ts`
- No ActivityPub content federation — identity layer only; forum and calendar content stays on-PDS

## [1.1.0] - 2026-04-29

### Added
- **Contact graph** (`net.openfederation.contact.*`): bidirectional contact relationships with explicit consent — sendRequest, respondToRequest (accept/reject), removeContact, list, listIncomingRequests, listOutgoingRequests (closes #67)
- **Write-time member display projection** (#66): `members_unique` now stores denormalized display/role/kind columns; new `community_attestation_index` table; `listMembers` and `listAttestations` include resolved `displayName`/`avatarUrl` fields without N+1 fetches
- **XRPC output shape smoke tests** (#65): CI-time validation that handler responses match their lexicon schemas; catches handler/schema drift before production

### Fixed
- `account.list` was returning raw pg-node `Date` objects for `createdAt`/`approvedAt` instead of ISO strings (#65)
- XRPC input validation now runs for all requests including unauthenticated endpoints (#63)
- Cascade revocation on `deleteAttestation` — revokes all active viewing grants for the deleted attestation (#58)

### Changed
- `membership.ts` (662 lines) decomposed into per-lifecycle modules under `src/community/membership/` (#62)
- `listMembers` lexicon bumped to revision 3 (adds required `displayName`, optional `avatarUrl`)
- `listAttestations` lexicon bumped to revision 2 (adds required `subjectDisplayName`, optional `subjectAvatarUrl`)

## [1.0.0] - 2026-03-28

### Added

- **PDS Server**: Express.js + TypeScript + PostgreSQL backend with XRPC routing
- **Identity**: `did:plc` and `did:web` support with real PLC directory registration
- **Repository Engine**: Real MST repos wrapping `@atproto/repo` with signed commits and CAR export
- **Authentication**: JWT access tokens, refresh token rotation with reuse detection, session management
- **Authorization**: Role-based access control (admin, moderator, partner-manager, auditor, user)
- **Registration**: Invite-only with moderator approval workflow
- **Communities**: Create, join, leave, manage members, role management, attestations
- **AT Protocol Compliance**: suspend, unsuspend, takedown, export, transfer for both accounts and communities
- **User Lifecycle**: deactivate, activate, export, delete (ATProto-compatible)
- **External Identity Keys**: Cross-network identity bridging (Ed25519, X25519, secp256k1, P256)
- **Partner API**: Trusted third-party app registration with per-key rate limiting
- **SDK**: `@open-federation/sdk` zero-dependency browser library (ESM + CJS + IIFE)
- **Web UI**: Next.js 15 admin dashboard with shadcn/ui, React Query, kbar command palette
- **CLI**: `ofc` command-line tool following clig.dev conventions
- **PLC Directory**: Standalone `plc-server/` service for self-hosted DID resolution
- **Security**: AES-256-GCM key encryption at rest, rate limiting, audit logging
- **Federation**: `sync.getRepo` CAR stream, well-known endpoints (did.json, webfinger)
- **Profiles**: Standard `app.bsky.actor.profile` + custom collection aggregation

[1.1.0]: https://github.com/athlon-misa/openfederation-pds/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/athlon-misa/openfederation-pds/releases/tag/v1.0.0
