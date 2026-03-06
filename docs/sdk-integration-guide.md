# OpenFederation SDK Integration Guide

How to add user registration and login to your website using the `@openfederation/sdk`. This is the simplest way to let users create OpenFederation accounts directly from your app — no redirects, no invite codes, users are auto-approved and logged in immediately.

---

## When to Use This vs. OAuth

| Use case | Approach |
|----------|----------|
| **Register new users** on your platform (game accounts, etc.) | **Partner SDK** (this guide) |
| **Log in existing** OpenFederation/Bluesky/ATProto users | [OAuth Integration](./third-party-oauth-integration.md) |
| **Both** — register new users AND let existing users sign in | Partner SDK for registration, OAuth for "Sign in with ATProto" |

---

## Prerequisites

1. An OpenFederation PDS instance (e.g., `https://pds.openfederation.net`)
2. A **partner API key** — ask the PDS admin to create one for you (see [Admin: Creating Partner Keys](#admin-creating-partner-keys) below)

---

## Quick Start: `<script>` Tag

The fastest way — no build tools, no npm, just a script tag.

```html
<script src="https://pds.openfederation.net/sdk/v1.js"></script>
<script>
  const ofd = OpenFederation.createClient({
    serverUrl: 'https://pds.openfederation.net',
    partnerKey: 'ofp_your_key_here',
  });

  // Register a new user
  document.getElementById('register-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const user = await ofd.register({
        handle: document.getElementById('handle').value,
        email: document.getElementById('email').value,
        password: document.getElementById('password').value,
      });
      console.log('Registered! DID:', user.did);
      console.log('Handle:', ofd.displayHandle(user.handle));
    } catch (err) {
      console.error('Registration failed:', err.message);
    }
  };
</script>
```

The SDK bundle is served directly from the PDS at `/sdk/v1.js` (~2.5KB gzipped, zero dependencies).

---

## Quick Start: npm

```bash
npm install @openfederation/sdk
```

```typescript
import { createClient } from '@openfederation/sdk';

const ofd = createClient({
  serverUrl: 'https://pds.openfederation.net',
  partnerKey: 'ofp_your_key_here',
  onAuthChange: (user) => {
    if (user) {
      console.log('Logged in:', user.did);
    } else {
      console.log('Logged out');
    }
  },
});

// Register
const user = await ofd.register({
  handle: 'gamer42',
  email: 'gamer@example.com',
  password: 'MySecureP@ss1',
});

// Login (returning user)
const user = await ofd.login({
  identifier: 'gamer42',      // handle or email
  password: 'MySecureP@ss1',
});

// Check session
if (ofd.isAuthenticated()) {
  const user = await ofd.getUser();
  console.log(user.did);       // "did:plc:abc123"
}

// Logout
await ofd.logout();
```

---

## API Reference

### `createClient(config)`

Creates a new SDK client instance.

```typescript
const ofd = createClient({
  serverUrl: string;           // Required. PDS URL, e.g. "https://pds.openfederation.net"
  partnerKey: string;          // Required. Partner API key (ofp_...)
  storage?: 'local' | 'session' | 'memory';  // Default: 'local'
  storagePrefix?: string;      // Default: 'ofd_'
  autoRefresh?: boolean;       // Default: true
  onAuthChange?: (user: User | null) => void;
});
```

**Storage options:**
- `'local'` — `localStorage`, persists across tabs and browser restarts
- `'session'` — `sessionStorage`, cleared when the tab closes
- `'memory'` — in-memory only, cleared on page refresh (useful for SSR/testing)

### `ofd.register({ handle, email, password })`

Register a new user via the partner API. No invite code needed — the user is auto-approved and logged in immediately.

Returns: `Promise<User>`

```typescript
const user = await ofd.register({
  handle: 'alice',           // 3-30 chars, lowercase alphanumeric + hyphens
  email: 'alice@example.com',
  password: 'SecureP@ss1',  // 10-128 chars, 3 of 4 categories
});
// user = { did: "did:plc:...", handle: "alice", email: "alice@example.com", active: true }
```

**Errors:**
- `ValidationError` (400) — invalid handle/email/password format
- `ConflictError` (409) — handle or email already in use
- `RateLimitError` (429) — partner rate limit exceeded
- `AuthenticationError` (401) — invalid or revoked partner key
- `ForbiddenError` (403) — origin not allowed for this partner key

### `ofd.login({ identifier, password })`

Log in an existing user. Uses the standard ATProto `createSession` endpoint.

Returns: `Promise<User>`

```typescript
const user = await ofd.login({
  identifier: 'alice',        // handle or email
  password: 'SecureP@ss1',
});
```

### `ofd.getUser()`

Get the current user from local storage, or `null` if not logged in.

Returns: `Promise<User | null>`

### `ofd.isAuthenticated()`

Synchronous check for whether tokens are present in storage.

Returns: `boolean`

### `ofd.logout()`

Log out, invalidate the session on the server, and clear local tokens.

Returns: `Promise<void>`

### `ofd.displayHandle(handle)`

Strip the PDS domain suffix for display. `"alice.openfederation.net"` becomes `"alice"`.

Returns: `string`

### `ofd.fetch(nsid, options?)`

Make an authenticated XRPC request to the PDS. Automatically retries once with a fresh token on 401.

```typescript
const session = await ofd.fetch('com.atproto.server.getSession');
```

Returns: `Promise<unknown>`

### `ofd.loginWithATProto(handle)`

Redirect the browser to the PDS OAuth flow for existing ATProto users. Use this alongside `register()` if you want to support both new and existing users.

### `ofd.handleOAuthCallback()`

Call this on your OAuth callback page to complete the ATProto login flow.

Returns: `Promise<User>`

### `ofd.destroy()`

Clean up timers and callbacks. Call this when unmounting or cleaning up.

---

## User Object

```typescript
interface User {
  did: string;      // "did:plc:abc123" — stable, portable identifier
  handle: string;   // "alice.openfederation.net"
  email: string;    // "alice@example.com"
  active: boolean;  // true if account is active
}
```

The **DID** is the stable identifier — it never changes even if the user changes their handle or moves to a different PDS. **Store the DID as the primary key** in your database.

---

## Error Handling

All errors extend `OpenFederationError` and have `status`, `code`, and `message` properties.

```typescript
import { ConflictError, ValidationError, RateLimitError } from '@openfederation/sdk';

try {
  await ofd.register({ handle: 'alice', email: 'a@b.com', password: 'Str0ng!Pass' });
} catch (err) {
  if (err instanceof ConflictError) {
    // 409 — handle or email already taken
    showError('That username is already taken.');
  } else if (err instanceof ValidationError) {
    // 400 — invalid input
    showError(err.message);
  } else if (err instanceof RateLimitError) {
    // 429 — too many registrations
    showError('Please try again later.');
  } else {
    showError('Something went wrong.');
  }
}
```

---

## Token Management

The SDK handles token lifecycle automatically:

- **Access tokens** are stored in your chosen storage backend and sent with every authenticated request
- **Auto-refresh** fires 60 seconds before the access token expires (configurable via `autoRefresh: false` to disable)
- **Refresh failure** clears all tokens and calls `onAuthChange(null)` so your UI can redirect to login
- **401 retry** — `ofd.fetch()` automatically retries once with a fresh token on 401

Stored keys (with default prefix `ofd_`):
- `ofd_access_jwt` — current access token
- `ofd_refresh_jwt` — current refresh token
- `ofd_user` — cached user object (JSON)

---

## Full Example: Game Registration Page

```html
<!DOCTYPE html>
<html>
<head>
  <title>Create Account — Grvty Games</title>
</head>
<body>
  <h1>Create Your Game Account</h1>

  <form id="register-form">
    <input id="handle" placeholder="Username" required>
    <input id="email" type="email" placeholder="Email" required>
    <input id="password" type="password" placeholder="Password" required>
    <button type="submit">Create Account</button>
  </form>

  <div id="result" style="display:none">
    <p>Welcome, <strong id="display-name"></strong>!</p>
    <p>Your DID: <code id="user-did"></code></p>
    <button id="logout-btn">Log Out</button>
  </div>

  <p id="error" style="color:red"></p>

  <script src="https://pds.openfederation.net/sdk/v1.js"></script>
  <script>
    const ofd = OpenFederation.createClient({
      serverUrl: 'https://pds.openfederation.net',
      partnerKey: 'ofp_your_key_here',
      onAuthChange: (user) => {
        document.getElementById('register-form').style.display = user ? 'none' : 'block';
        document.getElementById('result').style.display = user ? 'block' : 'none';
        if (user) {
          document.getElementById('display-name').textContent = ofd.displayHandle(user.handle);
          document.getElementById('user-did').textContent = user.did;
        }
      },
    });

    document.getElementById('register-form').onsubmit = async (e) => {
      e.preventDefault();
      document.getElementById('error').textContent = '';
      try {
        await ofd.register({
          handle: document.getElementById('handle').value,
          email: document.getElementById('email').value,
          password: document.getElementById('password').value,
        });
      } catch (err) {
        document.getElementById('error').textContent = err.message;
      }
    };

    document.getElementById('logout-btn').onclick = () => ofd.logout();
  </script>
</body>
</html>
```

---

## Security Model

The partner API key is intentionally **public** — it's visible in your page source. This is safe because:

1. **Origin restriction** — the PDS validates the `Origin` header against the key's `allowed_origins` list. Requests from unlisted origins get 403.
2. **Permission scoping** — keys only grant `register` permission. They can't log in as users, access admin endpoints, or read other users' data.
3. **Per-key rate limiting** — each key has a configurable hourly limit (default: 100 registrations/hour). Exceeding it returns 429.
4. **Revocation** — the PDS admin can instantly revoke a compromised key. Existing users are unaffected.

The `Origin` header can be spoofed by non-browser clients (curl, scripts), so rate limiting is the primary defense against abuse. For most use cases, the combination of origin + rate limit + revocation provides sufficient protection.

---

## Admin: Managing Partner Keys

Partner keys let third-party apps register users on your PDS without invite codes. Each key is scoped to a specific partner, can be restricted to certain origins, and has its own rate limit. The raw key is shown **once** at creation time — save it immediately.

There are three ways to manage partner keys:

### Who Can Manage Partner Keys?

Users with the **admin** or **partner-manager** PDS role can create, list, and revoke partner keys. Users with the **auditor** role can view (list) keys but not create or revoke them.

To grant someone the `partner-manager` role without full admin access:
```bash
ofc account set-roles <did> --add partner-manager
```

See [PDS Roles](#pds-roles) below for the full role system.

### Option 1: Web UI (Recommended)

1. Log in to the admin dashboard at `https://web.openfederation.net`
2. Navigate to **Admin > Partner Keys** in the sidebar
3. Click **Create Key** and fill in:
   - **Key Name** — a label for your reference (e.g., "FlappySoccer Production")
   - **Partner Name** — the partner's domain or identifier (e.g., "games.grvty.tech")
   - **Allowed Origins** — comma-separated origins for CORS validation (leave blank to allow any origin)
   - **Rate Limit** — max registrations per hour for this key (default: 100)
4. Copy the raw key from the dialog — it won't be shown again
5. To revoke a key, click the **Revoke** button in the table

### Option 2: CLI

```bash
# First, log in as an admin
ofc -s https://pds.openfederation.net auth login -u admin

# Create a partner key
ofc partner create-key \
  -n "FlappySoccer Production" \
  -p "games.grvty.tech" \
  -o "https://games.grvty.tech" \
  -r 200

# List all partner keys
ofc partner list-keys

# Revoke a key by ID
ofc partner revoke-key <key-uuid>
```

Set `PDS_SERVICE_URL` to avoid passing `-s` every time:
```bash
export PDS_SERVICE_URL=https://pds.openfederation.net
```

### Option 3: API (curl)

```bash
# Create a partner key
curl -X POST https://pds.openfederation.net/xrpc/net.openfederation.partner.createKey \
  -H "Authorization: Bearer <admin_access_jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Grvty Production",
    "partnerName": "grvty.tech",
    "allowedOrigins": ["https://grvty.tech", "https://www.grvty.tech"],
    "rateLimitPerHour": 200
  }'
```

Response (raw key shown ONCE — save it immediately):
```json
{
  "id": "uuid",
  "key": "ofp_abc123...",
  "keyPrefix": "ofp_abc1",
  "name": "Grvty Production",
  "partnerName": "grvty.tech",
  "permissions": ["register"],
  "allowedOrigins": ["https://grvty.tech", "https://www.grvty.tech"],
  "rateLimitPerHour": 200,
  "status": "active"
}
```

```bash
# List all keys (shows prefix, stats — never raw key)
curl https://pds.openfederation.net/xrpc/net.openfederation.partner.listKeys \
  -H "Authorization: Bearer <admin_access_jwt>"

# Revoke a compromised key
curl -X POST https://pds.openfederation.net/xrpc/net.openfederation.partner.revokeKey \
  -H "Authorization: Bearer <admin_access_jwt>" \
  -H "Content-Type: application/json" \
  -d '{"id": "key-uuid"}'
```

### Create Key Options

| Field | Required | Default | Description |
|-------|:--------:|:-------:|-------------|
| `name` | Yes | — | Label for identifying the key (e.g., "FlappySoccer Production") |
| `partnerName` | Yes | — | Partner domain or identifier (e.g., "games.grvty.tech") |
| `allowedOrigins` | No | Any | Origins allowed to use the key. Leave blank to allow all origins. Set for browser apps to restrict usage to your domain(s). |
| `rateLimitPerHour` | No | 100 | Max registrations per hour (1–10,000) |
| `permissions` | No | `["register"]` | Permission scopes granted to this key |

### What Partner Keys Control

Partner keys are specifically for **user registration** by third-party apps. They:

- **Allow** apps to register new users without invite codes (auto-approved)
- **Restrict** which origins (domains) can make registration requests
- **Limit** registration rate per key to prevent abuse
- **Can be revoked** instantly if a key is compromised

Partner keys do **not** control:
- User login — any registered user can log in normally, no key needed
- OAuth/SSO — ATProto OAuth is a separate flow for existing users
- Admin endpoints — those require admin JWT authentication

---

## Partner API Endpoints

| NSID | Method | Auth | Description |
|------|:---:|:---:|-------------|
| `net.openfederation.partner.register` | POST | X-Partner-Key | Register user (no invite, auto-approved, returns tokens) |
| `net.openfederation.partner.createKey` | POST | Admin or Partner Manager | Generate a new partner key (raw key shown once) |
| `net.openfederation.partner.listKeys` | GET | Admin, Partner Manager, or Auditor | List all keys with stats (never shows raw key) |
| `net.openfederation.partner.revokeKey` | POST | Admin or Partner Manager | Revoke a partner key |

---

## PDS Roles

The PDS uses additive (non-hierarchical) roles. A user can hold multiple roles simultaneously.

| Role | Description |
|------|-------------|
| **admin** | Full PDS access. Server config, user deletion, community takedown, all other roles' permissions. |
| **moderator** | User moderation. Approve/reject registrations, suspend/unsuspend users, manage invites. Cannot delete accounts or take down communities. |
| **partner-manager** | Partner integration management. Create, list, and revoke partner API keys. Cannot moderate users or access server config. |
| **auditor** | Read-only oversight. Audit logs, server stats, user/invite/partner key lists. Cannot perform any mutations. |
| **user** | Default role for all accounts. Create/join communities, write records, manage own account. |

### Permission Matrix

| Action | admin | moderator | partner-manager | auditor |
|--------|:-----:|:---------:|:---------------:|:-------:|
| Server config & stats | Y | | | Y |
| Audit log | Y | | | Y |
| List users & invites | Y | Y | | Y |
| Approve/reject registrations | Y | Y | | |
| Create invites | Y | Y | | |
| Suspend/unsuspend users | Y | Y | | |
| Takedown/delete users | Y | | | |
| Create/revoke partner keys | Y | | Y | |
| List partner keys | Y | | Y | Y |
| Suspend/takedown communities | Y | | | |
| View subject status | Y | Y | | Y |
| Export user data | Y | Y | | |

### Managing Roles

**Web UI:** Admin > Users > click **Roles** button on any user > toggle checkboxes.

**CLI:**
```bash
# Promote a user to moderator
ofc account set-roles <did> --add moderator

# Grant partner management + auditor roles
ofc account set-roles <did> --add partner-manager,auditor

# Remove a role
ofc account set-roles <did> --remove moderator

# Combine add and remove
ofc account set-roles <did> --add partner-manager --remove moderator
```

**API:**
```bash
curl -X POST https://pds.openfederation.net/xrpc/net.openfederation.account.updateRoles \
  -H "Authorization: Bearer <admin_jwt>" \
  -H "Content-Type: application/json" \
  -d '{"did": "did:plc:abc123", "addRoles": ["moderator", "partner-manager"]}'
```

**Safety rules:**
- Only admins can change roles
- Cannot remove your own admin role (lockout protection)
- Cannot remove the last admin from the system
- Role changes take effect on next token refresh (within 15 minutes)

### PDS Roles vs. Community Roles

These are separate systems:

| Scope | Roles | Stored in | Controls |
|-------|-------|-----------|----------|
| **PDS** | admin, moderator, partner-manager, auditor, user | `user_roles` table | Server-wide actions |
| **Community** | owner, moderator, member | Repo records | Per-community actions |

A PDS moderator can approve registrations server-wide but has no special powers in any community. A community moderator can manage members in their community but cannot approve PDS registrations. A user can hold roles in both systems independently.

---

## Database Schema (PDS Side)

The partner system adds one table and one column:

```sql
-- Partner API keys
CREATE TABLE partner_keys (
    id VARCHAR(36) PRIMARY KEY,
    key_hash VARCHAR(128) NOT NULL UNIQUE,
    key_prefix VARCHAR(12) NOT NULL,
    name VARCHAR(255) NOT NULL,
    partner_name VARCHAR(255) NOT NULL,
    created_by VARCHAR(36) REFERENCES users(id),
    permissions JSONB NOT NULL DEFAULT '["register"]',
    allowed_origins JSONB DEFAULT NULL,
    rate_limit_per_hour INTEGER NOT NULL DEFAULT 100,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    total_registrations INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Track which partner created each user
ALTER TABLE users ADD COLUMN created_by_partner VARCHAR(36) REFERENCES partner_keys(id);
```

Migrations:
- `scripts/migrate-004-partner-keys.sql` — partner keys table
- `scripts/migrate-006-rbac-roles.sql` — adds `partner-manager` and `auditor` roles
