# OpenFederation as a Cross-Network Identity Bridge

## The Problem: Siloed Identities Across Networks

Every network has its own identity system. Your ATProto DID means nothing on a Meshtastic mesh network. Your Nostr npub is invisible to WireGuard. Your SSH public key can't prove who you are in a federated social network. Users end up managing separate identities for every protocol they touch, with no way to link them cryptographically.

This fragmentation gets worse as decentralised networks grow. A youth football club might have members on ATProto (for community management), Meshtastic (for match-day coordination on mesh radios), and Nostr (for announcements). Three networks, three identity systems, zero interoperability.

## The Approach: Application-Layer Keys, Not Protocol Changes

The obvious solution would be to pick one key algorithm and force every network to use it. Ed25519 is fast, secure, and widely supported. Why not just use it everywhere?

Because AT Protocol already works. Its identity layer uses secp256k1 and P-256 for `did:plc` operations, repo signing, and relay verification. Replacing these would break federation with every other ATProto PDS, Bluesky relay, and client in existence. That is not a trade-off worth making.

Instead, OpenFederation stores auxiliary public keys as standard ATProto repo records. No protocol changes. No identity migration. No federation fragmentation. The keys federate via `sync.getRepo` CAR exports like any other record, and trust derives from the existing ATProto repo signing chain (MST commits signed by the user's secp256k1 key).

This is the same trust model as profiles, posts, and every other ATProto record. If you trust the repo, you trust the keys in it.

## How It Works

### Storing an External Key

A user stores their Ed25519 public key in their ATProto repo:

```
POST /xrpc/net.openfederation.identity.setExternalKey
{
  "rkey": "meshtastic-relay-1",
  "type": "ed25519",
  "purpose": "meshtastic",
  "publicKey": "z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
  "label": "My relay node"
}
```

The public key is in `did:key` multibase format (base58btc with `z` prefix). The PDS validates that the multicodec prefix (`0xed01` for Ed25519) matches the declared type, and that the key is the correct length. Then it writes the record to the user's repo via a signed MST commit.

### Bridge Discovery

A Meshtastic bridge service reads external keys to build the identity mapping:

```
GET /xrpc/net.openfederation.identity.listExternalKeys?did=did:plc:abc123&purpose=meshtastic
```

Returns all Meshtastic keys for that user. The bridge derives `SHA-256(ed25519_pubkey)[:16]` to get the mesh identity hash and maps it to the ATProto DID.

### Reverse Lookup

The bridge-critical endpoint: given an external public key, find the ATProto identity that owns it:

```
GET /xrpc/net.openfederation.identity.resolveByKey?publicKey=z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK
```

Returns the DID, handle, key type, and purpose. This is how a Meshtastic node, Nostr relay, or WireGuard peer can resolve a cryptographic key back to a human-readable ATProto identity.

## Supported Networks

| Network | Key Type | Purpose | Bridge Reads |
|---------|----------|---------|-------------|
| Meshtastic | Ed25519 | `meshtastic` | `SHA-256(pubkey)[:16]` mesh identity hash |
| Nostr | secp256k1 | `nostr` | Convert to npub for Nostr identity |
| WireGuard | X25519 | `wireguard` | Peer public key for tunnel configuration |
| SSH | Ed25519 | `ssh` | Authorized keys for infrastructure access |
| Hardware devices | Ed25519 | `device` | Device attestation and authentication |

The `type` field uses standard cryptographic algorithm names. The `purpose` field accepts any string, so new networks can be added without schema changes.

## Multi-Device Support

Users can store multiple keys under different record keys:

```
at://did:plc:abc123/net.openfederation.identity.externalKey/meshtastic-relay-1
at://did:plc:abc123/net.openfederation.identity.externalKey/meshtastic-mobile
at://did:plc:abc123/net.openfederation.identity.externalKey/nostr-primary
at://did:plc:abc123/net.openfederation.identity.externalKey/wireguard-laptop
```

No device taxonomy or enum. The record key is the device identifier. Add as many as you need.

## Key Rotation and Revocation

- **Rotation:** Overwrite the record (same rkey) with a new public key. The MST commit history preserves the old key for audit.
- **Revocation:** Delete the record. The signed deletion commit is cryptographic proof of revocation.

No `revoked` boolean fields or complex rotation protocols. ATProto's commit history handles the audit trail.

## Community Attestations: Verifiable Credentials

Alongside the identity bridge, communities can now issue signed attestations for their members. A youth football club can certify that a player is on their roster, a coach holds a specific qualification, or a fan is a verified supporter.

```
POST /xrpc/net.openfederation.community.issueAttestation
{
  "communityDid": "did:plc:club123",
  "subjectDid": "did:plc:player456",
  "subjectHandle": "carlos-martinez",
  "type": "role",
  "claim": {
    "role": "athlete",
    "position": "Goalkeeper",
    "number": 1,
    "ageGroup": "U-16",
    "status": "active"
  }
}
```

Attestations are stored in the community's ATProto repo (`net.openfederation.community.attestation` collection). Because every commit is signed by the community's keypair, any external system can verify the attestation by checking the repo signature, without trusting the PDS.

### Verification

```
GET /xrpc/net.openfederation.community.verifyAttestation?communityDid=did:plc:club123&rkey=3jui7kd2h3...
```

Record existence equals validity. If the attestation record exists in the repo, it is valid. If it has been deleted, it has been revoked. The signed deletion commit proves the revocation. Optional `expiresAt` timestamps allow time-bounded credentials.

### Why Delete-as-Revoke?

We deliberately avoided adding a `revoked: boolean` field to attestation records. In ATProto, deletion creates a signed commit that proves the record was removed. A `revoked: true` record would still sync via `sync.getRepo` and appear valid to any client that does not check the field. Delete-as-revoke is cleaner, more ATProto-native, and eliminates an entire class of "forgot to check the revoked flag" bugs.

## Member Role Management

Community owners can now promote and demote members:

```
POST /xrpc/net.openfederation.community.updateMemberRole
{
  "communityDid": "did:plc:club123",
  "memberDid": "did:plc:coach789",
  "role": "moderator"
}
```

Roles (`moderator`, `member`) are written directly into the member record in the community's ATProto repo. The owner role cannot be changed through this endpoint (ownership transfer is a separate, more deliberate process).

## Extended User Profiles

User profiles now support both the standard ATProto `app.bsky.actor.profile` and custom application-specific collections:

```
POST /xrpc/net.openfederation.account.updateProfile
{
  "collection": "app.grvty.actor.profile",
  "record": {
    "displayName": "Carlos Martinez",
    "bio": "Goalkeeper for Hackney Youth FC U-16",
    "role": "athlete",
    "meta": {
      "position": "Goalkeeper",
      "number": 1,
      "ageGroup": "U-16"
    }
  }
}
```

The `getProfile` endpoint aggregates the standard profile and all custom `*.actor.profile` collections into a single response. Applications define their own NSID namespaces (`app.grvty.*`, `app.yourapp.*`) following ATProto conventions.

## Architecture Principles

Every feature in this release follows the same principles:

1. **ATProto compatibility is non-negotiable.** No protocol-level changes. Only application-layer extensions using standard repo records and custom lexicons.

2. **Trust derives from repo signing.** The MST commit chain is the trust anchor. No cross-algorithm signatures, no external certificate authorities, no additional trust infrastructure.

3. **Records are the interface.** External keys, attestations, and profiles are all ATProto repo records. They federate, sync, export, and verify using existing ATProto infrastructure.

4. **Delete is revoke.** ATProto's signed commits make deletion a first-class cryptographic operation. No boolean flags, no tombstones, no "soft delete" ambiguity.

5. **Extend, never replace.** secp256k1 stays for ATProto signing. Ed25519 is added as application data. Both coexist without conflict.

## What This Enables

- A Meshtastic relay reads a user's Ed25519 key from their ATProto repo and maps mesh traffic to a human-readable identity
- A Nostr bridge resolves an npub back to an OpenFederation community member
- A WireGuard configuration tool pulls peer public keys from ATProto repos instead of managing them manually
- A youth football league verifies player registrations across clubs by checking attestation records in community repos
- A game platform reads custom profile data from `app.grvty.actor.profile` without touching the standard Bluesky profile

All of this works today, with 77 integration tests proving it, and zero changes to the AT Protocol.
