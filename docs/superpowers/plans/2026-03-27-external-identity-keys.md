# External Identity Keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add external identity key management so users can store auxiliary cryptographic public keys (Ed25519, X25519, secp256k1, P256) in their ATProto repo for cross-network identity bridging (Meshtastic, Nostr, WireGuard, SSH, hardware devices).

**Architecture:** External keys are standard ATProto repo records in the `net.openfederation.identity.externalKey` collection. Five dedicated XRPC endpoints provide validated access. A validation module handles multibase/multicodec parsing. Trust derives from ATProto repo signing (MST commit chain). No protocol-level changes.

**Tech Stack:** TypeScript ESM, Express XRPC handlers, `multiformats` (already in deps) for base58btc multibase, `RepoEngine` for repo writes, `records_index` for queries.

---

## File Structure

| File | Responsibility |
|------|----------------|
| **Create:** `src/identity/external-keys.ts` | Multibase validation, multicodec prefix matching, rkey validation |
| **Create:** `src/api/net.openfederation.identity.setExternalKey.ts` | POST handler — create/update external key in user's repo |
| **Create:** `src/api/net.openfederation.identity.listExternalKeys.ts` | GET handler — list external keys for a DID (public) |
| **Create:** `src/api/net.openfederation.identity.getExternalKey.ts` | GET handler — get single key by DID + rkey (public) |
| **Create:** `src/api/net.openfederation.identity.deleteExternalKey.ts` | POST handler — delete external key from user's repo |
| **Create:** `src/api/net.openfederation.identity.resolveByKey.ts` | GET handler — reverse lookup DID by public key (public) |
| **Create:** `src/lexicon/net.openfederation.identity.setExternalKey.json` | Lexicon definition |
| **Create:** `src/lexicon/net.openfederation.identity.listExternalKeys.json` | Lexicon definition |
| **Create:** `src/lexicon/net.openfederation.identity.getExternalKey.json` | Lexicon definition |
| **Create:** `src/lexicon/net.openfederation.identity.deleteExternalKey.json` | Lexicon definition |
| **Create:** `src/lexicon/net.openfederation.identity.resolveByKey.json` | Lexicon definition |
| **Create:** `tests/api/net.openfederation.identity.externalKeys.test.ts` | Integration tests for all 5 endpoints |
| **Modify:** `src/server/index.ts` | Import + register 5 new handlers in frozen handler map |
| **Modify:** `src/db/audit.ts` | Add 2 new audit action types |

---

### Task 1: Multibase Validation Module

**Files:**
- Create: `src/identity/external-keys.ts`

This module validates multibase-encoded public keys and verifies the multicodec prefix matches the declared key type.

- [ ] **Step 1: Create the validation module**

```typescript
// src/identity/external-keys.ts

import { base58btc } from 'multiformats/bases/base58';

/**
 * Supported external key types and their multicodec prefixes.
 * These are the first bytes after multibase decoding.
 */
export const KEY_TYPE_MULTICODEC: Record<string, number[]> = {
  ed25519:   [0xed, 0x01],
  x25519:    [0xec, 0x01],
  secp256k1: [0xe7, 0x01],
  p256:      [0x80, 0x24],
};

export const VALID_KEY_TYPES = Object.keys(KEY_TYPE_MULTICODEC);

/** Expected raw public key lengths (bytes, after multicodec prefix) */
const KEY_LENGTHS: Record<string, number> = {
  ed25519: 32,
  x25519: 32,
  secp256k1: 33, // compressed
  p256: 33,      // compressed
};

export interface ExternalKeyRecord {
  type: string;
  purpose: string;
  publicKey: string;
  label?: string;
  createdAt: string;
}

export type ValidateKeyResult =
  | { valid: true }
  | { valid: false; error: string };

/**
 * Validate that a multibase-encoded public key matches the declared type.
 * Expects base58btc encoding (z prefix) with the correct multicodec prefix.
 */
export function validatePublicKey(publicKey: string, type: string): ValidateKeyResult {
  if (!VALID_KEY_TYPES.includes(type)) {
    return { valid: false, error: `Unsupported key type: ${type}. Must be one of: ${VALID_KEY_TYPES.join(', ')}` };
  }

  if (!publicKey.startsWith('z')) {
    return { valid: false, error: 'Public key must be multibase base58btc encoded (z prefix)' };
  }

  let decoded: Uint8Array;
  try {
    decoded = base58btc.decode(publicKey);
  } catch {
    return { valid: false, error: 'Invalid base58btc encoding' };
  }

  const expectedPrefix = KEY_TYPE_MULTICODEC[type];
  if (decoded.length < expectedPrefix.length) {
    return { valid: false, error: 'Public key too short' };
  }

  for (let i = 0; i < expectedPrefix.length; i++) {
    if (decoded[i] !== expectedPrefix[i]) {
      return { valid: false, error: `Multicodec prefix does not match type "${type}"` };
    }
  }

  const rawKeyLength = decoded.length - expectedPrefix.length;
  const expectedLength = KEY_LENGTHS[type];
  if (rawKeyLength !== expectedLength) {
    return { valid: false, error: `Invalid key length for ${type}: expected ${expectedLength} bytes, got ${rawKeyLength}` };
  }

  return { valid: true };
}

/**
 * Validate an rkey for external key records.
 * Must be 1-512 chars, alphanumeric + hyphens, no leading/trailing hyphens.
 */
export function validateRkey(rkey: string): ValidateKeyResult {
  if (!rkey || rkey.length === 0 || rkey.length > 512) {
    return { valid: false, error: 'rkey must be 1-512 characters' };
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$/.test(rkey) && rkey.length > 1) {
    return { valid: false, error: 'rkey must be alphanumeric with hyphens, no leading/trailing hyphens' };
  }
  if (rkey.length === 1 && !/^[a-zA-Z0-9]$/.test(rkey)) {
    return { valid: false, error: 'rkey must be alphanumeric' };
  }
  return { valid: true };
}

/**
 * Validate the purpose field.
 */
export function validatePurpose(purpose: string): ValidateKeyResult {
  if (!purpose || purpose.length === 0 || purpose.length > 64) {
    return { valid: false, error: 'purpose must be 1-64 characters' };
  }
  return { valid: true };
}

/**
 * Validate the label field (optional).
 */
export function validateLabel(label: string | undefined): ValidateKeyResult {
  if (label !== undefined && label.length > 100) {
    return { valid: false, error: 'label must be at most 100 characters' };
  }
  return { valid: true };
}

/** The collection name for external key records */
export const EXTERNAL_KEY_COLLECTION = 'net.openfederation.identity.externalKey';
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit src/identity/external-keys.ts 2>&1 | head -20`

Expected: No errors (or only pre-existing errors from other files).

- [ ] **Step 3: Commit**

```bash
git add src/identity/external-keys.ts
git commit -m "feat(identity): add multibase validation module for external keys"
```

---

### Task 2: Lexicon Definitions

**Files:**
- Create: `src/lexicon/net.openfederation.identity.setExternalKey.json`
- Create: `src/lexicon/net.openfederation.identity.listExternalKeys.json`
- Create: `src/lexicon/net.openfederation.identity.getExternalKey.json`
- Create: `src/lexicon/net.openfederation.identity.deleteExternalKey.json`
- Create: `src/lexicon/net.openfederation.identity.resolveByKey.json`

- [ ] **Step 1: Create setExternalKey lexicon**

```json
{
  "lexicon": 1,
  "id": "net.openfederation.identity.setExternalKey",
  "description": "Create or update an external identity key in the authenticated user's ATProto repo.",
  "defs": {
    "main": {
      "type": "procedure",
      "description": "Store an auxiliary cryptographic public key for cross-network identity bridging (Meshtastic, Nostr, WireGuard, SSH, etc.).",
      "input": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "properties": {
            "rkey": { "type": "string", "description": "Record key identifier (1-512 chars, alphanumeric + hyphens)." },
            "type": { "type": "string", "enum": ["ed25519", "x25519", "secp256k1", "p256"], "description": "Key algorithm type." },
            "purpose": { "type": "string", "description": "Target network or use case (1-64 chars). Examples: meshtastic, nostr, wireguard, ssh, device." },
            "publicKey": { "type": "string", "description": "Public key in did:key multibase format (base58btc, z prefix)." },
            "label": { "type": "string", "description": "Optional human-readable label (max 100 chars)." }
          },
          "required": ["rkey", "type", "purpose", "publicKey"]
        }
      },
      "output": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "properties": {
            "uri": { "type": "string", "description": "AT URI of the created/updated record." },
            "cid": { "type": "string", "description": "CID of the record." }
          },
          "required": ["uri", "cid"]
        }
      },
      "errors": [
        { "name": "InvalidRequest", "description": "Missing required fields or validation failed." },
        { "name": "InvalidPublicKey", "description": "Public key format invalid or multicodec prefix doesn't match type." }
      ]
    }
  }
}
```

- [ ] **Step 2: Create listExternalKeys lexicon**

```json
{
  "lexicon": 1,
  "id": "net.openfederation.identity.listExternalKeys",
  "description": "List external identity keys for a DID. Public endpoint for bridge/discovery services.",
  "defs": {
    "main": {
      "type": "query",
      "description": "List external keys stored in a user's ATProto repo.",
      "parameters": {
        "type": "params",
        "properties": {
          "did": { "type": "string", "description": "The DID to look up." },
          "purpose": { "type": "string", "description": "Optional filter by purpose (e.g., meshtastic)." },
          "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 50, "description": "Max results." },
          "cursor": { "type": "string", "description": "Pagination cursor." }
        },
        "required": ["did"]
      },
      "output": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "properties": {
            "keys": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "uri": { "type": "string" },
                  "rkey": { "type": "string" },
                  "type": { "type": "string" },
                  "purpose": { "type": "string" },
                  "publicKey": { "type": "string" },
                  "label": { "type": "string" },
                  "createdAt": { "type": "string" }
                },
                "required": ["uri", "rkey", "type", "purpose", "publicKey", "createdAt"]
              }
            },
            "cursor": { "type": "string" }
          },
          "required": ["keys"]
        }
      },
      "errors": [
        { "name": "InvalidRequest", "description": "Missing or invalid DID." }
      ]
    }
  }
}
```

- [ ] **Step 3: Create getExternalKey lexicon**

```json
{
  "lexicon": 1,
  "id": "net.openfederation.identity.getExternalKey",
  "description": "Get a specific external identity key by DID and record key.",
  "defs": {
    "main": {
      "type": "query",
      "description": "Retrieve a single external key record.",
      "parameters": {
        "type": "params",
        "properties": {
          "did": { "type": "string", "description": "The DID." },
          "rkey": { "type": "string", "description": "The record key." }
        },
        "required": ["did", "rkey"]
      },
      "output": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "properties": {
            "uri": { "type": "string" },
            "rkey": { "type": "string" },
            "type": { "type": "string" },
            "purpose": { "type": "string" },
            "publicKey": { "type": "string" },
            "label": { "type": "string" },
            "createdAt": { "type": "string" }
          },
          "required": ["uri", "rkey", "type", "purpose", "publicKey", "createdAt"]
        }
      },
      "errors": [
        { "name": "InvalidRequest", "description": "Missing required parameters." },
        { "name": "KeyNotFound", "description": "No external key found for the given DID and rkey." }
      ]
    }
  }
}
```

- [ ] **Step 4: Create deleteExternalKey lexicon**

```json
{
  "lexicon": 1,
  "id": "net.openfederation.identity.deleteExternalKey",
  "description": "Delete an external identity key from the authenticated user's repo.",
  "defs": {
    "main": {
      "type": "procedure",
      "description": "Remove an external key record. Only the key owner can delete.",
      "input": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "properties": {
            "rkey": { "type": "string", "description": "The record key to delete." }
          },
          "required": ["rkey"]
        }
      },
      "output": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "properties": {
            "success": { "type": "boolean" }
          },
          "required": ["success"]
        }
      },
      "errors": [
        { "name": "InvalidRequest", "description": "Missing rkey." },
        { "name": "KeyNotFound", "description": "No external key found with the given rkey." }
      ]
    }
  }
}
```

- [ ] **Step 5: Create resolveByKey lexicon**

```json
{
  "lexicon": 1,
  "id": "net.openfederation.identity.resolveByKey",
  "description": "Reverse lookup: find the ATProto DID that owns a given external public key.",
  "defs": {
    "main": {
      "type": "query",
      "description": "Resolve an external public key to its ATProto identity. Critical for bridge services.",
      "parameters": {
        "type": "params",
        "properties": {
          "publicKey": { "type": "string", "description": "The public key in multibase format." },
          "purpose": { "type": "string", "description": "Optional: narrow search to a specific purpose." }
        },
        "required": ["publicKey"]
      },
      "output": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "properties": {
            "did": { "type": "string" },
            "handle": { "type": "string" },
            "rkey": { "type": "string" },
            "type": { "type": "string" },
            "purpose": { "type": "string" },
            "createdAt": { "type": "string" }
          },
          "required": ["did", "handle", "rkey", "type", "purpose", "createdAt"]
        }
      },
      "errors": [
        { "name": "InvalidRequest", "description": "Missing publicKey parameter." },
        { "name": "KeyNotFound", "description": "No identity found for the given public key." }
      ]
    }
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add src/lexicon/net.openfederation.identity.*.json
git commit -m "feat(identity): add lexicon definitions for external key endpoints"
```

---

### Task 3: Audit Action Types

**Files:**
- Modify: `src/db/audit.ts:3-37`

- [ ] **Step 1: Add external key audit actions**

Add `'identity.setExternalKey'` and `'identity.deleteExternalKey'` to the `AuditAction` union type in `src/db/audit.ts`.

Insert before the closing semicolon of the type union (after `'account.password.change'`):

```typescript
  | 'identity.setExternalKey'
  | 'identity.deleteExternalKey';
```

- [ ] **Step 2: Commit**

```bash
git add src/db/audit.ts
git commit -m "feat(identity): add audit action types for external keys"
```

---

### Task 4: setExternalKey Endpoint

**Files:**
- Create: `src/api/net.openfederation.identity.setExternalKey.ts`

- [ ] **Step 1: Create the handler**

```typescript
// src/api/net.openfederation.identity.setExternalKey.ts

import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireApprovedUser } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';
import {
  validatePublicKey,
  validateRkey,
  validatePurpose,
  validateLabel,
  EXTERNAL_KEY_COLLECTION,
} from '../identity/external-keys.js';

export default async function setExternalKey(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireApprovedUser(req, res)) return;

    const { rkey, type, purpose, publicKey, label } = req.body;

    // Validate required fields
    if (!rkey || !type || !purpose || !publicKey) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required fields: rkey, type, purpose, publicKey',
      });
      return;
    }

    // Validate rkey
    const rkeyResult = validateRkey(rkey);
    if (!rkeyResult.valid) {
      res.status(400).json({ error: 'InvalidRequest', message: rkeyResult.error });
      return;
    }

    // Validate purpose
    const purposeResult = validatePurpose(purpose);
    if (!purposeResult.valid) {
      res.status(400).json({ error: 'InvalidRequest', message: purposeResult.error });
      return;
    }

    // Validate label
    const labelResult = validateLabel(label);
    if (!labelResult.valid) {
      res.status(400).json({ error: 'InvalidRequest', message: labelResult.error });
      return;
    }

    // Validate public key format and multicodec prefix
    const keyResult = validatePublicKey(publicKey, type);
    if (!keyResult.valid) {
      res.status(400).json({ error: 'InvalidPublicKey', message: keyResult.error });
      return;
    }

    const did = req.auth!.did;
    const engine = new RepoEngine(did);
    const keypair = await getKeypairForDid(did);

    const record = {
      type,
      purpose,
      publicKey,
      ...(label ? { label } : {}),
      createdAt: new Date().toISOString(),
    };

    const result = await engine.putRecord(keypair, EXTERNAL_KEY_COLLECTION, rkey, record);

    await auditLog('identity.setExternalKey', req.auth!.userId, did, {
      rkey,
      type,
      purpose,
    });

    res.status(200).json({
      uri: result.uri,
      cid: result.cid,
    });
  } catch (error) {
    console.error('Error in setExternalKey:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to set external key',
    });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/api/net.openfederation.identity.setExternalKey.ts
git commit -m "feat(identity): add setExternalKey XRPC endpoint"
```

---

### Task 5: listExternalKeys Endpoint

**Files:**
- Create: `src/api/net.openfederation.identity.listExternalKeys.ts`

- [ ] **Step 1: Create the handler**

```typescript
// src/api/net.openfederation.identity.listExternalKeys.ts

import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { query } from '../db/client.js';
import { EXTERNAL_KEY_COLLECTION } from '../identity/external-keys.js';

export default async function listExternalKeys(req: AuthRequest, res: Response): Promise<void> {
  try {
    const did = req.query.did as string;
    const purpose = req.query.purpose as string | undefined;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 100);
    const cursor = req.query.cursor as string | undefined;

    if (!did || typeof did !== 'string' || !did.startsWith('did:')) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'did parameter is required and must be a valid DID',
      });
      return;
    }

    let sql = `SELECT rkey, record FROM records_index
               WHERE community_did = $1 AND collection = $2`;
    const params: (string | number)[] = [did, EXTERNAL_KEY_COLLECTION];
    let paramIdx = 3;

    if (cursor) {
      sql += ` AND rkey > $${paramIdx}`;
      params.push(cursor);
      paramIdx++;
    }

    sql += ` ORDER BY rkey ASC LIMIT $${paramIdx}`;
    params.push(limit + 1); // fetch one extra to detect if there are more

    const result = await query<{ rkey: string; record: any }>(sql, params);
    let rows = result.rows;

    let nextCursor: string | undefined;
    if (rows.length > limit) {
      rows = rows.slice(0, limit);
      nextCursor = rows[rows.length - 1].rkey;
    }

    // Filter by purpose if specified
    if (purpose) {
      rows = rows.filter(r => r.record?.purpose === purpose);
    }

    const keys = rows.map(row => ({
      uri: `at://${did}/${EXTERNAL_KEY_COLLECTION}/${row.rkey}`,
      rkey: row.rkey,
      type: row.record?.type,
      purpose: row.record?.purpose,
      publicKey: row.record?.publicKey,
      label: row.record?.label,
      createdAt: row.record?.createdAt,
    }));

    res.status(200).json({
      keys,
      ...(nextCursor ? { cursor: nextCursor } : {}),
    });
  } catch (error) {
    console.error('Error in listExternalKeys:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to list external keys',
    });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/api/net.openfederation.identity.listExternalKeys.ts
git commit -m "feat(identity): add listExternalKeys XRPC endpoint"
```

---

### Task 6: getExternalKey Endpoint

**Files:**
- Create: `src/api/net.openfederation.identity.getExternalKey.ts`

- [ ] **Step 1: Create the handler**

```typescript
// src/api/net.openfederation.identity.getExternalKey.ts

import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { query } from '../db/client.js';
import { EXTERNAL_KEY_COLLECTION } from '../identity/external-keys.js';

export default async function getExternalKey(req: AuthRequest, res: Response): Promise<void> {
  try {
    const did = req.query.did as string;
    const rkey = req.query.rkey as string;

    if (!did || typeof did !== 'string' || !did.startsWith('did:')) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'did parameter is required and must be a valid DID',
      });
      return;
    }

    if (!rkey) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'rkey parameter is required',
      });
      return;
    }

    const result = await query<{ record: any }>(
      `SELECT record FROM records_index
       WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
      [did, EXTERNAL_KEY_COLLECTION, rkey]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        error: 'KeyNotFound',
        message: 'No external key found for the given DID and rkey',
      });
      return;
    }

    const record = result.rows[0].record;

    res.status(200).json({
      uri: `at://${did}/${EXTERNAL_KEY_COLLECTION}/${rkey}`,
      rkey,
      type: record?.type,
      purpose: record?.purpose,
      publicKey: record?.publicKey,
      label: record?.label,
      createdAt: record?.createdAt,
    });
  } catch (error) {
    console.error('Error in getExternalKey:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to get external key',
    });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/api/net.openfederation.identity.getExternalKey.ts
git commit -m "feat(identity): add getExternalKey XRPC endpoint"
```

---

### Task 7: deleteExternalKey Endpoint

**Files:**
- Create: `src/api/net.openfederation.identity.deleteExternalKey.ts`

- [ ] **Step 1: Create the handler**

```typescript
// src/api/net.openfederation.identity.deleteExternalKey.ts

import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireApprovedUser } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';
import { query } from '../db/client.js';
import { EXTERNAL_KEY_COLLECTION } from '../identity/external-keys.js';

export default async function deleteExternalKey(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireApprovedUser(req, res)) return;

    const { rkey } = req.body;

    if (!rkey) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required field: rkey',
      });
      return;
    }

    const did = req.auth!.did;

    // Check the record exists before deleting
    const existing = await query(
      `SELECT 1 FROM records_index
       WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
      [did, EXTERNAL_KEY_COLLECTION, rkey]
    );

    if (existing.rows.length === 0) {
      res.status(404).json({
        error: 'KeyNotFound',
        message: 'No external key found with the given rkey',
      });
      return;
    }

    const engine = new RepoEngine(did);
    const keypair = await getKeypairForDid(did);
    await engine.deleteRecord(keypair, EXTERNAL_KEY_COLLECTION, rkey);

    await auditLog('identity.deleteExternalKey', req.auth!.userId, did, { rkey });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error in deleteExternalKey:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to delete external key',
    });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/api/net.openfederation.identity.deleteExternalKey.ts
git commit -m "feat(identity): add deleteExternalKey XRPC endpoint"
```

---

### Task 8: resolveByKey Endpoint

**Files:**
- Create: `src/api/net.openfederation.identity.resolveByKey.ts`

- [ ] **Step 1: Create the handler**

```typescript
// src/api/net.openfederation.identity.resolveByKey.ts

import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { query } from '../db/client.js';
import { EXTERNAL_KEY_COLLECTION } from '../identity/external-keys.js';

export default async function resolveByKey(req: AuthRequest, res: Response): Promise<void> {
  try {
    const publicKey = req.query.publicKey as string;
    const purpose = req.query.purpose as string | undefined;

    if (!publicKey) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'publicKey parameter is required',
      });
      return;
    }

    // Search records_index for matching publicKey in external key records.
    // PostgreSQL JSONB allows querying inside the record column.
    let sql = `SELECT ri.community_did, ri.rkey, ri.record, u.handle
               FROM records_index ri
               JOIN users u ON u.did = ri.community_did
               WHERE ri.collection = $1 AND ri.record->>'publicKey' = $2`;
    const params: string[] = [EXTERNAL_KEY_COLLECTION, publicKey];

    if (purpose) {
      sql += ` AND ri.record->>'purpose' = $3`;
      params.push(purpose);
    }

    sql += ' LIMIT 1';

    const result = await query<{
      community_did: string;
      rkey: string;
      record: any;
      handle: string;
    }>(sql, params);

    if (result.rows.length === 0) {
      res.status(404).json({
        error: 'KeyNotFound',
        message: 'No identity found for the given public key',
      });
      return;
    }

    const row = result.rows[0];
    res.status(200).json({
      did: row.community_did,
      handle: row.handle,
      rkey: row.rkey,
      type: row.record?.type,
      purpose: row.record?.purpose,
      createdAt: row.record?.createdAt,
    });
  } catch (error) {
    console.error('Error in resolveByKey:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to resolve key',
    });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/api/net.openfederation.identity.resolveByKey.ts
git commit -m "feat(identity): add resolveByKey XRPC endpoint for bridge discovery"
```

---

### Task 9: Register Handlers in Server

**Files:**
- Modify: `src/server/index.ts:1-257`

- [ ] **Step 1: Add imports**

Add after the line `import listPeerCommunities from '../api/net.openfederation.federation.listPeerCommunities.js';` (line 70):

```typescript
import setExternalKey from '../api/net.openfederation.identity.setExternalKey.js';
import listExternalKeys from '../api/net.openfederation.identity.listExternalKeys.js';
import getExternalKey from '../api/net.openfederation.identity.getExternalKey.js';
import deleteExternalKey from '../api/net.openfederation.identity.deleteExternalKey.js';
import resolveByKeyHandler from '../api/net.openfederation.identity.resolveByKey.js';
```

- [ ] **Step 2: Add handler entries**

Add after the partner API entries block (after line 231 `'net.openfederation.partner.revokeKey': { handler: revokePartnerKey },`):

```typescript

  // External identity key endpoints
  'net.openfederation.identity.setExternalKey': { handler: setExternalKey },
  'net.openfederation.identity.listExternalKeys': { handler: listExternalKeys, limiter: discoveryLimiter },
  'net.openfederation.identity.getExternalKey': { handler: getExternalKey, limiter: discoveryLimiter },
  'net.openfederation.identity.deleteExternalKey': { handler: deleteExternalKey },
  'net.openfederation.identity.resolveByKey': { handler: resolveByKeyHandler, limiter: discoveryLimiter },
```

Note: Read endpoints (`list`, `get`, `resolveByKey`) use `discoveryLimiter` (60/min) since they're public and bridge-facing.

- [ ] **Step 3: Build the project**

Run: `npm run build`

Expected: Clean build with no errors.

- [ ] **Step 4: Commit**

```bash
git add src/server/index.ts
git commit -m "feat(identity): register external key XRPC handlers"
```

---

### Task 10: Integration Tests

**Files:**
- Create: `tests/api/net.openfederation.identity.externalKeys.test.ts`

These tests require the PLC directory to be running (user registration creates `did:plc`). Tests use the `createTestUser` helper from `tests/api/helpers.ts`.

- [ ] **Step 1: Write the test file**

```typescript
// tests/api/net.openfederation.identity.externalKeys.test.ts

import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcPost,
  xrpcGet,
  xrpcAuthPost,
  xrpcAuthGet,
  createTestUser,
  isPLCAvailable,
  uniqueHandle,
} from './helpers.js';

// A valid Ed25519 public key in multibase (base58btc) format.
// This is multicodec prefix 0xed01 + 32 bytes of key material.
// Generated from: base58btc.encode(Uint8Array.from([0xed, 0x01, ...32 random bytes]))
const VALID_ED25519_KEY = 'z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
// A different valid Ed25519 key for multi-key tests
const VALID_ED25519_KEY_2 = 'z6MkpTHR8VNs5zPpBBXUsb7nnawm5hnfQdPbWQyTjVc9rpNf';

describe('External Identity Keys', () => {
  let plcAvailable: boolean;
  let user: { accessJwt: string; did: string; handle: string };

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;
    user = await createTestUser(uniqueHandle('extkey'));
  });

  describe('setExternalKey', () => {
    it('should reject unauthenticated requests', async () => {
      const res = await xrpcPost('net.openfederation.identity.setExternalKey', {
        rkey: 'test-key',
        type: 'ed25519',
        purpose: 'meshtastic',
        publicKey: VALID_ED25519_KEY,
      });
      expect(res.status).toBe(401);
    });

    it('should reject missing required fields', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost(
        'net.openfederation.identity.setExternalKey',
        user.accessJwt,
        { rkey: 'test-key' }
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('InvalidRequest');
    });

    it('should reject invalid key type', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost(
        'net.openfederation.identity.setExternalKey',
        user.accessJwt,
        {
          rkey: 'test-key',
          type: 'rsa',
          purpose: 'meshtastic',
          publicKey: VALID_ED25519_KEY,
        }
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('InvalidPublicKey');
    });

    it('should reject mismatched type and multicodec prefix', async () => {
      if (!plcAvailable) return;
      // Pass an ed25519 key but declare type as secp256k1
      const res = await xrpcAuthPost(
        'net.openfederation.identity.setExternalKey',
        user.accessJwt,
        {
          rkey: 'test-key',
          type: 'secp256k1',
          purpose: 'nostr',
          publicKey: VALID_ED25519_KEY,
        }
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('InvalidPublicKey');
    });

    it('should reject invalid rkey format', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost(
        'net.openfederation.identity.setExternalKey',
        user.accessJwt,
        {
          rkey: '-invalid-',
          type: 'ed25519',
          purpose: 'meshtastic',
          publicKey: VALID_ED25519_KEY,
        }
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('InvalidRequest');
    });

    it('should reject purpose longer than 64 chars', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost(
        'net.openfederation.identity.setExternalKey',
        user.accessJwt,
        {
          rkey: 'test-key',
          type: 'ed25519',
          purpose: 'a'.repeat(65),
          publicKey: VALID_ED25519_KEY,
        }
      );
      expect(res.status).toBe(400);
    });

    it('should reject label longer than 100 chars', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost(
        'net.openfederation.identity.setExternalKey',
        user.accessJwt,
        {
          rkey: 'test-key',
          type: 'ed25519',
          purpose: 'meshtastic',
          publicKey: VALID_ED25519_KEY,
          label: 'x'.repeat(101),
        }
      );
      expect(res.status).toBe(400);
    });

    it('should create an external key record', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost(
        'net.openfederation.identity.setExternalKey',
        user.accessJwt,
        {
          rkey: 'mesh-relay-1',
          type: 'ed25519',
          purpose: 'meshtastic',
          publicKey: VALID_ED25519_KEY,
          label: 'My relay node',
        }
      );
      expect(res.status).toBe(200);
      expect(res.body.uri).toContain('net.openfederation.identity.externalKey');
      expect(res.body.cid).toBeTruthy();
    });

    it('should create a second key with different rkey', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost(
        'net.openfederation.identity.setExternalKey',
        user.accessJwt,
        {
          rkey: 'mesh-mobile',
          type: 'ed25519',
          purpose: 'meshtastic',
          publicKey: VALID_ED25519_KEY_2,
        }
      );
      expect(res.status).toBe(200);
    });

    it('should overwrite an existing key (rotation)', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost(
        'net.openfederation.identity.setExternalKey',
        user.accessJwt,
        {
          rkey: 'mesh-relay-1',
          type: 'ed25519',
          purpose: 'meshtastic',
          publicKey: VALID_ED25519_KEY_2,
          label: 'Rotated key',
        }
      );
      expect(res.status).toBe(200);
    });
  });

  describe('getExternalKey', () => {
    it('should return a specific key', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.identity.getExternalKey', {
        did: user.did,
        rkey: 'mesh-relay-1',
      });
      expect(res.status).toBe(200);
      expect(res.body.type).toBe('ed25519');
      expect(res.body.purpose).toBe('meshtastic');
      expect(res.body.publicKey).toBe(VALID_ED25519_KEY_2); // rotated
      expect(res.body.label).toBe('Rotated key');
      expect(res.body.createdAt).toBeTruthy();
    });

    it('should return 404 for non-existent key', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.identity.getExternalKey', {
        did: user.did,
        rkey: 'nonexistent',
      });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('KeyNotFound');
    });

    it('should reject missing did', async () => {
      const res = await xrpcGet('net.openfederation.identity.getExternalKey', {
        rkey: 'test',
      });
      expect(res.status).toBe(400);
    });
  });

  describe('listExternalKeys', () => {
    it('should list all keys for a DID', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.identity.listExternalKeys', {
        did: user.did,
      });
      expect(res.status).toBe(200);
      expect(res.body.keys.length).toBe(2);
    });

    it('should filter by purpose', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.identity.listExternalKeys', {
        did: user.did,
        purpose: 'meshtastic',
      });
      expect(res.status).toBe(200);
      expect(res.body.keys.length).toBe(2);
      expect(res.body.keys.every((k: any) => k.purpose === 'meshtastic')).toBe(true);
    });

    it('should return empty for unknown DID', async () => {
      const res = await xrpcGet('net.openfederation.identity.listExternalKeys', {
        did: 'did:plc:nonexistent',
      });
      expect(res.status).toBe(200);
      expect(res.body.keys.length).toBe(0);
    });

    it('should reject missing did', async () => {
      const res = await xrpcGet('net.openfederation.identity.listExternalKeys', {});
      expect(res.status).toBe(400);
    });
  });

  describe('resolveByKey', () => {
    it('should resolve a public key to its DID', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.identity.resolveByKey', {
        publicKey: VALID_ED25519_KEY_2,
      });
      expect(res.status).toBe(200);
      expect(res.body.did).toBe(user.did);
      expect(res.body.handle).toBeTruthy();
      expect(res.body.type).toBe('ed25519');
    });

    it('should return 404 for unknown key', async () => {
      const res = await xrpcGet('net.openfederation.identity.resolveByKey', {
        publicKey: 'z6MkrCD1cSyzsKR3xFKhYV1xczJ3LqEcSQVdZpvpuRNpMpwi',
      });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('KeyNotFound');
    });

    it('should reject missing publicKey', async () => {
      const res = await xrpcGet('net.openfederation.identity.resolveByKey', {});
      expect(res.status).toBe(400);
    });
  });

  describe('deleteExternalKey', () => {
    it('should reject unauthenticated', async () => {
      const res = await xrpcPost('net.openfederation.identity.deleteExternalKey', {
        rkey: 'mesh-mobile',
      });
      expect(res.status).toBe(401);
    });

    it('should reject missing rkey', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost(
        'net.openfederation.identity.deleteExternalKey',
        user.accessJwt,
        {}
      );
      expect(res.status).toBe(400);
    });

    it('should return 404 for non-existent key', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost(
        'net.openfederation.identity.deleteExternalKey',
        user.accessJwt,
        { rkey: 'nonexistent' }
      );
      expect(res.status).toBe(404);
    });

    it('should delete a key', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost(
        'net.openfederation.identity.deleteExternalKey',
        user.accessJwt,
        { rkey: 'mesh-mobile' }
      );
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify it's gone
      const getRes = await xrpcGet('net.openfederation.identity.getExternalKey', {
        did: user.did,
        rkey: 'mesh-mobile',
      });
      expect(getRes.status).toBe(404);
    });

    it('should show one fewer key after deletion', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.identity.listExternalKeys', {
        did: user.did,
      });
      expect(res.status).toBe(200);
      expect(res.body.keys.length).toBe(1);
    });
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/api/net.openfederation.identity.externalKeys.test.ts`

Expected: All tests pass (or skip if PLC not available).

- [ ] **Step 3: Commit**

```bash
git add tests/api/net.openfederation.identity.externalKeys.test.ts
git commit -m "test(identity): add integration tests for external key endpoints"
```

---

### Task 11: Generate Valid Test Keys

The test file uses hardcoded multibase keys. These must be real valid Ed25519 keys with the correct multicodec prefix. This task generates them and updates the test if needed.

- [ ] **Step 1: Generate real Ed25519 test keys**

Run the following to verify the hardcoded keys are valid (or generate correct ones):

```bash
node --input-type=module -e "
import { base58btc } from 'multiformats/bases/base58';
import crypto from 'crypto';

// Generate two Ed25519 keypairs
const k1 = crypto.generateKeyPairSync('ed25519');
const k2 = crypto.generateKeyPairSync('ed25519');

// Extract raw 32-byte public keys
const raw1 = k1.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
const raw2 = k2.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);

// Encode as multibase with ed25519 multicodec prefix (0xed, 0x01)
const mb1 = base58btc.encode(Uint8Array.from([0xed, 0x01, ...raw1]));
const mb2 = base58btc.encode(Uint8Array.from([0xed, 0x01, ...raw2]));

console.log('Key 1:', mb1);
console.log('Key 2:', mb2);

// Verify round-trip
const decoded = base58btc.decode(mb1);
console.log('Prefix check:', decoded[0] === 0xed && decoded[1] === 0x01 ? 'PASS' : 'FAIL');
console.log('Length check:', decoded.length === 34 ? 'PASS' : 'FAIL');
"
```

- [ ] **Step 2: Update test constants if needed**

If the generated keys differ from the placeholders in the test file, update `VALID_ED25519_KEY` and `VALID_ED25519_KEY_2` in `tests/api/net.openfederation.identity.externalKeys.test.ts` with the generated values.

- [ ] **Step 3: Re-run tests to confirm**

Run: `npx vitest run tests/api/net.openfederation.identity.externalKeys.test.ts`

Expected: All tests pass.

- [ ] **Step 4: Commit if updated**

```bash
git add tests/api/net.openfederation.identity.externalKeys.test.ts
git commit -m "test(identity): use generated Ed25519 test keys"
```

---

### Task 12: Full Build + Verification

- [ ] **Step 1: Build the complete project**

Run: `npm run build`

Expected: Clean build with no new errors.

- [ ] **Step 2: Run all tests**

Run: `npx vitest run`

Expected: All tests pass (existing + new external key tests).

- [ ] **Step 3: Final commit if any fixes were needed**

Only if build or tests required adjustments.
