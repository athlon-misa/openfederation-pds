# @open-federation/lexicon

## 0.4.0

### Minor Changes

- 13cc1b5: Export generated TypeScript types for BFF consumers.

  `@open-federation/lexicon` now exports all `Net*Input`, `Net*Output`, and `Net*Error` types derived from the `net.openfederation.*` lexicon schemas. The PDS-internal maps (`LexiconInputMap`, `LexiconOutputMap`, `LexiconErrorMap`) are intentionally excluded.

  BFF consumers can now import authoritative types instead of hand-authoring them:

  ```ts
  import type { NetOpenfederationContactListOutput } from "@open-federation/lexicon";
  type Contact = NetOpenfederationContactListOutput["contacts"][number];
  ```

  `build:lexicon` now runs `lexicon:generate` as a prerequisite so the types file is always up-to-date with the JSON schemas before the package builds.

## 0.3.0

### Minor Changes

- f4fcee0: Sync schemas with `src/lexicon/` after the architecture review (issues #54–#60).

  ### Headline

  - **Extended:** `net.openfederation.community.get` output gains an optional `myMembership` field carrying the caller's Membership shape — `status`, `role`, `roleRkey`, `kind`, `tags`, `attributes`, `joinRequestStatus` (closes consumer N+1 calls; see #56). Schema revision bumped to 2; the field is optional, so existing readers keep working.

  ### Other lexicon updates absorbed in this bump

  Schemas touched by the typed-XRPC-errors work (#54) and related lifecycle / wallet / vault work — added or tightened declared error codes, `revision` bumps where shape changed:

  - Community: `join`, `update`, `updateMember`, `updateRole`, `revokeDelegation`, `setDelegation`, `setGovernanceModel`
  - Account: `register`, `getSecurityLevel`, `listSessions`
  - Admin: `deleteExportSchedule`, `importRepo`
  - Vault / Wallet: `vault.getCustodialSecret`, `wallet.finalizeTierChange`, `wallet.retrieveForUpgrade`, `wallet.sign`

  All changes are additive at the schema level; readers that ignore unknown fields and treat declared error codes as a closed-but-extensible set are unaffected.

  ### Why a republish was needed

  `packages/openfederation-lexicon/schemas/` is regenerated from `src/lexicon/` by `pnpm build:lexicon` and gitignored. The architecture-review commit (`cc3bfa6`) modified `src/lexicon/` but no changeset was added, so the release pipeline didn't ship the changes. This changeset corrects that.

  ### Consumer impact

  - `@grvty/api-client` consumers in `grvty-web` already read the `myMembership` field via the BFF — no consumer-side action required for that path.
  - SDK and React packages are unchanged (no source-dir commits since `0.2.0` / `0.1.1`); not bumping.

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
