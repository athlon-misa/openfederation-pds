# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
