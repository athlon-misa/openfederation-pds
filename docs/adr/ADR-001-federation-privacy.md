# ADR-001: Private communities are PDS-local

**Status:** accepted · **Date:** 2026-08-07 · **Issue:** #85

## Decision

Private communities do not federate. Their records, member lists, profile
content and repo bytes are served only through this PDS's membership-gated
endpoints, and are excluded from every surface an external consumer can
reach. This is issue #85's **option 1**, chosen over a trusted-peer
allowlist (option 2) and encrypted repos (option 3).

Discovery is **existence-visible, content-stripped**: webfinger resolves a
private community's handle and its ActivityPub actor exists, but the actor
carries no display name, no description and no linked-application
attachments, and webfinger advertises no profile page.

## Why

- **Existence is not protectable, so we do not pretend to protect it.** A
  `did:plc` community's DID and handle live in the public PLC directory by
  design; hiding them at this PDS while PLC hands them out would be theater.
  What lies past existence — content, membership, records — is protectable,
  and is protected.
- **Existence-visible discovery keeps deliberate integrations alive.**
  Linking an AP application is an explicit owner action, and the linked
  instances need the actor document for addressing and HTTP-signature
  verification. A 404 would break the integration the owner asked for; a
  stripped actor serves it without advertising the community's content or
  which instances back it.
- **Option 1 matches the code's existing posture.** Every repo read surface
  already gates on membership (`requireRepoReadable` /
  `requireCommunityReadable`, commit 831285b); `community.listAll` is
  hard-filtered to public in SQL; peer exchange requests public-only. The
  audit for this ADR found exactly two surfaces that had missed the posture
  — the AP actor route and webfinger's profile-page link — and both are now
  closed. Options 2 and 3 are design efforts against threats that need a
  second trusted deployment (2) or a key-distribution scheme in tension
  with "extend, never replace" (3); neither has a consumer today.

## Enforcement map

One predicate, `communityFederationView()` in `src/federation/privacy.ts`,
is the reference answer. Existing surfaces and where they enforce:

| Surface | Enforcement |
|---|---|
| `com.atproto.sync.getRepo`, `com.atproto.repo.*` | `requireRepoReadable` |
| community read endpoints (get, listMembers, forum, calendar…) | `requireCommunityReadable` / per-handler visibility checks |
| `net.openfederation.community.listAll` | public-only SQL filter |
| peer federation (`peer-cache`) | requests `visibility=public`; source filters regardless |
| `/ap/actor/:did` | `communityFederationView` — stripped when private |
| `/.well-known/webfinger` | `communityFederationView` — no content links when private |
| `/nodeinfo/2.1`, `getPublicConfig` | aggregate counts only, no per-community data |

`tests/api/federation-privacy.test.ts` walks every row of this table
against a real private community.

## The standing rule for future surfaces

**Any firehose, `subscribeRepos`, `listRepos`, relay announcement, or other
bulk/event surface MUST consult `src/federation/privacy.ts` and exclude
every DID whose view is `private`.** A private community's commits do not
enter an event stream. This is the load-bearing sentence of this ADR: the
issue exists because AT Protocol repos are public by design, and the moment
a relay surface ships without this exclusion, "private" silently regresses
to "public".

## Upgrade path (not chosen now)

Option 2 — federating private communities to OpenFederation peers that
attest to the same gating contract (mutual authentication + policy
attestation) — remains the designed upgrade if cross-PDS private
communities become a need. It layers on top of this decision: the default
stays "excluded", and attested peers would become a named exception in
`privacy.ts`. Option 3 (encrypted repos) is the only design that could
relax the firehose rule, and would be its own ADR.
