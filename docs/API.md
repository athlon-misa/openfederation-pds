# API Endpoints

Reference index of all XRPC endpoints exposed by the PDS. Lexicon JSONs in `src/lexicon/` are the source of truth; this file is a navigable summary.

## ATProto Standard

| Method | NSID | Auth | Description |
|:---|:---|:---|:---|
| POST | `com.atproto.server.createSession` | No | Login (returns access + refresh tokens) |
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
| POST | `net.openfederation.community.transfer` | Owner | Generate transfer package for migration (owner-only per AT Protocol) |
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

## OpenFederation Contact Graph

| Method | NSID | Auth | Description |
|:---|:---|:---|:---|
| POST | `net.openfederation.contact.sendRequest` | Yes | Send a contact request; 409 if pending or already contacts |
| POST | `net.openfederation.contact.respondToRequest` | Yes | Accept or reject an incoming request (accept creates contact records on both repos) |
| POST | `net.openfederation.contact.removeContact` | Yes | Remove an accepted contact (cooperatively removes from counterpart's repo) |
| GET  | `net.openfederation.contact.list` | Yes | List the caller's accepted contacts, paginated |
| GET  | `net.openfederation.contact.listIncomingRequests` | Yes | List pending requests addressed to the caller |
| GET  | `net.openfederation.contact.listOutgoingRequests` | Yes | List pending requests sent by the caller |
