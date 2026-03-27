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

## 2. Role Model: String Roles vs Role-Reference Records

**Whitepaper says (Section 3.1, 3.3):** Member records reference a role TID pointing to a `net.openfederation.community.role` record with a custom permissions array. Communities can define arbitrary roles (e.g., "coach", "physio", "treasurer").

**Implementation:** Roles are stored as string values (`owner`, `moderator`, `member`) directly in the member record. There is no `community.role` collection.

**Rationale:**
- Simpler for Phase 1. The three-role hierarchy covers all current use cases.
- Custom roles with permission arrays are tracked in GitHub issue #17 for Phase 2 (Governance Layer).
- The migration path is straightforward: create default role records, then update member records to reference them by rkey.

**Status:** Temporary deviation. Will be resolved by #17.
