# On-Chain Governance Infrastructure Design (Chain-Agnostic)

**Issue:** #20 — Implement on-chain governance mode with Oracle service
**Date:** 2026-03-29
**Status:** Approved

## Context

The PDS already has governance enforcement (`benevolent-dictator` and `simple-majority` modes), a proposal/voting system, protected collections, and vote delegation. The `on-chain` governance mode is stubbed but not implemented — `enforceGovernance()` rejects all writes with a message about "authorized Oracle service" but no Oracle authentication mechanism exists.

This design builds the **PDS-side infrastructure** for on-chain governance without committing to any specific blockchain. The Oracle service itself (event listener, chain RPC) is out of scope — it's proprietary infrastructure run by businesses like Grvty.

**Architecture:** OpenFederation defines the Oracle protocol (how an external service authenticates and submits governance proofs to the PDS). Businesses (Grvty, etc.) run the actual Oracle + blockchain infrastructure and connect via this protocol. Different businesses can use different chains.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Oracle auth | Dedicated credential system, isolated from partner keys | Oracle has higher trust level than partners; isolation prevents privilege escalation if partner key features are loosened |
| Credential scope | Per-community | Principle of least privilege; maps to one Oracle watching one contract per community |
| Proof format | Structured metadata (option B) | Chain-agnostic, auditable, forward-compatible with future verification (#33) |
| Proof validation | Trust Oracle (no on-chain verification) | Chain-specific verification deferred to #33 |
| Write mechanism | Oracle uses existing putRecord/createRecord/deleteRecord with special auth | No separate submission endpoint; Oracle is just a privileged caller |

## 1. Oracle Credential System

**Table: `oracle_credentials`**

| Column | Type | Description |
|--------|------|-------------|
| id | VARCHAR(36) PK | UUID |
| community_did | VARCHAR(255) NOT NULL FK | Scoped to one community |
| key_prefix | VARCHAR(16) NOT NULL | First 16 chars (for identification in logs) |
| key_hash | VARCHAR(255) NOT NULL | SHA-256 hash of the full key |
| name | VARCHAR(255) NOT NULL | Human label (e.g., "Grvty Solana Oracle") |
| created_by | VARCHAR(36) | Admin who created it |
| status | VARCHAR(20) DEFAULT 'active' | active / revoked |
| allowed_origins | JSONB | Optional origin restrictions |
| revoked_at | TIMESTAMPTZ | When revoked |
| last_used_at | TIMESTAMPTZ | Last successful proof submission |
| proofs_submitted | INTEGER DEFAULT 0 | Counter for monitoring |
| created_at | TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP | Creation time |

**Key format:** `ofo_` prefix + 48 random bytes base64url. Same generation pattern as partner keys but distinct prefix.

**Admin XRPC endpoints:**
- `net.openfederation.oracle.createCredential` — admin creates credential for a community (returns raw key once)
- `net.openfederation.oracle.listCredentials` — admin lists credentials (shows prefix, never raw key)
- `net.openfederation.oracle.revokeCredential` — admin revokes a credential

**CLI commands:**
- `ofc oracle create <communityDid> --name <label>` — create credential
- `ofc oracle list [--community <did>]` — list credentials
- `ofc oracle revoke <credentialId>` — revoke a credential

**Constraint:** One active credential per community. Creating a new one for a community that already has an active credential fails (revoke first, then create).

## 2. Oracle Authentication

**Auth path:** Requests with `X-Oracle-Key` header go through a separate validation path, distinct from JWT bearer and partner key auth.

**`src/auth/oracle-guard.ts`:**
1. Hash the key from `X-Oracle-Key` header with SHA-256
2. Look up in `oracle_credentials` where `key_hash` matches and `status = 'active'`
3. Verify the community DID in the request body matches the credential's `community_did`
4. Update `last_used_at` and increment `proofs_submitted`
5. Return `OracleContext` with `{ credentialId, communityDid, name }`

**Enforcement integration:** In `enforceGovernance()`, the `on-chain` case checks if the request carries a valid `OracleContext` for this community. If yes, allow the write. If no, block with existing message.

The Oracle submits changes through **existing** `putRecord`/`createRecord`/`deleteRecord` endpoints. No separate submission endpoint. The Oracle is just a specially authenticated caller allowed to write to protected collections when governance mode is `on-chain`.

## 3. Governance Proof Schema

The Oracle includes a `governanceProof` field in the request body alongside the normal record data:

```typescript
interface GovernanceProof {
  chainId: string;                      // e.g., "solana-mainnet", "137"
  transactionHash: string;              // on-chain tx that authorized this change
  blockNumber?: number;                 // optional — not all chains have block numbers
  contractAddress: string;              // the governance contract address
  timestamp: string;                    // ISO 8601 — when the chain event occurred
  metadata?: Record<string, unknown>;   // chain-specific extras (slot, signatures, etc.)
}
```

**Storage:** Written to the audit log `meta` field on each Oracle-applied write:

```
action: 'oracle.proofApplied'
meta: { collection, rkey, action, proof: { chainId, transactionHash, ... } }
```

No separate proofs table. If independent proof querying is needed later (for verification per #33), extract to a dedicated table then.

## 4. Governance Config for On-Chain Mode

Update `setGovernanceModel` to accept `on-chain`:

```typescript
{
  governanceModel: 'on-chain',
  governanceConfig: {
    chainId: string;                  // required — identifies the chain
    contractAddress: string;          // required — the governance contract
    oracleEndpoint?: string;          // optional — Oracle service URL (informational)
    protectedCollections?: string[];  // optional — same normalization as simple-majority
  }
}
```

**Validation:**
- `chainId` and `contractAddress` are required, non-empty strings
- `protectedCollections` normalized same as simple-majority (auto-prepend namespace, ensure mandatory collections)
- Setting `on-chain` is irreversible (existing enforcement — can't downgrade)
- An active Oracle credential must exist for this community before enabling on-chain mode

## 5. Out of Scope

- **No chain-specific proof verification** — deferred to #33
- **No Oracle service implementation** — proprietary, run by businesses (Grvty, etc.)
- **No smart contract interface specification** — chain-specific
- **No Web UI for Oracle management** — CLI and API only
- **No multi-Oracle per community** — one active credential per community; revoke and replace to change
