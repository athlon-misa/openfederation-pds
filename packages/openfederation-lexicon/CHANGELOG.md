# @open-federation/lexicon

## 0.2.1

### Patch Changes

- 40177bb: Add `com.atproto.identity.resolveHandle` lexicon (closes #52).

  Standard AT Protocol method for handle → DID resolution. Query takes a single `handle` parameter, returns `{ did }`, or `HandleNotFound` if the handle isn't registered on the PDS.

  The OpenFederation PDS was previously missing this conformance endpoint, which blocked local-first bare-handle login flows in consumer apps and "did you mean …" UX. The new lexicon matches the upstream spec verbatim (https://atproto.com/specs/handle) — no OpenFederation-specific fields.

## 0.2.0

### Minor Changes

- c509f92: Semantic member classification and `updateMember` procedure (closes #50).

  ### What changed

  - **New:** `net.openfederation.community.updateMember` — partial update of member records, accepts any subset of `role`, `roleRkey`, `kind`, `tags`, `attributes`. Null clears an optional field.
  - **Removed:** `net.openfederation.community.updateMemberRole` — replaced by the more general `updateMember`. Consumers that called the old NSID (or imported `nsids.CommunityUpdateMemberRole`) must migrate.
  - **Extended:** `net.openfederation.community.listMembers` `#member` object gains optional `roleRkey`, `kind`, `tags`, `attributes`. The required fields remain `did`, `handle`, `role`, `joinedAt`, so existing readers keep working.
  - **Extended:** `net.openfederation.community.join` input gains optional `kind`, `tags`, `attributes` so semantic metadata can be set at join time.

  ### Why

  Consumers building community pages (clubs, charities, research collectives) need to distinguish _kinds_ of members — players vs. staff vs. fans — and attach kind-specific metadata without reinventing the taxonomy. These fields are identity-shaped; putting them at the lexicon layer lets them travel with the identity across PDSes.

  ### Consumer vocabulary, not PDS vocabulary

  The PDS does not validate `kind` strings or `attributes` shapes. It only enforces bounds:

  - `kind`: <= 64 chars
  - `tags`: <= 20 items, each <= 64 chars
  - `attributes`: <= 4096 bytes serialized

  Apps own the vocabulary per domain.

  ### Migration

  For clients that used `community.updateMemberRole`:

  ```diff
  - xrpc('net.openfederation.community.updateMemberRole', {
  + xrpc('net.openfederation.community.updateMember', {
      communityDid, memberDid, role: 'moderator',
    });
  ```

  The shape of the input for the `role`-only case is identical; just change the NSID.
