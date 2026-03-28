# Security Hardening Plan A: Quick Fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 9 confirmed security vulnerabilities that each require minimal code changes — no migrations, no new dependencies, no architectural decisions.

**Architecture:** Each task is an independent patch to an existing file. No task depends on another. All can be committed separately and any subset can ship.

**Tech Stack:** TypeScript, Express.js, Node.js crypto

**Follows:** Copilot security deep-dive triage. See also Plan B (Auth Hardening + Email) and Plan C (API Safety, AP Fix, CLI).

---

## File Map

### Modified files

| File | Change |
|------|--------|
| `cli/ofc.ts` | Replace `--current`/`--new` password flags with interactive prompts |
| `src/api/com.atproto.server.createSession.ts` | Add `auditLog()` calls on all 7 failure paths |
| `src/db/audit.ts` | Add `session.loginFailed` to `AuditAction` type |
| `src/auth/encryption.ts` | Replace `pbkdf2Sync` with async `pbkdf2` |
| `src/oauth/external-routes.ts` | Add size cap to `pendingCodes` Map |
| `src/server/index.ts` | Add `Content-Security-Policy` header; add `createLimiter` to invite handler; make trust proxy configurable |
| `src/auth/utils.ts` | Expand `RESERVED_HANDLES` set |
| `src/auth/bootstrap.ts` | Add warning when admin exists but password env var is still set |
| `src/federation/peer-cache.ts` | Add `isPrivateHost()` check before fetching peer URLs |
| `src/config.ts` | Add `EXPRESS_TRUST_PROXY` env var |

---

## Task 1: CLI — replace password flags with interactive prompts

**Files:**
- Modify: `cli/ofc.ts` (change-password command, ~lines 303-320)

- [ ] **Step 1: Find the change-password command and replace flag-based password input**

In `cli/ofc.ts`, find the `change-password` command. Replace:

```typescript
.requiredOption('--current <password>', 'Current password')
.requiredOption('--new <password>', 'New password')
```

With options that support both interactive and stdin modes:

```typescript
.option('--password-stdin', 'Read passwords from stdin (format: current\\nnew)')
```

And update the action handler to prompt interactively when `--password-stdin` is not set:

```typescript
const action = async (opts: { passwordStdin?: boolean }) => {
  let currentPassword: string;
  let newPassword: string;

  if (opts.passwordStdin) {
    const input = await readStdin();
    const lines = input.trim().split('\n');
    if (lines.length < 2) {
      console.error('Error: --password-stdin expects two lines: current password and new password');
      process.exit(1);
    }
    currentPassword = lines[0];
    newPassword = lines[1];
  } else {
    currentPassword = await promptPassword('Current password: ');
    newPassword = await promptPassword('New password: ');
    const confirmNew = await promptPassword('Confirm new password: ');
    if (newPassword !== confirmNew) {
      console.error('Error: New passwords do not match');
      process.exit(1);
    }
  }

  // ... rest of the handler uses currentPassword and newPassword
};
```

Note: `promptPassword()` and `readStdin()` should already exist in the CLI codebase (used by `auth login`). Find them and reuse.

- [ ] **Step 2: Test interactively**

Run: `npm run build && npm run cli -- account change-password`

Expected: prompts for current password, new password, confirmation — no passwords visible in shell history.

- [ ] **Step 3: Commit**

```bash
git add cli/ofc.ts
git commit -m "security(cli): use interactive prompts for change-password (#32-1)

Passwords were previously accepted as --current/--new CLI flags,
exposing them in shell history and process listings. Now uses
interactive prompts (same pattern as auth login) with --password-stdin
for scripted use."
```

---

## Task 2: Audit failed login attempts

**Files:**
- Modify: `src/db/audit.ts` (add action type)
- Modify: `src/api/com.atproto.server.createSession.ts` (add auditLog calls)

- [ ] **Step 1: Add `session.loginFailed` to AuditAction type**

In `src/db/audit.ts`, add to the `AuditAction` union type:

```typescript
  | 'session.loginFailed'
```

Add it after the existing `'session.delete'` entry (around line 10).

- [ ] **Step 2: Add auditLog calls to each failure path in createSession**

In `src/api/com.atproto.server.createSession.ts`, add `import { auditLog } from '../db/audit.js';` at the top.

Then add `auditLog()` calls before each error response. There are 7 failure paths:

**User not found (line 42-48):**
```typescript
    if (userResult.rows.length === 0) {
      await auditLog('session.loginFailed', null, null, {
        identifier: input.identifier,
        reason: 'user_not_found',
        ip: req.ip,
      });
      res.status(401).json({ /* ... existing ... */ });
      return;
    }
```

**External account (line 53-58):**
```typescript
    if (user.auth_type === 'external') {
      await auditLog('session.loginFailed', null, user.id, {
        identifier: input.identifier,
        reason: 'external_account',
        ip: req.ip,
      });
      res.status(400).json({ /* ... existing ... */ });
      return;
    }
```

**No password hash (line 61-66):**
```typescript
    if (!user.password_hash) {
      await auditLog('session.loginFailed', null, user.id, {
        identifier: input.identifier,
        reason: 'no_password_hash',
        ip: req.ip,
      });
      res.status(401).json({ /* ... existing ... */ });
      return;
    }
```

**Wrong password (line 70-75):**
```typescript
    if (!passwordOk) {
      await auditLog('session.loginFailed', null, user.id, {
        identifier: input.identifier,
        reason: 'wrong_password',
        ip: req.ip,
      });
      res.status(401).json({ /* ... existing ... */ });
      return;
    }
```

**Suspended (line 78-83):**
```typescript
    if (user.status === 'suspended') {
      await auditLog('session.loginFailed', null, user.id, {
        identifier: input.identifier,
        reason: 'account_suspended',
        ip: req.ip,
      });
      res.status(403).json({ /* ... existing ... */ });
      return;
    }
```

**Taken down (line 86-91):**
```typescript
    if (user.status === 'takendown') {
      await auditLog('session.loginFailed', null, user.id, {
        identifier: input.identifier,
        reason: 'account_takendown',
        ip: req.ip,
      });
      res.status(410).json({ /* ... existing ... */ });
      return;
    }
```

**Deactivated (line 94-99) and not approved (line 102-107):** Same pattern with `reason: 'account_deactivated'` and `reason: 'account_not_approved'`.

- [ ] **Step 3: Verify tests still pass**

Run: `npm run test:unit`

Expected: all pass (auditLog is fire-and-forget, no return value changes).

- [ ] **Step 4: Commit**

```bash
git add src/db/audit.ts src/api/com.atproto.server.createSession.ts
git commit -m "security(auth): audit all failed login attempts

Every failure path in createSession now writes to audit_log with
the identifier, failure reason, and client IP. Enables forensic
analysis of brute-force attempts and credential stuffing."
```

---

## Task 3: Replace pbkdf2Sync with async pbkdf2

**Files:**
- Modify: `src/auth/encryption.ts`

- [ ] **Step 1: Convert deriveKey to async**

Replace the entire `src/auth/encryption.ts` file. Changes: `deriveKey` becomes async, `encryptKeyBytes` and `decryptKeyBytes` become async.

```typescript
import crypto from 'crypto';
import { promisify } from 'util';
import { config } from '../config.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;
const ITERATIONS = 100000;

const pbkdf2 = promisify(crypto.pbkdf2);

async function deriveKey(secret: string, salt: Buffer): Promise<Buffer> {
  return pbkdf2(secret, salt, ITERATIONS, KEY_LENGTH, 'sha512');
}

/**
 * Encrypt data using AES-256-GCM with a derived key from KEY_ENCRYPTION_SECRET.
 * Returns a buffer: [salt (32)] [iv (16)] [authTag (16)] [ciphertext (...)]
 */
export async function encryptKeyBytes(plaintext: Buffer): Promise<Buffer> {
  const secret = config.keyEncryptionSecret;
  if (!secret) {
    throw new Error('KEY_ENCRYPTION_SECRET must be set to encrypt keys at rest');
  }

  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = await deriveKey(secret, salt);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([salt, iv, authTag, encrypted]);
}

/**
 * Decrypt data that was encrypted with encryptKeyBytes.
 */
export async function decryptKeyBytes(cipherBundle: Buffer): Promise<Buffer> {
  const secret = config.keyEncryptionSecret;
  if (!secret) {
    throw new Error('KEY_ENCRYPTION_SECRET must be set to decrypt keys at rest');
  }

  const salt = cipherBundle.subarray(0, SALT_LENGTH);
  const iv = cipherBundle.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = cipherBundle.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = cipherBundle.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  const key = await deriveKey(secret, salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}
```

- [ ] **Step 2: Fix all callers**

Search for all call sites of `encryptKeyBytes` and `decryptKeyBytes`. They are already in async functions, so add `await` where missing:

```bash
grep -rn 'encryptKeyBytes\|decryptKeyBytes' src/
```

Every call site should already have `await` since the functions were called from async contexts. If any call site is missing `await`, add it. The TypeScript compiler will flag calls that don't await the now-Promise return type.

- [ ] **Step 3: Build and test**

Run: `npm run build && npm run test:unit`

Expected: build succeeds (TS catches any missing awaits), all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/auth/encryption.ts
git commit -m "security(crypto): replace pbkdf2Sync with async pbkdf2

Unblocks the Node.js event loop during key derivation (~100ms per
call at 100k iterations). All callers are already async."
```

---

## Task 4: Cap the OAuth pending-code Map

**Files:**
- Modify: `src/oauth/external-routes.ts`

- [ ] **Step 1: Add size cap with eviction**

At the top of the file (after the `pendingCodes` Map declaration at line 41), add a constant and helper:

```typescript
const MAX_PENDING_CODES = 10_000;

function addPendingCode(code: string, entry: { tokens: LocalTokens; expiresAt: number }): void {
  if (pendingCodes.size >= MAX_PENDING_CODES) {
    // Evict oldest entry
    const oldest = pendingCodes.keys().next().value;
    if (oldest) pendingCodes.delete(oldest);
  }
  pendingCodes.set(code, entry);
}
```

- [ ] **Step 2: Replace direct Map.set calls**

Find all `pendingCodes.set(...)` calls in the file and replace them with `addPendingCode(...)`.

- [ ] **Step 3: Commit**

```bash
git add src/oauth/external-routes.ts
git commit -m "security(oauth): cap pending-code Map at 10k entries

Prevents memory exhaustion from sustained OAuth callback abuse.
Evicts oldest entry on insert when at capacity."
```

---

## Task 5: Add Content-Security-Policy header

**Files:**
- Modify: `src/server/index.ts` (security headers middleware, ~line 116-126)

- [ ] **Step 1: Add CSP header**

In the security headers middleware, after the existing headers (before `next()`), add:

```typescript
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'"
  );
```

- [ ] **Step 2: Commit**

```bash
git add src/server/index.ts
git commit -m "security(server): add Content-Security-Policy header

Sets restrictive CSP as defence-in-depth against XSS. The existing
comment at X-XSS-Protection said 'use CSP instead' but CSP was
never set."
```

---

## Task 6: Add rate limiter to invite.create

**Files:**
- Modify: `src/server/index.ts` (handler registry, ~line 227)

- [ ] **Step 1: Add limiter to handler entry**

In the handler registry, change:

```typescript
  'net.openfederation.invite.create': { handler: createInvite },
```

to:

```typescript
  'net.openfederation.invite.create': { handler: createInvite, limiter: createLimiter },
```

This reuses the existing `createLimiter` (10 per hour) which is already used for `community.create`.

- [ ] **Step 2: Commit**

```bash
git add src/server/index.ts
git commit -m "security(api): add rate limiter to invite.create

Reuses createLimiter (10/hr). Prevents a compromised moderator
from generating unlimited invite codes."
```

---

## Task 7: Add SSRF guard to peer health checks

**Files:**
- Modify: `src/federation/peer-cache.ts`

- [ ] **Step 1: Import isPrivateHost**

At the top of `src/federation/peer-cache.ts`, add:

```typescript
import { isPrivateHost } from './remote-verify.js';
```

- [ ] **Step 2: Add validation before fetch**

In the `getCachedPeerInfo` function, inside the `peerUrls.map(async ...)` callback, after extracting `peerHostname` (~line 143), add:

```typescript
      if (isPrivateHost(peerHostname)) {
        console.warn(`Skipping peer ${peerUrl}: private/internal host`);
        return { hostname: peerHostname, serviceUrl: peerUrl, webUrl: null, healthy: false };
      }
```

Place this between the hostname extraction try/catch block and the `try { const url = ...` fetch block.

- [ ] **Step 3: Commit**

```bash
git add src/federation/peer-cache.ts
git commit -m "security(federation): add SSRF guard to peer health checks

Validates peer hostnames against isPrivateHost() before fetching.
Prevents misconfigured PEER_PDS_URLS from triggering requests to
internal services."
```

---

## Task 8: Expand reserved handles list

**Files:**
- Modify: `src/auth/utils.ts`

- [ ] **Step 1: Add trust-signal handles**

Replace the `RESERVED_HANDLES` set:

```typescript
const RESERVED_HANDLES = new Set([
  'admin', 'administrator', 'root', 'system', 'moderator', 'mod',
  'null', 'undefined', 'api', 'xrpc', 'health', 'status',
  'openfederation', 'atproto', 'bluesky', 'support', 'help',
  'official', 'security', 'staff', 'team', 'ops', 'operations',
  'abuse', 'contact', 'info', 'news', 'legal', 'privacy', 'tos',
  'trust', 'safety', 'bot', 'service', 'noreply', 'no-reply',
]);
```

- [ ] **Step 2: Commit**

```bash
git add src/auth/utils.ts
git commit -m "security(auth): expand reserved handles to block impersonation

Adds security, official, staff, team, legal, privacy, and other
trust-signal names that could be used to impersonate platform
operators."
```

---

## Task 9: Warn when bootstrap admin password env var persists

**Files:**
- Modify: `src/auth/bootstrap.ts`

- [ ] **Step 1: Add warning in the "admin exists" branch**

In `ensureBootstrapAdmin()`, inside the `if (existing.rows.length > 0)` block (line 26), just before `return;` (line 43), add:

```typescript
    console.warn(
      'WARNING: BOOTSTRAP_ADMIN_PASSWORD is still set in your environment. ' +
      'The admin account already exists — remove this variable to reduce your attack surface.'
    );
```

- [ ] **Step 2: Commit**

```bash
git add src/auth/bootstrap.ts
git commit -m "security(auth): warn when bootstrap password persists after setup

Operators who leave BOOTSTRAP_ADMIN_PASSWORD set after first startup
are now warned at every server start that the variable should be
removed."
```

---

## Task 10: Make trust proxy configurable

**Files:**
- Modify: `src/config.ts`
- Modify: `src/server/index.ts`

- [ ] **Step 1: Add EXPRESS_TRUST_PROXY to config**

In `src/config.ts`, add to the config object (in the `server` or top-level section):

```typescript
trustProxy: process.env.EXPRESS_TRUST_PROXY || 1,
```

Parse it: if the value is a number string, use the number; if `'true'`/`'false'`, use the boolean; otherwise use the string (for IP-based configs like `'loopback'`).

```typescript
function parseTrustProxy(val: string | undefined): string | number | boolean {
  if (!val) return 1;
  if (val === 'true') return true;
  if (val === 'false') return false;
  const num = parseInt(val, 10);
  if (!isNaN(num)) return num;
  return val;
}

// In config:
trustProxy: parseTrustProxy(process.env.EXPRESS_TRUST_PROXY),
```

- [ ] **Step 2: Use config in server**

In `src/server/index.ts`, replace:

```typescript
app.set('trust proxy', 1);
```

with:

```typescript
app.set('trust proxy', config.trustProxy);
```

- [ ] **Step 3: Commit**

```bash
git add src/config.ts src/server/index.ts
git commit -m "security(server): make trust proxy configurable via EXPRESS_TRUST_PROXY

Defaults to 1 (correct for single-proxy deployments). Set to 2 for
Cloudflare + Railway, or true to trust all proxies."
```

---

## Task 11: Final verification

- [ ] **Step 1: Build**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 2: Run unit tests**

```bash
npm run test:unit
```

Expected: all pass.

- [ ] **Step 3: Run integration tests (if PLC available)**

```bash
npm run test:api
```

Expected: all pass.

- [ ] **Step 4: Push and verify CI**

```bash
git push
```

Expected: CI green on both Node 20 and 22.
