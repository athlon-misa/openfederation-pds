# On-Chain Governance Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the chain-agnostic PDS infrastructure for on-chain governance — Oracle credential system, authentication, governance proof submission, and enforcement integration.

**Architecture:** Oracle credentials are per-community, stored in a dedicated table isolated from partner keys. Oracles authenticate via `X-Oracle-Key` header and submit changes through existing repo write endpoints. `enforceGovernance()` allows writes from Oracle-authenticated requests when mode is `on-chain`. `setGovernanceModel` is updated to accept `on-chain` with chain config.

**Tech Stack:** TypeScript, PostgreSQL, Express.js, Node.js crypto

---

## File Map

### New files

| File | Purpose |
|------|---------|
| `scripts/migrate-013-oracle-credentials.sql` | Oracle credentials table |
| `src/auth/oracle-keys.ts` | Key generation (`ofo_` prefix) and format validation |
| `src/auth/oracle-guard.ts` | Validate `X-Oracle-Key` header, return `OracleContext` |
| `src/api/net.openfederation.oracle.createCredential.ts` | Admin creates credential for a community |
| `src/api/net.openfederation.oracle.listCredentials.ts` | Admin lists credentials |
| `src/api/net.openfederation.oracle.revokeCredential.ts` | Admin revokes a credential |
| `src/lexicon/net.openfederation.oracle.createCredential.json` | Lexicon |
| `src/lexicon/net.openfederation.oracle.listCredentials.json` | Lexicon |
| `src/lexicon/net.openfederation.oracle.revokeCredential.json` | Lexicon |

### Modified files

| File | Change |
|------|--------|
| `src/db/schema.sql` | Add `oracle_credentials` table |
| `src/db/audit.ts` | Add Oracle audit actions |
| `src/governance/enforcement.ts` | Accept `OracleContext` param, allow on-chain writes from Oracle |
| `src/api/com.atproto.repo.putRecord.ts` | Pass Oracle context to `enforceGovernance`, extract governance proof |
| `src/api/com.atproto.repo.createRecord.ts` | Same |
| `src/api/com.atproto.repo.deleteRecord.ts` | Same |
| `src/api/net.openfederation.community.setGovernanceModel.ts` | Accept `on-chain` mode with validation |
| `src/server/index.ts` | Register Oracle handlers, add Oracle middleware |
| `cli/ofc.ts` | Add `oracle create/list/revoke` commands |

---

## Task 1: Oracle key generation module

**Files:**
- Create: `src/auth/oracle-keys.ts`

- [ ] **Step 1: Create oracle key module**

Write `src/auth/oracle-keys.ts` — follows the exact pattern of `src/auth/partner-keys.ts`:

```typescript
import crypto from 'crypto';
import { hashToken } from './tokens.js';

const ORACLE_KEY_PREFIX = 'ofo_';

/**
 * Generate a new Oracle API key.
 * Returns the raw key (shown once) and its SHA-256 hash (stored in DB).
 */
export function generateOracleKey(): { rawKey: string; keyHash: string; keyPrefix: string } {
  const randomBytes = crypto.randomBytes(48);
  const rawKey = ORACLE_KEY_PREFIX + randomBytes.toString('base64url');
  const keyHash = hashToken(rawKey);
  const keyPrefix = rawKey.substring(0, ORACLE_KEY_PREFIX.length + 12);
  return { rawKey, keyHash, keyPrefix };
}

/**
 * Validate that a string looks like an Oracle key format.
 */
export function isValidOracleKeyFormat(key: string): boolean {
  return key.startsWith(ORACLE_KEY_PREFIX) && key.length > ORACLE_KEY_PREFIX.length + 8;
}

/**
 * Hash an Oracle key for DB lookup.
 */
export function hashOracleKey(key: string): string {
  return hashToken(key);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/auth/oracle-keys.ts
git commit -m "feat(oracle): add Oracle key generation module (#20)"
```

---

## Task 2: Database migration and schema

**Files:**
- Create: `scripts/migrate-013-oracle-credentials.sql`
- Modify: `src/db/schema.sql`

- [ ] **Step 1: Create migration**

Write `scripts/migrate-013-oracle-credentials.sql`:

```sql
-- Migration 013: Oracle credentials for on-chain governance
CREATE TABLE IF NOT EXISTS oracle_credentials (
    id VARCHAR(36) PRIMARY KEY,
    community_did VARCHAR(255) NOT NULL,
    key_prefix VARCHAR(16) NOT NULL,
    key_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    created_by VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    allowed_origins JSONB,
    revoked_at TIMESTAMP WITH TIME ZONE,
    last_used_at TIMESTAMP WITH TIME ZONE,
    proofs_submitted INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_oracle_credentials_hash ON oracle_credentials(key_hash);
CREATE INDEX IF NOT EXISTS idx_oracle_credentials_community ON oracle_credentials(community_did);
```

- [ ] **Step 2: Add table to schema.sql**

Add the same table definition to `src/db/schema.sql` at the end so fresh installs include it.

- [ ] **Step 3: Commit**

```bash
git add scripts/migrate-013-oracle-credentials.sql src/db/schema.sql
git commit -m "feat(oracle): add oracle_credentials table (#20)"
```

---

## Task 3: Oracle guard (authentication)

**Files:**
- Create: `src/auth/oracle-guard.ts`

- [ ] **Step 1: Create oracle guard**

Write `src/auth/oracle-guard.ts`:

```typescript
import type { Request } from 'express';
import { query } from '../db/client.js';
import { isValidOracleKeyFormat, hashOracleKey } from './oracle-keys.js';

export interface OracleContext {
  credentialId: string;
  communityDid: string;
  name: string;
}

/**
 * Validate an X-Oracle-Key header and return the Oracle context.
 * Returns null if the key is missing, invalid, or doesn't match the community.
 * Does NOT send error responses — caller decides how to handle null.
 */
export async function validateOracleKey(req: Request): Promise<OracleContext | null> {
  const rawKey = req.headers['x-oracle-key'] as string | undefined;
  if (!rawKey || !isValidOracleKeyFormat(rawKey)) return null;

  const keyHash = hashOracleKey(rawKey);

  const result = await query<{
    id: string;
    community_did: string;
    name: string;
    status: string;
    allowed_origins: string[] | null;
  }>(
    `SELECT id, community_did, name, status, allowed_origins
     FROM oracle_credentials WHERE key_hash = $1`,
    [keyHash]
  );

  if (result.rows.length === 0) return null;

  const cred = result.rows[0];
  if (cred.status !== 'active') return null;

  // Validate origin if allowed_origins is set
  if (cred.allowed_origins && cred.allowed_origins.length > 0) {
    const origin = req.headers.origin as string | undefined;
    if (!origin || !cred.allowed_origins.includes(origin)) return null;
  }

  // Update usage stats (fire-and-forget)
  query(
    'UPDATE oracle_credentials SET last_used_at = CURRENT_TIMESTAMP, proofs_submitted = proofs_submitted + 1 WHERE id = $1',
    [cred.id]
  ).catch(() => {});

  return {
    credentialId: cred.id,
    communityDid: cred.community_did,
    name: cred.name,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/auth/oracle-guard.ts
git commit -m "feat(oracle): add Oracle key authentication guard (#20)"
```

---

## Task 4: Oracle CRUD endpoints

**Files:**
- Create: `src/api/net.openfederation.oracle.createCredential.ts`
- Create: `src/api/net.openfederation.oracle.listCredentials.ts`
- Create: `src/api/net.openfederation.oracle.revokeCredential.ts`
- Create: `src/lexicon/net.openfederation.oracle.createCredential.json`
- Create: `src/lexicon/net.openfederation.oracle.listCredentials.json`
- Create: `src/lexicon/net.openfederation.oracle.revokeCredential.json`
- Modify: `src/db/audit.ts`
- Modify: `src/server/index.ts`

- [ ] **Step 1: Add audit actions**

In `src/db/audit.ts`, add to the `AuditAction` union:

```typescript
  | 'oracle.credential.create'
  | 'oracle.credential.revoke'
  | 'oracle.proofApplied'
```

- [ ] **Step 2: Create lexicon files**

Write `src/lexicon/net.openfederation.oracle.createCredential.json`:

```json
{
  "lexicon": 1,
  "id": "net.openfederation.oracle.createCredential",
  "description": "Create an Oracle credential for on-chain governance. Admin only.",
  "defs": {
    "main": {
      "type": "procedure",
      "description": "Generate a new Oracle credential scoped to a community. Returns the raw key once.",
      "input": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "required": ["communityDid", "name"],
          "properties": {
            "communityDid": { "type": "string", "description": "Community DID this credential is scoped to." },
            "name": { "type": "string", "description": "Human label for this credential." },
            "allowedOrigins": { "type": "array", "items": { "type": "string" }, "description": "Optional origin restrictions." }
          }
        }
      },
      "output": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "required": ["id", "key", "keyPrefix", "communityDid", "name"],
          "properties": {
            "id": { "type": "string" },
            "key": { "type": "string", "description": "Raw key — shown once, never again." },
            "keyPrefix": { "type": "string" },
            "communityDid": { "type": "string" },
            "name": { "type": "string" }
          }
        }
      },
      "errors": [
        { "name": "InvalidRequest", "description": "Missing fields or community not found." },
        { "name": "CredentialExists", "description": "An active credential already exists for this community." }
      ]
    }
  }
}
```

Write `src/lexicon/net.openfederation.oracle.listCredentials.json`:

```json
{
  "lexicon": 1,
  "id": "net.openfederation.oracle.listCredentials",
  "description": "List Oracle credentials. Admin only.",
  "defs": {
    "main": {
      "type": "query",
      "description": "List Oracle credentials, optionally filtered by community DID.",
      "parameters": {
        "type": "params",
        "properties": {
          "communityDid": { "type": "string", "description": "Filter by community DID." }
        }
      },
      "output": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "required": ["credentials"],
          "properties": {
            "credentials": {
              "type": "array",
              "items": { "type": "ref", "ref": "#credentialInfo" }
            }
          }
        }
      }
    },
    "credentialInfo": {
      "type": "object",
      "required": ["id", "communityDid", "keyPrefix", "name", "status", "createdAt"],
      "properties": {
        "id": { "type": "string" },
        "communityDid": { "type": "string" },
        "keyPrefix": { "type": "string" },
        "name": { "type": "string" },
        "status": { "type": "string" },
        "proofsSubmitted": { "type": "integer" },
        "lastUsedAt": { "type": "string", "format": "datetime" },
        "createdAt": { "type": "string", "format": "datetime" }
      }
    }
  }
}
```

Write `src/lexicon/net.openfederation.oracle.revokeCredential.json`:

```json
{
  "lexicon": 1,
  "id": "net.openfederation.oracle.revokeCredential",
  "description": "Revoke an Oracle credential. Admin only.",
  "defs": {
    "main": {
      "type": "procedure",
      "description": "Revoke an Oracle credential by ID.",
      "input": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "required": ["credentialId"],
          "properties": {
            "credentialId": { "type": "string", "description": "ID of the credential to revoke." }
          }
        }
      },
      "output": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "required": ["success"],
          "properties": {
            "success": { "type": "boolean" }
          }
        }
      },
      "errors": [
        { "name": "NotFound", "description": "Credential not found." }
      ]
    }
  }
}
```

- [ ] **Step 3: Create createCredential handler**

Write `src/api/net.openfederation.oracle.createCredential.ts`:

```typescript
import { Response } from 'express';
import crypto from 'crypto';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth, requireRole } from '../auth/guards.js';
import { generateOracleKey } from '../auth/oracle-keys.js';
import { auditLog } from '../db/audit.js';
import { query } from '../db/client.js';

export default async function createOracleCredential(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    if (!requireRole(req, res, ['admin'])) return;

    const { communityDid, name, allowedOrigins } = req.body || {};

    if (!communityDid || !name) {
      res.status(400).json({ error: 'InvalidRequest', message: 'communityDid and name are required.' });
      return;
    }

    // Verify community exists
    const communityResult = await query('SELECT 1 FROM communities WHERE did = $1', [communityDid]);
    if (communityResult.rows.length === 0) {
      res.status(404).json({ error: 'InvalidRequest', message: 'Community not found.' });
      return;
    }

    // Check for existing active credential
    const existingResult = await query(
      `SELECT 1 FROM oracle_credentials WHERE community_did = $1 AND status = 'active'`,
      [communityDid]
    );
    if (existingResult.rows.length > 0) {
      res.status(409).json({
        error: 'CredentialExists',
        message: 'An active Oracle credential already exists for this community. Revoke it first.',
      });
      return;
    }

    const { rawKey, keyHash, keyPrefix } = generateOracleKey();
    const id = crypto.randomUUID();

    await query(
      `INSERT INTO oracle_credentials (id, community_did, key_prefix, key_hash, name, created_by, allowed_origins)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, communityDid, keyPrefix, keyHash, name, req.auth!.userId, allowedOrigins ? JSON.stringify(allowedOrigins) : null]
    );

    await auditLog('oracle.credential.create', req.auth!.userId, communityDid, {
      credentialId: id, name, keyPrefix,
    });

    res.status(201).json({ id, key: rawKey, keyPrefix, communityDid, name });
  } catch (error) {
    console.error('Error creating Oracle credential:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to create credential.' });
  }
}
```

- [ ] **Step 4: Create listCredentials handler**

Write `src/api/net.openfederation.oracle.listCredentials.ts`:

```typescript
import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth, requireRole } from '../auth/guards.js';
import { query } from '../db/client.js';

export default async function listOracleCredentials(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    if (!requireRole(req, res, ['admin'])) return;

    const communityDid = req.query.communityDid as string | undefined;

    let sql = `SELECT id, community_did, key_prefix, name, status, proofs_submitted, last_used_at, created_at
               FROM oracle_credentials`;
    const params: string[] = [];

    if (communityDid) {
      sql += ' WHERE community_did = $1';
      params.push(communityDid);
    }

    sql += ' ORDER BY created_at DESC';

    const result = await query<{
      id: string; community_did: string; key_prefix: string; name: string;
      status: string; proofs_submitted: number; last_used_at: string | null; created_at: string;
    }>(sql, params);

    const credentials = result.rows.map(row => ({
      id: row.id,
      communityDid: row.community_did,
      keyPrefix: row.key_prefix,
      name: row.name,
      status: row.status,
      proofsSubmitted: row.proofs_submitted,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
    }));

    res.status(200).json({ credentials });
  } catch (error) {
    console.error('Error listing Oracle credentials:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to list credentials.' });
  }
}
```

- [ ] **Step 5: Create revokeCredential handler**

Write `src/api/net.openfederation.oracle.revokeCredential.ts`:

```typescript
import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth, requireRole } from '../auth/guards.js';
import { auditLog } from '../db/audit.js';
import { query } from '../db/client.js';

export default async function revokeOracleCredential(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    if (!requireRole(req, res, ['admin'])) return;

    const { credentialId } = req.body || {};

    if (!credentialId) {
      res.status(400).json({ error: 'InvalidRequest', message: 'credentialId is required.' });
      return;
    }

    const result = await query<{ community_did: string }>(
      `UPDATE oracle_credentials SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'active' RETURNING community_did`,
      [credentialId]
    );

    if (result.rowCount === 0) {
      res.status(404).json({ error: 'NotFound', message: 'Active credential not found.' });
      return;
    }

    await auditLog('oracle.credential.revoke', req.auth!.userId, result.rows[0].community_did, {
      credentialId,
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error revoking Oracle credential:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to revoke credential.' });
  }
}
```

- [ ] **Step 6: Register handlers in server/index.ts**

Import and register the three handlers:

```typescript
import createOracleCredential from '../api/net.openfederation.oracle.createCredential.js';
import listOracleCredentials from '../api/net.openfederation.oracle.listCredentials.js';
import revokeOracleCredential from '../api/net.openfederation.oracle.revokeCredential.js';
```

Add to handler registry:

```typescript
'net.openfederation.oracle.createCredential': { handler: createOracleCredential },
'net.openfederation.oracle.listCredentials': { handler: listOracleCredentials },
'net.openfederation.oracle.revokeCredential': { handler: revokeOracleCredential },
```

- [ ] **Step 7: Build and commit**

```bash
npm run build
git add src/api/net.openfederation.oracle.*.ts src/lexicon/net.openfederation.oracle.*.json src/db/audit.ts src/server/index.ts
git commit -m "feat(oracle): add credential CRUD endpoints (#20)"
```

---

## Task 5: Governance enforcement integration

**Files:**
- Modify: `src/governance/enforcement.ts`
- Modify: `src/api/com.atproto.repo.putRecord.ts`
- Modify: `src/api/com.atproto.repo.createRecord.ts`
- Modify: `src/api/com.atproto.repo.deleteRecord.ts`

- [ ] **Step 1: Update enforceGovernance to accept OracleContext**

In `src/governance/enforcement.ts`, add the import and update the function signature:

```typescript
import type { OracleContext } from '../auth/oracle-guard.js';
```

Update the `enforceGovernance` function signature:

```typescript
export async function enforceGovernance(
  communityDid: string,
  collection: string,
  action: 'write' | 'delete',
  oracleContext?: OracleContext | null,
): Promise<GovernanceResult> {
```

Update the `on-chain` case:

```typescript
    case 'on-chain':
      if (oracleContext && oracleContext.communityDid === communityDid) {
        return { allowed: true, governanceModel };
      }
      return {
        allowed: false,
        reason: 'GovernanceRequired: on-chain governance is active. Writes to protected collections must come via an authorized Oracle service.',
        governanceModel,
      };
```

- [ ] **Step 2: Update putRecord to pass Oracle context**

In `src/api/com.atproto.repo.putRecord.ts`:

1. Add imports:
```typescript
import { validateOracleKey } from '../auth/oracle-guard.js';
import type { OracleContext } from '../auth/oracle-guard.js';
import { auditLog } from '../db/audit.js';
```

2. Before the governance enforcement block (`if (await isCommunityDid(repo))`), add Oracle validation:

```typescript
    // Check for Oracle authentication
    let oracleContext: OracleContext | null = null;
    if (req.headers['x-oracle-key']) {
      oracleContext = await validateOracleKey(req);
    }
```

3. Pass the Oracle context to `enforceGovernance`:

```typescript
      const governance = await enforceGovernance(repo, collection, 'write', oracleContext);
```

4. After the successful write (after `engine.putRecord` call), if Oracle context is present, log the governance proof:

```typescript
    // Log governance proof if Oracle-submitted
    if (oracleContext && req.body.governanceProof) {
      await auditLog('oracle.proofApplied', oracleContext.credentialId, repo, {
        collection, rkey, action: 'write',
        proof: req.body.governanceProof,
      });
    }
```

- [ ] **Step 3: Update createRecord the same way**

Apply the same 4 changes to `src/api/com.atproto.repo.createRecord.ts`:
- Import `validateOracleKey` and `OracleContext`
- Validate Oracle key before governance check
- Pass `oracleContext` to `enforceGovernance`
- Log governance proof after successful write

- [ ] **Step 4: Update deleteRecord the same way**

Apply the same changes to `src/api/com.atproto.repo.deleteRecord.ts`:
- Import, validate, pass context, log proof (with `action: 'delete'`)

- [ ] **Step 5: Build and commit**

```bash
npm run build
git add src/governance/enforcement.ts src/api/com.atproto.repo.putRecord.ts src/api/com.atproto.repo.createRecord.ts src/api/com.atproto.repo.deleteRecord.ts
git commit -m "feat(oracle): integrate Oracle auth with governance enforcement (#20)

enforceGovernance() now accepts OracleContext. On-chain mode allows
writes from Oracle-authenticated requests. Governance proofs are
logged to audit trail."
```

---

## Task 6: Update setGovernanceModel for on-chain mode

**Files:**
- Modify: `src/api/net.openfederation.community.setGovernanceModel.ts`

- [ ] **Step 1: Add `on-chain` to valid models and add validation**

In `src/api/net.openfederation.community.setGovernanceModel.ts`:

1. Update the `VALID_MODELS` constant:

```typescript
const VALID_MODELS = ['benevolent-dictator', 'simple-majority', 'on-chain'];
```

2. Add validation for on-chain config after the existing simple-majority validation block (after line 69):

```typescript
    if (governanceModel === 'on-chain') {
      if (!governanceConfig || typeof governanceConfig !== 'object') {
        res.status(400).json({
          error: 'InvalidRequest',
          message: 'governanceConfig is required for on-chain (chainId, contractAddress)',
        });
        return;
      }
      if (!governanceConfig.chainId || typeof governanceConfig.chainId !== 'string') {
        res.status(400).json({ error: 'InvalidRequest', message: 'governanceConfig.chainId is required' });
        return;
      }
      if (!governanceConfig.contractAddress || typeof governanceConfig.contractAddress !== 'string') {
        res.status(400).json({ error: 'InvalidRequest', message: 'governanceConfig.contractAddress is required' });
        return;
      }

      // Verify an active Oracle credential exists for this community
      const oracleResult = await query(
        `SELECT 1 FROM oracle_credentials WHERE community_did = $1 AND status = 'active'`,
        [communityDid]
      );
      if (oracleResult.rows.length === 0) {
        res.status(400).json({
          error: 'InvalidRequest',
          message: 'An active Oracle credential must exist for this community before enabling on-chain governance. Create one first.',
        });
        return;
      }

      // Normalize protectedCollections (same logic as simple-majority)
      if (governanceConfig.protectedCollections) {
        if (!Array.isArray(governanceConfig.protectedCollections)) {
          res.status(400).json({ error: 'InvalidRequest', message: 'protectedCollections must be an array' });
          return;
        }
        const mandatory = ['net.openfederation.community.settings', 'net.openfederation.community.role'];
        const normalized = governanceConfig.protectedCollections.map((c: string) =>
          c.startsWith('net.openfederation.community.') ? c : `net.openfederation.community.${c}`
        );
        for (const m of mandatory) {
          if (!normalized.includes(m)) normalized.push(m);
        }
        governanceConfig.protectedCollections = normalized;
      }
    }
```

3. Remove the "on-chain is not yet available" error message from the model validation (line 25 — the current check rejects anything not in `VALID_MODELS`, which now includes `on-chain`).

- [ ] **Step 2: Add the query import if not present**

The `query` function should already be imported. Verify.

- [ ] **Step 3: Build and commit**

```bash
npm run build
git add src/api/net.openfederation.community.setGovernanceModel.ts
git commit -m "feat(oracle): enable on-chain governance mode with chain config (#20)

setGovernanceModel now accepts 'on-chain' with required chainId and
contractAddress. Validates that an active Oracle credential exists
before allowing the switch. Protected collection normalization
reused from simple-majority."
```

---

## Task 7: CLI commands

**Files:**
- Modify: `cli/ofc.ts`

- [ ] **Step 1: Add oracle command group**

Add a new top-level command group in `cli/ofc.ts` (after the `security` section):

```typescript
// ── ofc oracle ──────────────────────────────────────────────────────

const oracle = program.command('oracle').description('Oracle credential management (admin)');

oracle
  .command('create')
  .description('Create an Oracle credential for a community')
  .argument('<communityDid>', 'Community DID')
  .requiredOption('--name <label>', 'Human-readable label for this credential')
  .action(run(async () => {
    const cmd = oracle.commands.find(c => c.name() === 'create')!;
    const communityDid = cmd.args[0];
    const opts = cmd.opts();
    const c = client();
    const result = await c.authPost('net.openfederation.oracle.createCredential', {
      communityDid,
      name: opts.name,
    });
    if (isJsonMode()) {
      json(result);
    } else {
      success('Oracle credential created');
      table(['Field', 'Value'], [
        ['ID', result.id],
        ['Community', result.communityDid],
        ['Name', result.name],
        ['Key Prefix', result.keyPrefix],
        ['Key', result.key],
      ]);
      hint('Save this key now — it will never be shown again.');
    }
  }));

oracle
  .command('list')
  .description('List Oracle credentials')
  .option('--community <did>', 'Filter by community DID')
  .action(run(async () => {
    const cmd = oracle.commands.find(c => c.name() === 'list')!;
    const opts = cmd.opts();
    const c = client();
    const params: Record<string, string> = {};
    if (opts.community) params.communityDid = opts.community;
    const result = await c.authGet('net.openfederation.oracle.listCredentials', params);
    if (isJsonMode()) {
      json(result);
    } else {
      if (result.credentials.length === 0) {
        info('No Oracle credentials found');
        return;
      }
      table(['ID', 'Community', 'Name', 'Status', 'Proofs', 'Last Used'],
        result.credentials.map((cr: any) => [
          cr.id.substring(0, 8),
          cr.communityDid.substring(0, 20) + '...',
          cr.name,
          cr.status,
          cr.proofsSubmitted || 0,
          cr.lastUsedAt ? new Date(cr.lastUsedAt).toLocaleString() : '—',
        ])
      );
    }
  }));

oracle
  .command('revoke')
  .description('Revoke an Oracle credential')
  .argument('<credentialId>', 'Credential ID to revoke')
  .action(run(async () => {
    const cmd = oracle.commands.find(c => c.name() === 'revoke')!;
    const credentialId = cmd.args[0];
    const c = client();
    await c.authPost('net.openfederation.oracle.revokeCredential', { credentialId });
    if (isJsonMode()) {
      json({ success: true });
    } else {
      success('Oracle credential revoked');
    }
  }));
```

- [ ] **Step 2: Build and commit**

```bash
npm run build
git add cli/ofc.ts
git commit -m "feat(cli): add oracle credential management commands (#20)"
```

---

## Task 8: Final verification

- [ ] **Step 1: Build**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 2: Validate lexicons**

```bash
npm run validate:lexicon
```

Expected: all schemas valid (including 3 new Oracle lexicons).

- [ ] **Step 3: Run unit tests**

```bash
npm run test:unit
```

Expected: all pass.

- [ ] **Step 4: Push and verify CI**

```bash
git push
```

Expected: CI green.
