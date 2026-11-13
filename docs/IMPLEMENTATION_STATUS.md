# Implementation Status

Snapshot of what exists in the PDS. For release history see `CHANGELOG.md`; endpoint reference: `docs/API.md`.

## Status key

| Badge | Meaning |
|-------|---------|
| **shipped** | Coded, wired, and battle-tested in production |
| **needs-validation** | Implemented and registered; not yet validated end-to-end (see linked GitHub issue) |
| **parked** | Intentionally deferred — tracked as a GitHub issue |

Tracking issues use the `status/shipped`, `status/needs-validation`, `status/parked`, `status/coded`, and `status/dismissed` labels.

---

## Core — **shipped**

- Express + TypeScript ESM server with frozen XRPC handler registry
- PostgreSQL with auto-schema migration on startup (`ensureSchema()` in `src/server/index.ts`)
- Identity Manager: `did:plc` (real PLC registration via `src/identity/plc-client.ts` — direct protocol, not `@did-plc/lib`) and `did:web` with domain validation
- Real MST repos via `@atproto/repo` + `PgBlockstore` on PostgreSQL; `repo_roots` tracks root CID + revision per DID
- ATProto-compliant TID generation (`@atproto/common-web`) and CIDs (`cidForRecord()`)
- User identities: real `did:plc` + signing key + initial `app.bsky.actor.profile` repo record. PDS holds rotation + signing keys for users (separate `user_signing_keys` table)
- PLC directory service (`plc-server/`) for self-hosted deployment

## Install & first-run setup — setup page and Railway **shipped**, Docker **planned** ([#405](https://github.com/athlon-misa/openfederation-pds/issues/405))

- `src/index.ts` loads the settings file, runs setup mode when needed (`src/setup/launcher.ts`, `mode.ts`), then imports the server, so `src/config.ts` reads the wizard's settings on its first import. Nothing in `src/setup/` imports `src/config.ts` (`tests/unit/setup-config-free.test.ts`).
- Setup mode: production with neither `AUTH_JWT_SECRET` nor `KEY_ENCRYPTION_SECRET` and no settings file, or `OPENFEDERATION_SETUP=on`. Serves `/setup`, its assets and API, and `/health` (`status: "setup"`); everything else 503 `SetupRequired`.
- Claim: setup code printed in the log, kept as a SHA-256 in memory, new at every start (`claim.ts`); session cookie `of_setup` (HttpOnly, SameSite=Strict, path `/setup`).
- Settings: `OPENFEDERATION_CONFIG_FILE` (`config-file.ts`), plain `KEY=value`, mode 0600, written once; environment variables win; `server_setup` row (migrate-060) locks setup and carries the first admin (bcrypt hash) to the next start (`src/auth/setup-admin.ts`).
- In normal mode `/setup` says the server is set up and `/setup/api/*` answers 410.
- `/.well-known/atproto-did` answers the DID for this server's own handles (by `Host`).
- Railway template: [docs/RAILWAY-TEMPLATE.md](RAILWAY-TEMPLATE.md) (made in Railway's UI); guide: [docs/INSTALL-RAILWAY.md](INSTALL-RAILWAY.md).

## Auth — **shipped**

- JWT access tokens + refresh token rotation with reuse detection (compromise → revoke all sessions)
- Role-based guards: admin, moderator, partner-manager, auditor, user; `requireApprovedUser`, `requireActiveCommunity`, `requireCommunityRole`
- Per-account brute-force protection: 5/10/15/20 failures → 1m/5m/30m/2h lockout
- Cross-PDS service-auth (ES256K/ES256 JWTs): inbound verification via `@atproto/identity` resolver, 5-min cache, replay-protected, per-DID rate limit
- ATProto OAuth: authorization-server (`@atproto/oauth-provider`) + external login client (`@atproto/oauth-client-node`); dual auth middleware (DPoP → OAuth, Bearer → JWT)
- Session management: list, revoke by ID, revoke-all, email notifications
- Self-service password reset: SHA-256 hashed tokens, 1h expiry, all sessions revoked on reset
- Admin identity verification: email nonce challenge

## Registration & approval — **shipped**

- Invite-only with moderator approval workflow; invite binding (`--bound-to` email + notes)
- Partner Registration API: trusted apps register users without invites, auto-approved, per-key rate limiting, origin validation, instant revocation; keys SHA-256 hashed (`ofp_` prefix)

## Key management — **shipped**

- AES-256-GCM at-rest encryption for recovery + signing keys; PBKDF2 (100k iter, SHA-512) from `KEY_ENCRYPTION_SECRET`
- Primary rotation key returned to user once and never stored
- ActivityPub RSA keys persisted encrypted, survive restarts

## Communities — **shipped**

- CRUD + suspend/unsuspend/takedown (admin), export, transfer (owner)
- Members: join/leave, kick, role management (promote/demote between moderator and member)
- Join requests: list pending, approve/reject
- Attestations: issue, verify, list, delete-as-revoke (ATProto-native), encrypted variant with AES-256-GCM DEK + commitment hashes; `listAttestations` includes `subjectDisplayName`/`subjectAvatarUrl` from write-time projection
- Write-time member display projection: `members_unique` stores denormalized `display_name`/`avatar_url`/`role`/`kind`/`tags`/`attributes`; `community_attestation_index` mirrors the same for attestations; `updateProfile` fans out display changes across all membership rows. `listMembers` and `listAttestations` are single-table reads (no N+1)

## Disclosure proxy — **shipped** ([#81](https://github.com/athlon-misa/openfederation-pds/issues/81))

- Code: `src/attestation/lifecycle.ts`, `src/disclosure/`; `viewing_grants`, `disclosure_sessions`, `disclosure_audit_log` tables
- Flow: subject grants a viewer time-limited access → viewer redeems → claim re-encrypted under a one-time session key, watermarked (v2 HMAC, format documented in the test) and audited
- `tests/api/disclosure-redemption-e2e.test.ts` covers the round trip, the session and audit rows, expiry and the watermark MAC against an independent computation
- The watermark MAC is keyed by `KEY_ENCRYPTION_SECRET`: the PDS operator can attribute a leak, third parties cannot verify it offline. `disclosure_sessions.expires_at` is recorded but nothing reads a session after redemption

## Contact Graph — **shipped**

- Bidirectional contact graph with explicit consent: `sendRequest`, `respondToRequest` (accept/reject), `removeContact`, `list`, `listIncomingRequests`, `listOutgoingRequests`
- `withdrawRequest`, `block`, `unblock`, `listBlocks`, `listMutualContacts`, `listFriendOfFriends` (opt-in FOF, `fof_discovery` per user)
- Records: `net.openfederation.contact.request` (requester's repo), `net.openfederation.contact.contact` (both repos after acceptance)
- DB: `contact_requests` + `contacts` + `contact_blocks` index tables
- Display fields (`displayName`, `avatarUrl`) populated from write-time projection — absent (not null) when no profile exists

## Notifications — **shipped**

- Generic inbox: `createNotification`, `listNotifications` (paginated, filterable by category), `markRead`, `unreadCount`
- `contact_request` notifications written at `sendRequest` time (non-blocking, fire-and-forget)

## Profiles & identity — **shipped**

- Standard `app.bsky.actor.profile` + custom collection aggregation (`*.actor.profile`)
- External Identity Keys: Meshtastic/Nostr/WireGuard/SSH/hardware bridge via multibase-validated Ed25519/X25519/secp256k1/P256; reverse lookup
- DID-to-wallet linking: EIP-191 (Ethereum) + Ed25519 (Solana) challenge-response, reverse resolution
- Public DID→wallet resolver + W3C DID-document augmentation: did:web injects CAIP-10 verificationMethod entries into `/.well-known/did.json`
- Sign-In With OpenFederation (SIWOF): CAIP-122 / SIWE-compatible flow; offline-verifiable didToken (service-auth JWT) + walletProof

## Wallets (progressive custody) — Tier 1 **shipped**, Tiers 2–3 **needs-validation** ([#78](https://github.com/athlon-misa/openfederation-pds/issues/78))

- One DID anchors many per-chain wallets at three custody tiers, all on `wallet_links` substrate with stable addresses across upgrades
- **Tier 1 (custodial):** PDS encrypts key, signs server-side per consent grant — used in production by downstream consumers
- **Tier 2 (user_encrypted):** SDK wraps BIP-39 mnemonic under user passphrase; PDS stores opaque blob — coded, not validated end-to-end
- **Tier 3 (self_custody):** client-only mnemonic, PDS holds public link only — coded, not validated end-to-end
- Transaction signing: EIP-1559/legacy EVM (chainId required) and Solana transaction-message bytes; SDK exposes `asEthersSigner()` and `asSolanaSigner()`
- Tier upgrades (1→2, 1→3, 2→3) via `retrieveForUpgrade` + `finalizeTierChange`; downgrades unsupported — coded, not validated end-to-end

## Vault & recovery — **needs-validation** ([#77](https://github.com/athlon-misa/openfederation-pds/issues/77))

- Code: registration splits the PLC rotation key 2-of-3 (`secrets.js-grempe`, `src/identity/user-identity.ts`); shares 2 and 3 encrypted in `vault_shares`; `vault_audit_log`; `escrow_providers`
- XRPC endpoints registered: `vault.requestShareRelease`, `vault.exportRecoveryKey`, `vault.registerEscrow`, `vault.auditLog`, `account.getSecurityLevel`, plus `vault.storeCustodialSecret` / `getCustodialSecret`
- Custody tiers, all custodial (#239): this PDS holds shares 2 and 3 of every user's rotation key, a quorum. T1 `custodial`, T2 `escrow-recorded` (a provider on record; the share stays here, no transfer exists), T3 `key-exported` (the user also holds the rotation key, from `vault.exportRecoveryKey`, one export per identity verification). `getSecurityLevel` reports `pdsHoldsRotationKey`. Real self-custody (no rotation key on the PDS) is the planned `self` custody mode.
- Custody modes (ADR-003), all five steps: `users.custody_mode` (custodial / assisted / self), the installation policy (`OPENFEDERATION_PROFILE`, `IDENTITY_CUSTODY_*`, `PSEUDONYMS_ENABLED`), reported by `getPublicConfig` and `getSecurityLevel`, enforced at custodial sign-up, the vault endpoints and `pseudonym.signLink`. Step 2: `@open-federation/sdk/custody` (keys, PLC operations, owner signatures, passkey unlock) and the server's `verifyOwnerSignature`. Step 3: `account.registerSelfCustody` and `account.reserveCustodyKey`. Step 4a: mode changes in every direction (`identity.prepareCustodyChange` / `finalizeCustodyChange`). Step 4b: `identity.recoverAssistedAccount`, the 72-hour notice on every server-signed update for `assisted`, SDK `buildCancelOp`. Step 5a: reveal bundles v2 (`ownerAttestation`: person or PDS-held key). Step 5b: person-signed records (`ownerSig`, `identity.verifyRecord`, SDK `signRecord` / `verifyOwnerRecord`). Not in the ADR: a dashboard screen for custody modes.
- Operational protections against a hostile PDS (#241): `RepoWatcher` in `@open-federation/sdk/custody` reports writes the device did not make, from the public `com.atproto.sync` endpoints of the PDS or a relay; `leavePds` points an `assisted` / `self` DID at another PDS with the person's rotation key; `copyRepo` imports a repository and its blobs; `verifyRepoCommit` checks who signed a commit. Newsroom self-hosting checklist in `docs/HARDENING.md`. Not yet: a `self` account moving into another OpenFederation PDS (createAccount, signPlcOperation and importRepo have no path for it).
- Custodial Secret Storage: opaque encrypted blobs per user per chain, FK-cascaded on account delete
- `tests/api/vault-recovery-e2e.test.ts`: shares 2 + 3 rebuild the rotation key the PLC directory lists; storage encryption and secret rotation; release, export, escrow, security level and audit rows. It also pins the custody gaps in [#239](https://github.com/athlon-misa/openfederation-pds/issues/239): share 1 never reaches a client, tier 3 deletes nothing, escrow only relabels share 3
- Not exercised: the emailed code on staging, and a real escrow provider (there is no transfer to, or retrieval from, one)

## Federation & ATProto compliance — **shipped**

- Repo endpoints: `getRecord`, `putRecord`, `createRecord`, `deleteRecord`, `describeRepo`, `listRecords`
- `sync.getRepo` (full repo as CAR stream) — federation-critical
- Account lifecycle: suspend, unsuspend, takedown, deactivate, activate, export, delete (all ATProto-compatible)
- Takedown policy ([FAIR-USE.md](FAIR-USE.md)), accounts and communities alike: `standard` (owner gets a private export link, deleted after 30 days, reminder 7 days before) or `hard` (no owner export, 90-day legal hold, then deleted); daily sweep in `src/moderation/takedown.ts`
- Activity timelines ([#42](https://github.com/athlon-misa/openfederation-pds/issues/42)): `activity.getUserTimeline` (home-PDS fan-out over the caller's memberships, here and on configured peers via service-auth) and `activity.listCommunityActivity` (per-PDS, privacy enforced by the hosting PDS); design in [API.md](API.md#openfederation-activity-timelines). Memberships on non-peer PDSes are not reached
- `com.atproto.identity.resolveHandle` — local + external cross-PDS resolution (DNS TXT → HTTPS well-known, 1h cache)
- Well-known: `/.well-known/did.json` (PDS service DID, secp256k1, encrypted in `pds_service_keys`; falls through to community at hostname), `/.well-known/webfinger`
- Cross-server community discovery ([#41](https://github.com/athlon-misa/openfederation-pds/issues/41)): `/.well-known/openfederation-communities.json` and `net.openfederation.community.discover`; design below
- Private communities are gated on read (`requireCommunityReadable` / `requireRepoReadable`, `831285b`, 2026-07-10) at this PDS only. **This PDS is not yet federating to any external relay or AppView** — no production federation network is deployed. Before that federation is turned on, private-community DIDs still need to be excluded (or only sent to relays honoring the same gating) — tracked in [#85](https://github.com/athlon-misa/openfederation-pds/issues/85)

### Cross-server community discovery (#41)

**Mechanism: peer list + well-known.** No central service and no gossip. Each PDS publishes its own public communities at `/.well-known/openfederation-communities.json` (`version`, `pds`, `generatedAt`, `communities[]` with DID, handle, display name, short description, member count, home PDS URL). `net.openfederation.community.discover` returns this PDS's list followed by each peer's, deduplicated by DID, with the status of every peer asked. A peer's list is never re-published, so nothing travels further than one hop.

**Opting in** is one variable: `FEDERATION_PEERS=https://a.example,https://b.example`. A new deployment publishes its well-known document from the start; other servers see it once they add it to their own list.

**Peers are untrusted.** Each fetch has a timeout (`FEDERATION_PEER_TIMEOUT_MS`, 3 s), a 1 MiB size cap, no redirects, and at most 1000 entries; in production the URL must be https and resolve to a public address (`assertPublicHttpsUrl`). Every entry is validated (DID, handle, integer member count; text cut to 128 / 300 characters), entries marked as not public are dropped, and `pdsUrl` is always the peer that was fetched, whatever it claims. A peer can never speak for a DID this PDS hosts, so it cannot surface one of our private communities or rename a public one. Answers are cached per peer for `FEDERATION_CACHE_TTL_MS` (failures for 30 s at most); one peer failing never fails the request. What a peer says about its own communities (names, member counts) is reported as `source: 'peer'` and not verified further.

**A central directory later** plugs in where peers come from, not where they are fetched: `src/federation/peer-sources.ts` defines `PeerSource` (`listPeers(): Promise<string[]>`), and `peerSources()` in `src/federation/community-discovery.ts` returns the list consulted; today it holds only the `FEDERATION_PEERS` source. A directory would be one more `PeerSource` that returns the servers it knows; fetching, validation, caching and merging stay as they are. The directory itself could be an ordinary consumer of the same well-known documents.

**Not built:** pagination of peer documents (each peer's first 1000 entries are used), verifying peer-reported data against PLC or the community repo, and a dashboard screen.

## On-chain governance — **needs-validation** ([#76](https://github.com/athlon-misa/openfederation-pds/issues/76))

- Code: `src/modules/chain/` — EVM adapter (ethers v6), `oracle-credentials.ts`, oracle auth middleware, proof caching, oracle XRPC handlers. Core keeps only the neutral `GovernanceAttestor` / `GovernanceRequestAuthority` contracts in `src/governance/`; `scripts/check-import-boundaries.ts` (`npm run lint:boundaries`, run by `npm run build`) fails if core ever imports the module.
- XRPC endpoints registered: `createOracleCredential`, `getOracleCredential`, `listOracleCredentials`, `revokeOracleCredential`, `submitProof`, `listProofs`, `verifyGovernanceProof`
- Not validated against a real (or test) RPC endpoint; `CHAIN_ADAPTERS` env flow not exercised end-to-end

## ActivityPub identity layer — **needs-validation** ([#80](https://github.com/athlon-misa/openfederation-pds/issues/80))

- Code: `src/activitypub/` — `Group` actor JSON-LD for communities (with always-empty `inbox`/`outbox`; inbox deliveries get 405), enhanced WebFinger, NodeInfo 2.1
- XRPC endpoints registered: `linkApplication`, `unlinkApplication`, `listApplications`, `verifyMembership`
- Controlled by `ACTIVITYPUB_ENABLED` (default: enabled)
- `tests/api/activitypub-discovery.test.ts` walks Mastodon's discovery checks (WebFinger → actor → WebFinger back) and NodeInfo 2.1 schema constraints locally
- `tests/api/activitypub-interop.test.ts` has Fedify discover the community over HTTP (WebFinger, `Group` actor, RSA key, inbox/outbox, attachments), expands the actor with jsonld.js, and validates NodeInfo with Ajv against the vendored 2.1 schema; `AP_LIVE_TEST=1` repeats it read-only against production (no community there has linked applications yet). Not yet fetched by a running Mastodon instance
- The actor `url` and WebFinger profile-page link are the web UI's community page (`WEB_UI_URL`), omitted when unset

## Lexicons — **shipped**

- `@open-federation/lexicon` npm package, schema validation in CI, GitHub Pages docs
- Per-schema `revision` integer field; bump on input/output/error changes; CI validates

## Hardening — **shipped**

- Content-Security-Policy header on all responses
- Audit logging for all admin and security-relevant actions
- Async PBKDF2; OAuth pending-code Map cap; SSRF guard on peer health checks; expanded reserved handles; invite rate limiting
- Rate limits: global 120/min, auth 20/15min, registration 5/hr, community-create 10/hr, service-auth 60/min/DID, wallet-sign 60/min/IP
- Request body size: 256kb
- N+1 query elimination in list endpoints (SQL JOINs + batch display-field projection)
- XRPC input validation runs for all requests including unauthenticated

## SDK & developer adoption

- `@open-federation/sdk` — **shipped**: zero-dep, ESM + CJS + IIFE (`/sdk/v1.js`, ~2.5KB gzipped); auto-refresh tokens; localStorage / sessionStorage / memory backends; typed error classes; ATProto OAuth redirect support; `loginWithExternalSession`; `client.signInWithOpenFederation()` (tier-aware) + offline `verifySignInAssertion()`; `client.wallet.signTransaction` (tier-dispatched); `client.mountSignInButton(el, opts)` for zero-framework integrators
- `@open-federation/react` — **needs-validation** ([#79](https://github.com/athlon-misa/openfederation-pds/issues/79)): `<OpenFederationProvider>`, hooks, `<SignInWithOpenFederation>` component — coded but not verified working in a downstream consumer

## CLI & tooling — **shipped**

- CLI (`cli/pds-cli.ts`): login/logout/whoami, health/info, invite/user management, community ops, sessions, security diagnostics, oracle CRUD, password change, admin verification
- Configurable timeout (30s default); session creds at `.pds-cli/session.json` with restrictive perms

## Web UI — **shipped**

- Next.js 15 + shadcn/ui + Zustand + React Query v5 + kbar (port 3001)
- Ozone-style admin dashboard: sidebar shell, command palette, data tables (`@tanstack/react-table`)
- Pages: `/admin/{users,communities,invites,audit}`, `/communities`, `/explore`, `/settings`, `/(auth)/{login,register}`, `/callback`

## Email — **shipped**

- Nodemailer-based with SMTP transport; console fallback when `SMTP_HOST` unset

## Tests — **shipped**

- 63 test files; integration, unit, E2E, and security suites; XRPC output shape smoke tests validate handler/lexicon parity on every CI run

## Community Forum & Events — **shipped**

- **Forum threads** (`net.openfederation.forum.thread`) stored as ATProto records in the author's user repo; **posts** (`net.openfederation.forum.post`) likewise author-repo records linking back to the thread URI
- **Calendar events** (`community.lexicon.calendar.event`) stored in the community's own repo; **RSVPs** (`community.lexicon.calendar.rsvp`) stored in the attendee's user repo with `subject.uri` pointing to the event
- Aggregation index: `forum_threads` + `forum_posts` + `event_rsvps` tables built from write-path hooks; `backfillForumIndex()` (`scripts/backfill-forum-index.ts`) reconstructs the index from `records_index` without touching the repos — run via `npx tsx scripts/backfill-forum-index.ts`
- Moderation: `hidePost` / `hideThread` (soft-hide, index flag only, underlying record preserved), `deletePost` (author-only, full removal + signed commit). Gated by a dedicated `community.forum.moderate` permission, split from `community.forum.write` on 2026-07-03 after a scoping bug let ordinary members hide content they could merely post; `community.myCapabilities` reports the caller's resolved permission list so clients don't have to infer moderation UI from role names
- 11 XRPC endpoints: `createThread`, `createPost`, `getThread`, `listThreads`, `deletePost`, `hidePost`, `hideThread`, `calendar.createEvent`, `calendar.listEvents`, `calendar.rsvp`, `calendar.listRsvps`
- Private-community gating: as of 2026-07-10 (`831285b`), all four forum/calendar read endpoints 404 for outside callers — those who are neither the owner, a PDS admin, nor a member — matching the same guard used on the generic ATProto repo read endpoints (see Federation & ATProto compliance, below)
- No ActivityPub content federation — identity layer only; forum content stays on-PDS

### Importing from Discord (#86)

- `ofc community import discord` reads DiscordChatExporter JSON files on the organiser's machine (`cli/discord-export.ts`: strict, size-capped parsing; mapping) and sends batches to `net.openfederation.forum.importBatch` (owner or PDS admin; `src/forum/import.ts`). Dry run unless `--apply`. No Discord token anywhere.
- Mapping: channel → forum thread `#name` (tags `discord`, category); Discord thread → forum thread (tags `discord`, `#parent`); message → post with its original `createdAt`, reply link kept within a channel, `importedFrom { platform, channelId, messageId, author, editedAt, attachmentCount }`. The forum has no boards, so channels are threads. Bots' messages and private threads are skipped unless asked for; system messages always; direct-message exports refused. Attachments counted, never uploaded or linked.
- Written by the community in its own repo (signed with its key, no `author` field): nobody is impersonated, and a private community's history is gated like the rest of its repo. Authors are "Discord member N" per import unless `--keep-names`; the label ↔ Discord account mapping stays in a local checkpoint file (mode 0600). Discord user ids never reach the PDS.
- Idempotent: record keys are the Discord id's 63 bits written as a TID, so a re-sent batch creates nothing; the checkpoint lets an interrupted run resume without re-sending.
- `--invites`: one single-use PDS invite code per member (from `--members` CSV, else the imported authors) via `invite.create` with `count` (needs a PDS admin/moderator), written to a local CSV with links to `/register?invite=`. The PDS stores nothing linking a code to a Discord account unless `--invite-note` says so; joining the community after sign-up is the normal flow.
- Not yet: Slack, attachments (blob upload), a live bot import, community-scoped invite codes.

## Pseudonyms — **shipped**

Anonymous accounts the owner can reveal later, offline-verifiable. Design: `docs/superpowers/specs/2026-10-08-pseudonyms-design.md` (local, not committed).

- Anonymous creation with blind tokens (RSABSSA-SHA384-PSS-Randomized, one 2048-bit key per UTC month, current and previous epoch accepted): `getTokenKeys`, `collectTokens`, `createAccount`, plus `com.atproto.server.reserveSigningKey`. A pseudonym is an ordinary `did:plc` account and repo (`auth_type='pseudonym'`); the PDS cannot link it to its owner
- Phrase login (12-word BIP-39, owner key `m/1984'/0'`): `getLoginChallenge` + `createSession`; refused for all email/password/recovery flows
- Reveal: `signLink` (owner half of a dual-signed link) and record lexicons `net.openfederation.pseudonym.link`, `net.openfederation.authorship.claim`; modes are public (link record in both repos), private file (reveal bundle) and in person (presence signature)
- Offline verifier + `ofc pseudonym verify | presence-challenge | verify-presence`; client library `@open-federation/pseudonym` (`packages/openfederation-pseudonym`)
- Privacy: no audit entries for pseudonyms (`auditLog()` drops them); no timestamps on token issuance, redemption, reserved keys or challenges; no IP stored in disclosure audit for pseudonym requesters
- Abuse control: per-person limit only via tokens (`PSEUDONYM_TOKENS_PER_EPOCH`); per-pseudonym write probation (`PSEUDONYM_PROBATION_DAYS`, `PSEUDONYM_PROBATION_DAILY_WRITES`, in memory)
- Migration: `scripts/migrate-041-pseudonyms.sql`

Known limits (accepted for v1):

- **The owner's root signature is produced by the PDS** (root keys are custodial), so the PDS sees each link at signing time. It stores and logs nothing about it.
- **A valid reveal proves the owner's PDS signed, not that the owner consented.** Owner root keys are custodial, so the PDS operator (or anyone holding the database and `KEY_ENCRYPTION_SECRET`) can create a pseudonym whose genesis commits to any local account V and have `signLink` sign the link with V's key. The resulting bundle passes every check, including the online one. `ofc pseudonym verify` therefore reports VALID as "V's PDS-held key signed this link and the genesis commits to V", not as proof of consent. A non-custodial owner key (held on the owner's device) would close this; it is not part of v1.
- **An offline check cannot rule out framing.** Offline, the bundle's owner signing key is not tied to the owner's DID. Someone could commit a new pseudonym to a victim's DID using their own key. Only the online check (resolving the owner's DID) gives a full verdict. Offline, the verifier reports the owner key as unchecked, and the CLI says so and exits with code 2. Presence checks take the pseudonym's key from its genesis operation (a file, or fetched from PLC), never from the person being checked.
- **The verifier trusts only the genesis rotation key.** Key rotation needs audit-log verification, which comes later.
- **The commitment entry marks a DID as an OpenFederation pseudonym.** Follow-up: give all new accounts a decoy commitment.
- **Request-level logs outside this codebase** (hosting provider, reverse proxy, CDN) are the operator's responsibility. Self-hosting documentation must say so.
- **Per-person limits come only from tokens.** One approved account can create at most 20 pseudonyms a month. Abuse is then handled per pseudonym (probation, moderation).
- **Lost tokens** (for example after reinstalling the app) are replaced only at the next epoch.
- **PLC acceptance of the URN must be confirmed.** The `@did-plc/lib` schema accepts any strings in `alsoKnownAs`. The E2E test confirms this against the local directory.

## Community & account migration/portability — **pseudonyms, user accounts and communities can move between PDSes**

- Export primitives: `net.openfederation.community.export` (owner/admin) and `net.openfederation.account.export` (self/admin/mod) produce JSON archives; `com.atproto.sync.getRepo` produces a CAR stream. The current account-export moderator authority is tracked as a security issue and must not be treated as the intended final authorization model.
- **Account migration (#250), standard AT Protocol endpoints:** `com.atproto.server.createAccount` with an existing DID (proof by a JWT signed with a PLC rotation key; the account opens deactivated), `com.atproto.repo.importRepo` (CAR verified against the DID's current atproto key, stored in one transaction), `com.atproto.sync.listBlobs` / `com.atproto.repo.listMissingBlobs` / `uploadBlob` for blobs, `checkAccountStatus`, `getRecommendedDidCredentials`, and `activateAccount` once the DID points here. `moveAccount` in `@open-federation/pseudonym` runs a full move; covered by a two-PDS E2E test (`tests/e2e/account-migration.e2e.test.ts`).
- Pseudonyms and user accounts can move (#266: service auth from the old PDS, custodial rotation key made here, `requestPlcOperationSignature` / `signPlcOperation` / `submitPlcOperation` on the old side; the client flow is `tests/e2e/custodial-move.ts`, with no web UI screen for it yet). The gate (`MIGRATION_ACCOUNTS`, `MIGRATION_PSEUDONYMS`), limited sessions for deactivated accounts, activation only where the DID points, moving back, and the conservative clean-up sweep are in (#265). Communities move too (#267, [ADR-002](adr/ADR-002-community-migration.md)): `community.migrateIn` pulls the repository from the DID's current home and rebuilds the member and attestation indexes, the owner (by DID, on any PDS) points the DID here and activates, and the old home hands the private attestations' keys over sealed to the new signing key; the client flow is `tests/e2e/community-move.ts`. Communities carry no blobs today, so nothing is copied for them. The dashboard moves an account (Settings → Move account) or a community (its Move tab) with these flows (#268). The copy left behind by a move stays as a backup until its owner deletes it (`com.atproto.server.deleteAccount`, or `community.delete` through service auth) or an admin does (#269).
- `net.openfederation.admin.importRepo` verifies the CAR and writes it atomically using the same code as `importRepo` (#262), for a DID that has no repo here yet (409 otherwise). It does not register an account or update the DID.
- Not built: cross-platform import from Discord, Slack, or equivalent platforms; tracked separately in [#86](https://github.com/athlon-misa/openfederation-pds/issues/86).

---

## Parked

- **Blob storage** ([#82](https://github.com/athlon-misa/openfederation-pds/issues/82)): `com.atproto.repo.uploadBlob` + S3/R2 backend; deferred until downstream consumers need self-hosted images
- **Email verification** ([#83](https://github.com/athlon-misa/openfederation-pds/issues/83)): `confirmEmail` + `requestEmailConfirmation`; deferred until open registration or compliance requirements
