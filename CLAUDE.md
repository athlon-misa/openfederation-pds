
# OpenFederation PDS: Implementation Guide

**Objective:** To build the Minimum Viable Product (MVP) for the OpenFederation Personal Data Server (PDS) based on the provided architectural documents. This guide follows the **Phase 1** implementation roadmap.

**Core Principle:** Adhere strictly to the design decisions outlined in the `Identity_Layer_Specification.md` and other provided documents, especially regarding security, key management, and community choice.

---

## Quick Start

### Development Commands

```bash
# Install dependencies
npm install

# Initialize database
./scripts/init-db.sh

# Run in development mode
npm run dev

# Build for production
npm run build

# Run production build
npm start

# CLI (build first)
npm run cli -- <command>

# Run tests
npm test              # Security tests
npm run test:api      # Integration + unit tests
npm run test:e2e      # E2E journey tests (requires PLC: npm run plc:dev)
```

### Required Environment Variables

Before starting the server, configure `.env` (see `.env.example`):

| Variable | Required | Description |
|----------|:---:|-------------|
| `AUTH_JWT_SECRET` | Production | Random string, minimum 32 characters. Server refuses to start in production without it. |
| `KEY_ENCRYPTION_SECRET` | Production | Random string for encrypting recovery/signing keys at rest. Required before creating communities. |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Yes | PostgreSQL connection details. |
| `DB_SSL` | Production | Set to `true` for SSL database connections. |
| `SMTP_HOST` | No | SMTP server hostname. Email disabled when unset (logged to console). |
| `SMTP_PORT` | No | SMTP port (default: 587). |
| `SMTP_USER` | No | SMTP username. |
| `SMTP_PASSWORD` | No | SMTP password. |
| `SMTP_FROM` | No | From address (default: noreply@openfederation.net). |
| `EXPRESS_TRUST_PROXY` | No | Express trust proxy setting (default: 1). Set to 2 for Cloudflare + proxy. |
| `CHAIN_ADAPTERS` | No | Chain RPC URLs for proof verification. Format: `eip155:137=https://rpc.example.com`. Treat as secret (contains API keys). |
| `PDS_SERVICE_DID` | No | Service DID accepted in the `aud` claim of inbound service-auth JWTs (default: `did:web:{PDS_HOSTNAME}`). |
| `SERVICE_AUTH_RATE_LIMIT` | No | Max inbound service-auth requests per caller DID per minute (default: 60). |
| `WALLET_SIGN_RATE_LIMIT` | No | Max Tier 1 wallet-sign requests per minute per IP (default: 60). |
| `CREATE_RATE_LIMIT` | No | Max "create" operations (invites, communities, wallets, consents) per hour per IP (default: 10). |

### Current Implementation Status

**Completed:**
- Project structure and TypeScript ESM configuration
- PostgreSQL database schema (35 tables: users, user_roles, invites, sessions, communities, plc_keys, signing_keys, user_signing_keys, repo_blocks, repo_roots, records_index, members_unique, commits, join_requests, audit_log, partner_keys, blobs, export_schedules, export_snapshots, password_reset_tokens, ap_signing_keys, oracle_credentials, proof_verifications, wallet_links, wallet_link_challenges, wallet_custody, wallet_dapp_consents, vault_shares, vault_audit_log, escrow_providers, recovery_attempts, attestation_encryption, viewing_grants, disclosure_sessions, disclosure_audit_log, custodial_secrets)
- Express server with XRPC routing and frozen handler registry
- Identity Manager supporting both `did:plc` and `did:web` with domain validation
- Real MST Repository Engine wrapping `@atproto/repo` with signed commits, CAR export, and ATProto-compliant TID generation
- Authentication: JWT access tokens, refresh token rotation with reuse detection, session invalidation
- Authorization: role-based guards (admin, moderator, partner-manager, auditor, user), approved-user gate
- Invite-only registration with moderator approval workflow
- Rate limiting: global (120/min), auth (20/15min), registration (5/hr), community creation (10/hr)
- AES-256-GCM encryption for recovery keys and signing keys at rest
- Audit logging for all admin and security-relevant actions
- Community CRUD: create, get, list (public/mine/all), update, join, leave
- Join request workflow: request, list pending, approve/reject
- CLI with authentication, session management, and admin commands
- Request body size limit (256kb)
- N+1 query elimination in list endpoints (SQL JOINs)
- AT Protocol compliance: community suspend, unsuspend, takedown, export, transfer
- User account lifecycle: suspend, unsuspend, takedown, deactivate, activate, export, delete (ATProto-compatible)
- Community member removal (kick) by owner/admin
- Community deletion by owner/admin
- Web UI: Ozone-style admin dashboard with React Query, kbar command palette, sidebar shell, data tables
- Real PLC DID registration via `plc-client.ts` (direct PLC protocol implementation)
- User identity creation with signing keys and repos (`user-identity.ts`)
- Registration creates user repos with `app.bsky.actor.profile` record
- ATProto repo endpoints: `putRecord`, `createRecord`, `deleteRecord`, `describeRepo`, `listRecords`
- Federation endpoint: `sync.getRepo` (full repo as CAR stream)
- Well-known endpoints: `/.well-known/did.json` (did:web), `/.well-known/webfinger` (AT Protocol discovery)
- Auto-schema migration on startup (no manual `psql` needed for fresh deploys)
- PLC directory service (`plc-server/`) for Railway deployment
- Partner Registration API: trusted third-party apps can register users without invite codes (auto-approved)
- Partner key management: create, list, revoke keys (admin endpoints)
- Partner security: SHA-256 hashed keys, origin validation, per-key rate limiting, instant revocation
- Vanilla JS SDK (`@openfederation/sdk`): zero-dependency browser library for registration, login, session management
- SDK distribution: PDS-hosted at `/sdk/v1.js` (IIFE, 2.5KB gzipped) + npm publishable from `packages/openfederation-sdk/`
- SDK features: auto-refresh tokens, localStorage/sessionStorage/memory backends, typed error classes, ATProto OAuth redirect support
- External Identity Keys: cross-network identity bridging (Meshtastic, Nostr, WireGuard, SSH, hardware devices) via `net.openfederation.identity.externalKey` records
- Multibase/multicodec validation for Ed25519, X25519, secp256k1, P256 public keys (did:key format)
- Reverse key lookup: resolve external public key to ATProto DID (`resolveByKey` endpoint)
- Community member role management: promote/demote between moderator and member
- Community attestations: issue, verify, list, and revoke (delete-as-revoke, ATProto-native) cryptographically signed credentials
- User profile endpoints: update standard `app.bsky.actor.profile` and custom collections (e.g., `app.grvty.actor.profile`)
- Profile aggregation: `getProfile` returns standard + all custom `*.actor.profile` collections
- Test suite: 38 test files — 18 integration (API), 5 unit, 9 E2E journeys, 6 security (vitest + node:test)
- Email service: Nodemailer-based with SMTP transport, console fallback for development
- Per-account brute-force protection: failed login tracking with exponential lockout (5 failures: 1min, 10: 5min, 15: 30min, 20+: 2hr)
- Session management: list active sessions, revoke by ID or revoke-all, email notifications
- Self-service password reset: email-based token flow with 1-hour expiry, all sessions revoked on reset
- Security hardening: Content-Security-Policy header, audit logging for all failed logins, async PBKDF2, OAuth pending-code Map cap, SSRF guard on peer health checks, expanded reserved handles, invite rate limiting
- Admin identity verification: nonce challenge via email for secure account operations
- Oracle credential system: per-community scoped credentials for on-chain governance (`ofo_` prefix keys)
- On-chain governance mode: chain-agnostic Oracle protocol, governance proof logging, enforcement integration
- Invite binding: `--bound-to` email restriction and notes on invite codes
- ActivityPub RSA key persistence: keys stored encrypted in DB, survive restarts
- CLI: session management, security diagnostics (check-config, audit-summary), Oracle credential CRUD
- Lexicon registry: `@resonator-foundation/lexicon` npm package, schema validation in CI, GitHub Pages docs
- Lexicon per-schema revision tracking: `"revision"` integer field on all lexicon JSONs, CI validation, docs generation
- Chain-specific proof verification: `ChainAdapter` interface, EVM adapter (ethers v6), proof caching, `submitProof` endpoint with Oracle auth, graceful fallback for unregistered chains
- DID-to-wallet linking: challenge-response Ethereum (EIP-191) and Solana (Ed25519) signature verification, reverse wallet-to-DID resolution, transaction-safe linking
- Vault Service: Shamir 2-of-3 threshold key splitting for recovery keys, encrypted share storage, vault audit log, escrow provider registration, key export for self-custody
- Identity Recovery Tiers: Tier 1 (email recovery), Tier 2 (2-of-3 escrow), Tier 3 (self-custodial), security level endpoint, recovery initiation/completion flow
- Encrypted Attestations: private attestations with AES-256-GCM DEK encryption, commitment hashes, policy-based disclosure (Mode 1), time-limited viewing grants (Mode 2)
- Disclosure Proxy: time-limited grant redemption with session-scoped re-encryption, JSON watermarking for forensic traceability, disclosure audit logging
- Custodial Secret Storage: opaque encrypted blob storage per user per chain (`custodial_secrets`), upsert-safe, FK-cascaded on account delete, vault audit logging for all access
- SDK `loginWithExternalSession`: inject iron-session tokens into client without login flow — enables server-side Next.js/grvty-web usage with no custom XRPC wrappers
- Cross-PDS service-auth (atproto inter-service JWTs): `com.atproto.server.getServiceAuth` mints outbound JWTs; inbound ES256K/ES256 JWTs verified against the issuer DID's atproto signing key (did:plc + did:web), cached 5 min, replay-protected, per-DID rate limited — lets Bluesky / federated users authenticate to `net.openfederation.*` endpoints without a local session
- Progressive-custody wallets: a single DID anchors many per-chain wallets, each at one of three custody tiers. Tier 1 (`custodial`) — PDS holds the key encrypted at rest, signs server-side per explicit per-dApp consent with expiry. Tier 2 (`user_encrypted`) — SDK wraps a BIP-39 mnemonic under the user's passphrase; the PDS stores an opaque blob it can never decrypt. Tier 3 (`self_custody`) — client keeps mnemonic offline, PDS holds only the public link. All three share one `wallet_links` substrate and the same EIP-191 / Ed25519 proof-of-control, so addresses remain stable across future tier upgrades
- Wallet transaction signing + ecosystem adapters: `wallet.signTransaction` endpoint signs EIP-1559/legacy EVM transactions (chainId required — replay-safe) and Solana transaction-message bytes at Tier 1 with consent gating. SDK: `client.wallet.signTransaction` (tier-dispatched), `client.wallet.asEthersSigner()` produces an ethers v6 Signer drop-in, `client.wallet.asSolanaSigner()` duck-types on `@solana/web3.js` Transaction / VersionedTransaction. `ethers` is an optional peerDependency — dynamic-imported, kept out of the SDK bundle
- Sign-In With OpenFederation (SIWOF): CAIP-122 / SIWE-compatible sign-in flow. `signInChallenge` issues a canonical message scoped to a dApp audience; `signInAssert` verifies the wallet signature and mints a didToken (service-auth JWT signed by the user's atproto key) plus a walletProof. Both are offline-verifiable — any dApp can confirm authenticity via standard W3C DID resolution without calling OpenFederation. SDK `client.signInWithOpenFederation(...)` runs the full flow in one call (tier-aware); `verifySignInAssertion()` is the pure offline verifier (did:plc + did:web resolver, ES256K/ES256 JWT + EIP-191/Ed25519 wallet signatures)

**TODO for Full Production:**
- Blob storage for avatars and banners
- Email verification

### Important Notes

- **AT Protocol Libraries:** The codebase uses `@atproto/crypto`, `@atproto/identity`, `@atproto/repo`, and `@atproto/common-web`. We use `TID.nextStr()` from `@atproto/common-web` for ATProto-compliant TID generation and `cidForRecord()` from `@atproto/repo` for content-addressed CIDs.
- **PLC DIDs:** Real PLC DID registration via `src/identity/plc-client.ts`. Implements the PLC protocol directly using `@ipld/dag-cbor` and `@atproto/crypto`. For local development, run `npm run plc:dev` to start a PLC directory on port 2582. Production uses `PLC_DIRECTORY_URL` (e.g., `https://plc.openfederation.net`).
- **User Identity:** Registration creates a real `did:plc` identity with signing key and an initial `app.bsky.actor.profile` repo record. The PDS holds both rotation and signing keys for users. User signing keys are stored in the `user_signing_keys` table (separate from community `signing_keys`).
- **Security:** Recovery keys and signing keys are encrypted at rest using AES-256-GCM with PBKDF2-derived keys. The `KEY_ENCRYPTION_SECRET` environment variable must be set before creating communities.
- **Token Security:** Refresh token rotation with reuse detection. If a previously-rotated token is reused, all sessions for that user are automatically revoked (compromise response).
- **Auto-Schema Migration:** The PDS automatically initializes the database schema on first startup if the `users` table doesn't exist. No manual `psql` runs needed for fresh deploys.
- **E2E Tests:** Require PLC directory running (`npm run plc:dev`) and a seeded database. See `tests/README.md` for full setup guide.

### Lexicon Revision Policy

Every `src/lexicon/*.json` file must contain a `"revision"` integer field (>= 1) placed after the `"id"` field.
Bump `revision` by 1 whenever a schema's inputs, outputs, or errors change — additions and breaking changes alike.
New schemas start at `"revision": 1`.
Run `npm run lexicon:validate` before committing lexicon changes to confirm all files are valid.
The docs builder (`npm run build:lexicon-docs`) includes the revision number next to each schema heading.

---

## 1. Technology Stack

*   **Language:** TypeScript (ESM)
*   **Runtime:** Node.js >= 18
*   **Framework:** Express.js 5 (for handling XRPC routing)
*   **Database:** PostgreSQL (for storing user data, repository state, and encrypted keys)
*   **AT Protocol Libraries:**
    *   `@atproto/api` - Client library for ATProto and Bluesky
    *   `@atproto/crypto` - Cryptographic key management (Secp256k1, P256)
    *   `@atproto/identity` - DID resolution and identity handling
    *   `@atproto/repo` - Repository, MST implementation, and `cidForRecord()`
    *   `@atproto/common-web` - ATProto TID generation
    *   `@atproto/lexicon` - Lexicon schema language
    *   `@atproto/xrpc` - XRPC protocol implementation
    *   `multiformats` - Multiformat encoding (CID, multibase, etc.)
*   **Security:**
    *   `bcryptjs` - Password hashing
    *   `jsonwebtoken` - JWT access tokens
    *   `express-rate-limit` - Endpoint rate limiting
    *   Node.js `crypto` - AES-256-GCM key encryption, PBKDF2 key derivation

---

## 2. Project Structure

```
/openfederation-pds
|-- /cli               # CLI tool (pds-cli.ts)
|-- /plc-server        # Standalone PLC directory service for Railway
|-- /scripts           # Database init and migration scripts
|-- /src
|   |-- /api           # XRPC method implementations
|   |-- /auth          # Authentication, guards, tokens, encryption, utils
|   |-- /db            # Database client, schema, audit logging
|   |-- /identity      # DID creation, key management, domain validation
|   |-- /repo          # Repository (MST) engine with ATProto TID/CID
|   |-- /server        # Express server, XRPC routing, rate limiting
|   |-- /lexicon       # JSON definitions of custom schemas
|   |-- config.ts      # Server configuration
|   |-- index.ts       # Main application entry point
|-- /packages
|   |-- /openfederation-sdk  # @openfederation/sdk — vanilla JS SDK for 3rd-party apps
|       |-- /src             # TypeScript source (client, auth, storage, types, errors, utils)
|       |-- /dist            # Build output (ESM, CJS, IIFE)
|       |-- tsup.config.ts   # Build config (esbuild-based)
|-- /web-interface     # Next.js 15 web UI (Ozone-style admin dashboard)
|   |-- /src
|   |   |-- /app           # Next.js App Router pages
|   |   |   |-- /(auth)    # Login/register (unauthenticated)
|   |   |   |-- /(dashboard) # Authenticated pages with sidebar shell
|   |   |       |-- /admin    # Admin pages (users, communities, invites, audit)
|   |   |       |-- /communities  # Community list and detail ([did])
|   |   |       |-- /explore      # Public community discovery
|   |   |       |-- /settings     # Account settings
|   |   |-- /components    # UI components (shell, data-table, shared)
|   |   |-- /hooks         # React Query hooks (use-communities, use-admin, use-audit)
|   |   |-- /lib           # API client, types, utilities
|   |   |-- /providers     # QueryProvider, CommandPaletteProvider
|   |   |-- /store         # Zustand auth store
|-- package.json
|-- tsconfig.json
|-- .env
```

---

## 3. API Endpoints

### ATProto Standard

| Method | NSID | Auth | Description |
|:---|:---|:---|:---|
| POST | `com.atproto.server.createSession` | No | Login (returns access + refresh tokens) |
| POST | `com.atproto.server.refreshSession` | Yes | Rotate refresh token (reuse detection) |
| GET  | `com.atproto.server.getSession` | Yes | Get current session info |
| POST | `com.atproto.server.deleteSession` | Yes | Logout / invalidate session |
| GET  | `com.atproto.server.getServiceAuth` | Yes | Mint short-lived ES256K JWT signed by the caller's atproto key for outbound cross-PDS auth |
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

### OpenFederation Account Management

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

### OpenFederation Session Management

| Method | NSID | Auth | Description |
|:---|:---|:---|:---|
| GET | `net.openfederation.account.listSessions` | Yes | List active sessions (admin can query by DID) |
| POST | `net.openfederation.account.revokeSession` | Yes | Revoke session by ID or revoke all |
| POST | `net.openfederation.account.requestPasswordReset` | No | Request password reset email |
| POST | `net.openfederation.account.confirmPasswordReset` | No | Confirm reset with token + new password |
| GET  | `net.openfederation.account.getSecurityLevel` | Yes | Get recovery tier and security checklist |
| POST | `net.openfederation.account.initiateRecovery` | No | Start identity recovery (email-based) |
| POST | `net.openfederation.account.completeRecovery` | No | Complete recovery with token + new password |

### OpenFederation Community Management

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
| GET  | `net.openfederation.community.listMembers` | Yes | List community members |
| GET  | `net.openfederation.community.listJoinRequests` | Owner/Admin | List pending join requests |
| POST | `net.openfederation.community.resolveJoinRequest` | Owner/Admin | Approve or reject a join request |
| GET  | `net.openfederation.community.export` | Owner/Admin | Export community data as JSON archive |
| POST | `net.openfederation.community.suspend` | Admin | Suspend a community |
| POST | `net.openfederation.community.unsuspend` | Admin | Unsuspend a community |
| POST | `net.openfederation.community.takedown` | Admin | Take down a community (requires prior export) |
| POST | `net.openfederation.community.transfer` | Owner | Generate transfer package for migration (owner-only per AT Protocol) |
| POST | `net.openfederation.community.updateMemberRole` | Owner/Admin | Change a member's role (moderator/member) |
| POST | `net.openfederation.community.issueAttestation` | Owner/Mod | Issue a signed attestation for a member |
| POST | `net.openfederation.community.deleteAttestation` | Owner/Mod | Revoke an attestation (delete-as-revoke) |
| GET  | `net.openfederation.community.listAttestations` | No | List attestations by community/subject/type |
| GET  | `net.openfederation.community.verifyAttestation` | No | Verify an attestation exists (record existence = validity) |
| POST | `net.openfederation.attestation.requestDisclosure` | Yes | Request disclosure of a private attestation (policy-based) |
| POST | `net.openfederation.attestation.createViewingGrant` | Yes | Create time-limited viewing grant (subject-only) |
| GET  | `net.openfederation.attestation.verifyCommitment` | No | Verify commitment hash without revealing content |

### OpenFederation Disclosure Proxy

| Method | NSID | Auth | Description |
|:---|:---|:---|:---|
| POST | `net.openfederation.disclosure.redeemGrant` | Yes | Redeem viewing grant (decrypt + watermark + re-encrypt) |
| GET  | `net.openfederation.disclosure.grantStatus` | Yes | Check grant status and access count |
| POST | `net.openfederation.disclosure.revokeGrant` | Yes | Revoke a viewing grant early (subject-only) |
| GET  | `net.openfederation.disclosure.auditLog` | Yes | View disclosure audit trail |

### OpenFederation Oracle Management

| Method | NSID | Auth | Description |
|:---|:---|:---|:---|
| POST | `net.openfederation.oracle.createCredential` | Admin | Create Oracle credential for a community |
| GET | `net.openfederation.oracle.listCredentials` | Admin | List Oracle credentials |
| POST | `net.openfederation.oracle.revokeCredential` | Admin | Revoke an Oracle credential |
| POST | `net.openfederation.oracle.submitProof` | Oracle | Submit governance proof for on-chain verification |

### OpenFederation Vault

| Method | NSID | Auth | Description |
|:---|:---|:---|:---|
| POST | `net.openfederation.vault.requestShareRelease` | Yes | Release vault share after identity verification |
| POST | `net.openfederation.vault.registerEscrow` | Yes | Register external escrow provider for Share 3 |
| POST | `net.openfederation.vault.exportRecoveryKey` | Yes | Export vault share for self-custody (elevated verification) |
| GET  | `net.openfederation.vault.auditLog` | Yes | View vault audit log entries |
| POST | `net.openfederation.vault.storeCustodialSecret` | Yes | Store opaque encrypted blob (e.g. wallet mnemonic) per chain; upsert |
| GET  | `net.openfederation.vault.getCustodialSecret` | Yes | Retrieve encrypted blob for a given chain |

### OpenFederation Identity Bridge

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

### OpenFederation Progressive-Custody Wallets

| Method | NSID | Auth | Description |
|:---|:---|:---|:---|
| POST | `net.openfederation.wallet.provision` | Yes | Tier 1 only: PDS generates a wallet, encrypts the key at rest, links the address to the caller's DID |
| POST | `net.openfederation.wallet.sign` | Yes | Tier 1 only: sign a message with a custodial wallet; requires `X-dApp-Origin` header or body `dappOrigin` and an active consent grant |
| POST | `net.openfederation.wallet.signTransaction` | Yes | Tier 1 only: sign an EVM transaction (returns signed RLP) or Solana message bytes (returns base58 signature); same consent + tier gate as `wallet.sign` |
| POST | `net.openfederation.wallet.grantConsent` | Yes | Grant a dApp origin time-bounded permission to sign with Tier 1 wallet(s); default 7-day TTL, max 30-day |
| POST | `net.openfederation.wallet.revokeConsent` | Yes | Revoke consent by id or by (dappOrigin, chain?, walletAddress?) scope |
| GET  | `net.openfederation.wallet.listConsents` | Yes | List the caller's active (unrevoked, unexpired) Tier 1 signing consents |

### OpenFederation Partner API

| Method | NSID | Auth | Description |
|:---|:---|:---|:---|
| POST | `net.openfederation.partner.register` | X-Partner-Key | Register user (no invite, auto-approved, returns tokens) |
| POST | `net.openfederation.partner.createKey` | Admin | Generate a new partner API key (shown once) |
| GET  | `net.openfederation.partner.listKeys` | Admin | List all partner keys with stats |
| POST | `net.openfederation.partner.revokeKey` | Admin | Revoke a partner key |

### OpenFederation Admin

| Method | NSID | Auth | Description |
|:---|:---|:---|:---|
| GET  | `net.openfederation.audit.list` | Admin | List audit log entries with filters |
| GET  | `net.openfederation.server.getConfig` | Admin | Get server config and stats |
| POST | `net.openfederation.admin.createVerificationChallenge` | Admin | Send identity verification nonce to user |
| POST | `net.openfederation.admin.verifyChallenge` | Admin | Verify nonce response from user |

---

## 4. Database Schema (PostgreSQL)

See `src/db/schema.sql` for the full schema. Key tables (22 total):

| Table | Purpose |
|-------|---------|
| `users` | Account information (handle, email, password hash, status, DID, lifecycle columns) |
| `user_roles` | Role assignments (admin, moderator, partner-manager, auditor, user) |
| `invites` | Invite codes with max uses and expiration |
| `sessions` | Refresh token hashes with reuse detection (`previous_token_hash`) |
| `communities` | Community metadata (DID, handle, DID method, creator) |
| `plc_keys` | Encrypted recovery keys for `did:plc` communities |
| `signing_keys` | Encrypted signing keys for community repos |
| `user_signing_keys` | Encrypted signing keys for user repos |
| `repo_blocks` | Raw repository blocks addressed by CID (communities and users) |
| `repo_roots` | Root CID and current revision per DID |
| `records_index` | Fast record lookup by (community_did, collection, rkey) |
| `members_unique` | Enforces one membership per DID per community |
| `commits` | Commit history per repository |
| `join_requests` | Join request workflow (pending/approved/rejected) |
| `audit_log` | Structured audit log for admin and security actions |
| `partner_keys` | Partner API keys (hashed) with origin restrictions, rate limits, stats |
| `blobs` | Binary large object storage (avatars, banners, files) |
| `export_schedules` | Automated community export schedules |
| `export_snapshots` | Export snapshot history and status |
| `password_reset_tokens` | Password reset tokens (SHA-256 hashed, time-limited) |
| `ap_signing_keys` | Persisted RSA signing keys for ActivityPub actors |
| `oracle_credentials` | Oracle API credentials for on-chain governance (per-community scoped) |
| `proof_verifications` | Cached on-chain governance proof verification results |
| `wallet_links` | Cryptographically verified wallet-to-DID bindings |
| `wallet_link_challenges` | Ephemeral wallet link challenges (5-min TTL) |
| `vault_shares` | Encrypted Shamir key shares for threshold recovery |
| `vault_audit_log` | Append-only audit trail for vault operations |
| `escrow_providers` | Registered third-party key custodians |
| `recovery_attempts` | Identity recovery attempt tracking (token-based, time-limited) |
| `attestation_encryption` | Private attestation DEK metadata and access policies |
| `viewing_grants` | Time-limited disclosure grants for private attestations |
| `disclosure_sessions` | Active grant redemption sessions with session key hashes |
| `disclosure_audit_log` | Forensic audit trail for all disclosure events |
| `custodial_secrets` | Opaque encrypted blobs per user per chain (UNIQUE user_did+chain, FK cascade on delete) |

### Migration Scripts

Schema is auto-initialized on first startup. Incremental migrations are applied manually:

`scripts/migrate-001-repo-roots.sql`, `scripts/migrate-002-user-signing-keys.sql`, `scripts/migrate-003-oauth.sql`, `scripts/migrate-004-partner-keys.sql`, `scripts/migrate-005-user-lifecycle.sql`, `scripts/migrate-006-rbac-roles.sql`, `scripts/migrate-007-blobs.sql`, `scripts/migrate-008-export-schedules.sql`, `scripts/migrate-009-login-protection.sql`, `scripts/migrate-010-password-reset.sql`, `scripts/migrate-011-ap-keys.sql`, `scripts/migrate-012-invite-binding.sql`, `scripts/migrate-013-oracle-credentials.sql`, `scripts/migrate-014-proof-verifications.sql`, `scripts/migrate-015-wallet-links.sql`, `scripts/migrate-016-vault-shares.sql`, `scripts/migrate-017-recovery-tiers.sql`, `scripts/migrate-018-encrypted-attestations.sql`, `scripts/migrate-019-disclosure-sessions.sql`, `scripts/migrate-020-custodial-secrets.sql`, `scripts/migrate-021-wallet-custody.sql`, `scripts/migrate-022-signin-challenges.sql`

---

## 5. Security

### Authentication
- JWT access tokens (configurable TTL, default 15m)
- Refresh tokens: random 64-byte hex strings, SHA-256 hashed in DB
- Refresh token rotation with **reuse detection**: if a rotated-out token is replayed, all user sessions are revoked
- Roles re-validated from DB on every token refresh
- Cross-PDS service-auth JWTs (ES256K / ES256): verified against the issuer DID's atproto signing key via `@atproto/identity` DID resolver with 5-min cache; signature-based replay cache; per-DID rate limit (default 60/min, `SERVICE_AUTH_RATE_LIMIT`); local users keep roles, external callers get `authMethod: 'service-auth'` with empty roles and `status: 'approved'`. Service DID defaults to `did:web:{PDS_HOSTNAME}`, overridable via `PDS_SERVICE_DID`

### Key Management
- Recovery keys and signing keys encrypted at rest using AES-256-GCM
- Encryption key derived via PBKDF2 (100,000 iterations, SHA-512) from `KEY_ENCRYPTION_SECRET`
- Primary rotation key returned to user once and never stored

### Rate Limiting
- Global: 120 requests/minute per IP
- Authentication: 20 attempts per 15 minutes per IP
- Registration: 5 per hour per IP
- Community creation: 10 per hour per IP

### Login Protection
- Failed login attempts tracked per account in the `users` table
- After 5 failures: 1-minute lockout, 10: 5 minutes, 15: 30 minutes, 20+: 2 hours
- Counter resets on successful login
- All failed login attempts logged to `audit_log` with reason, identifier, and IP
- Content-Security-Policy header set on all responses

### Validation
- Handles: 3-30 chars, lowercase alphanumeric + hyphens, no leading/trailing/consecutive hyphens, reserved name blocklist
- Passwords: 10-128 chars, must contain 3 of 4 categories (lowercase, uppercase, digit, special)
- Domains (did:web): valid hostname format, no protocol prefix
- Request body: 256kb limit
- Error messages: sanitized (no internal state leakage)

### Audit Logging
All admin and security-relevant actions are logged to the `audit_log` table with actor, target, action type, and metadata.

---

## 6. Security Imperatives

*   **NEVER store the user's primary `did:plc` rotation key.** It must be returned upon creation and then discarded from memory.
*   **Encrypt the server's secondary recovery key at rest** in the database using `KEY_ENCRYPTION_SECRET`.
*   **Set `AUTH_JWT_SECRET`** to a cryptographically random string of at least 32 characters. The server refuses to start in production without it.
*   **Set `KEY_ENCRYPTION_SECRET`** before creating any communities. Required in production.
*   Rate limiting is applied to all endpoints with stricter limits on authentication and registration.

---

## 7. CLI Tool

The CLI (`cli/pds-cli.ts`) provides command-line access to all major operations:

- `login` / `logout` / `whoami` - Session management
- `health` / `info` - Server status
- `create-invite` / `list-pending` / `approve-user` / `reject-user` - User management
- `create-community` / `get-record` - Community operations
- `sessions list` / `sessions revoke` / `sessions revoke-all` - Session management
- `security check-config` / `security audit-summary` - Security diagnostics
- `oracle create` / `oracle list` / `oracle revoke` - Oracle credential management (admin)
- `account change-password` - Change password (interactive prompts)
- `account verify` / `account verify-confirm` - Admin identity verification

All requests have a configurable timeout (default 30s). Session credentials are stored locally in `.pds-cli/session.json` with restrictive file permissions. See `cli/README.md` for full documentation.

---

## 8. Multi-Repo Coordination

### Ownership

This repository owns **the OpenFederation PDS API server, the `@openfederation/sdk` vanilla JS SDK, the PLC directory service, and the Web UI admin dashboard**.
Any bugs, features, or refactors related to the above are this agent's responsibility to fix directly.

### Dependencies from sibling repositories

This repository has **no dependencies on sibling repos**. It is the upstream identity/auth provider for the project.

### Downstream consumers

The following sibling repos depend on packages owned by this repo:

- **grvty-leaderboards** ([repo](https://github.com/athlon-misa/grvty-leaderboards)) — uses `@openfederation/sdk` via `@grvty/identity` for user authentication and partner registration
- **FlappySoccer** ([repo](https://github.com/athlon-misa/flappysoccer)) — uses `@openfederation/sdk` (IIFE bundle at `/sdk/v1.js`) for user registration and login

### Cross-repo routing rules

When you encounter a bug or need a feature change in a downstream consumer:

1. **Do NOT attempt to fix it in this repository.** Changes to game logic, leaderboard services, etc. belong in their respective repos.
2. **Draft a GitHub issue** targeting the correct downstream repository if a change here would break them.
3. **Always ask the user for confirmation** before filing the issue. Show them the full issue preview.

### Receiving cross-repo issues

If you see issues labeled `cross-repo` filed against this repository:
- These were created by agents working in sibling repos that hit a problem with the PDS API or SDK
- Treat them as high-priority bug reports or feature requests
- When creating a PR to fix them, reference the original issue number
- After fixing, notify the user so the downstream repo can update its dependency

### Issue filing

Use `gh issue create` with these defaults:
- **Labels:** `cross-repo`, plus `bug`, `enhancement`, or `breaking-change` as appropriate
- **Body:** Always include: consumer repo name + URL, SDK version, reproduction steps, expected vs actual behavior

### Project topology

This repo is part of a multi-repo project:
- [OpenFederationPDS](https://github.com/athlon-misa/openfederation-pds) — Identity platform, PDS API, `@openfederation/sdk`
- [grvty-leaderboards](https://github.com/athlon-misa/grvty-leaderboards) — Leaderboard microservice with OpenFederation auth
- [FlappySoccer](https://github.com/athlon-misa/flappysoccer) — Browser game consuming both OpenFederation auth and leaderboard API

Manifest file: `.multi-repo-manifest.json` (machine-readable topology)
