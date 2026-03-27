# External Identity Key System

**Date:** 2026-03-27
**Status:** Approved
**Issue:** #10 (declined as stated; this is the alternative approach)

## Problem

OpenFederation users need to link their ATProto identity to external networks (Meshtastic, Nostr, WireGuard, SSH, hardware devices). The original proposal (issue #10) suggested replacing secp256k1 with Ed25519 at the protocol level, which would break ATProto compatibility.

## Solution

Store auxiliary cryptographic public keys as standard ATProto repo records. External systems read these keys to bridge identities. Zero protocol changes. The PDS becomes a general identity bridge layer.

### Design Constraints

- ATProto compatibility is non-negotiable — no protocol-level changes
- Keys are application-layer data, not signing infrastructure
- Trust derives from ATProto repo signing (MST commit chain)
- Public keys only — PDS never stores external private keys
- All records federate via `sync.getRepo` CAR exports

## Record Schema

```
Collection: net.openfederation.identity.externalKey
rkey: user-chosen identifier (e.g., "meshtastic-relay-1", "nostr-primary")
```

```json
{
  "type": "ed25519",
  "purpose": "meshtastic",
  "publicKey": "z6Mk...",
  "label": "My relay node",
  "createdAt": "2026-03-27T12:00:00.000Z"
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | Key algorithm: `ed25519`, `x25519`, `secp256k1`, `p256` |
| `purpose` | string | Yes | Target network: `meshtastic`, `nostr`, `wireguard`, `ssh`, `device`, or any custom string |
| `publicKey` | string | Yes | Public key in did:key multibase format (base58btc, `z` prefix) |
| `label` | string | No | Human-readable label, max 100 characters |
| `createdAt` | string | Yes | ISO 8601 timestamp |

### Multicodec Prefixes

The `publicKey` multibase value must match the declared `type`:

| Type | Multicodec Prefix | Example |
|------|-------------------|---------|
| `ed25519` | `0xed01` | `z6Mk...` |
| `x25519` | `0xec01` | `z6LS...` |
| `secp256k1` | `0xe701` | `zQ3s...` |
| `p256` | `0x1200` | `zDn...` |

### Trust Model

No cross-algorithm signatures. Every record in an ATProto repo is signed by the repo owner's signing key via the MST commit chain. If you trust the repo (which relays verify), you trust the record. This is the same trust model as profiles, posts, and every other ATProto record.

### Rotation Semantics

- Overwriting a record (same rkey) = key rotation
- Deleting a record = key revocation
- Only the latest record per rkey is valid
- No history tracking needed — ATProto commit history preserves the audit trail

### Multi-Device

Multiple records with different rkeys in the same collection. No `device` enum — the rkey itself is the device identifier:

```
at://did:plc:abc123/net.openfederation.identity.externalKey/meshtastic-relay-1
at://did:plc:abc123/net.openfederation.identity.externalKey/meshtastic-mobile
at://did:plc:abc123/net.openfederation.identity.externalKey/nostr-primary
```

## XRPC Endpoints

### net.openfederation.identity.setExternalKey

**Type:** procedure (POST)
**Auth:** Required (approved user)
**Description:** Create or update an external key in the authenticated user's repo.

**Input:**
```json
{
  "rkey": "meshtastic-relay-1",
  "type": "ed25519",
  "purpose": "meshtastic",
  "publicKey": "z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
  "label": "My relay node"
}
```

**Validation:**
- `rkey`: alphanumeric + hyphens, 1-512 chars
- `type`: must be one of `ed25519`, `x25519`, `secp256k1`, `p256`
- `publicKey`: must be valid multibase (base58btc `z` prefix), multicodec prefix must match `type`
- `purpose`: required, 1-64 chars
- `label`: optional, max 100 chars

**Output:**
```json
{
  "uri": "at://did:plc:abc123/net.openfederation.identity.externalKey/meshtastic-relay-1",
  "cid": "bafyrei..."
}
```

**Audit:** `identity.setExternalKey`

### net.openfederation.identity.listExternalKeys

**Type:** query (GET)
**Auth:** None (public, bridge-readable)
**Description:** List external keys for a DID. Bridges and external services use this for identity discovery.

**Parameters:**
- `did` (required): The DID to look up
- `purpose` (optional): Filter by purpose (e.g., `meshtastic`)
- `limit` (optional): Max results, default 50, max 100
- `cursor` (optional): Pagination cursor

**Output:**
```json
{
  "keys": [
    {
      "uri": "at://did:plc:abc123/net.openfederation.identity.externalKey/meshtastic-relay-1",
      "rkey": "meshtastic-relay-1",
      "type": "ed25519",
      "purpose": "meshtastic",
      "publicKey": "z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
      "label": "My relay node",
      "createdAt": "2026-03-27T12:00:00.000Z"
    }
  ],
  "cursor": "next_rkey"
}
```

### net.openfederation.identity.getExternalKey

**Type:** query (GET)
**Auth:** None (public)
**Description:** Get a specific external key by DID and rkey.

**Parameters:**
- `did` (required): The DID
- `rkey` (required): The record key

**Output:** Same shape as a single item in `listExternalKeys.keys[]`, or `KeyNotFound` error.

### net.openfederation.identity.deleteExternalKey

**Type:** procedure (POST)
**Auth:** Required (owner only)
**Description:** Delete an external key from the authenticated user's repo.

**Input:**
```json
{
  "rkey": "meshtastic-relay-1"
}
```

**Output:**
```json
{
  "success": true
}
```

**Audit:** `identity.deleteExternalKey`

### net.openfederation.identity.resolveByKey

**Type:** query (GET)
**Auth:** None (public, bridge-critical)
**Description:** Reverse lookup — find the ATProto DID that owns a given external public key. This is the key bridge enabler.

**Parameters:**
- `publicKey` (required): The public key in multibase format
- `purpose` (optional): Narrow search to a specific purpose

**Output:**
```json
{
  "did": "did:plc:abc123",
  "handle": "alice.openfederation.net",
  "rkey": "meshtastic-relay-1",
  "type": "ed25519",
  "purpose": "meshtastic",
  "createdAt": "2026-03-27T12:00:00.000Z"
}
```

Returns `KeyNotFound` error if no match.

**Implementation note:** Queries `records_index` where `collection = 'net.openfederation.identity.externalKey'` and scans record values for matching `publicKey`. The dataset is bounded (one key per user per purpose), so a sequential scan is acceptable for MVP. If the table grows, we add a `public_key_hash` index column to `records_index` for O(1) lookups.

## Implementation

### Files to Create

| File | Description |
|------|-------------|
| `src/lexicon/net.openfederation.identity.setExternalKey.json` | Lexicon definition |
| `src/lexicon/net.openfederation.identity.listExternalKeys.json` | Lexicon definition |
| `src/lexicon/net.openfederation.identity.getExternalKey.json` | Lexicon definition |
| `src/lexicon/net.openfederation.identity.deleteExternalKey.json` | Lexicon definition |
| `src/lexicon/net.openfederation.identity.resolveByKey.json` | Lexicon definition |
| `src/api/net.openfederation.identity.setExternalKey.ts` | Endpoint handler |
| `src/api/net.openfederation.identity.listExternalKeys.ts` | Endpoint handler |
| `src/api/net.openfederation.identity.getExternalKey.ts` | Endpoint handler |
| `src/api/net.openfederation.identity.deleteExternalKey.ts` | Endpoint handler |
| `src/api/net.openfederation.identity.resolveByKey.ts` | Endpoint handler |
| `src/identity/external-keys.ts` | Multibase validation and key type verification |

### Files to Modify

| File | Change |
|------|--------|
| `src/server/index.ts` | Register 5 new XRPC handlers |

### Validation Module (`src/identity/external-keys.ts`)

Responsibilities:
- Parse multibase-encoded public keys (base58btc `z` prefix)
- Verify multicodec prefix matches declared `type`
- Validate rkey format
- No new npm dependencies — use `multiformats` (already in dependency tree via `@atproto/repo`)

### Handler Pattern

All write endpoints follow the existing codebase pattern:
1. Auth guard (`requireAuth` + `requireApprovedUser`)
2. Input validation
3. `RepoEngine.putRecord()` / `deleteRecord()` with user's keypair
4. Audit log entry
5. Return result

Read endpoints are unauthenticated and query `records_index` directly, matching the `listRecords` pattern.

## What's NOT Included

- No `version` field — lexicon versioning handles schema evolution
- No `device` enum — multiple rkeys handle multi-device naturally
- No cross-algorithm signatures — repo signing is the trust anchor
- No key rotation protocol — overwrite = rotate, delete = revoke
- No private key storage — public keys only
- No WebFinger integration — future enhancement if needed
- No `records_index` schema changes — existing columns sufficient for MVP

## Use Cases

| Network | Type | Purpose | Bridge Reads |
|---------|------|---------|-------------|
| Meshtastic | `ed25519` | `meshtastic` | `SHA-256(pubkey)[:16]` mesh identity hash |
| Nostr | `secp256k1` | `nostr` | Convert to npub for Nostr identity |
| WireGuard | `x25519` | `wireguard` | Peer public key for tunnel config |
| SSH | `ed25519` | `ssh` | Authorized keys for infrastructure access |
| Hardware | `ed25519` | `device` | Device attestation and authentication |
