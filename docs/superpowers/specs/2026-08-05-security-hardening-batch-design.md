# Security Hardening Batch

## Scope

This batch resolves GitHub issues #100, #102, #127, and #130 in three
independent workstreams. The full crash-atomic governance workflow is
explicitly deferred to #188.

## Governance vote serialization (#100)

Acquire a PostgreSQL advisory lock scoped to `(communityDid, proposalRkey)`
before reading or changing a proposal. Hold the lock through the proposal
decision and any target mutation, then release it in `finally`. This makes a
quorum-crossing transition single-writer across PDS processes, so a later vote
observes the first terminal decision instead of computing from stale arrays.

The endpoint keeps its existing XRPC shape, authorization, audit events, and
AT Protocol repository writes. A concurrency regression test demonstrates that
opposite simultaneous quorum-crossing votes cannot apply a proposal whose
durable outcome is rejected.

## Dashboard session revocation (#102)

Add a web API helper for `com.atproto.server.deleteSession`, accepting the
current refresh JWT. Change dashboard logout to await this best-effort server
revocation and always clear browser state in `finally`. Update all logout
callers to await the new asynchronous operation. Test that a copied refresh
token cannot be redeemed after logout.

## Federation peer fetch and cache bounds (#127, #130)

Create one internal peer-fetch seam used by both peer-info and peer-community
refreshes. It validates the configured peer URL using the existing outbound
HTTPS guard, fetches with `redirect: 'error'`, retains the current timeout,
and reads response text through the existing byte-limited reader before JSON
parsing.

The community path caps valid entries per peer and across the cache before
mapping/retaining them. Peer-info results remain bounded by configured peers.
Malformed, oversized, redirected, non-public, or failed peer responses are
treated as an unhealthy/empty peer response and never populate caches.

## Out of scope

- Authenticated dApp identity for custodial wallet signing (#101).
- SDK `did:web` resolver SSRF hardening (#97).
- Crash-atomic proposal decision plus target mutation (#188).
- Schema, lexicon, or SDK API changes.

## Verification

- Unit/API concurrency coverage for proposal resolution.
- API/UI coverage for logout revocation.
- Peer-cache tests for redirects, oversized streamed bodies, and oversized
  arrays.
- Security suite, affected API tests, and build on Node 22.
