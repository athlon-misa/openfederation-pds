# ADR-002: Community migration (#267)

**Status:** accepted · **Date:** 2026-10-29 · **Issue:** #267 · **Replaces:** `net.openfederation.community.transfer`

A community moves from one PDS to another the way accounts do (#261–#266): the
new home fills up first, the public directory is changed only once the new
home holds everything, and the old home keeps a closed copy. Three things make
a community different from an account, and this spec is about those three.

## Decisions

1. **The owner is a DID, not a local user.** `communities.owner_did` replaces
   `created_by` as the test of ownership (`created_by` stays as history). The
   owner may therefore live on any PDS and act on the community through
   cross-PDS service auth, which this PDS already accepts. Nobody has to move
   first.
2. **Keys.** The owner holds the community's primary rotation key (returned
   once, at creation) and signs the PLC update with it. The new PDS makes a
   fresh repo signing key and a fresh recovery key for the community and
   recommends both; the old PDS's recovery key drops out of the DID in that
   same update. The old PDS never learns the primary key.
3. **Private attestations keep working: their keys are re-wrapped.** Each
   private attestation's data key is wrapped under the old PDS's
   `KEY_ENCRYPTION_SECRET`. The old PDS hands the keys over *encrypted to the
   community's new repo signing key*, and only once the directory says the
   community lives elsewhere. So the keys go only to wherever the directory
   names as the community's home, no server has to trust another server's
   identity, and nothing is lost. (Issuing attestations again was the
   alternative: cheaper to build, but every private attestation a community
   ever issued would be gone, and grants and commitments with them.)
4. **The old side is marked `moved`**, refuses writes, keeps serving reads
   until the owner deletes it, and is never deleted automatically.
   `community.transfer` is removed; the dashboard's Transfer action becomes
   Move (UI is a follow-up).

## The flow

The new PDS pulls; the owner only proves control and signs. Every fetch from
the old PDS is a public, signature-checked read (`sync.getRepo`,
`sync.listBlobs`, `sync.getBlob`), so the old PDS needs no cooperation beyond
staying online.

| Step | Where | What |
|---|---|---|
| open | new | `net.openfederation.community.migrateIn { did, handle, fromPds }`. Proof: a JWT signed by one of the community's PLC rotation keys (the owner's primary), `aud` = new PDS service DID, `lxm` = this method, short-lived, single use, like `createAccount` for pseudonyms. Gate: `MIGRATION_COMMUNITIES` (`open` / `invite` / `closed`, default `invite`; invite claimed by the owner's DID). Creates the `communities` row with `status = 'importing'`, `owner_did` = `iss`, a fresh signing key and a fresh recovery key, then pulls the repo CAR from `fromPds`, verifies it against the DID's **current** atproto key, stores it in one transaction, rebuilds the derived tables, and pulls every referenced blob. Returns `{ did, handle, recommended }` where `recommended` is what to put in the DID. Repeatable: a second call refreshes the copy. |
| check | new | `net.openfederation.community.checkMigration { did }` → `{ status, repoCommit, indexedRecords, members, attestations, expectedBlobs, importedBlobs, validDid, recommended }`. |
| point | owner | Signs the PLC update with the primary rotation key: `rotationKeys = [primary, new recovery]`, `verificationMethods.atproto` = new signing key, `services.atproto_pds` = new PDS, `alsoKnownAs` = the handle at the new PDS. The client refuses to sign until `check` reports the exact exported commit and all blobs. |
| activate | new | `net.openfederation.community.activate { did }` (owner). Requires the DID to point here. Fetches `net.openfederation.community.getMovedKeys { did }` from `fromPds`, decrypts with the community's signing key, re-wraps every data key under this PDS's secret, writes `attestation_encryption`, sets `status = 'active'`. If the old PDS is unreachable the community still activates; the keys can be fetched again later (`activate` is repeatable while any attestation's keys are missing). |
| retire | old | On `getMovedKeys`, and on the weekly sweep, the old PDS sees the DID pointing elsewhere and sets `status = 'moved'`. The owner can also call `net.openfederation.community.markMoved { did }`. |

`net.openfederation.community.getMovedKeys { did }` is public: it answers only
when the PLC directory names another PDS as the community's home, and what it
returns is readable only by the holder of the DID's current atproto key
(ECIES: secp256k1 ECDH with an ephemeral key, HKDF-SHA256, AES-256-GCM, using
Node's `crypto`). It carries `attestation_encryption` rows for the community
(issuer and subject data keys, commitment hash and salt, issuer signature,
schema hash, access policy). Viewing grants and the disclosure audit log are
not carried: grants are short-lived and subjects can grant again; the audit
log is the old PDS's record of what it disclosed.

## Ownership by DID

- `owner_did` is backfilled from `created_by → users.did`.
- `isOwner` everywhere (`guards.ts` `requireCommunityRole`, `community.get`,
  `update`, `delete`, `export`, `requestDisclosure`, `disclosure.auditLog`)
  becomes `community.owner_did === req.auth.did`. A service-auth caller has
  `req.auth.did` and empty roles, so an owner on another PDS passes the owner
  test and nothing else.
- `community.create` sets both `created_by` and `owner_did`.

## Derived tables, rebuilt from records on import

| Table | Source |
|---|---|
| `records_index` | every record (already done by `storeRepoImport`) |
| `members_unique` | `net.openfederation.community.member` records, the same projection `RepoEngine.syncRecordsIndex` applies on write, then `fanOutDisplayFields` for display names |
| `community_attestation_index` | `net.openfederation.community.attestation` records (public claim or `null` for private), via the same `indexAttestation` the issue path uses |
| `attestation_encryption` | carried over by `getMovedKeys` (not derivable) |
| `commits` | not rebuilt; it is history of local writes |
| `join_requests`, `export_*`, `viewing_grants`, `disclosure_audit_log`, `forum_*`, `oracle_credentials` | stay on the old PDS; forum tables mirror records and are rebuilt by their own handlers as records are read (out of scope here, noted in the status doc) |

The rebuild runs in the import transaction, so a failed import leaves the
community `importing` with its previous copy intact.

## Old side

- `communities.status` gains `importing` and `moved`. `moved` is refused by
  every write the way `suspended` is (`requireActiveCommunity` and the status
  checks in handlers), reads keep working, `listAll` hides it.
- No automatic deletion. `community.delete` by the owner (service auth or
  local) removes the closed copy.
- The weekly sweep (#265) also marks communities `moved` when their DID
  points elsewhere. An `importing` community whose move never finished is
  not swept: it is harmless, and it is deleted only by its owner.

## did:web communities

Same flow without the PLC step: the owner updates the DID document to the new
signing key and endpoint. `migrateIn` resolves the DID through the resolver
instead of the PLC log. Not covered by the E2E in this slice.

## Tests

- Unit: ECIES round trip; `buildCommunityMoveOp`.
- API (single PDS): `migrateIn` gate and proof; rebuild of members and
  attestations from a CAR; `getMovedKeys` refuses while the DID points here,
  answers once it does not, and what it returns decrypts only with the new
  key; owner-by-DID through service auth.
- E2E (two PDSes): a community with members, a public and a private
  attestation and an avatar moves from A to B; on B `listMembers`,
  `listAttestations` and `requestDisclosure` match; A shows `moved` and
  refuses a write; the owner's account never leaves A.

## Not in this slice

- Dashboard "Move community" screen (replaces Transfer).
- Forum projection tables for moved communities.
- Owner-side deletion of a moved copy from the dashboard.
