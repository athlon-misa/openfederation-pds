# Whitepaper Deviations

This document records deliberate deviations from the OpenFederation Technical White Paper (v2.1, February 2026) and their rationale.

## 1. Attestation Revocation: Delete-as-Revoke

**Whitepaper says (Section 4.3):** "Records should never be deleted; revocation is represented by setting revokedAt."

**Implementation:** Revocation is performed by deleting the attestation record from the community repo. The `deleteAttestation` endpoint wraps `RepoEngine.deleteRecord()`, which creates a signed MST commit proving the deletion.

**Rationale:**
- More ATProto-native. In AT Protocol, deletion creates a signed commit that is cryptographic proof of removal.
- A `revoked: true` record still syncs via `sync.getRepo` and appears valid to any client or relay that does not explicitly check the `revoked` field. Delete-as-revoke eliminates this entire class of bugs.
- The ATProto commit history preserves the full timeline: the attestation existed at commit A and was deleted at commit B. Both are verifiable from the CAR export.
- The audit log captures who revoked the attestation, when, and why (via the `reason` parameter).

**Decision:** Discussed and approved in GitHub issue #12.

## 2. Role Model: Custom Roles with Permissions (Resolved)

**Whitepaper says (Section 3.1, 3.3):** Member records reference a role TID pointing to a `net.openfederation.community.role` record with a custom permissions array.

**Implementation:** Resolved in GitHub issue #17. The `community.role` collection now exists with full CRUD endpoints (`createRole`, `updateRole`, `deleteRole`, `listRoles`). Member records use `roleRkey` to reference role records. 12 permission strings defined. Default roles (owner, moderator, member) created during community creation. The owner role is a regular role record (not hardcoded) with lockout protection on `community.role.write` and `community.settings.write` permissions.

**Status:** Resolved. No longer a deviation.

## 3. Governance Model: Configurable Protection (Extension)

**Whitepaper says (Section 5.5):** Five collections are protected under on-chain governance.

**Implementation:** Protected collections are configurable per-community via `governanceConfig.protectedCollections`. Communities in simple-majority mode can choose which collections require proposals/votes. `community.settings` and `community.role` are always mandatory (cannot be removed from protection). Default: all 5 collections protected.

**Status:** Extension beyond the whitepaper. Provides more flexibility than the whitepaper's all-or-nothing approach.

## 4. External Identity Keys (Extension)

**Not in whitepaper.** The `net.openfederation.identity.externalKey` collection stores auxiliary cryptographic public keys (Ed25519, X25519, secp256k1, P256) for cross-network identity bridging (Meshtastic, Nostr, WireGuard, SSH, hardware devices). This extends ATProto at the application layer without any protocol changes. Trust derives from repo signing (MST commit chain).

**Status:** New feature beyond whitepaper scope.
