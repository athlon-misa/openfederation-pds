# Implementation Status

Snapshot of what exists in the PDS so design decisions don't reinvent shipped subsystems. For chronological release notes, see `CHANGELOG.md`. Endpoint reference: `docs/API.md`.

## Shipped subsystems

### Core
- Express + TypeScript ESM server with frozen XRPC handler registry
- PostgreSQL with auto-schema migration on startup (`ensureSchema()` in `src/server/index.ts`)
- Identity Manager: `did:plc` (real PLC registration via `src/identity/plc-client.ts` — direct protocol, not `@did-plc/lib`) and `did:web` with domain validation
- Real MST repos via `@atproto/repo` + `PgBlockstore` on PostgreSQL; `repo_roots` tracks root CID + revision per DID
- ATProto-compliant TID generation (`@atproto/common-web`) and CIDs (`cidForRecord()`)
- User identities: real `did:plc` + signing key + initial `app.bsky.actor.profile` repo record. PDS holds rotation + signing keys for users (separate `user_signing_keys` table)
- PLC directory service (`plc-server/`) for self-hosted deployment

### Auth
- JWT access tokens + refresh token rotation with reuse detection (compromise → revoke all sessions)
- Role-based guards: admin, moderator, partner-manager, auditor, user; `requireApprovedUser`, `requireActiveCommunity`, `requireCommunityRole`
- Per-account brute-force protection: 5/10/15/20 failures → 1m/5m/30m/2h lockout
- Cross-PDS service-auth (ES256K/ES256 JWTs): inbound verification via `@atproto/identity` resolver, 5-min cache, replay-protected, per-DID rate limit
- ATProto OAuth: authorization-server (`@atproto/oauth-provider`) + external login client (`@atproto/oauth-client-node`); dual auth middleware (DPoP → OAuth, Bearer → JWT)
- Session management: list, revoke by ID, revoke-all, email notifications
- Self-service password reset: SHA-256 hashed tokens, 1h expiry, all sessions revoked on reset
- Admin identity verification: email nonce challenge

### Registration & approval
- Invite-only with moderator approval workflow; invite binding (`--bound-to` email + notes)
- Partner Registration API: trusted apps register users without invites, auto-approved, per-key rate limiting, origin validation, instant revocation; keys SHA-256 hashed (`ofp_` prefix)

### Key management
- AES-256-GCM at-rest encryption for recovery + signing keys; PBKDF2 (100k iter, SHA-512) from `KEY_ENCRYPTION_SECRET`
- Primary rotation key returned to user once and never stored
- ActivityPub RSA keys persisted encrypted, survive restarts

### Communities
- CRUD + suspend/unsuspend/takedown (admin), export, transfer (owner)
- Members: join/leave, kick, role management (promote/demote between moderator and member)
- Join requests: list pending, approve/reject
- Attestations: issue, verify, list, delete-as-revoke (ATProto-native), encrypted variant with AES-256-GCM DEK + commitment hashes; `listAttestations` includes `subjectDisplayName`/`subjectAvatarUrl` from write-time projection
- Disclosure proxy: time-limited grant redemption with session-scoped re-encryption + JSON watermarking + audit log
- Write-time member display projection: `members_unique` stores denormalized `display_name`/`avatar_url`/`role`/`kind`/`tags`/`attributes`; `community_attestation_index` mirrors the same for attestations; `updateProfile` fans out display changes across all membership rows. `listMembers` and `listAttestations` are now single-table reads (no N+1).

### Contact Graph
- Bidirectional contact graph with explicit consent: `sendRequest`, `respondToRequest` (accept/reject), `removeContact` (cooperative cross-repo deletion), `list`, `listIncomingRequests`, `listOutgoingRequests`
- Records: `net.openfederation.contact.request` (requester's repo), `net.openfederation.contact.contact` (both repos after acceptance)
- DB: `contact_requests` + `contacts` index tables

### Profiles & identity
- Standard `app.bsky.actor.profile` + custom collection aggregation (`*.actor.profile`)
- External Identity Keys: Meshtastic/Nostr/WireGuard/SSH/hardware bridge via multibase-validated Ed25519/X25519/secp256k1/P256; reverse lookup
- DID-to-wallet linking: EIP-191 (Ethereum) + Ed25519 (Solana) challenge-response, reverse resolution
- Public DID→wallet resolver + W3C DID-document augmentation: did:web injects CAIP-10 verificationMethod entries into `/.well-known/did.json`
- Sign-In With OpenFederation (SIWOF): CAIP-122 / SIWE-compatible flow; offline-verifiable didToken (service-auth JWT) + walletProof

### Wallets (progressive custody)
- One DID anchors many per-chain wallets at three custody tiers, all on `wallet_links` substrate with stable addresses across upgrades
- Tier 1 (custodial): PDS encrypts key, signs server-side per consent grant
- Tier 2 (user_encrypted): SDK wraps BIP-39 mnemonic under user passphrase; PDS stores opaque blob
- Tier 3 (self_custody): client-only mnemonic, PDS holds public link only
- Transaction signing: EIP-1559/legacy EVM (chainId required) and Solana transaction-message bytes; SDK exposes `asEthersSigner()` and `asSolanaSigner()`
- Tier upgrades (1→2, 1→3, 2→3) via `retrieveForUpgrade` + `finalizeTierChange`; downgrades unsupported

### Vault & recovery
- Shamir 2-of-3 threshold key splitting; encrypted share storage; vault audit log; escrow provider registration
- Recovery tiers: T1 email, T2 2-of-3 escrow, T3 self-custodial; security level endpoint
- Custodial Secret Storage: opaque encrypted blobs per user per chain, FK-cascaded on account delete

### Federation & ATProto compliance
- Repo endpoints: `getRecord`, `putRecord`, `createRecord`, `deleteRecord`, `describeRepo`, `listRecords`
- `sync.getRepo` (full repo as CAR stream) — federation-critical
- Account lifecycle: suspend, unsuspend, takedown, deactivate, activate, export, delete (all ATProto-compatible)
- `com.atproto.identity.resolveHandle` standard resolution
- Well-known: `/.well-known/did.json` (PDS service DID, secp256k1, encrypted in `pds_service_keys`; falls through to community at hostname), `/.well-known/webfinger`

### On-chain governance
- Oracle credential system per-community (`ofo_` prefix); chain-agnostic Oracle protocol; governance proof logging
- Chain-specific proof verification: `ChainAdapter` interface, EVM adapter (ethers v6), proof caching, `submitProof` endpoint with Oracle auth

### Lexicons
- `@open-federation/lexicon` npm package, schema validation in CI, GitHub Pages docs
- Per-schema `revision` integer field; bump on input/output/error changes; CI validates

### Hardening
- Content-Security-Policy header on all responses
- Audit logging for all admin and security-relevant actions
- Async PBKDF2; OAuth pending-code Map cap; SSRF guard on peer health checks; expanded reserved handles; invite rate limiting
- Rate limits: global 120/min, auth 20/15min, registration 5/hr, community-create 10/hr, service-auth 60/min/DID, wallet-sign 60/min/IP
- Request body size: 256kb
- N+1 query elimination in list endpoints (SQL JOINs)
- XRPC input validation runs for all requests including unauthenticated (previously skipped for public endpoints)

### SDK & developer adoption
- `@open-federation/sdk` (`packages/openfederation-sdk/`): zero-dep, ESM + CJS + IIFE (`/sdk/v1.js`, ~2.5KB gzipped)
- Auto-refresh tokens; localStorage / sessionStorage / memory backends; typed error classes; ATProto OAuth redirect support
- `loginWithExternalSession`: inject iron-session tokens for server-side Next.js usage
- `client.signInWithOpenFederation()` (tier-aware) + pure offline `verifySignInAssertion()`
- `client.wallet.signTransaction` (tier-dispatched), `asEthersSigner()`, `asSolanaSigner()`; `ethers` is optional peerDependency, dynamic-imported
- `client.mountSignInButton(el, opts)` for zero-framework integrators
- `@open-federation/react` (`packages/openfederation-react/`): `<OpenFederationProvider>`, hooks, `<SignInWithOpenFederation>` drop-in component

### CLI & tooling
- CLI (`cli/pds-cli.ts`): login/logout/whoami, health/info, invite/user management, community ops, sessions, security diagnostics, oracle CRUD, password change, admin verification
- Configurable timeout (30s default); session creds at `.pds-cli/session.json` with restrictive perms

### Web UI
- Next.js 15 + shadcn/ui + Zustand + React Query v5 + kbar (port 3001)
- Ozone-style admin dashboard: sidebar shell, command palette, data tables (`@tanstack/react-table`)
- Pages: `/admin/{users,communities,invites,audit}`, `/communities`, `/explore`, `/settings`, `/(auth)/{login,register}`, `/callback`

### Email
- Nodemailer-based with SMTP transport; console fallback when `SMTP_HOST` unset

### Tests
- 63 test files; integration, unit, E2E, and security suites; XRPC output shape smoke tests validate handler/lexicon parity on every CI run

## TODO
- Blob storage for avatars and banners
- Email verification
