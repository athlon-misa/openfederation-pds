# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
