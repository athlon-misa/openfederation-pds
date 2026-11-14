# API Endpoints

Reference index of all XRPC endpoints exposed by the PDS. Lexicon JSONs in `src/lexicon/` are the source of truth; this file is a navigable summary.

**Handles.** Every response gives a handle in full, as AT Protocol does: the name plus this server's handle domain (`HANDLE_SUFFIX`, listed in `describeServer` as `availableUserDomains`), the same name as the `at://` entry in the DID document's `alsoKnownAs` (#411). That includes the bootstrap admin, which has no PLC identity. A handle that is not one of this server's names is given as it is: an external account's own handle or its `plc-…` placeholder, or a member handle another server wrote into a record. Wherever a handle is an input, the short name and the full handle are both accepted; this server's domain is removed before the lookup, any other domain is not. The database, access tokens and audit entries keep the short name.

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
| POST | `net.openfederation.admin.takedown` | Admin | Take an account or community down, `standard` (owner export 30 days) or `hard` (no owner export, 90-day hold); changes tier or deadline of an existing takedown ([FAIR-USE.md](FAIR-USE.md)) |
| POST | `net.openfederation.admin.reverseTakedown` | Admin | Lift a takedown before its deletion date |
| GET  | `/takedown-export/:token` (`/blobs`, `/blob/:cid`) | Link | Owner's private download after a standard takedown: repository CAR, blob list, blobs |
| POST | `com.atproto.admin.deleteAccount` | Admin | Permanently delete a user account and all repo data |
| POST | `com.atproto.server.deactivateAccount` | Yes | User deactivates own account (self-service) |
| POST | `com.atproto.server.activateAccount` | Yes | User reactivates own account after deactivation |

## OpenFederation Account Management

| Method | NSID | Auth | Description |
|:---|:---|:---|:---|
| POST | `net.openfederation.account.register` | No | Register (invite required when `INVITE_REQUIRED`). `status` is `pending` until an admin approves, or `approved` at once under `ACCOUNT_APPROVAL=automatic` |
| GET  | `net.openfederation.account.listPending` | Admin/Mod | List pending registrations |
| POST | `net.openfederation.account.approve` | Admin/Mod | Approve a pending user |
| POST | `net.openfederation.account.reject` | Admin/Mod | Reject a pending user |
| GET  | `net.openfederation.account.list` | Admin/Mod | List all accounts with search/filter |
| GET  | `net.openfederation.account.export` | Self/Admin/Mod | Export user repo data as JSON (AT Protocol "free to go") |
| POST | `net.openfederation.account.updateRoles` | Admin | Add or remove PDS roles for a user |
| POST | `net.openfederation.account.updateProfile` | Yes | Update standard or custom profile collection |
| GET  | `net.openfederation.account.getProfile` | No | Get user profile (standard + custom collections) |
| POST | `net.openfederation.invite.create` | Admin/Mod | Create an invite code; optional `maxUses`, `expiresAt`, `boundTo`, `note`, and `count` (1–100 codes with the same settings, returned as `codes`) |
| GET  | `net.openfederation.invite.list` | Admin/Mod | List invite codes with status filter |

## Device signing (#240)

For `self` and `assisted` accounts, where `getPublicConfig` says `identity.deviceSigningAllowed`. The device holds the repo signing key and the DID's `atproto` key names it ([ADR-003](adr/ADR-003-custody-modes.md) decision 14), so commits this server signed would be refused everywhere. While device signing is on, every server-side write into the account's repository answers `403 DeviceSigningRequired`: `com.atproto.repo.createRecord` / `putRecord` / `deleteRecord`, `account.updateProfile`, `identity.setExternalKey` / `deleteExternalKey`, `contact.*` writes, `forum.createThread` / `createPost` / `deletePost` (author's repo), `calendar.rsvp`, `community.voteOnProposal`, `community.objectToProposal`, and `com.atproto.server.getServiceAuth` / `identity.signInAssert` (tokens are checked against the device's key). Writes go through prepare and submit instead (`@open-federation/sdk/custody` does both).

| Method | NSID | Auth | Description |
|:---|:---|:---|:---|
| POST | `net.openfederation.account.enableDeviceSigning` | Yes | Turn it on after the phrase-signed PLC update naming the device key. Refuses `DeviceSigningNotAllowed`, `CustodyModeNotSupported` (custodial), `AtprotoKeyNotDevice` (PLC still names a server key). Returns `{ deviceSigning, atprotoKey }`. Idempotent |
| POST | `net.openfederation.account.disableDeviceSigning` | Yes | Turn it off once PLC names this server's key again (`com.atproto.identity.getRecommendedDidCredentials`); else `AtprotoKeyNotServer`. Drops prepared commits. Idempotent |
| POST | `net.openfederation.repo.prepareCommit` | Yes | `{ repo?, writes: [{ action: create \| update \| delete, collection, rkey?, value? }] }` (up to 200, the `applyWrites` shape; createRecord / putRecord / deleteRecord are one-write batches). Builds the commit on the current root without signing it. Returns `{ handle, did, rev, prevRoot, unsignedCommit (base64 DAG-CBOR without sig: sign exactly these bytes), newBlocks [{ cid, bytes }], writes [{ collection, rkey, uri, cid }], expiresAt }`. Own repo only; same collection rules as the generic writes. Expires after 5 minutes; at most 8 waiting per account (`TooManyPendingCommits`). Errors: `DeviceSigningOff`, `UseDedicatedEndpoint`, `RecordNotFound` |
| POST | `net.openfederation.repo.submitCommit` | Yes | `{ handle, sig }` (base64 compact 64-byte low-S ECDSA over `unsignedCommit`). Takes the prepared commit (once, only by the account that prepared it), reads the DID's current `atproto` key from PLC, verifies the signature, checks the root has not moved, then stores blocks, root and `records_index` in one transaction. Returns `{ commit: { cid, rev }, writes }`. Errors: `UnknownCommit` (replayed or someone else's), `CommitExpired`, `InvalidSignature`, `RepoHeadMoved` (prepare again), `DeviceSigningOff` (also when PLC names this server's key again, which turns it off), `UpstreamFailure` |

## OpenFederation Session Management

| Method | NSID | Auth | Description |
|:---|:---|:---|:---|
| GET | `net.openfederation.account.listSessions` | Yes | List active sessions (admin can query by DID) |
| POST | `net.openfederation.account.revokeSession` | Yes | Revoke session by ID or revoke all |
| POST | `net.openfederation.account.requestPasswordReset` | No | Request password reset email |
| POST | `net.openfederation.account.confirmPasswordReset` | No | Confirm reset with token + new password |
| POST | `net.openfederation.account.reserveCustodyKey` | No | Reserve the rotation key this server will hold for an `assisted` account; returns `rotationKey` (did:key) to list second in the genesis operation (ADR-003) |
| POST | `net.openfederation.account.registerSelfCustody` | No | Register an `assisted` or `self` account whose genesis operation is already in PLC: `{ did, mode, handle, email, password, inviteCode? }`; same rules as `register`; refuses `InvalidGenesis`, `SigningKeyNotReserved`, `PdsKeyNotReserved`, `CustodyModeNotAllowed` (ADR-003) |
| POST | `net.openfederation.identity.prepareCustodyChange` | Yes + password | Prepare a custody mode change (ADR-003): returns the unsigned PLC update, its CID, `signer` (`pds` from custodial, `user` otherwise), `possessionText` (sign with both new keys) or `pdsRotationDidKey` (a key the server reserved for itself) |
| POST | `net.openfederation.identity.finalizeCustodyChange` | Yes + password | Finalize it: from custodial the server checks the possession proofs, signs, submits and reads back; otherwise checks the user's operation is the latest at PLC. Then stores or deletes its key shares, updates the mode, emails the account. Idempotent. Errors: `NotSubmitted`, `OperationMismatch`, `StateChanged`, `PossessionProofInvalid`, `PdsKeyNotReserved`, `UpstreamFailure` |
| POST | `net.openfederation.identity.recoverAssistedAccount` | Yes + password + identity verification | Recover an `assisted` account whose phrase is lost: without `operationCid` returns the planned update and `possessionText`; with it, the server signs (second-priority key) the update putting the new keys first, and emails the 72-hour cancel notice. One recovery per verification. Errors: `NotAssisted`, `VerificationRequired`, `PossessionProofInvalid`, `OperationMismatch` (ADR-003) |
| GET  | `net.openfederation.identity.verifyRecord` | No | Is a record hosted here person-signed (ADR-003, decision 11)? `uri` → `{ personSigned, reason?, ownerKey? }`; `reason`: `NotSigned`, `NoOwnerKey`, `CidMismatch`, `SignatureInvalid` |
| GET  | `net.openfederation.account.getSecurityLevel` | Yes | Recovery tier, security checklist, `pdsHoldsRotationKey`, `custodyMode` (`custodial` / `assisted` / `self`, ADR-003), `deviceSigning` and `deviceSigningKey` (#240) |
| POST | `net.openfederation.account.initiateRecovery` | No | Start identity recovery (email-based) |
| POST | `net.openfederation.account.completeRecovery` | No | Complete recovery with token + new password |

## OpenFederation Community Management

| Method | NSID | Auth | Description |
|:---|:---|:---|:---|
| POST | `net.openfederation.community.create` | Approved | Create a new community |
| GET  | `net.openfederation.community.get` | No | Get community details (auth optional for membership info) |
| GET  | `net.openfederation.community.listAll` | Yes | List public communities (or all for admin) |
| GET  | `net.openfederation.community.discover` | No | Public communities here and on the peers in `FEDERATION_PEERS`, deduplicated by DID (#41). Params `limit` (1–100, default 50), `cursor`, `q` (text filter on handle, name, description). Returns `communities[]` (`did`, `handle`, `displayName`, `description`, `memberCount`, `pdsUrl`, `webUrl?`: the hosting server's dashboard origin, community page at `{webUrl}/communities/{did}`, `source`: `local` / `peer`), `cursor` when there is more, and `peers[]` (`url`, `status`: `ok` / `failed`, `communityCount` or `error`: `Timeout`, `Unreachable`, `BlockedUrl`, `HttpError`, `InvalidResponse`, `ResponseTooLarge`). A failed peer never fails the request |
| GET  | `/.well-known/openfederation-communities.json` | No | This PDS's public communities for peers to fetch: `{ version: 1, pds: { url, hostname, webUrl? }, generatedAt, communities: [{ did, handle, displayName, description, memberCount, pdsUrl }] }`. Same filter as unauthenticated `listAll`, at most 1000 entries, descriptions cut to 300 characters; never includes what peers list |
| GET  | `net.openfederation.federation.listPeerCommunities` | No | **Deprecated: use `community.discover`.** Communities listed by the configured peers only (none hosted here), with peer health and `cachedAt`. Still served, not removed; the dashboard no longer calls it |
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
| POST | `net.openfederation.community.takedown` | Admin | Standard takedown of a community: hidden, owner export link for 30 days, then deleted ([FAIR-USE.md](FAIR-USE.md)) |
| POST | `net.openfederation.community.updateMember` | Owner/Admin | Partial update of member record: role, kind, tags, attributes (any subset). Renamed from updateMemberRole to support semantic classification (#50). |
| POST | `net.openfederation.community.issueAttestation` | Owner/Mod | Issue a signed attestation for a member |
| POST | `net.openfederation.community.deleteAttestation` | Owner/Mod | Revoke an attestation (delete-as-revoke) |
| GET  | `net.openfederation.community.listAttestations` | No | List attestations by community/subject/type (items include `subjectDisplayName` and `subjectAvatarUrl`) |
| GET  | `net.openfederation.community.verifyAttestation` | No / see note | Verify an attestation exists (record existence = validity). Public attestations in public communities: anyone. Private attestations or private communities: members, the subject, viewing-grant holders (granted fields only) and admins; anyone else gets the answer for a missing attestation |
| POST | `net.openfederation.attestation.requestDisclosure` | Yes | Request disclosure of a private attestation (policy-based) |
| POST | `net.openfederation.attestation.createViewingGrant` | Yes | Create time-limited viewing grant (subject-only) for a private attestation or any attestation in a private community; the grantee can verify and redeem it |
| GET  | `net.openfederation.attestation.verifyCommitment` | Yes (standing) | Verify commitment hash without revealing content; members, the subject, viewing-grant holders and admins only, otherwise NotFound |

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
| POST | `net.openfederation.wallet.grantConsent` | Yes | Removed: returns 403 `UserApprovalRequired`; use `requestConsent` |
| POST | `net.openfederation.wallet.requestConsent` | Yes | Ask the user for signing consent (wallet, `allowedContracts`, value limits, TTL default 1h, max `WALLET_CONSENT_MAX_HOURS`); returns `approveUrl` on the PDS |
| GET | `net.openfederation.wallet.getConsentRequest` | Yes | Status of a consent request: pending / approved / denied / expired |
| POST | `net.openfederation.wallet.approveConsentRequest` | No (password) | Used by the PDS approval page only; Origin must be the PDS; password checked with login lockout |
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
| GET  | `net.openfederation.admin.getServerSettings` | Admin | The settings an admin can change at runtime (#410): `settings[]` of `{ id, envVar, value, source, fixed, fallback, fallbackSource, changedAt? }`, plus `profile?`, `problem?` (saved changes ignored because they conflict with the environment) and `refreshSeconds`. `source` is `environment` (fixed: shown, never changeable here), `admin`, `setup` (the setup wizard's choice) or `default` |
| POST | `net.openfederation.admin.updateServerSettings` | Admin | `{ changes: { <id>: value \| null } }`; null drops the admin's change. All or nothing, applied without a restart (other instances within `refreshSeconds`), each change audited as `server.settings.update` with `before` and `after`. Errors: `InvalidRequest`, `InvalidSetting` (with `setting`), `InvalidCombination` (offered first not offered; device signing without Self or Assisted), `SettingFixedByEnvironment` |

### Server settings (#410)

Settings ids and the environment variable each is otherwise read from: `pseudonymsEnabled` (`PSEUDONYMS_ENABLED`), `pseudonymTokensPerEpoch` (1–1000), `pseudonymProbationDays` (0–365), `pseudonymProbationDailyWrites` (1–100000), `custodyAllowed` (list of `custodial`/`assisted`/`self`), `custodyDefault`, `deviceSigningAllowed`, `inviteRequired`, `emailVerificationPolicy`, `migrationAccounts` / `migrationCommunities` (`open`/`invite`/`closed`), `migrationPseudonyms` (`open`/`token`/`closed`), `federationPeers` (up to 50 https addresses; `PEER_PDS_URLS` still adds to it from the environment), `accountApproval` (`ACCOUNT_APPROVAL`: `manual`/`automatic`), `defaultAppearance` (`DEFAULT_APPEARANCE`: `pds-basic`/`openfederation`/`opennewsrooms`).

**Approving new accounts (`accountApproval`).** `manual` (the default, under both profiles): a new account from `account.register`, `account.registerSelfCustody` or OAuth sign-up starts `pending` and cannot sign in until an admin or moderator calls `account.approve`. `automatic`: it starts `approved` (with `approved_at`, `approved_by` NULL) and is audited as `account.approve` with no actor and `meta: { via: 'automatic', setting: 'ACCOUNT_APPROVAL', handle }`, like the approval email verification gives a partner sign-up. Invite-only sign-up still applies. Turning it on approves nobody already waiting. Unaffected: pen names (their own path, never audited), accounts moving in (`com.atproto.server.createAccount` opens them deactivated; `activateAccount` approves them, gated by `MIGRATION_ACCOUNTS`), and `partner.register` (a signed ticket approves; without one, verifying the email does).

**Default appearance (`defaultAppearance`).** Published as `getPublicConfig.appearance.defaultPreset`. The dashboard uses it for anyone who has not chosen a look; a person's own choice always wins. An unknown value in the environment warns and falls back to `openfederation`; a dashboard that lacks a preset ignores it.

**Precedence:** environment variable > an admin's change (table `server_settings`) > the setup wizard's choice (its settings file) > the `OPENFEDERATION_PROFILE` default > the built-in default. The wizard's choices for these settings are not loaded into the environment, so they stay changeable here. Turning something off only stops new things: existing pen names, accounts in a mode no longer offered, devices already signing and finished moves keep working. `getPublicConfig`, `describeServer` and `server.getConfig` show the values in effect.

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
| POST | `net.openfederation.forum.importBatch` | Owner or PDS admin | Import up to 100 threads and 100 posts from another platform (`platform: "discord"`) into the community's own repo, signed by the community; see below |
| POST | `net.openfederation.calendar.createEvent` | Member | Create a calendar event; stores record in the community's repo |
| GET  | `net.openfederation.calendar.listEvents` | No* | List calendar events for a community |
| POST | `net.openfederation.calendar.rsvp` | Member | Submit or update an RSVP for a calendar event |
| GET  | `net.openfederation.calendar.listRsvps` | No* | List RSVPs for an event with per-status counts |

\* Gated by community visibility — see note above.

### Importing history from another platform (`forum.importBatch`, #86)

Written for `ofc community import discord` (see `cli/README.md`), which reads the export and sends batches; any client may call it.

- **Input:** `{ community, platform: "discord", threads?: [{ channelId, title, tags?, createdAt }], posts?: [{ channelId, messageId, replyToMessageId?, text, createdAt, editedAt?, author?, attachmentCount? }] }`. Ids are Discord snowflakes (decimal strings, < 2^63). At most 100 threads and 100 posts; posts oldest first. A post's thread (`channelId`) must be in the batch or already imported; `replyToMessageId` must be a post earlier in the batch or already imported in the same channel. Unknown fields, bad ids or times, over-long strings (title 300, text 10 000, tag 64, author 100 UTF-8 bytes) and a post with neither text nor attachments are refused (`InvalidRequest`, `ThreadNotFound`, `ParentNotFound`); a refused batch writes nothing.
- **Output:** `{ threads: { created, existing }, posts: { created, existing } }`.
- **What is written:** `net.openfederation.forum.thread` / `.post` records in the **community's** repository, in one signed commit per batch. They carry no `author` (nothing is written in a Discord user's name) and an `importedFrom` object: `{ platform, channelId }` on a thread; `{ platform, channelId, messageId, author?, editedAt?, attachmentCount? }` on a post. `createdAt` is the original time; the commit carries the import time. Visibility follows the community: a private community's imported history is readable by its members only.
- **Record keys** are the Discord id's 63 bits written as a TID (the lexicons declare `key: tid`), so the same message always lands at the same address. A record already there is left alone and counted as `existing` (and re-indexed), which makes a re-run or a resumed run safe.
- **Rate limit:** `IMPORT_RATE_LIMIT` per IP per minute (default 30). Audited as `forum.import` with counts only.

## OpenFederation Activity Timelines

| Method | NSID | Auth | Description |
|:---|:---|:---|:---|
| GET | `net.openfederation.activity.getUserTimeline` | Yes (local account; not service-auth) | Activity across every community the caller belongs to, here and on configured peers, newest first. `limit` (1–100, default 30), `cursor`. Returns `entries`, `cursor?`, `unreachable` (community DIDs whose PDS did not answer in time) and `unreachablePeers` (peer URLs that could not be asked) |
| GET | `net.openfederation.activity.listCommunityActivity` | Yes (session, OAuth or service-auth) | Merged activity of up to 25 communities hosted here (`community`, repeated), `limit`, `cursor`. Returns `entries`, `cursor?` and `unavailable`: requested communities not listed, whether missing, not active, or private and the caller is not a member, all answered alike |

An entry is `{ id, kind, community, actor?, uri?, cid?, createdAt, summary? }`. `kind` is one of `member.joined`, `joinRequest.created`, `proposal.created`, `event.created`, `forum.thread.created`; `summary` carries a few display fields (`handle`, `role`, `title`, `name`, `startsAt`, `action`, `targetCollection`, `status`). The cursor is opaque and the same for both methods.

**Design (#42).** Home-PDS fan-out, no push index and no AppView. The caller's own PDS reads the communities it hosts straight from the database, in one query: the member rows (`members_unique`), pending join requests, proposal and calendar-event records (`records_index`) and forum threads (`forum_threads`). Nothing new is written to produce activity. For each peer in `FEDERATION_PEERS` (the same list `community.discover` uses) it asks, in parallel and with a service-auth token signed by the caller's key (`aud` = the peer's service DID from `describeServer`, `lxm` = the method), `community.listMine` for the caller's memberships there (kept only when the community's DID document names that peer as its PDS) and then `activity.listCommunityActivity` for their activity. Entries are merged newest first by the time the community's PDS recorded them (UTC, microseconds), ties broken by `id` in byte order, so a cursor (`createdAt|id`) is stable.

- **Privacy** is decided by the PDS that hosts the community, per request: a public community for any authenticated caller, a private one for its members, owner and PDS admins (the rules of `requireCommunityReadable`); join requests for the owner and PDS admins only (as `listJoinRequests`); hidden forum threads never. Taken-down, importing and moved copies are not served. Entries from a peer are kept only for communities that peer was asked about, and their fields are bounded.
- **Caching:** each community's feed for 10 s (after the access check, so it is only handed to viewers who may read it); a peer's answer for 10 s and the caller's memberships on a peer for `FEDERATION_CACHE_TTL_MS` (default 5 min), per caller.
- **Limits:** up to 100 communities hosted here (most recently joined) and 100 per peer (calls of 25). A peer gets 450 ms; one that does not answer is left out of that page and named in the response, and its call finishes in the background (up to 5 s) to fill the cache. Paging past a page that missed a peer does not bring that peer's skipped entries back.
- **Not covered:** memberships in communities on PDSes that are not configured peers (a membership is a record in the community's repo, and joining writes nothing on the member's side, so the home PDS cannot learn of them otherwise); forum posts, RSVPs and votes as activity; push notifications. Measured with 20 memberships hosted here: p95 about 12 ms uncached (`tests/api/net.openfederation.activity.timeline.test.ts`).

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
| POST | `net.openfederation.community.migrateIn` | Proof JWT (see description) | create | A community arrives here. Input `{ did, handle, inviteCode? }`; proof: a Bearer JWT signed by one of the community's PLC rotation keys (`iss` = the community DID, `sub` = the owner's DID, `aud` = this PDS's service DID, `lxm` = this method, short-lived). Gate `MIGRATION_COMMUNITIES` (`open` / `invite` / `closed`, default `invite`). This PDS makes fresh signing and recovery keys, **pulls** the repository from wherever the DID currently points (verified against the DID's current signing key, stored in one transaction), rebuilds `members_unique` and the attestation index from the records, and pulls every referenced blob. The community sits in `importing` until activated; a second call refreshes the copy. Output: counts, `progressCode` (private; opens `checkMigration` while importing, new on each call) plus `recommended`, what to put in the DID (`rotationKeys: [the owner's key, this PDS's recovery key]`, signing key, endpoint, handle). Errors: the gate and invite errors, `AuthRequired`/`InvalidToken`, `IncompatibleDidDoc` (the DID already points here), `AlreadyExists`, `Forbidden` (the copy here belongs to another owner), the import errors, `UpstreamFailure`. |
| GET | `com.atproto.server.describeServer` | No | — | AT Protocol standard: `{ did, availableUserDomains, inviteCodeRequired, phoneVerificationRequired, links }`. `did` is the service DID to use as `aud` in service-auth tokens addressed to this PDS. |
| GET | `com.atproto.sync.getLatestCommit` | No | — | AT Protocol standard: `{ cid, rev }` of a repository's current commit; same access rules as `sync.getRepo`. |
| POST | `com.atproto.server.requestAccountDelete` | Yes (also a deactivated account's limited session) | create | Emails the account a deletion code (`XXXXX-XXXXX`, 15 minutes); a new request replaces the old code. Pseudonyms have no email and use their owner key instead. |
| POST | `com.atproto.server.deleteAccount` | Password + code, or owner-key JWT (pseudonyms) | create | The owner deletes their account here (#269). User accounts: `{ did, password, token }`. Pseudonyms: `{ did }` with a Bearer JWT signed by the owner key (`iss` = did, `lxm` = this method, at most 5 minutes). **Allowed** for an active account, or a deactivated copy whose DID now names another server (left behind by a move, or an abandoned move here). **Refused**: deactivated while the DID still names this server (`AccountDeactivated`: reactivate first, it may be the only copy), suspended or taken down (`AccountModerated`), admin accounts. Removes keys, repository, blobs nobody else owns, memberships and sessions; the DID stays in PLC. Audited as `account.delete` (not for pseudonyms). A community's owner removes a copy left behind with `community.delete`, through service auth from their own PDS. |
| GET | `net.openfederation.community.checkMigration` | Code, owner or admin while importing | — | Params `did`, `code?`. While the community is importing, only its owner (signed in here, or by service auth), an admin, or the `progressCode` from `migrateIn` sees progress; anyone else gets `NotFound`. Once live, readable like the community. Output `{ status, validDid, repoCommit, repoRev, indexedRecords, members, attestations, expectedBlobs, importedBlobs, missingAttestationKeys, recommended? }`. |
| POST | `net.openfederation.community.activate` | Owner (local session or cross-PDS service auth) | create | Input `{ did }`. Switches the community on once the DID names this PDS and its signing key (`IncompatibleDidDoc` otherwise). Fetches the attestation keys from the old home (`getMovedKeys`) and re-wraps them under this PDS's secret; if the old home does not answer the community still activates and the call can be repeated while `missingAttestationKeys > 0`. |
| GET | `net.openfederation.community.getMovedKeys` | No | create | Param `did`. The old home's side: once the PLC directory names another PDS as the community's home, returns the private attestations' data keys and commitment metadata **sealed to the signing key the DID now names** (`sealed`: ECDH secp256k1 with an ephemeral key, HKDF-SHA256, AES-256-GCM), so only the new home can read them, and marks the copy here `moved`. `NotMoved` while the DID still points here. Audited. |
| POST | `net.openfederation.community.markMoved` | Owner | — | Input `{ did }`. Marks the copy left behind by a move as `moved` once the DID points elsewhere (`NotMoved` otherwise). |
| POST | `com.atproto.server.activateAccount` | Yes | — | Activates a deactivated account only when its PLC state names this PDS as `atproto_pds` and this PDS's key as `atproto` (else `IncompatibleDidDoc`); accounts not in the PLC directory are exempt. `UpstreamFailure` (502, revision 3) when the directory cannot be reached. Bumps the token version, so the migration session ends; log in again. Pseudonyms get no status timestamps. |
