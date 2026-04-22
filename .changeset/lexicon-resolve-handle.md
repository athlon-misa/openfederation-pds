---
"@open-federation/lexicon": patch
---

Add `com.atproto.identity.resolveHandle` lexicon (closes #52).

Standard AT Protocol method for handle → DID resolution. Query takes a single `handle` parameter, returns `{ did }`, or `HandleNotFound` if the handle isn't registered on the PDS.

The OpenFederation PDS was previously missing this conformance endpoint, which blocked local-first bare-handle login flows in consumer apps and "did you mean …" UX. The new lexicon matches the upstream spec verbatim (https://atproto.com/specs/handle) — no OpenFederation-specific fields.
