# API Endpoints

Reference index of all XRPC endpoints exposed by the PDS. Lexicon JSONs in `src/lexicon/` are the source of truth; this file is a navigable summary.

## ATProto Standard

| Method | NSID | Auth | Description |
|:---|:---|:---|:---|
| POST | `com.atproto.server.createSession` | No | Login (returns access + refresh tokens) |
| POST | `com.atproto.server.reserveSigningKey` | No | Reserve a repo signing key to name in a PLC genesis op before creating an account (rate limit: create) |
| POST | `com.atproto.server.refreshSession` | Yes | Rotate refresh token (reuse detection) |
| GET  | `com.atproto.server.getSession` | Yes | Get current session info |
| POST | `com.atproto.server.deleteSession` | Yes | Logout / invalidate session |
| GET  | `com.atproto.server.getServiceAuth` | Yes | Mint short-lived ES256K JWT signed by the caller's atproto key for outbound cross-PDS auth |
| GET  | `com.atproto.identity.resolveHandle` | No | Standard AT Protocol handle → DID resolution. Accepts bare or suffixed handles; looks up users, falls back to communities. |
| GET  | `com.atproto.repo.getRecord` | No | Fetch a single record from a repo |
| POST | `com.atproto.repo.putRecord` | Yes | Write a record (real MST signed commit) |
| POST | `com.atproto.repo.createRecord` | Yes | Create a record with auto-generated TID rkey |
| POST | `com.atproto.repo.deleteRecord` | Yes | Delete a record (signed commit) |
| GET  | `com.atproto.repo.describeRepo` | No | Repo metadata and collections |
| GET  | `com.atproto.repo.listRecords` | No | Paginated record listing |
| GET  | `com.atproto.sync.getRepo` | No | Full repo as CAR stream (federation-critical) |
| POST | `com.atproto.admin.updateSubjectStatus` | Admin | Suspend/unsuspend or takedown/reverse-takedown a user by DID |
| GET  | `com.atproto.admin.getSubjectStatus` | Admin | Check takedown/deactivation status of an account by DID |
| POST | `com.atproto.admin.deleteAccount` | Admin | Permanently delete a user account and all repo data |
| POST | `com.atproto.server.deactivateAccount` | Yes | User deactivates own account (self-service) |
| POST | `com.atproto.server.activateAccount` | Yes | User reactivates own account after deactivation |

## OpenFederation Account Management

| Method | NSID | Auth | Description |
|:---|:---|:---|:---|
| POST | `net.openfederation.account.register` | No | Register (invite required) |
| GET  | `net.openfederation.account.listPending` | Admin/Mod | List pending registrations |
| POST | `net.openfederation.account.approve` | Admin/Mod | Approve a pending user |
| POST | `net.openfederation.account.reject` | Admin/Mod | Reject a pending user |
| GET  | `net.openfederation.account.list` | Admin/Mod | List all accounts with search/filter |
| GET  | `net.openfederation.account.export` | Self/Admin/Mod | Export user repo data as JSON (AT Protocol "free to go") |
| POST | `net.openfederation.account.updateRoles` | Admin | Add or remove PDS roles for a user |
| POST | `net.openfederation.account.updateProfile` | Yes | Update standard or custom profile collection |
| GET  | `net.openfederation.account.getProfile` | No | Get user profile (standard + custom collections) |
| POST | `net.openfederation.invite.create` | Admin/Mod | Create an invite code |
| GET  | `net.openfederation.invite.list` | Admin/Mod | List invite codes with status filter |

## OpenFederation Session Management

| Method | NSID | Auth | Description |
|:---|:---|:---|:---|
| GET | `net.openfederation.account.listSessions` | Yes | List active sessions (admin can query by DID) |
| POST | `net.openfederation.account.revokeSession` | Yes | Revoke session by ID or revoke all |
| POST | `net.openfederation.account.requestPasswordReset` | No | Request password reset email |
| POST | `net.openfederation.account.confirmPasswordReset` | No | Confirm reset with token + new password |
| GET  | `net.openfederation.account.getSecurityLevel` | Yes | Get recovery tier and security checklist |
| POST | `net.openfederation.account.initiateRecovery` | No | Start identity recovery (email-based) |
| POST | `net.openfederation.account.completeRecovery` | No | Complete recovery with token + new password |

## OpenFederation Community Management

| Method | NSID | Auth | Description |
|:---|:---|:---|:---|
| POST | `net.openfederation.community.create` | Approved | Create a new community |
| GET  | `net.openfederation.community.get` | No | Get community details (auth optional for membership info) |
| GET  | `net.openfederation.community.listAll` | Yes | List public communities (or all for admin) |
| GET  | `net.openfederation.community.listMine` | Yes | List communities user belongs to |
| POST | `net.openfederation.community.update` | Owner | Update community settings |
| POST | `net.openfederation.community.join` | Approved | Join or request to join a community |
| POST | `net.openfederation.community.leave` | Member | Leave a community |
| POST | `net.openfederation.community.removeMember` | Owner/Admin | Remove (kick) a member |
| POST | `net.openfederation.community.delete` | Owner/Admin | Delete a community and all its data |
| GET  | `net.openfederation.community.listMembers` | Yes | List community members (members include `displayName` and `avatarUrl` from write-time projection) |
| GET  | `net.openfederation.community.listJoinRequests` | Owner/Admin | List pending join requests |
| POST | `net.openfederation.community.resolveJoinRequest` | Owner/Admin | Approve or reject a join request |
| GET  | `net.openfederation.community.export` | Owner/Admin | Export community data as JSON archive |
| POST | `net.openfederation.community.suspend` | Admin | Suspend a community |
| POST | `net.openfederation.community.unsuspend` | Admin | Unsuspend a community |
| POST | `net.openfederation.community.takedown` | Admin | Take down a community (requires prior export) |
| POST | `net.openfederation.community.updateMember` | Owner/Admin | Partial update of member record: role, kind, tags, attributes (any subset). Renamed from updateMemberRole to support semantic classification (#50). |
| POST | `net.openfederation.community.issueAttestation` | Owner/Mod | Issue a signed attestation for a member |
| POST | `net.openfederation.community.deleteAttestation` | Owner/Mod | Revoke an attestation (delete-as-revoke) |
| GET  | `net.openfederation.community.listAttestations` | No | List attestations by community/subject/type (items include `subjectDisplayName` and `subjectAvatarUrl`) |
| GET  | `net.openfederation.community.verifyAttestation` | No | Verify an attestation exists (record existence = validity) |
| POST | `net.openfederation.attestation.requestDisclosure` | Yes | Request disclosure of a private attestation (policy-based) |
| POST | `net.openfederation.attestation.createViewingGrant` | Yes | Create time-limited viewing grant (subject-only) |
| GET  | `net.openfederation.attestation.verifyCommitment` | No | Verify commitment hash without revealing content |

## OpenFederation Disclosure Proxy

| Method | NSID | Auth | Description |
|:---|:---|:---|:---|
| POST | `net.openfederation.disclosure.redeemGrant` | Yes | Redeem viewing grant (decrypt + watermark + re-encrypt) |
| GET  | `net.openfederation.disclosure.grantStatus` | Yes | Check grant status and access count |
| POST | `net.openfederation.disclosure.revokeGrant` | Yes | Revoke a viewing grant early (subject-only) |
| GET  | `net.openfederation.disclosure.auditLog` | Yes | View disclosure audit trail |

## OpenFederation Oracle Management

| Method | NSID | Auth | Description |
|:---|:---|:---|:---|
| POST | `net.openfederation.oracle.createCredential` | Admin | Create Oracle credential for a community |
| GET | `net.openfederation.oracle.listCredentials` | Admin | List Oracle credentials |
| POST | `net.openfederation.oracle.revokeCredential` | Admin | Revoke an Oracle credential |
| POST | `net.openfederation.oracle.submitProof` | Oracle | Submit governance proof for on-chain verification |

## OpenFederation Vault

| Method | NSID | Auth | Description |
|:---|:---|:---|:---|
| POST | `net.openfederation.vault.requestShareRelease` | Yes | Release vault share after identity verification |
| POST | `net.openfederation.vault.registerEscrow` | Yes | Register external escrow provider for Share 3 |
| POST | `net.openfederation.vault.exportRecoveryKey` | Yes | Export vault share for self-custody (elevated verification) |
| GET  | `net.openfederation.vault.auditLog` | Yes | View vault audit log entries |
| POST | `net.openfederation.vault.storeCustodialSecret` | Yes | Store opaque encrypted blob (e.g. wallet mnemonic) per chain; upsert |
| GET  | `net.openfederation.vault.getCustodialSecret` | Yes | Retrieve encrypted blob for a given chain |

## OpenFederation Identity Bridge

| Method | NSID | Auth | Description |
|:---|:---|:---|:---|
| POST | `net.openfederation.identity.setExternalKey` | Yes | Store an external public key (Ed25519, X25519, secp256k1, P256) |
| GET  | `net.openfederation.identity.listExternalKeys` | No | List external keys for a DID (bridge-readable) |
| GET  | `net.openfederation.identity.getExternalKey` | No | Get a specific external key by DID + rkey |
| POST | `net.openfederation.identity.deleteExternalKey` | Yes | Delete an external key (revocation) |
| GET  | `net.openfederation.identity.resolveByKey` | No | Reverse lookup: find ATProto DID by external public key |
| GET  | `net.openfederation.identity.getWalletLinkChallenge` | Yes | Generate challenge for wallet linking |
| POST | `net.openfederation.identity.linkWallet` | Yes | Link wallet with signed challenge |
| POST | `net.openfederation.identity.unlinkWallet` | Yes | Unlink a wallet by label |
| GET  | `net.openfederation.identity.listWalletLinks` | Yes | List user's linked wallets |
| GET  | `net.openfederation.identity.resolveWallet` | No | Reverse lookup: find ATProto DID by wallet address |
| POST | `net.openfederation.identity.signInChallenge` | Yes | Issue a canonical CAIP-122 message for SIWOF (dApp scoped by audience, 5-min TTL) |
| POST | `net.openfederation.identity.signInAssert` | Yes | Verify wallet signature + mint didToken (atproto-signed JWT) + walletProof; both are offline-verifiable by dApps |
| GET  | `net.openfederation.identity.getPrimaryWallet` | No | Public DID→wallet resolver; returns `{did, walletAddress, custodyTier, proof?}` where `proof` is a service-auth JWT |
| GET  | `net.openfederation.identity.listWalletsPublic` | No | All active wallet links for a DID (public fields only, primaries first) |
| POST | `net.openfederation.identity.setPrimaryWallet` | Yes | Mark one of caller's wallets as primary on its chain (one primary per chain, atomic swap) |
| GET  | `net.openfederation.identity.getDidAugmentation` | No | W3C DID-Core verificationMethod + assertionMethod entries derived from the DID's linked wallets (CAIP-10 blockchainAccountId) |
| POST | `net.openfederation.wallet.retrieveForUpgrade` | Yes | One-shot plaintext export of a Tier 1 wallet's private key; password re-auth required |
| POST | `net.openfederation.wallet.finalizeTierChange` | Yes | Atomic tier swap: drops old custody, optionally stores new encrypted blob, revokes consents, updates `custody_tier`. Supports 1→2, 1→3, 2→3 |

## OpenFederation Progressive-Custody Wallets

| Method | NSID | Auth | Description |
|:---|:---|:---|:---|
| POST | `net.openfederation.wallet.provision` | Yes | Tier 1 only: PDS generates a wallet, encrypts the key at rest, links the address to the caller's DID |
| POST | `net.openfederation.wallet.sign` | Yes | Tier 1 only: sign a message with a custodial wallet; requires `X-dApp-Origin` header or body `dappOrigin` and an active consent grant |
| POST | `net.openfederation.wallet.signTransaction` | Yes | Tier 1 only: sign an EVM transaction (returns signed RLP) or Solana message bytes (returns base58 signature); same consent + tier gate as `wallet.sign` |
| POST | `net.openfederation.wallet.grantConsent` | Yes | Grant a dApp origin time-bounded permission to sign with Tier 1 wallet(s); default 7-day TTL, max 30-day |
| POST | `net.openfederation.wallet.revokeConsent` | Yes | Revoke consent by id or by (dappOrigin, chain?, walletAddress?) scope |
| GET  | `net.openfederation.wallet.listConsents` | Yes | List the caller's active (unrevoked, unexpired) Tier 1 signing consents |

## OpenFederation Partner API

| Method | NSID | Auth | Description |
|:---|:---|:---|:---|
| POST | `net.openfederation.partner.register` | X-Partner-Key | Register user (no invite, auto-approved, returns tokens) |
| POST | `net.openfederation.partner.createKey` | Admin | Generate a new partner API key (shown once) |
| GET  | `net.openfederation.partner.listKeys` | Admin | List all partner keys with stats |
| POST | `net.openfederation.partner.revokeKey` | Admin | Revoke a partner key |

## OpenFederation Admin

| Method | NSID | Auth | Description |
|:---|:---|:---|:---|
| GET  | `net.openfederation.audit.list` | Admin | List audit log entries with filters |
| GET  | `net.openfederation.server.getConfig` | Admin | Get server config and stats |
| POST | `net.openfederation.admin.createVerificationChallenge` | Admin | Send identity verification nonce to user |
| POST | `net.openfederation.admin.verifyChallenge` | Admin | Verify nonce response from user |
| POST | `net.openfederation.admin.importRepo` | Admin | Restore a repository from a CAR backup (`?did=`, body `application/vnd.ipld.car`, at most 100 MB) for a DID with no repo here. Verified like `com.atproto.repo.importRepo` (DID, signature against the DID's current atproto key, complete record tree) and stored in one transaction. Output `{ did, rootCid, blockCount, recordCount }`. Errors: `InvalidRequest`, `RepoAlreadyExists` (409), `InvalidCar`, `DidMismatch`, `UnresolvableDid`, `InvalidSignature`, `InvalidRepo`, `PayloadTooLarge` (413) |

## OpenFederation Contact Graph

| Method | NSID | Auth | Description |
|:---|:---|:---|:---|
| POST | `net.openfederation.contact.sendRequest` | Yes | Send a contact request; 409 if pending or already contacts |
| POST | `net.openfederation.contact.respondToRequest` | Yes | Accept or reject an incoming request (accept creates contact records on both repos) |
| POST | `net.openfederation.contact.removeContact` | Yes | Remove an accepted contact (cooperatively removes from counterpart's repo) |
| GET  | `net.openfederation.contact.list` | Yes | List the caller's accepted contacts, paginated |
| GET  | `net.openfederation.contact.listIncomingRequests` | Yes | List pending requests addressed to the caller |
| GET  | `net.openfederation.contact.listOutgoingRequests` | Yes | List pending requests sent by the caller |

## OpenFederation Forum & Events

Forum threads and posts are stored as ATProto records in the **author's** user repo (`net.openfederation.forum.thread` / `net.openfederation.forum.post`). Calendar events are stored in the **community's** repo (`community.lexicon.calendar.event`); RSVPs are stored in the **attendee's** user repo. All four collections are aggregated into index tables (`forum_threads`, `forum_posts`, `event_rsvps`) for efficient reads. Use `scripts/backfill-forum-index.ts` to rebuild the index from `records_index`.

Reads are visibility-gated for private communities: `getThread`, `listThreads`, `calendar.listEvents`, and `calendar.listRsvps` all 404 for outside callers — those who are neither the owner, a PDS admin, nor a member (`requireCommunityReadable`, since `831285b`, 2026-07-10). "No" in the Auth column below means no auth is *required*, not that the endpoint is unconditionally public — the community's own visibility still applies.

Moderation (`hidePost`/`hideThread`) requires the dedicated `community.forum.moderate` permission, distinct from `community.forum.write` since 2026-07-03 — a member who can post is not automatically able to hide content.

| Method | NSID | Auth | Description |
|:---|:---|:---|:---|
| POST | `net.openfederation.forum.createThread` | Member | Create a new forum thread in a community; stores record in author's repo |
| POST | `net.openfederation.forum.createPost` | Member | Reply to a thread (or a specific post); stores record in author's repo |
| GET  | `net.openfederation.forum.getThread` | No* | Get thread metadata plus replies (moderators also see hidden ones), paginated |
| GET  | `net.openfederation.forum.listThreads` | No* | List threads for a community (moderators also see hidden ones), ordered by recent activity |
| POST | `net.openfederation.forum.deletePost` | Author only | Delete the caller's own post record and decrement thread post count |
| POST | `net.openfederation.forum.hidePost` | Mod (`community.forum.moderate`) | Soft-hide an individual post via index flag; underlying record is preserved |
| POST | `net.openfederation.forum.hideThread` | Mod (`community.forum.moderate`) | Soft-hide a thread via index flag; underlying record is preserved |
| POST | `net.openfederation.calendar.createEvent` | Member | Create a calendar event; stores record in the community's repo |
| GET  | `net.openfederation.calendar.listEvents` | No* | List calendar events for a community |
| POST | `net.openfederation.calendar.rsvp` | Member | Submit or update an RSVP for a calendar event |
| GET  | `net.openfederation.calendar.listRsvps` | No* | List RSVPs for an event with per-status counts |

\* Gated by community visibility — see note above.

## OpenFederation Pseudonyms

Anonymous accounts that the owner can later reveal. The PDS never stores or logs which account owns a pseudonym. Design: `docs/superpowers/specs/2026-10-08-pseudonyms-design.md`; client library: `packages/openfederation-pseudonym`. Pseudonym endpoints write no `audit_log` entries, and pseudonym accounts are refused (indistinguishably) by email, password and recovery flows. Pseudonyms are ordinary `did:plc` accounts with `auth_type='pseudonym'`.

| Method | NSID | Auth | Rate limit | Description |
|:---|:---|:---|:---|:---|
| GET  | `net.openfederation.pseudonym.getTokenKeys` | No | discovery | Public blind-signature keys: `{ keys: [{ epoch, publicKey }] }` for the current and previous epoch (`YYYY-MM`, UTC). Fetch without credentials. |
| POST | `net.openfederation.pseudonym.collectTokens` | Approved local account | create | Input `{ epoch, blindedMessages[] }` (epoch = current UTC month; exactly `PSEUDONYM_TOKENS_PER_EPOCH` base64url strings). Output `{ epoch, blindSignatures[] }`. Errors: `WrongEpoch`, `AlreadyCollected` (409, one batch per epoch), `Forbidden` (pseudonym, external or service-auth callers), `InvalidRequest`. |
| POST | `com.atproto.server.reserveSigningKey` | No | create | Input `{ did? }`. Output `{ signingKey }` (a secp256k1 `did:key`). The caller names it as `verificationMethods.atproto` in its own genesis op; the key is consumed by `createAccount`. With `did` (account migration) the reservation is bound to that DID, replaces any earlier one for it, and is consumed by `com.atproto.server.createAccount`; without it the reservation stays anonymous. |
| POST | `net.openfederation.pseudonym.createAccount` | Anonymous (creation token) | create | Input `{ did, token }`. The PDS reads the DID's PLC log, checks the genesis op (exactly one op, this PDS as endpoint, handle under the handle suffix, reserved signing key, pseudonym commitment) and spends the token. Output (201) `{ did, handle, status: 'approved' }`. Errors: `InvalidRequest`, `InvalidToken`, `TokenSpent`, `InvalidGenesis`, `SigningKeyNotReserved`, `AlreadyExists` (409). |
| POST | `net.openfederation.pseudonym.getLoginChallenge` | No | auth | Input `{ ownerKey }` (secp256k1 `did:key`). Output `{ challengeId, challenge, serviceDid }`. Always issues a challenge, so it does not reveal which keys have accounts. Challenges expire after 5 minutes and are deleted when used. |
| POST | `net.openfederation.pseudonym.createSession` | No | auth | Input `{ challengeId, signature }` (owner-key signature over the login message). Output `{ did, handle, accessJwt, refreshJwt, active }`. Errors: `Unauthorized` (every bad credential, indistinguishably), `AccountNotActive` (403). |
| POST | `net.openfederation.pseudonym.signLink` | Yes (local account) | create | Input `{ statement }` (canonical link statement). Output `{ ownerDid, sig, signingKey }`: the owner's signature made with the caller's repo key. Errors: `InvalidStatement`, `Forbidden` (statement names another owner; pseudonym, external or service-auth callers). The PDS sees the link while signing and keeps nothing. **Custodial key:** the PDS holds the owner's signing key, so a link signed here proves the PDS signed it, not that the person consented; the operator (or anyone with the database and `KEY_ENCRYPTION_SECRET`) could create a pseudonym committing to any local account and sign a link for it. |

Record types (stored in repos only when the owner chooses to publish):

| Collection | Description |
|:---|:---|
| `net.openfederation.pseudonym.link` | Dual-signed link between a pseudonym and its owner: `statement`, `pseudonymSig`, `ownerSig`, `ownerSigningKey`, `commitmentSalt`, `genesisOp`, `createdAt`. Published to both repos on a public reveal. |
| `net.openfederation.authorship.claim` | Claim of authorship over content: `contentHash` (SHA-256, 64 lowercase hex), optional `url`, `title`, `publishedAt`, `createdAt`. |

Changed behavior on existing endpoints:

- `NoEmail` (400): `com.atproto.server.confirmEmail`, `com.atproto.server.requestEmailConfirmation` and `net.openfederation.admin.createVerificationChallenge` return it for accounts without an email address (pseudonyms).
- `ProbationLimit` (429): `com.atproto.repo.createRecord`, `putRecord`, `uploadBlob`, `net.openfederation.forum.createThread`, `forum.createPost` and `calendar.createEvent` return it when a pseudonym still in probation exceeds its daily write cap.

Environment variables:

| Variable | Default | Notes |
|:---|:---|:---|
| `PSEUDONYM_TOKENS_PER_EPOCH` | 20 | Creation tokens each approved account can collect per month; also the exact batch size `collectTokens` accepts |
| `PSEUDONYM_PROBATION_DAYS` | 7 | Days a new pseudonym is write-limited; `0` disables probation |
| `PSEUDONYM_PROBATION_DAILY_WRITES` | 20 | Writes per day while on probation. Counters live in memory only and reset on restart |

## Account migration

Moving an account to this PDS from another one, following AT Protocol account migration: open the account here (deactivated), import the repository, copy blobs, point the DID at this PDS, then activate. Built in slices (#250). Pseudonyms move with their own key; user accounts move with the old PDS's help (#266); communities move with the owner's rotation key (#267, [ADR-002](adr/ADR-002-community-migration.md)).

**Nobody is locked out, nothing is lost (#265).** A deactivated account keeps a session: `createSession`, `net.openfederation.pseudonym.createSession` and `refreshSession` all work and return `active: false, status: 'deactivated'`. That session reaches only the endpoints marked *while deactivated* (status, import, blobs, credentials, activate, deactivate, session and read endpoints, `account.export`); everything else answers `AccountDeactivated` (403). An account is switched on only where its DID points, so one DID never has two live homes, and a copy left behind by a move is switched on again simply by pointing the DID back: `moveAccount` to a PDS that still holds the old copy signs in to it, refills it from the current home and activates it. Nothing is deleted while a DID points at this PDS. The only automatic clean-up removes copies that never activated here and whose DID named another PDS on two sweeps in a row, `MIGRATION_CLEANUP_DAYS` apart (sweeps never run at start-up; `0` disables). It keeps a flag, not a timestamp, and does nothing when the PLC directory is unreachable. The copy left behind by a move away is never swept.

**Communities.** Ownership is by DID (`communities.owner_did`), so an owner whose account lives on another PDS administers the community through cross-PDS service auth. A community that moved away has `status = 'moved'`: reads keep working, every write answers `CommunityMoved` (403), `listAll` hides it, and it is never deleted automatically; one still arriving answers `CommunityImporting`. The weekly sweep also marks communities whose DID now names another PDS. `net.openfederation.community.transfer` is gone; the dashboard's Transfer action with it (a Move screen is a follow-up).

**The gate.** `MIGRATION_ACCOUNTS` (`open` / `invite` / `closed`, default `invite`) applies to user accounts, `MIGRATION_PSEUDONYMS` (`open` / `token` / `closed`, default `open`) to pseudonyms; both appear in `net.openfederation.server.getPublicConfig` as `migration`. A refusal happens at `createAccount`, before anything has changed anywhere. Pseudonyms are never asked for an invite code, because a code can say who handed it out; `token` spends a blind creation token in the same transaction, so this PDS learns only that a pass was used, not whose. `moveAccount` in `@open-federation/pseudonym` runs the whole move for a pseudonym.

| Method | NSID | Auth | Rate limit | Description |
|:---|:---|:---|:---|:---|
| POST | `com.atproto.server.createAccount` | Proof JWT or service auth (see description) | create | Imports an existing DID; new accounts use `net.openfederation.account.register`. Input `{ did, handle }`: `handle` must end with this PDS's handle suffix. **User accounts** (revision 3): the Bearer token is service auth minted by the old PDS (`com.atproto.server.getServiceAuth` with `aud` = this PDS's service DID and `lxm = com.atproto.server.createAccount`), the body also carries `email`, `password` and, under `MIGRATION_ACCOUNTS=invite`, `inviteCode`. This PDS makes a rotation key for the account, splits it 2-of-3 like at sign-up, keeps shares 2 and 3 in the vault and returns share 1 as `rotationDeviceShare`; the public key is what `getRecommendedDidCredentials` recommends. The password works at once for the limited session. Audited as `account.migrateIn`. **Pseudonyms**: Optional `token` (revision 2): a blind creation token, required for a pseudonym when `MIGRATION_PSEUDONYMS=token`, ignored otherwise. Proof of control: a Bearer JWT shaped like service auth (`iss` = `did`, `aud` = this PDS's service DID, `lxm` = `com.atproto.server.createAccount`, short `exp`, single use) signed by one of the DID's current PLC rotation keys; for a pseudonym that is the owner key, so the old PDS does not have to help. Opens the account **deactivated** with an empty repo signed by the key reserved for the DID (or a fresh one) and returns `{ did, handle, accessJwt, refreshJwt }`. Only pseudonyms are accepted so far. No audit for pseudonyms. Errors: `InvalidRequest` (no `did`), `UnresolvableDid`, `UnsupportedDomain`, `InvalidHandle`, `HandleNotAvailable`, `IncompatibleDidDoc` (not a pseudonym, or service auth from the old PDS), `AuthRequired`/`InvalidToken` (401), `AlreadyExists` (409), `MigrationNotAllowed` (403, policy `closed`), `InvalidToken`/`TokenSpent` (400, policy `token`), `InvalidPassword`, `InvalidInviteCode`, `InviteInvalid`/`InviteExpired`/`InviteUsed`/`InviteBound` (403). |
| GET | `com.atproto.server.checkAccountStatus` | Yes (own account, also while deactivated) | — | Output `{ activated, validDid, repoCommit, repoRev, repoBlocks, indexedRecords, privateStateValues, expectedBlobs, importedBlobs }`. `validDid` is true once the DID's PLC state names this PDS as `atproto_pds` and this PDS's key as `atproto`. `expectedBlobs` counts the distinct blobs the account's records reference; `importedBlobs` how many of them this PDS holds for it. |
| POST | `com.atproto.repo.importRepo` | Yes (the account itself, deactivated) | create | Body: the CAR exported by the old PDS (`application/vnd.ipld.car`, at most 100 MB). Fully verified before anything is stored: the commit names this account's DID, is signed by the DID's **current** atproto key (the old PDS's key until the DID is pointed here, which is why import comes before the PLC update), and the record tree is complete. Replaces the account's repository in one transaction, so it can be repeated. Errors: `InvalidCar`, `DidMismatch`, `UnresolvableDid`, `InvalidSignature`, `InvalidRepo`, `PayloadTooLarge` (413), `Forbidden` (not deactivated, or service auth). A copy left behind by a move uses it to catch up before moving back. |
| GET | `com.atproto.repo.listMissingBlobs` | Yes (own account, also while deactivated) | — | Params `limit` (1–1000, default 500), `cursor`. Output `{ blobs: [{ cid, recordUri }], cursor? }`: blobs the account's records reference that this PDS holds no copy of, in CID order, each with one record that references it. |
| POST | `com.atproto.repo.uploadBlob` | Yes | — | Also allowed for an account that is moving here and not yet activated, to copy its blobs; those uploads skip pseudonym probation. |
| GET | `com.atproto.sync.listBlobs` | No (private community repos gated like `getRepo`) | — | Params `did`, `since` (accepted and ignored: the full list is returned), `limit` (1–1000, default 500), `cursor`. Output `{ cids, cursor? }`: the blob CIDs the repo's records reference, in CID order. Unreferenced uploads are not listed. Error `RepoNotFound`. The old PDS side of a move. |
| GET | `com.atproto.identity.getRecommendedDidCredentials` | Yes (the account itself, also while deactivated) | — | What the account should put in its DID to live here: `{ alsoKnownAs: ['at://<handle here>'], verificationMethods: { atproto: <this PDS's key for it> }, services: { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint } } }`. `rotationKeys: [<this PDS's custodial key>]` for a user account (revision 2); none for a pseudonym, which keeps its own. |
| POST | `com.atproto.identity.requestPlcOperationSignature` | Yes (user account whose rotation key this PDS holds) | create | The old PDS's side of a user move (#266): emails a one-time code (15 minutes). Errors `NotCustodial` (pseudonym, external, or no vault shares), `NoEmail`, `EmailDeliveryFailed` (502). Audited. |
| POST | `com.atproto.identity.signPlcOperation` | Yes (same) | create | Input `{ token, password, rotationKeys?, alsoKnownAs?, verificationMethods?, services? }`: the DID's current PLC state with the given fields replaced, signed with the rotation key this PDS holds. Two checks before signing, the emailed code and the password (the password is this PDS's addition to the standard shape). The key is rebuilt from its Shamir shares for the call and wiped. Output `{ operation }`. The client checks the new PDS holds everything (`checkAccountStatus`) before asking; this PDS checks the operation keeps at least one rotation key and a PDS endpoint. Errors `NotCustodial`, `InvalidToken` (missing, wrong, used or expired code), `AuthenticationRequired` (401, wrong password), `InvalidRequest`. Audited, including refusals. |
| POST | `com.atproto.identity.submitPlcOperation` | Yes | create | Input `{ operation }`: a signed operation that continues the caller's DID's current chain (`prev` must be the current operation's CID); posted to the PLC directory. Errors `InvalidRequest`, `PlcRejected`. |
| POST | `net.openfederation.community.migrateIn` | Proof JWT (see description) | create | A community arrives here. Input `{ did, handle, inviteCode? }`; proof: a Bearer JWT signed by one of the community's PLC rotation keys (`iss` = the community DID, `sub` = the owner's DID, `aud` = this PDS's service DID, `lxm` = this method, short-lived). Gate `MIGRATION_COMMUNITIES` (`open` / `invite` / `closed`, default `invite`). This PDS makes fresh signing and recovery keys, **pulls** the repository from wherever the DID currently points (verified against the DID's current signing key, stored in one transaction), rebuilds `members_unique` and the attestation index from the records, and pulls every referenced blob. The community sits in `importing` until activated; a second call refreshes the copy. Output: counts plus `recommended`, what to put in the DID (`rotationKeys: [the owner's key, this PDS's recovery key]`, signing key, endpoint, handle). Errors: the gate and invite errors, `AuthRequired`/`InvalidToken`, `IncompatibleDidDoc` (the DID already points here), `AlreadyExists`, `Forbidden` (the copy here belongs to another owner), the import errors, `UpstreamFailure`. |
| GET | `net.openfederation.community.checkMigration` | No | — | Param `did`. Output `{ status, validDid, repoCommit, repoRev, indexedRecords, members, attestations, expectedBlobs, importedBlobs, missingAttestationKeys, recommended? }`. |
| POST | `net.openfederation.community.activate` | Owner (local session or cross-PDS service auth) | create | Input `{ did }`. Switches the community on once the DID names this PDS and its signing key (`IncompatibleDidDoc` otherwise). Fetches the attestation keys from the old home (`getMovedKeys`) and re-wraps them under this PDS's secret; if the old home does not answer the community still activates and the call can be repeated while `missingAttestationKeys > 0`. |
| GET | `net.openfederation.community.getMovedKeys` | No | create | Param `did`. The old home's side: once the PLC directory names another PDS as the community's home, returns the private attestations' data keys and commitment metadata **sealed to the signing key the DID now names** (`sealed`: ECDH secp256k1 with an ephemeral key, HKDF-SHA256, AES-256-GCM), so only the new home can read them, and marks the copy here `moved`. `NotMoved` while the DID still points here. Audited. |
| POST | `net.openfederation.community.markMoved` | Owner | — | Input `{ did }`. Marks the copy left behind by a move as `moved` once the DID points elsewhere (`NotMoved` otherwise). |
| POST | `com.atproto.server.activateAccount` | Yes | — | Activates a deactivated account only when its PLC state names this PDS as `atproto_pds` and this PDS's key as `atproto` (else `IncompatibleDidDoc`); accounts not in the PLC directory are exempt. `UpstreamFailure` (502, revision 3) when the directory cannot be reached. Bumps the token version, so the migration session ends; log in again. Pseudonyms get no status timestamps. |
