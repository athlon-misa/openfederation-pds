# Phase 2A: Custom Roles with Permissions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded string roles with a `community.role` collection, permission-based authorization, and custom role support.

**Architecture:** Roles are ATProto repo records in `net.openfederation.community.role`. Member records reference roles by rkey. A new `requireCommunityPermission()` guard resolves role → permissions for authorization. Default roles (owner, moderator, member) created during community creation. Migration script updates existing communities.

**Tech Stack:** TypeScript ESM, RepoEngine, records_index queries, existing auth guards pattern.

---

## File Structure

| File | Responsibility |
|------|----------------|
| **Create:** `src/auth/permissions.ts` | Permission constants, default role definitions, helpers |
| **Create:** `src/api/net.openfederation.community.createRole.ts` | Create role handler |
| **Create:** `src/api/net.openfederation.community.updateRole.ts` | Update role handler |
| **Create:** `src/api/net.openfederation.community.deleteRole.ts` | Delete role handler |
| **Create:** `src/api/net.openfederation.community.listRoles.ts` | List roles handler |
| **Create:** `src/lexicon/net.openfederation.community.createRole.json` | Lexicon |
| **Create:** `src/lexicon/net.openfederation.community.updateRole.json` | Lexicon |
| **Create:** `src/lexicon/net.openfederation.community.deleteRole.json` | Lexicon |
| **Create:** `src/lexicon/net.openfederation.community.listRoles.json` | Lexicon |
| **Create:** `scripts/migrate-008-roles.ts` | Migration: create default roles, update member records |
| **Create:** `tests/api/net.openfederation.community.roles.test.ts` | Integration tests |
| **Modify:** `src/auth/guards.ts` | Add `requireCommunityPermission()` |
| **Modify:** `src/auth/types.ts` | Update CommunityRole type |
| **Modify:** `src/db/audit.ts` | Add role audit actions |
| **Modify:** `src/server/index.ts` | Register 4 new handlers |
| **Modify:** `src/api/net.openfederation.community.create.ts` | Create default roles during community creation |
| **Modify:** `src/api/net.openfederation.community.join.ts` | Use roleRkey |
| **Modify:** `src/api/net.openfederation.community.resolveJoinRequest.ts` | Use roleRkey |
| **Modify:** `src/api/net.openfederation.community.updateMemberRole.ts` | Accept roleRkey |
| **Modify:** 8 endpoints using `requireCommunityRole` | Switch to `requireCommunityPermission` |

---

### Task 1: Permission constants and default role definitions

**Files:**
- Create: `src/auth/permissions.ts`

- [ ] **Step 1: Create the permissions module**

```typescript
// src/auth/permissions.ts

/**
 * Community permission strings.
 * Pattern: community.<collection-short>.<action>
 */
export const PERMISSIONS = {
  SETTINGS_WRITE: 'community.settings.write',
  PROFILE_WRITE: 'community.profile.write',
  MEMBER_READ: 'community.member.read',
  MEMBER_WRITE: 'community.member.write',
  MEMBER_DELETE: 'community.member.delete',
  ROLE_READ: 'community.role.read',
  ROLE_WRITE: 'community.role.write',
  ATTESTATION_WRITE: 'community.attestation.write',
  ATTESTATION_DELETE: 'community.attestation.delete',
  APPLICATION_WRITE: 'community.application.write',
  APPLICATION_DELETE: 'community.application.delete',
  GOVERNANCE_WRITE: 'community.governance.write',
} as const;

export type Permission = typeof PERMISSIONS[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

/** Permissions that cannot be removed from the owner role (prevents lockout) */
export const OWNER_REQUIRED_PERMISSIONS: Permission[] = [
  PERMISSIONS.ROLE_WRITE,
  PERMISSIONS.SETTINGS_WRITE,
];

export interface RoleRecord {
  name: string;
  description?: string;
  permissions: string[];
}

export const ROLE_COLLECTION = 'net.openfederation.community.role';
export const MEMBER_COLLECTION = 'net.openfederation.community.member';

/**
 * Default role definitions created for every new community.
 * Returns records with auto-generated rkeys.
 */
export function getDefaultRoleRecords(): Array<{ name: string; record: RoleRecord }> {
  return [
    {
      name: 'owner',
      record: {
        name: 'owner',
        description: 'Community owner with full permissions',
        permissions: [...ALL_PERMISSIONS],
      },
    },
    {
      name: 'moderator',
      record: {
        name: 'moderator',
        description: 'Community moderator',
        permissions: [
          PERMISSIONS.PROFILE_WRITE,
          PERMISSIONS.MEMBER_READ,
          PERMISSIONS.MEMBER_WRITE,
          PERMISSIONS.MEMBER_DELETE,
          PERMISSIONS.ROLE_READ,
          PERMISSIONS.ATTESTATION_WRITE,
          PERMISSIONS.ATTESTATION_DELETE,
          PERMISSIONS.GOVERNANCE_WRITE,
        ],
      },
    },
    {
      name: 'member',
      record: {
        name: 'member',
        description: 'Regular community member',
        permissions: [
          PERMISSIONS.MEMBER_READ,
          PERMISSIONS.ROLE_READ,
        ],
      },
    },
  ];
}

/**
 * Find the rkey for a default role by name in a community's records.
 */
export async function findRoleRkeyByName(
  communityDid: string,
  roleName: string,
  queryFn: (sql: string, params: any[]) => Promise<{ rows: any[] }>
): Promise<string | null> {
  const result = await queryFn(
    `SELECT rkey FROM records_index
     WHERE community_did = $1 AND collection = $2 AND record->>'name' = $3
     LIMIT 1`,
    [communityDid, ROLE_COLLECTION, roleName]
  );
  return result.rows[0]?.rkey || null;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/auth/permissions.ts
git commit -m "feat(governance): add permission constants and default role definitions"
```

---

### Task 2: Lexicons for role CRUD

**Files:**
- Create: 4 lexicon JSON files

- [ ] **Step 1: Create createRole lexicon**

Create `src/lexicon/net.openfederation.community.createRole.json`:
```json
{
  "lexicon": 1,
  "id": "net.openfederation.community.createRole",
  "description": "Create a custom role for a community.",
  "defs": {
    "main": {
      "type": "procedure",
      "description": "Create a named role with a set of permissions. Owner or community.role.write permission required.",
      "input": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "properties": {
            "communityDid": { "type": "string", "description": "The community DID." },
            "name": { "type": "string", "description": "Role name (1-64 chars, unique within community)." },
            "description": { "type": "string", "description": "Optional role description." },
            "permissions": { "type": "array", "items": { "type": "string" }, "description": "Array of permission strings." }
          },
          "required": ["communityDid", "name", "permissions"]
        }
      },
      "output": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "properties": {
            "uri": { "type": "string" },
            "cid": { "type": "string" },
            "rkey": { "type": "string" }
          },
          "required": ["uri", "cid", "rkey"]
        }
      },
      "errors": [
        { "name": "InvalidRequest", "description": "Missing fields or invalid permissions." },
        { "name": "RoleNameTaken", "description": "A role with this name already exists." }
      ]
    }
  }
}
```

- [ ] **Step 2: Create updateRole lexicon**

Create `src/lexicon/net.openfederation.community.updateRole.json`:
```json
{
  "lexicon": 1,
  "id": "net.openfederation.community.updateRole",
  "description": "Update a community role's name, description, or permissions.",
  "defs": {
    "main": {
      "type": "procedure",
      "description": "Update an existing role. Cannot remove community.role.write from the owner role.",
      "input": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "properties": {
            "communityDid": { "type": "string" },
            "rkey": { "type": "string", "description": "The role record key." },
            "name": { "type": "string" },
            "description": { "type": "string" },
            "permissions": { "type": "array", "items": { "type": "string" } }
          },
          "required": ["communityDid", "rkey"]
        }
      },
      "output": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "properties": { "uri": { "type": "string" }, "cid": { "type": "string" } },
          "required": ["uri", "cid"]
        }
      },
      "errors": [
        { "name": "InvalidRequest", "description": "Validation failed." },
        { "name": "RoleNotFound", "description": "No role found with the given rkey." },
        { "name": "OwnerLockout", "description": "Cannot remove required permissions from owner role." }
      ]
    }
  }
}
```

- [ ] **Step 3: Create deleteRole lexicon**

Create `src/lexicon/net.openfederation.community.deleteRole.json`:
```json
{
  "lexicon": 1,
  "id": "net.openfederation.community.deleteRole",
  "description": "Delete a community role. Fails if any members are assigned to it.",
  "defs": {
    "main": {
      "type": "procedure",
      "input": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "properties": {
            "communityDid": { "type": "string" },
            "rkey": { "type": "string" }
          },
          "required": ["communityDid", "rkey"]
        }
      },
      "output": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "properties": { "success": { "type": "boolean" } },
          "required": ["success"]
        }
      },
      "errors": [
        { "name": "RoleNotFound", "description": "No role found with the given rkey." },
        { "name": "RoleInUse", "description": "Cannot delete a role that has members assigned." }
      ]
    }
  }
}
```

- [ ] **Step 4: Create listRoles lexicon**

Create `src/lexicon/net.openfederation.community.listRoles.json`:
```json
{
  "lexicon": 1,
  "id": "net.openfederation.community.listRoles",
  "description": "List all roles defined for a community.",
  "defs": {
    "main": {
      "type": "query",
      "parameters": {
        "type": "params",
        "properties": {
          "communityDid": { "type": "string" }
        },
        "required": ["communityDid"]
      },
      "output": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "properties": {
            "roles": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "uri": { "type": "string" },
                  "rkey": { "type": "string" },
                  "name": { "type": "string" },
                  "description": { "type": "string" },
                  "permissions": { "type": "array", "items": { "type": "string" } },
                  "memberCount": { "type": "integer" }
                },
                "required": ["uri", "rkey", "name", "permissions", "memberCount"]
              }
            }
          },
          "required": ["roles"]
        }
      },
      "errors": [
        { "name": "InvalidRequest", "description": "Missing communityDid." }
      ]
    }
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add src/lexicon/net.openfederation.community.createRole.json src/lexicon/net.openfederation.community.updateRole.json src/lexicon/net.openfederation.community.deleteRole.json src/lexicon/net.openfederation.community.listRoles.json
git commit -m "feat(governance): add lexicons for role CRUD endpoints"
```

---

### Task 3: Add requireCommunityPermission guard + audit actions

**Files:**
- Modify: `src/auth/guards.ts`
- Modify: `src/auth/types.ts`
- Modify: `src/db/audit.ts`

- [ ] **Step 1: Add requireCommunityPermission to guards.ts**

Add this import at the top of `src/auth/guards.ts`:
```typescript
import { ROLE_COLLECTION, MEMBER_COLLECTION } from './permissions.js';
```

Add this new function at the end of `src/auth/guards.ts` (after `requireCommunityRole`):

```typescript
/**
 * Permission-based community authorization.
 * Resolves member's roleRkey → role record → permissions array.
 * PDS admin and community creator always pass.
 */
export async function requireCommunityPermission(
  req: AuthRequest & { auth: AuthContext },
  res: Response,
  communityDid: string,
  permission: string
): Promise<boolean> {
  // PDS admin always has access
  if (req.auth.roles.includes('admin')) {
    return true;
  }

  // Check if user is community creator (always has all permissions)
  const communityResult = await query<{ created_by: string }>(
    'SELECT created_by FROM communities WHERE did = $1',
    [communityDid]
  );

  if (communityResult.rows.length === 0) {
    res.status(404).json({ error: 'NotFound', message: 'Community not found' });
    return false;
  }

  if (communityResult.rows[0].created_by === req.auth.userId) {
    return true;
  }

  // Find member record
  const memberResult = await query<{ record_rkey: string }>(
    'SELECT record_rkey FROM members_unique WHERE community_did = $1 AND member_did = $2',
    [communityDid, req.auth.did]
  );

  if (memberResult.rows.length === 0) {
    res.status(403).json({ error: 'NotMember', message: 'You must be a member of this community' });
    return false;
  }

  // Get member record to find roleRkey
  const memberRecord = await query<{ record: { roleRkey?: string; role?: string } }>(
    `SELECT record FROM records_index
     WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
    [communityDid, MEMBER_COLLECTION, memberResult.rows[0].record_rkey]
  );

  const member = memberRecord.rows[0]?.record;
  const roleRkey = member?.roleRkey;

  // Backwards compat: if no roleRkey, fall back to old role string
  if (!roleRkey) {
    const oldRole = member?.role || 'member';
    // Old hierarchy: owner has all, moderator has most, member has read
    if (oldRole === 'owner') return true;
    if (oldRole === 'moderator') {
      // Moderators had: profile, member, attestation, governance permissions
      const modPermissions = [
        'community.profile.write', 'community.member.read', 'community.member.write',
        'community.member.delete', 'community.role.read', 'community.attestation.write',
        'community.attestation.delete', 'community.governance.write',
      ];
      if (modPermissions.includes(permission)) return true;
    }
    if (oldRole === 'member') {
      const memberPermissions = ['community.member.read', 'community.role.read'];
      if (memberPermissions.includes(permission)) return true;
    }
    res.status(403).json({ error: 'Forbidden', message: 'Insufficient community privileges' });
    return false;
  }

  // Resolve roleRkey → role record → permissions
  const roleResult = await query<{ record: { permissions?: string[] } }>(
    `SELECT record FROM records_index
     WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
    [communityDid, ROLE_COLLECTION, roleRkey]
  );

  const permissions = roleResult.rows[0]?.record?.permissions || [];

  if (permissions.includes(permission)) {
    return true;
  }

  res.status(403).json({ error: 'Forbidden', message: 'Insufficient community privileges' });
  return false;
}
```

- [ ] **Step 2: Add audit actions**

Add to `src/db/audit.ts` AuditAction union (before the semicolon):
```typescript
  | 'community.role.create'
  | 'community.role.update'
  | 'community.role.delete'
```

- [ ] **Step 3: Commit**

```bash
git add src/auth/guards.ts src/auth/types.ts src/db/audit.ts
git commit -m "feat(governance): add requireCommunityPermission guard and role audit actions"
```

---

### Task 4: Role CRUD endpoint handlers

**Files:**
- Create: 4 endpoint handler files

- [ ] **Step 1: Create createRole handler**

Create `src/api/net.openfederation.community.createRole.ts`:

```typescript
import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityPermission } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';
import { query } from '../db/client.js';
import { ROLE_COLLECTION, ALL_PERMISSIONS, OWNER_REQUIRED_PERMISSIONS } from '../auth/permissions.js';

export default async function createRole(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const { communityDid, name, description, permissions } = req.body;

    if (!communityDid || !name || !permissions) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing required fields: communityDid, name, permissions' });
      return;
    }

    if (typeof name !== 'string' || name.length < 1 || name.length > 64) {
      res.status(400).json({ error: 'InvalidRequest', message: 'name must be 1-64 characters' });
      return;
    }

    if (!Array.isArray(permissions)) {
      res.status(400).json({ error: 'InvalidRequest', message: 'permissions must be an array' });
      return;
    }

    // Validate all permission strings
    const invalid = permissions.filter((p: string) => !ALL_PERMISSIONS.includes(p as any));
    if (invalid.length > 0) {
      res.status(400).json({ error: 'InvalidRequest', message: `Invalid permissions: ${invalid.join(', ')}` });
      return;
    }

    const hasPermission = await requireCommunityPermission(
      req as AuthRequest & { auth: AuthContext }, res, communityDid, 'community.role.write'
    );
    if (!hasPermission) return;

    // Check name uniqueness within community
    const existing = await query(
      `SELECT 1 FROM records_index WHERE community_did = $1 AND collection = $2 AND record->>'name' = $3`,
      [communityDid, ROLE_COLLECTION, name]
    );
    if (existing.rows.length > 0) {
      res.status(409).json({ error: 'RoleNameTaken', message: 'A role with this name already exists' });
      return;
    }

    const engine = new RepoEngine(communityDid);
    const keypair = await getKeypairForDid(communityDid);
    const rkey = RepoEngine.generateTid();

    const record = { name, ...(description ? { description } : {}), permissions };
    const result = await engine.putRecord(keypair, ROLE_COLLECTION, rkey, record);

    await auditLog('community.role.create', req.auth!.userId, communityDid, { rkey, name });

    res.status(200).json({ uri: result.uri, cid: result.cid, rkey });
  } catch (error) {
    console.error('Error in createRole:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to create role' });
  }
}
```

- [ ] **Step 2: Create updateRole handler**

Create `src/api/net.openfederation.community.updateRole.ts`:

```typescript
import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityPermission } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';
import { query } from '../db/client.js';
import { ROLE_COLLECTION, ALL_PERMISSIONS, OWNER_REQUIRED_PERMISSIONS } from '../auth/permissions.js';

export default async function updateRole(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const { communityDid, rkey, name, description, permissions } = req.body;

    if (!communityDid || !rkey) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing required fields: communityDid, rkey' });
      return;
    }

    const hasPermission = await requireCommunityPermission(
      req as AuthRequest & { auth: AuthContext }, res, communityDid, 'community.role.write'
    );
    if (!hasPermission) return;

    // Fetch existing role
    const existing = await query<{ record: any }>(
      `SELECT record FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
      [communityDid, ROLE_COLLECTION, rkey]
    );
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'RoleNotFound', message: 'No role found with the given rkey' });
      return;
    }

    const currentRole = existing.rows[0].record;

    // Validate permissions if provided
    if (permissions) {
      if (!Array.isArray(permissions)) {
        res.status(400).json({ error: 'InvalidRequest', message: 'permissions must be an array' });
        return;
      }
      const invalid = permissions.filter((p: string) => !ALL_PERMISSIONS.includes(p as any));
      if (invalid.length > 0) {
        res.status(400).json({ error: 'InvalidRequest', message: `Invalid permissions: ${invalid.join(', ')}` });
        return;
      }

      // Prevent lockout: owner role must keep required permissions
      if (currentRole.name === 'owner') {
        const missing = OWNER_REQUIRED_PERMISSIONS.filter(p => !permissions.includes(p));
        if (missing.length > 0) {
          res.status(400).json({
            error: 'OwnerLockout',
            message: `Cannot remove required permissions from owner role: ${missing.join(', ')}`,
          });
          return;
        }
      }
    }

    // Check name uniqueness if changing name
    if (name && name !== currentRole.name) {
      const nameCheck = await query(
        `SELECT 1 FROM records_index WHERE community_did = $1 AND collection = $2 AND record->>'name' = $3 AND rkey != $4`,
        [communityDid, ROLE_COLLECTION, name, rkey]
      );
      if (nameCheck.rows.length > 0) {
        res.status(409).json({ error: 'RoleNameTaken', message: 'A role with this name already exists' });
        return;
      }
    }

    const engine = new RepoEngine(communityDid);
    const keypair = await getKeypairForDid(communityDid);

    const updatedRecord = {
      ...currentRole,
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(permissions !== undefined ? { permissions } : {}),
    };

    const result = await engine.putRecord(keypair, ROLE_COLLECTION, rkey, updatedRecord);

    await auditLog('community.role.update', req.auth!.userId, communityDid, { rkey, name: updatedRecord.name });

    res.status(200).json({ uri: result.uri, cid: result.cid });
  } catch (error) {
    console.error('Error in updateRole:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to update role' });
  }
}
```

- [ ] **Step 3: Create deleteRole handler**

Create `src/api/net.openfederation.community.deleteRole.ts`:

```typescript
import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityPermission } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';
import { query } from '../db/client.js';
import { ROLE_COLLECTION, MEMBER_COLLECTION } from '../auth/permissions.js';

export default async function deleteRole(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const { communityDid, rkey } = req.body;

    if (!communityDid || !rkey) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing required fields: communityDid, rkey' });
      return;
    }

    const hasPermission = await requireCommunityPermission(
      req as AuthRequest & { auth: AuthContext }, res, communityDid, 'community.role.write'
    );
    if (!hasPermission) return;

    // Check role exists
    const existing = await query<{ record: any }>(
      `SELECT record FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
      [communityDid, ROLE_COLLECTION, rkey]
    );
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'RoleNotFound', message: 'No role found with the given rkey' });
      return;
    }

    // Check if any members are assigned to this role
    const membersWithRole = await query(
      `SELECT 1 FROM records_index
       WHERE community_did = $1 AND collection = $2 AND record->>'roleRkey' = $3
       LIMIT 1`,
      [communityDid, MEMBER_COLLECTION, rkey]
    );
    if (membersWithRole.rows.length > 0) {
      res.status(409).json({
        error: 'RoleInUse',
        message: 'Cannot delete a role that has members assigned. Reassign members first.',
      });
      return;
    }

    const engine = new RepoEngine(communityDid);
    const keypair = await getKeypairForDid(communityDid);
    await engine.deleteRecord(keypair, ROLE_COLLECTION, rkey);

    await auditLog('community.role.delete', req.auth!.userId, communityDid, {
      rkey, roleName: existing.rows[0].record?.name,
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error in deleteRole:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to delete role' });
  }
}
```

- [ ] **Step 4: Create listRoles handler**

Create `src/api/net.openfederation.community.listRoles.ts`:

```typescript
import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { query } from '../db/client.js';
import { ROLE_COLLECTION, MEMBER_COLLECTION } from '../auth/permissions.js';

export default async function listRoles(req: AuthRequest, res: Response): Promise<void> {
  try {
    const communityDid = req.query.communityDid as string;

    if (!communityDid || !communityDid.startsWith('did:')) {
      res.status(400).json({ error: 'InvalidRequest', message: 'communityDid parameter is required' });
      return;
    }

    // Get all role records
    const roleResult = await query<{ rkey: string; record: any }>(
      `SELECT rkey, record FROM records_index
       WHERE community_did = $1 AND collection = $2
       ORDER BY rkey ASC`,
      [communityDid, ROLE_COLLECTION]
    );

    // Count members per role
    const memberCounts = await query<{ role_rkey: string; count: string }>(
      `SELECT record->>'roleRkey' as role_rkey, COUNT(*) as count
       FROM records_index
       WHERE community_did = $1 AND collection = $2 AND record->>'roleRkey' IS NOT NULL
       GROUP BY record->>'roleRkey'`,
      [communityDid, MEMBER_COLLECTION]
    );

    const countMap = new Map(memberCounts.rows.map(r => [r.role_rkey, parseInt(r.count)]));

    // Also count old-style role strings for backwards compat
    const oldStyleCounts = await query<{ role: string; count: string }>(
      `SELECT record->>'role' as role, COUNT(*) as count
       FROM records_index
       WHERE community_did = $1 AND collection = $2 AND record->>'roleRkey' IS NULL AND record->>'role' IS NOT NULL
       GROUP BY record->>'role'`,
      [communityDid, MEMBER_COLLECTION]
    );

    const oldCountMap = new Map(oldStyleCounts.rows.map(r => [r.role, parseInt(r.count)]));

    const roles = roleResult.rows.map(row => ({
      uri: `at://${communityDid}/${ROLE_COLLECTION}/${row.rkey}`,
      rkey: row.rkey,
      name: row.record?.name,
      description: row.record?.description,
      permissions: row.record?.permissions || [],
      memberCount: (countMap.get(row.rkey) || 0) + (oldCountMap.get(row.record?.name) || 0),
    }));

    res.status(200).json({ roles });
  } catch (error) {
    console.error('Error in listRoles:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to list roles' });
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add src/api/net.openfederation.community.createRole.ts src/api/net.openfederation.community.updateRole.ts src/api/net.openfederation.community.deleteRole.ts src/api/net.openfederation.community.listRoles.ts
git commit -m "feat(governance): add role CRUD endpoint handlers"
```

---

### Task 5: Update community creation to include default roles

**Files:**
- Modify: `src/api/net.openfederation.community.create.ts`

- [ ] **Step 1: Update community creation**

In `src/api/net.openfederation.community.create.ts`, find the `initialRecords` array (around line 133-163). Add default role records and change the member record to use `roleRkey`.

Add import at top:
```typescript
import { getDefaultRoleRecords, ROLE_COLLECTION } from '../auth/permissions.js';
```

Replace the `initialRecords` block. The new version creates 3 role records + settings + profile + member with roleRkey:

```typescript
    const defaultRoles = getDefaultRoleRecords();
    const ownerRoleRkey = RepoEngine.generateTid();
    const modRoleRkey = RepoEngine.generateTid();
    const memberRoleRkey = RepoEngine.generateTid();
    const roleRkeys = { owner: ownerRoleRkey, moderator: modRoleRkey, member: memberRoleRkey };

    const initialRecords = [
      // Role records
      { collection: ROLE_COLLECTION, rkey: ownerRoleRkey, record: defaultRoles[0].record },
      { collection: ROLE_COLLECTION, rkey: modRoleRkey, record: defaultRoles[1].record },
      { collection: ROLE_COLLECTION, rkey: memberRoleRkey, record: defaultRoles[2].record },
      // Settings
      {
        collection: 'net.openfederation.community.settings',
        rkey: 'self',
        record: { didMethod: input.didMethod, governanceModel: 'benevolent-dictator', visibility, joinPolicy },
      },
      // Profile
      {
        collection: 'net.openfederation.community.profile',
        rkey: 'self',
        record: { displayName, description, createdAt: now },
      },
      // Owner member record with roleRkey
      {
        collection: 'net.openfederation.community.member',
        rkey: memberRkey,
        record: { did: req.auth!.did, handle: req.auth!.handle, roleRkey: ownerRoleRkey, joinedAt: now },
      },
    ];
```

- [ ] **Step 2: Commit**

```bash
git add src/api/net.openfederation.community.create.ts
git commit -m "feat(governance): create default role records during community creation"
```

---

### Task 6: Update join and resolveJoinRequest to use roleRkey

**Files:**
- Modify: `src/api/net.openfederation.community.join.ts`
- Modify: `src/api/net.openfederation.community.resolveJoinRequest.ts`

- [ ] **Step 1: Update join.ts**

In `src/api/net.openfederation.community.join.ts`, add import:
```typescript
import { findRoleRkeyByName } from '../auth/permissions.js';
import { query as dbQuery } from '../db/client.js';
```

Find where the member record is created (around line 60-66). Before it, resolve the member role rkey:
```typescript
    const memberRoleRkey = await findRoleRkeyByName(did, 'member', dbQuery);
```

Change the member record from:
```typescript
    role: 'member',
```
to:
```typescript
    ...(memberRoleRkey ? { roleRkey: memberRoleRkey } : { role: 'member' }),
```

This falls back to the old string format if no role records exist (backwards compat for pre-migration communities).

- [ ] **Step 2: Update resolveJoinRequest.ts**

Same pattern in `src/api/net.openfederation.community.resolveJoinRequest.ts`. Add import:
```typescript
import { findRoleRkeyByName } from '../auth/permissions.js';
import { query as dbQuery } from '../db/client.js';
```

Before the member record creation (around line 91-99), resolve the member role rkey:
```typescript
    const memberRoleRkey = await findRoleRkeyByName(request.community_did, 'member', dbQuery);
```

Change `role: 'member'` to:
```typescript
    ...(memberRoleRkey ? { roleRkey: memberRoleRkey } : { role: 'member' }),
```

- [ ] **Step 3: Commit**

```bash
git add src/api/net.openfederation.community.join.ts src/api/net.openfederation.community.resolveJoinRequest.ts
git commit -m "feat(governance): use roleRkey in join and resolveJoinRequest"
```

---

### Task 7: Update updateMemberRole to accept roleRkey

**Files:**
- Modify: `src/api/net.openfederation.community.updateMemberRole.ts`

- [ ] **Step 1: Rewrite updateMemberRole**

The endpoint now accepts a `roleRkey` parameter instead of a `role` string. It validates that the target role exists and that it's not assigning the owner's reserved role inappropriately.

Replace the entire handler. The new version:
- Accepts `{ communityDid, memberDid, roleRkey }` (roleRkey is the TID of the target role record)
- Validates the role exists
- Uses `requireCommunityPermission` with `community.member.write`
- Prevents changing the community creator's role (they always keep owner access via `created_by`)

```typescript
import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityPermission } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';
import { query } from '../db/client.js';
import { ROLE_COLLECTION, MEMBER_COLLECTION } from '../auth/permissions.js';

export default async function updateMemberRole(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const { communityDid, memberDid, roleRkey } = req.body;

    if (!communityDid || !memberDid || !roleRkey) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required fields: communityDid, memberDid, roleRkey',
      });
      return;
    }

    const hasPermission = await requireCommunityPermission(
      req as AuthRequest & { auth: AuthContext },
      res, communityDid, 'community.member.write'
    );
    if (!hasPermission) return;

    // Verify target role exists
    const roleResult = await query<{ record: any }>(
      `SELECT record FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
      [communityDid, ROLE_COLLECTION, roleRkey]
    );
    if (roleResult.rows.length === 0) {
      res.status(404).json({ error: 'RoleNotFound', message: 'Target role not found' });
      return;
    }

    const targetRoleName = roleResult.rows[0].record?.name;

    // Find the member's record rkey
    const memberResult = await query<{ record_rkey: string }>(
      'SELECT record_rkey FROM members_unique WHERE community_did = $1 AND member_did = $2',
      [communityDid, memberDid]
    );
    if (memberResult.rows.length === 0) {
      res.status(404).json({ error: 'NotMember', message: 'Target DID is not a member of this community' });
      return;
    }

    const memberRkey = memberResult.rows[0].record_rkey;
    const engine = new RepoEngine(communityDid);
    const existing = await engine.getRecord(MEMBER_COLLECTION, memberRkey);
    if (!existing) {
      res.status(404).json({ error: 'NotMember', message: 'Member record not found in repository' });
      return;
    }

    const keypair = await getKeypairForDid(communityDid);
    const updatedRecord = { ...existing.record, roleRkey };
    // Remove old role string if present
    delete (updatedRecord as any).role;

    const result = await engine.putRecord(keypair, MEMBER_COLLECTION, memberRkey, updatedRecord);

    await auditLog('community.updateMemberRole', req.auth!.userId, communityDid, {
      memberDid, roleRkey, roleName: targetRoleName,
    });

    res.status(200).json({ uri: result.uri, cid: result.cid, role: targetRoleName, roleRkey });
  } catch (error) {
    console.error('Error in updateMemberRole:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to update member role' });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/api/net.openfederation.community.updateMemberRole.ts
git commit -m "feat(governance): update updateMemberRole to use roleRkey"
```

---

### Task 8: Migrate existing endpoints to requireCommunityPermission

**Files:**
- Modify: 8 endpoint files that use `requireCommunityRole`

- [ ] **Step 1: Update all community write endpoints**

For each file, change the import from `requireCommunityRole` to `requireCommunityPermission` and update the call. The mapping:

| File | Old | New Permission |
|------|-----|----------------|
| `com.atproto.repo.putRecord.ts` | `['owner', 'moderator']` | `'community.member.write'` |
| `com.atproto.repo.createRecord.ts` | `['owner', 'moderator']` | `'community.member.write'` |
| `com.atproto.repo.deleteRecord.ts` | `['owner', 'moderator']` | `'community.member.delete'` |
| `community.issueAttestation.ts` | `['owner', 'moderator']` | `'community.attestation.write'` |
| `community.deleteAttestation.ts` | `['owner', 'moderator']` | `'community.attestation.delete'` |
| `community.linkApplication.ts` | `['owner']` | `'community.application.write'` |
| `community.unlinkApplication.ts` | `['owner']` | `'community.application.delete'` |

For each file:
1. Change import: `requireCommunityRole` → `requireCommunityPermission`
2. Change the call pattern from:
```typescript
const role = await requireCommunityRole(req as AuthRequest & { auth: AuthContext }, res, communityDid, ['owner', 'moderator']);
if (role === null) return;
```
to:
```typescript
const hasPermission = await requireCommunityPermission(req as AuthRequest & { auth: AuthContext }, res, communityDid, '<permission>');
if (!hasPermission) return;
```

Note: The generic repo endpoints (`putRecord`, `createRecord`, `deleteRecord`) use `community.member.write` as a general "can write to this community" permission. The governance enforcement layer (Phase 2B) will add collection-specific checks.

- [ ] **Step 2: Commit**

```bash
git add src/api/com.atproto.repo.putRecord.ts src/api/com.atproto.repo.createRecord.ts src/api/com.atproto.repo.deleteRecord.ts src/api/net.openfederation.community.issueAttestation.ts src/api/net.openfederation.community.deleteAttestation.ts src/api/net.openfederation.community.linkApplication.ts src/api/net.openfederation.community.unlinkApplication.ts
git commit -m "feat(governance): migrate endpoints to requireCommunityPermission"
```

---

### Task 9: Register handlers + build

**Files:**
- Modify: `src/server/index.ts`

- [ ] **Step 1: Add imports and handler entries**

Add imports after the existing community imports:
```typescript
import createRole from '../api/net.openfederation.community.createRole.js';
import updateRole from '../api/net.openfederation.community.updateRole.js';
import deleteRole from '../api/net.openfederation.community.deleteRole.js';
import listRolesHandler from '../api/net.openfederation.community.listRoles.js';
```

Add to handler map after the attestation entries:
```typescript
  // Community role management
  'net.openfederation.community.createRole': { handler: createRole },
  'net.openfederation.community.updateRole': { handler: updateRole },
  'net.openfederation.community.deleteRole': { handler: deleteRole },
  'net.openfederation.community.listRoles': { handler: listRolesHandler, limiter: discoveryLimiter },
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Clean build.

- [ ] **Step 3: Commit**

```bash
git add src/server/index.ts
git commit -m "feat(governance): register role CRUD handlers"
```

---

### Task 10: Integration tests

**Files:**
- Create: `tests/api/net.openfederation.community.roles.test.ts`

- [ ] **Step 1: Create test file**

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcPost, xrpcGet, xrpcAuthPost,
  createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';

describe('Community Roles', () => {
  let plcAvailable: boolean;
  let owner: { accessJwt: string; did: string; handle: string };
  let member: { accessJwt: string; did: string; handle: string };
  let communityDid: string;
  let customRoleRkey: string;
  let memberRoleRkey: string;

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;

    owner = await createTestUser(uniqueHandle('role-owner'));
    member = await createTestUser(uniqueHandle('role-member'));

    const createRes = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('role-comm'),
      didMethod: 'plc',
      visibility: 'public',
      joinPolicy: 'open',
    });
    communityDid = createRes.body.did;

    await xrpcAuthPost('net.openfederation.community.join', member.accessJwt, { communityDid });
  });

  describe('listRoles', () => {
    it('should list default roles for a new community', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.community.listRoles', { communityDid });
      expect(res.status).toBe(200);
      expect(res.body.roles.length).toBe(3);
      const names = res.body.roles.map((r: any) => r.name).sort();
      expect(names).toEqual(['member', 'moderator', 'owner']);

      // Save member role rkey for later tests
      memberRoleRkey = res.body.roles.find((r: any) => r.name === 'member').rkey;
    });

    it('should show member counts', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.community.listRoles', { communityDid });
      const ownerRole = res.body.roles.find((r: any) => r.name === 'owner');
      expect(ownerRole.memberCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('createRole', () => {
    it('should reject unauthenticated', async () => {
      const res = await xrpcPost('net.openfederation.community.createRole', {
        communityDid: 'did:plc:test', name: 'coach', permissions: ['community.member.read'],
      });
      expect(res.status).toBe(401);
    });

    it('should reject non-owner', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.createRole', member.accessJwt, {
        communityDid, name: 'coach', permissions: ['community.member.read'],
      });
      expect(res.status).toBe(403);
    });

    it('should create a custom role', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.createRole', owner.accessJwt, {
        communityDid, name: 'coach', description: 'Team coach',
        permissions: ['community.member.read', 'community.attestation.write'],
      });
      expect(res.status).toBe(200);
      expect(res.body.rkey).toBeTruthy();
      customRoleRkey = res.body.rkey;
    });

    it('should reject duplicate name', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.createRole', owner.accessJwt, {
        communityDid, name: 'coach', permissions: ['community.member.read'],
      });
      expect(res.status).toBe(409);
    });

    it('should reject invalid permissions', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.createRole', owner.accessJwt, {
        communityDid, name: 'invalid', permissions: ['not.a.real.permission'],
      });
      expect(res.status).toBe(400);
    });
  });

  describe('updateRole', () => {
    it('should update a role', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.updateRole', owner.accessJwt, {
        communityDid, rkey: customRoleRkey,
        permissions: ['community.member.read', 'community.attestation.write', 'community.attestation.delete'],
      });
      expect(res.status).toBe(200);
    });

    it('should prevent owner lockout', async () => {
      if (!plcAvailable) return;
      const rolesRes = await xrpcGet('net.openfederation.community.listRoles', { communityDid });
      const ownerRkey = rolesRes.body.roles.find((r: any) => r.name === 'owner').rkey;

      const res = await xrpcAuthPost('net.openfederation.community.updateRole', owner.accessJwt, {
        communityDid, rkey: ownerRkey, permissions: ['community.member.read'],
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('OwnerLockout');
    });
  });

  describe('updateMemberRole with roleRkey', () => {
    it('should assign a member to a custom role', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.updateMemberRole', owner.accessJwt, {
        communityDid, memberDid: member.did, roleRkey: customRoleRkey,
      });
      expect(res.status).toBe(200);
      expect(res.body.role).toBe('coach');
      expect(res.body.roleRkey).toBe(customRoleRkey);
    });
  });

  describe('deleteRole', () => {
    it('should reject deleting a role with members', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.deleteRole', owner.accessJwt, {
        communityDid, rkey: customRoleRkey,
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('RoleInUse');
    });

    it('should delete a role after reassigning members', async () => {
      if (!plcAvailable) return;
      // Reassign member back to default member role
      await xrpcAuthPost('net.openfederation.community.updateMemberRole', owner.accessJwt, {
        communityDid, memberDid: member.did, roleRkey: memberRoleRkey,
      });

      const res = await xrpcAuthPost('net.openfederation.community.deleteRole', owner.accessJwt, {
        communityDid, rkey: customRoleRkey,
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/api/net.openfederation.community.roles.test.ts`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/api/net.openfederation.community.roles.test.ts
git commit -m "test(governance): add integration tests for role CRUD and permission-based auth"
```

---

### Task 11: Full build + all tests

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: Clean build.

- [ ] **Step 2: Run all tests**

Run: `npx vitest run`
Expected: All tests pass (existing + new role tests).

- [ ] **Step 3: Commit fixes if needed**
