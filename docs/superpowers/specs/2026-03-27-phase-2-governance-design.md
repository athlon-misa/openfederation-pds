# Phase 2: Governance Layer Design

**Date:** 2026-03-27
**Status:** Approved
**Issues:** #17 (custom roles), #18 (governance enforcement), #19 (simple-majority)
**Deferred:** #20 (on-chain — PDS enforcement built, Oracle/blockchain deferred)

## Overview

Three sub-projects executed sequentially:
- **A: Custom Roles (#17)** — `community.role` collection, permission-based authorization, member record migration
- **B: Governance Enforcement (#18)** — write policy middleware for protected collections, three governance modes
- **C: Simple-Majority Voting (#19)** — proposal/vote mechanism for governed writes

## Sub-project A: Custom Roles with Permissions (#17)

### Role Collection

```
Collection: net.openfederation.community.role
rkey: TID (auto-generated)
```

```json
{
  "name": "coach",
  "description": "Team coaching staff",
  "permissions": ["community.member.read", "community.attestation.write", "community.attestation.delete"]
}
```

The owner role is a regular role record with all permissions. It cannot have `community.role.write` removed (prevents lockout), and cannot be deleted while members are assigned.

### Permission Strings

Pattern: `community.<collection-short>.<action>` where action is `read`, `write`, `delete`.

| Permission | Meaning |
|------------|---------|
| `community.settings.write` | Update community settings |
| `community.profile.write` | Update community profile |
| `community.member.read` | View member list |
| `community.member.write` | Add/modify members, approve join requests |
| `community.member.delete` | Remove members |
| `community.role.read` | View roles |
| `community.role.write` | Create/modify/delete roles |
| `community.attestation.write` | Issue attestations |
| `community.attestation.delete` | Revoke attestations |
| `community.application.write` | Link applications |
| `community.application.delete` | Unlink applications |
| `community.governance.write` | Create/vote on proposals (simple-majority mode) |

### Default Roles

Created during community creation:

**owner** — all permissions:
```json
["community.settings.write", "community.profile.write", "community.member.read",
 "community.member.write", "community.member.delete", "community.role.read",
 "community.role.write", "community.attestation.write", "community.attestation.delete",
 "community.application.write", "community.application.delete", "community.governance.write"]
```

**moderator** — most permissions except role and settings management:
```json
["community.profile.write", "community.member.read", "community.member.write",
 "community.member.delete", "community.role.read", "community.attestation.write",
 "community.attestation.delete", "community.governance.write"]
```

**member** — read-only + self-actions:
```json
["community.member.read", "community.role.read"]
```

### Member Record Migration

Current member records:
```json
{ "did": "did:plc:...", "handle": "alice", "role": "member", "joinedAt": "..." }
```

After migration:
```json
{ "did": "did:plc:...", "handle": "alice", "roleRkey": "3k-abc-123", "joinedAt": "..." }
```

The `roleRkey` points to a role record in the same community's repo. Migration script:
1. Create default role records (owner, moderator, member) in each community repo
2. Update all member records: replace `role` string with `roleRkey` pointing to the matching default role
3. Update `members_unique` if needed

### XRPC Endpoints

| Method | NSID | Auth | Description |
|--------|------|------|-------------|
| POST | `net.openfederation.community.createRole` | Owner | Create a custom role |
| POST | `net.openfederation.community.updateRole` | Owner | Update role name/description/permissions |
| POST | `net.openfederation.community.deleteRole` | Owner | Delete a role (fails if members assigned) |
| GET | `net.openfederation.community.listRoles` | No | List all roles for a community |

### Guard Update

`requireCommunityRole` in `src/auth/guards.ts` changes from role-string hierarchy to permission-based:

```typescript
// Old: requireCommunityRole(req, res, communityDid, ['owner', 'moderator'])
// New: requireCommunityPermission(req, res, communityDid, 'community.attestation.write')
```

The function:
1. Gets member's `roleRkey` from `members_unique` → `records_index`
2. Fetches the role record by rkey
3. Checks if `permissions` array includes the required permission
4. PDS admin always passes (unchanged)
5. Community creator (`created_by`) always passes for owner-level permissions

### Files

| File | Responsibility |
|------|----------------|
| **Create:** `src/api/net.openfederation.community.createRole.ts` | Create role handler |
| **Create:** `src/api/net.openfederation.community.updateRole.ts` | Update role handler |
| **Create:** `src/api/net.openfederation.community.deleteRole.ts` | Delete role handler |
| **Create:** `src/api/net.openfederation.community.listRoles.ts` | List roles handler |
| **Create:** `src/lexicon/net.openfederation.community.createRole.json` | Lexicon |
| **Create:** `src/lexicon/net.openfederation.community.updateRole.json` | Lexicon |
| **Create:** `src/lexicon/net.openfederation.community.deleteRole.json` | Lexicon |
| **Create:** `src/lexicon/net.openfederation.community.listRoles.json` | Lexicon |
| **Create:** `src/auth/permissions.ts` | Permission constants and helpers |
| **Create:** `scripts/migrate-008-roles.ts` | Migration: create default roles, update member records |
| **Modify:** `src/auth/guards.ts` | Add `requireCommunityPermission()`, keep old guard for backwards compat during migration |
| **Modify:** `src/server/index.ts` | Register 4 new handlers |
| **Modify:** `src/db/audit.ts` | Add role audit actions |
| **Modify:** `src/api/net.openfederation.community.create.ts` | Create default role records during community creation |
| **Modify:** `src/api/net.openfederation.community.join.ts` | Use roleRkey instead of role string |
| **Modify:** `src/api/net.openfederation.community.resolveJoinRequest.ts` | Use roleRkey |
| **Modify:** `src/api/net.openfederation.community.updateMemberRole.ts` | Accept roleRkey instead of role string |
| **Modify:** All endpoints using `requireCommunityRole` | Switch to `requireCommunityPermission` |

---

## Sub-project B: Governance Enforcement (#18)

### Enforcement Module

New module `src/governance/enforcement.ts`:

```typescript
async function enforceGovernance(
  communityDid: string,
  collection: string,
  action: 'write' | 'delete',
  actorDid: string
): Promise<{ allowed: boolean; reason?: string; requiresProposal?: boolean }>
```

### Protected Collections

From whitepaper Section 5.5:
- `net.openfederation.community.settings` — always protected
- `net.openfederation.community.role` — always protected
- `net.openfederation.community.member` — always protected
- `net.openfederation.community.profile` — protected (configurable per-community in future)
- `net.openfederation.community.attestation` — protected (configurable per-community in future)

### Enforcement by Mode

**benevolent-dictator (default):**
- Permission check via `requireCommunityPermission()` (from Sub-project A)
- No additional governance gate
- `enforceGovernance()` returns `{ allowed: true }`

**simple-majority:**
- Protected collection writes require an approved proposal
- `enforceGovernance()` returns `{ allowed: false, requiresProposal: true }` for protected collections
- Unprotected collections: permission check only (same as benevolent-dictator)
- Exception: `community.member` writes for join/leave are always allowed (operational, not governance)

**on-chain:**
- All writes to protected collections rejected
- `enforceGovernance()` returns `{ allowed: false, reason: 'GovernanceRequired: on-chain governance is active, writes must come via an authorized Oracle service' }`
- The enforcement is real — no writes get through
- Oracle authentication hook is defined but not connected (deferred to #20)

### Generic Endpoint Fix

`com.atproto.repo.putRecord`, `createRecord`, `deleteRecord` gain a governance check:

```typescript
// Before engine.putRecord():
if (isCommunityDid(repo)) {
  const governance = await enforceGovernance(repo, collection, 'write', req.auth!.did);
  if (!governance.allowed) {
    res.status(403).json({ error: 'GovernanceDenied', message: governance.reason });
    return;
  }
}
```

### Governance Model Switching

New endpoint: `net.openfederation.community.setGovernanceModel`
- Owner only (benevolent-dictator → simple-majority)
- Upgrading to on-chain: blocked until Oracle infrastructure exists
- Downgrading from on-chain: blocked without PDS admin override
- Downgrading from simple-majority → benevolent-dictator: owner only

### Files

| File | Responsibility |
|------|----------------|
| **Create:** `src/governance/enforcement.ts` | Governance enforcement logic |
| **Create:** `src/api/net.openfederation.community.setGovernanceModel.ts` | Mode switching endpoint |
| **Create:** `src/lexicon/net.openfederation.community.setGovernanceModel.json` | Lexicon |
| **Modify:** `src/api/com.atproto.repo.putRecord.ts` | Add governance check |
| **Modify:** `src/api/com.atproto.repo.createRecord.ts` | Add governance check |
| **Modify:** `src/api/com.atproto.repo.deleteRecord.ts` | Add governance check |
| **Modify:** `src/server/index.ts` | Register new handler |
| **Modify:** All community write endpoints | Call `enforceGovernance()` before writes |

---

## Sub-project C: Simple-Majority Voting (#19)

### Proposal Collection

```
Collection: net.openfederation.community.proposal
rkey: TID (auto-generated)
```

```json
{
  "targetCollection": "net.openfederation.community.settings",
  "targetRkey": "self",
  "action": "write",
  "proposedRecord": { "visibility": "private", "joinPolicy": "approval" },
  "proposedBy": "did:plc:...",
  "status": "open",
  "votesFor": ["did:plc:voter1", "did:plc:voter2"],
  "votesAgainst": ["did:plc:voter3"],
  "createdAt": "2026-03-27T...",
  "expiresAt": "2026-04-03T...",
  "resolvedAt": null
}
```

### Governance Config

Stored in community settings record:

```json
{
  "governanceModel": "simple-majority",
  "governanceConfig": {
    "quorum": 3,
    "voterRole": "moderator",
    "proposalTtlDays": 7
  }
}
```

- `quorum`: minimum total votes needed for resolution
- `voterRole`: name of the role whose members can vote (and create proposals)
- `proposalTtlDays`: days until proposal expires (default 7)

### Auto-Commit

When a proposal reaches majority (`votesFor.length > quorum / 2`):
1. Update proposal status to `"approved"`
2. Apply the proposed change: `engine.putRecord()` or `engine.deleteRecord()` on the target collection
3. Audit log the governance action

When a proposal reaches majority against or expires:
1. Update proposal status to `"rejected"` or `"expired"`
2. No changes applied

### XRPC Endpoints

| Method | NSID | Auth | Description |
|--------|------|------|-------------|
| POST | `net.openfederation.community.createProposal` | Voter role | Propose a change to a protected collection |
| POST | `net.openfederation.community.voteOnProposal` | Voter role | Cast for/against vote |
| GET | `net.openfederation.community.listProposals` | No | List proposals (filter by status) |
| GET | `net.openfederation.community.getProposal` | No | Get a specific proposal |

### Files

| File | Responsibility |
|------|----------------|
| **Create:** `src/api/net.openfederation.community.createProposal.ts` | Create proposal handler |
| **Create:** `src/api/net.openfederation.community.voteOnProposal.ts` | Vote handler with auto-commit |
| **Create:** `src/api/net.openfederation.community.listProposals.ts` | List proposals handler |
| **Create:** `src/api/net.openfederation.community.getProposal.ts` | Get proposal handler |
| **Create:** `src/lexicon/net.openfederation.community.createProposal.json` | Lexicon |
| **Create:** `src/lexicon/net.openfederation.community.voteOnProposal.json` | Lexicon |
| **Create:** `src/lexicon/net.openfederation.community.listProposals.json` | Lexicon |
| **Create:** `src/lexicon/net.openfederation.community.getProposal.json` | Lexicon |
| **Modify:** `src/governance/enforcement.ts` | Wire up proposal check for simple-majority mode |
| **Modify:** `src/server/index.ts` | Register 4 new handlers |
| **Modify:** `src/db/audit.ts` | Add proposal audit actions |

---

## What's NOT Included

- On-chain Oracle service and smart contract infrastructure (#20 — deferred)
- On-chain mode is enforced at PDS level (rejects writes) but the Oracle doesn't exist yet
- Configurable per-collection protection levels (all protected collections are hardcoded for now)
- Proposal amendment (voters can only vote for/against, not modify the proposal)
- Delegation / proxy voting
