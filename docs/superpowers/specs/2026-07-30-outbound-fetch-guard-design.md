# Outbound Fetch Guard Design

## Goal

Block server-side requests to private or reserved network destinations while
preserving required AT Protocol DID and remote-PDS interoperability.

## Scope

This slice addresses #96, #103, #112, and #117. It covers PDS-side outbound
requests made while resolving service-auth issuers and federation DID/PDS
records. SDK-side resolution (#97) and resource/caching limits (#113, #114,
#118, #123) are separate slices.

## Design

Add `src/security/outbound-fetch.ts` as the only boundary for untrusted remote
URLs. It accepts an HTTPS URL, parses its authority with `URL`, rejects user
credentials and non-HTTPS schemes, resolves every DNS address, and rejects
loopback, private, link-local, unspecified, multicast, documentation, and
reserved IPv4/IPv6 ranges. It sends requests with `redirect: 'error'` and a
bounded timeout. Callers receive a typed rejection rather than a response.

`remote-verify.ts` will use this boundary for did:web documents, remote PDS
service endpoints, and remote records. A `did:web` identifier is converted to
an HTTPS URL before validation, so `host:port` is classified by its hostname,
not by an unparsed authority string.

The existing `@atproto/identity` resolver cannot inject this fetch policy.
For inbound service-auth, reject `did:web` issuers before passing them to that
resolver; `did:plc` remains supported through the configured PLC directory.
This blocks the exploitable untrusted did:web pre-signature fetch without
changing AT Protocol service-auth signatures or local authentication.

## Error Handling

Remote federation verification continues to return its established neutral
failure (`null`) on rejected destinations. Service-auth returns its existing
issuer-resolution failure. No internal address or DNS result is exposed.

## Tests

Unit tests cover parsed host-and-port input, private IPv4/IPv6 destinations,
and allowed public HTTPS URLs using a resolver seam. Integration tests prove a
forged service-auth token with a `did:web:localhost:port` issuer is rejected
before resolver invocation, and a remote DID document cannot select a private
PDS endpoint.
