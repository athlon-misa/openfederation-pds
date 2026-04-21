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

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `serverUrl` | `string` | *required* | Full URL of the PDS, e.g. `"https://pds.openfederation.net"`. Trailing slash is stripped automatically. |
| `partnerKey` | `string` | *required* | Partner API key (`ofp_...`). Used for registration. Login does not require a partner key, but the SDK always needs one at construction time. |
| `storage` | `'local' \| 'session' \| 'memory'` | `'local'` | Where to store tokens. `'local'` uses `localStorage` (persists across tabs/restarts). `'session'` uses `sessionStorage` (cleared on tab close). `'memory'` stores in-memory only (cleared on page refresh; useful for SSR/testing). |
| `storagePrefix` | `string` | `'ofd_'` | Prefix for all storage keys. Change this if you run multiple SDK instances on the same origin. |
| `autoRefresh` | `boolean` | `true` | When `true`, the SDK schedules a token refresh 60 seconds before the access token expires. Set to `false` to manage refresh timing yourself. |
| `onAuthChange` | `(user: User \| null) => void` | — | Called when auth state changes: after `login()`, `register()`, `logout()`, or when a token refresh fails. You can also subscribe later with `ofd.onAuthChange()`. |

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

**Errors:**
- `AuthenticationError` (401) — invalid credentials
- `ValidationError` (400) — missing or malformed fields
- `RateLimitError` (429) — too many login attempts

### `ofd.getUser()`

Get the current user from local storage, or `null` if not logged in. This reads from the cached user object in storage — it does not make a network request.

Returns: `Promise<User | null>`

### `ofd.isAuthenticated()`

Synchronous check for whether both access and refresh tokens are present in storage. Does not verify token validity — use `getAccessToken()` for that.

Returns: `boolean`

### `ofd.getAccessToken()`

Get a valid access JWT, auto-refreshing if the current token is expired or will expire within 60 seconds. Returns `null` if not authenticated.

This is the method to use when you need to make your own authenticated requests outside the SDK (e.g., passing the token to a WebSocket connection or a third-party library).

Returns: `Promise<string | null>`

```typescript
const token = await ofd.getAccessToken();
if (token) {
  // Use token in a custom request
  const res = await fetch('https://my-api.example.com/data', {
    headers: { Authorization: `Bearer ${token}` },
  });
}
```

### `ofd.getSession()`

Get the full session (access token, refresh token, and user object), auto-refreshing if needed. Returns `null` if not authenticated.

Returns: `Promise<Session | null>`

```typescript
interface Session {
  accessJwt: string;
  refreshJwt: string;
  user: User;
}

const session = await ofd.getSession();
if (session) {
  console.log('DID:', session.user.did);
  console.log('Token:', session.accessJwt);
}
```

### `ofd.onAuthChange(callback)`

Subscribe to auth state changes. The callback fires on login, logout, and token refresh failure. Returns an unsubscribe function.

You can have multiple subscribers. The `onAuthChange` option in `createClient()` is equivalent to calling this method immediately after construction.

Returns: `() => void` (unsubscribe function)

```typescript
const unsubscribe = ofd.onAuthChange((user) => {
  if (user) {
    showDashboard(user);
  } else {
    showLoginForm();
  }
});

// Later, to stop listening:
unsubscribe();
```

### `ofd.logout()`

Log out, invalidate the session on the server, and clear local tokens. Calls `onAuthChange(null)` after clearing.

Network errors during server-side session invalidation are silently ignored — the local tokens are always cleared regardless.

Returns: `Promise<void>`

### `ofd.displayHandle(handle)`

Strip the PDS domain suffix for display. `"alice.openfederation.net"` becomes `"alice"`. If the handle doesn't end with the PDS suffix, it's returned as-is.

Returns: `string`

### `ofd.fetch(nsid, options?)`

Make an authenticated XRPC request to the PDS. Automatically retries once with a fresh token on 401.

Returns: `Promise<unknown>`

```typescript
// GET request with query parameters
const records = await ofd.fetch('com.atproto.repo.listRecords', {
  method: 'GET',
  params: { repo: 'did:plc:abc123', collection: 'app.bsky.actor.profile' },
});

// POST request with body
await ofd.fetch('com.atproto.repo.putRecord', {
  method: 'POST',
  body: {
    repo: 'did:plc:abc123',
    collection: 'app.bsky.actor.profile',
    rkey: 'self',
    record: { displayName: 'Alice' },
  },
});
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `method` | `'GET' \| 'POST'` | `'GET'` | HTTP method |
| `body` | `Record<string, unknown>` | — | Request body (POST only), serialized as JSON |
| `params` | `Record<string, string>` | — | Query parameters (GET only) |

**Errors:**
- `AuthenticationError` (401) — not authenticated, or session expired after retry
- Any error from the PDS response is mapped to the appropriate error class

### `ofd.loginWithATProto(handle | options)`

Redirect the browser to the PDS OAuth flow for existing ATProto users. Use this alongside `register()` if you want to support both new and existing users.

This is synchronous — it navigates the browser window. No Promise is returned.

Accepts a handle string (simple form) or an options object (advanced form):

```typescript
// Simple — just a handle
ofd.loginWithATProto('alice.bsky.social');

// Advanced — with redirect URI and CSRF state
ofd.loginWithATProto({
  handle: 'alice.bsky.social',
  redirectUri: 'https://myapp.com/callback',
  state: crypto.randomUUID(),  // for CSRF protection
});
```

**Options (ATProtoLoginOptions):**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `handle` | `string` | *required* | ATProto handle (e.g. `"alice.bsky.social"`) |
| `redirectUri` | `string` | `window.location.href` | Where to redirect after auth |
| `state` | `string` | — | Opaque state for CSRF protection, passed through the OAuth flow |

### `ofd.handleOAuthCallback()`

Call this on your OAuth callback page to complete the ATProto login flow. Reads the `code` parameter from the current URL's query string and exchanges it for local JWT tokens.

Returns: `Promise<User>`

```typescript
// On your /callback page:
try {
  const user = await ofd.handleOAuthCallback();
  console.log('Logged in via ATProto:', user.did);
  window.location.href = '/dashboard';
} catch (err) {
  console.error('OAuth failed:', err.message);
}
```

**Errors:**
- `AuthenticationError` — if the callback URL contains an `error` parameter or no `code` parameter

### `ofd.destroy()`

Clean up auto-refresh timers and remove all auth change listeners. Call this when unmounting a component or tearing down the SDK instance.

After calling `destroy()`, the client instance should not be reused.

### `verifyPdsToken(accessToken, options?)` (server-side)

Verify a PDS access token by calling `com.atproto.server.getSession` on the issuing PDS. This is a standalone function (not a method on the client) intended for use in your backend.

Returns: `Promise<VerifiedSession | null>` — `{ did, handle }` on success, `null` on any failure.

```typescript
import { verifyPdsToken } from '@openfederation/sdk';

// Recommended: verify against a known PDS
const session = await verifyPdsToken(req.headers.authorization?.split(' ')[1], {
  pdsUrl: 'https://pds.openfederation.net',
});

if (!session) {
  res.status(401).json({ error: 'Invalid token' });
  return;
}

console.log('Authenticated user:', session.did, session.handle);
```

**Options (VerifyPdsTokenOptions):**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `pdsUrl` | `string` | — | PDS URL to verify against directly. Skips DID-based discovery. Recommended for most apps. |
| `plcDirectoryUrl` | `string` | `'https://plc.openfederation.net'` | PLC directory URL for DID-based PDS discovery (used when `pdsUrl` is not set). |
| `expectedDid` | `string` | — | If set, verification fails when the token's DID doesn't match. |
| `timeoutMs` | `number` | `5000` | Request timeout in milliseconds. |

### `displayHandle(handle, suffix?)` (standalone)

Standalone version of `ofd.displayHandle()`. Can be imported and used without creating a client instance.

```typescript
import { displayHandle } from '@openfederation/sdk';
displayHandle('alice.openfederation.net');  // "alice"
displayHandle('alice.custom.net', '.custom.net');  // "alice"
```

### `SDK_VERSION`

The SDK version string (e.g. `"0.1.0"`). Follows semver.

```typescript
import { SDK_VERSION } from '@openfederation/sdk';
console.log('SDK version:', SDK_VERSION);
```

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

### Error Classes

| Class | HTTP Status | Code | When |
|-------|:-----------:|------|------|
| `OpenFederationError` | any | varies | Base class for all SDK errors |
| `AuthenticationError` | 401 | `Unauthorized` | Invalid credentials, expired session, invalid partner key |
| `ValidationError` | 400 | `InvalidRequest` | Malformed input (bad handle, weak password, etc.) |
| `ConflictError` | 409 | `AccountExists` | Handle or email already in use |
| `RateLimitError` | 429 | `RateLimitExceeded` | Too many requests (partner rate limit or IP rate limit) |
| `ForbiddenError` | 403 | `Forbidden` | Origin not allowed for this partner key |

All error classes are available as named exports:

```typescript
// npm
import { OpenFederationError, AuthenticationError } from '@openfederation/sdk';

// IIFE (script tag)
const { OpenFederationError, AuthenticationError } = OpenFederation;
```

Each error instance has these properties:
- `message` (string) — human-readable error description from the server
- `status` (number) — HTTP status code
- `code` (string) — machine-readable error code
- `name` (string) — class name (e.g. `"ConflictError"`)

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

## Handling SDK Load Failures

When using the IIFE bundle via a `<script>` tag, the SDK script might fail to load (network error, CDN outage, ad blocker). The SDK provides built-in tools for handling this gracefully.

### The `openfederation:ready` Event

The IIFE bundle dispatches a custom DOM event when it finishes loading:

```javascript
document.addEventListener('openfederation:ready', (event) => {
  console.log('SDK loaded, version:', event.detail.version);
  const ofd = OpenFederation.createClient({ ... });
});
```

### `waitForSDK(timeoutMs?)`

If the SDK is already loaded (i.e., you're calling this from within the same bundle or after it loaded synchronously), `waitForSDK()` resolves immediately:

```javascript
OpenFederation.waitForSDK().then((sdk) => {
  const ofd = sdk.createClient({ ... });
});
```

### Recommended Guard Pattern for `async`/`defer` Scripts

When loading the SDK with `async` or `defer`, you can't assume `OpenFederation` exists when your own code runs. Use this pattern:

```html
<script src="https://pds.openfederation.net/sdk/v1.js" async></script>
<script>
  // Guard: wait for SDK to load, with timeout
  function whenSDKReady(timeoutMs) {
    // Already loaded?
    if (typeof OpenFederation !== 'undefined' && OpenFederation.createClient) {
      return Promise.resolve(OpenFederation);
    }
    // Not yet — listen for the ready event
    return new Promise(function(resolve, reject) {
      var timer = setTimeout(function() {
        reject(new Error('OpenFederation SDK failed to load within ' + timeoutMs + 'ms'));
      }, timeoutMs || 10000);

      document.addEventListener('openfederation:ready', function() {
        clearTimeout(timer);
        resolve(OpenFederation);
      }, { once: true });
    });
  }

  whenSDKReady(10000).then(function(sdk) {
    var ofd = sdk.createClient({
      serverUrl: 'https://pds.openfederation.net',
      partnerKey: 'ofp_your_key_here',
    });
    // SDK is ready to use
  }).catch(function(err) {
    console.error(err.message);
    // Show fallback UI or retry
  });
</script>
```

### Synchronous Script (Simple Case)

If you load the SDK without `async`/`defer`, no guard is needed — the script blocks until loaded:

```html
<script src="https://pds.openfederation.net/sdk/v1.js"></script>
<script>
  // OpenFederation is guaranteed to exist here
  const ofd = OpenFederation.createClient({ ... });
</script>
```

---

## TypeScript Support

The SDK ships TypeScript type definitions (`.d.ts`) for all three output formats.

### npm (ESM / CommonJS)

Types are automatically resolved via `package.json` exports. No extra configuration needed:

```typescript
import { createClient, type User, type ClientConfig } from '@openfederation/sdk';
```

All types are exported:
- `ClientConfig`, `User`, `Session`, `RegisterOptions`, `LoginOptions`, `FetchOptions`
- `AuthProvider`, `ATProtoLoginOptions`
- `VerifiedSession`, `VerifyPdsTokenOptions`

### IIFE Bundle (script tag)

For TypeScript projects that use the IIFE bundle, add a triple-slash reference to get types for the `OpenFederation` global:

```typescript
/// <reference types="@openfederation/sdk/global" />

const ofd = OpenFederation.createClient({
  serverUrl: 'https://pds.openfederation.net',
  partnerKey: 'ofp_...',
});
```

### AuthProvider Interface

The `OpenFederationClient` implements the `AuthProvider` interface, which can be used by other SDKs that need to consume OpenFederation auth:

```typescript
import type { AuthProvider } from '@openfederation/sdk';

class MyGameClient {
  constructor(private auth: AuthProvider) {}

  async fetchLeaderboard() {
    const token = await this.auth.getAccessToken();
    // ... use token
  }
}

// Pass the SDK client as an auth provider
const ofd = createClient({ ... });
const game = new MyGameClient(ofd);
```

---

## SDK Versioning

The SDK follows [Semantic Versioning](https://semver.org/).

### IIFE Bundle Endpoint

The PDS serves the IIFE bundle at `/sdk/v1.js`. The `v1` in the URL is the **API major version**, not the package version. All `0.x` and `1.x` package releases are served through this endpoint.

| Endpoint | Package Versions | Status |
|----------|-----------------|--------|
| `/sdk/v1.js` | `0.1.0` through `1.x` | Current |

When a breaking change requires a new major version, a `/sdk/v2.js` endpoint will be introduced. The previous endpoint will continue working for a deprecation period.

### Checking the SDK Version

```javascript
// IIFE
console.log(OpenFederation.SDK_VERSION);  // "0.1.0"

// npm
import { SDK_VERSION } from '@openfederation/sdk';
console.log(SDK_VERSION);  // "0.1.0"
```

### Changelog

See [`packages/openfederation-sdk/CHANGELOG.md`](../packages/openfederation-sdk/CHANGELOG.md) for the full release history.

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


---

## Progressive-Custody Wallets

OpenFederation provisions web3 wallets at three custody tiers. One DID, many wallets, each at a security level chosen by the user — and upgradable later without changing the on-chain address.

| Tier | Where the key lives | Signing path | When to use |
|---|---|---|---|
| **1 Custodial** | PDS (encrypted at rest) | `client.wallet.sign(...)` routes to the PDS; per-dApp consent required | Casual gaming, points, badges |
| **2 User-encrypted** | PDS holds a passphrase-wrapped blob; user holds the passphrase | `client.wallet.unlockTier2(...)` returns a `WalletSession` that signs in-browser | Community tokens, regular voting |
| **3 Self-custody** | Nowhere on OF — client keeps the mnemonic | Sign in your own wallet software | Treasury signing, governance, high value |

All tiers share the same on-chain address and the same `wallet_links` binding. Upgrading a tier (Milestone 2.5, future PR) preserves the address.

### Tier 1 — Custodial wallet

```ts
const client = createClient({ serverUrl, partnerKey });
await client.register({ handle, email, password });

// Ask the PDS to generate a custodial Ethereum wallet.
const t1 = await client.wallet.createTier1({ chain: 'ethereum', label: 'game-1' });
// => { chain: 'ethereum', walletAddress: '0x…', custodyTier: 'custodial', label: 'game-1' }

// Before any dApp can sign with this wallet, the user must grant consent
// to the dApp's origin. Default TTL 7 days, max 30 days.
await client.wallet.grantConsent({
  dappOrigin: 'https://game.example.com',
  chain: 'ethereum',
  walletAddress: t1.walletAddress,
});

// Sign a message via the PDS. Returns an EIP-191 hex signature.
const { signature } = await client.wallet.sign({
  chain: 'ethereum',
  walletAddress: t1.walletAddress,
  message: 'Hello from Tier 1',
  dappOrigin: 'https://game.example.com',
});
```

### Tier 2 — User-encrypted wallet

```ts
// Client-side: generate a BIP-39 mnemonic, wrap with a passphrase,
// upload the encrypted blob, link the derived address to the DID.
const t2 = await client.wallet.createTier2({
  chain: 'solana',
  passphrase: 'correct-horse-battery-staple',
  label: 'community-1',
});

// To sign, unlock with the passphrase → get an in-memory WalletSession.
const session = await client.wallet.unlockTier2({
  chain: 'solana',
  passphrase: 'correct-horse-battery-staple',
});
const sig = session.signMessage('hello', 'solana'); // base58 Ed25519 signature

// When done, wipe the in-memory keys.
session.destroy();
```

### Tier 3 — Self-custody wallet

```ts
// Client generates the mnemonic, links the public address to the DID,
// and returns the mnemonic for the caller to store offline.
const t3 = await client.wallet.createTier3({ chain: 'ethereum', label: 'treasury' });
console.log('Store this mnemonic offline:', t3.mnemonic);
// Nothing was uploaded to the PDS beyond the public link. From here on,
// sign with your own wallet software (MetaMask, Ledger, etc.).
```

### Rate limits

- `CREATE_RATE_LIMIT` (default 10/hr/IP) caps provisioning + consent grants.
- `WALLET_SIGN_RATE_LIMIT` (default 60/min/IP) caps Tier 1 signing requests.
- Both are surfaced as 429 with `error: "RateLimitExceeded"`.

### See also

- End-to-end demo: `scripts/demos/wallet-progressive-custody.ts` — creates one wallet per tier and independently verifies each signature.
- Database migration: `scripts/migrate-021-wallet-custody.sql`.


### Signing transactions (M2)

`wallet.signMessage` covers user-facing sign-in prompts; `wallet.signTransaction` produces wire-ready signed transactions.

```ts
// Tier 1 — the PDS signs. Consent must already be granted.
const result = await client.wallet.signTransaction({
  chain: 'ethereum',
  walletAddress: t1.walletAddress,
  dappOrigin: 'https://game.example.com',
  tx: {
    to: '0x…',
    value: '1000000000000000',          // wei, as string
    gasLimit: '21000',
    maxFeePerGas: '30000000000',
    maxPriorityFeePerGas: '1000000000',
    nonce: 0,
    chainId: 137,                       // REQUIRED — we refuse replay-vulnerable tx
  },
});
// result.signedTx === '0x…' — broadcast via your provider.

// Solana: server signs the message bytes of Transaction.compileMessage().
const messageBytes = tx.serializeMessage();
const { signature } = await client.wallet.signTransaction({
  chain: 'solana',
  walletAddress: solT1,
  messageBase64: Buffer.from(messageBytes).toString('base64'),
});
tx.addSignature(publicKey, bs58.decode(signature));
```

### Drop-in ethers v6 signer

```ts
// Tier 2 unlock → adapter wraps the in-memory session.
const session = await client.wallet.unlockTier2({
  chain: 'ethereum',
  passphrase: 'correct-horse',
});
const signer = await client.wallet.asEthersSigner({
  walletAddress: t2Address,
  session,                              // omit for Tier 1
});

// Use it with any ethers workflow.
import { Contract, JsonRpcProvider } from 'ethers';
const provider = new JsonRpcProvider(rpcUrl);
const connected = signer.connect(provider);
const contract = new Contract(contractAddress, abi, connected);
await contract.someMethod(args);        // uses the OF wallet transparently
```

Install `ethers@^6` yourself — it's an **optional peerDependency**. The SDK doesn't bundle it; dApps that already use ethers get it for free.

### Lightweight Solana signer

```ts
import { Transaction } from '@solana/web3.js';
const signer = client.wallet.asSolanaSigner({
  walletAddress: solAddress,
  session,                              // omit for Tier 1
});

const tx = new Transaction().add(/* ... */);
tx.recentBlockhash = recentBlockhash;
tx.feePayer = new PublicKey(solAddress);

const sigB58 = await signer.signTransactionMessage(tx);
tx.addSignature(new PublicKey(solAddress), bs58.decode(sigB58));
await connection.sendRawTransaction(tx.serialize());
```

The Solana signer duck-types on `serializeMessage()` (legacy Transaction) and `message.serialize()` (VersionedTransaction). Full `@solana/wallet-adapter-base` compatibility ships in a dedicated package in Milestone 5.


---

## Sign-In With OpenFederation (M3)

A dApp says "authenticate this user and prove control of a wallet" — OpenFederation returns two artifacts:

- **`didToken`** — a short-lived JWT signed by the user's atproto signing key, containing DID, audience, wallet address, nonce, CAIP-10 subject. Verifiable via standard W3C DID resolution; no call to OpenFederation required.
- **`walletProof`** — the CAIP-122 message and the wallet's signature over it. Verifiable via chain-native tooling (ethers.verifyMessage, tweetnacl).

Together they prove: *"this DID said this wallet speaks for them, to this dApp, at this time."*

### Running the flow (embed)

```ts
// The user is already logged into OpenFederation.
const assertion = await client.signInWithOpenFederation({
  chain: 'ethereum',
  walletAddress: ethAddr,
  audience: 'https://game.example.com/login',
  statement: 'Welcome to Game. Sign to continue.',
  // Tier 2/3: pass `signer` (WalletSession or anything with signMessage).
  // Tier 1: omit `signer` — the PDS signs via the active consent grant.
});
// assertion.didToken, assertion.walletProof, assertion.did, assertion.audience
```

### Verifying offline on the dApp side

```ts
import { verifySignInAssertion } from '@openfederation/sdk';

try {
  const { did, walletAddress, nonce, audience } = await verifySignInAssertion(
    request.body.didToken,
    request.body.walletProof,
    {
      expectedAudience: 'https://game.example.com/login',
      plcUrl: 'https://plc.directory',  // optional; default shown
      // clockSkewSec: 30,              // default
    }
  );
  // Trust `did`. Issue your dApp session cookie / JWT keyed on it.
} catch (err) {
  // typed SiwofVerifyError — err.code is one of:
  //   InvalidToken, ExpiredToken, BadAudience, InvalidJwtSignature,
  //   InvalidWalletSignature, ProofMismatch, UnresolvableDid
}
```

### Security notes

- **Nonce + expiry** — the CAIP-122 message carries an `expirationTime` (default 5 min) and a random nonce. Challenges are one-shot: after a successful `signInAssert`, the challenge is deleted.
- **Message ↔ token cross-check** — verifier confirms the `walletAddress`, `chain`, and `chainIdCaip2` claims in the JWT match the `walletProof` exactly. Tampering either side fails with `ProofMismatch`.
- **Audience binding** — the `aud` claim is the normalized dApp URL; pass `expectedAudience` to the verifier to block tokens minted for a different origin.
- **Replay of the didToken** — short TTL (5 min). If longer sessions are needed, the dApp should exchange the `didToken` for its own long-lived session once on receipt.


---

## Public DID → wallet resolution (M4)

Any dApp can resolve a DID to its on-chain wallets without OpenFederation credentials, via two independent paths: a convenience XRPC, and standard W3C DID resolution.

### Resolver convenience API

```ts
// Unauthenticated.
GET /xrpc/net.openfederation.identity.getPrimaryWallet?did={did}&chain=ethereum
// → { did, handle, walletAddress, custodyTier, proof?: <service-auth JWT> }
```

The `proof` field is a short-lived JWT signed by the user's atproto key. Any dApp can verify the DID→wallet binding cryptographically by resolving the DID via standard W3C methods and checking the signature — no trust in OpenFederation required.

```ts
GET /xrpc/net.openfederation.identity.listWalletsPublic?did={did}
// → { did, handle, wallets: [ { chain, walletAddress, label, linkedAt, custodyTier, isPrimary } ] }
```

Users control which wallet is primary per chain:

```ts
// Authenticated.
POST /xrpc/net.openfederation.identity.setPrimaryWallet
body: { chain: 'ethereum', walletAddress: '0x…' }
```

### W3C DID-document augmentation

For **did:web** identities served by OpenFederation, `/.well-known/did.json` carries wallet verification methods automatically:

```json
{
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/suites/secp256k1-2019/v1",
    "https://w3id.org/security/suites/ed25519-2020/v1"
  ],
  "id": "did:web:pds.openfederation.net",
  "verificationMethod": [
    { "id": "…#atproto", "type": "Multikey", "publicKeyMultibase": "z…" },
    {
      "id": "…#wallet-ethereum",
      "type": "EcdsaSecp256k1VerificationKey2019",
      "controller": "…",
      "blockchainAccountId": "eip155:1:0xabc…"
    },
    {
      "id": "…#wallet-solana",
      "type": "Ed25519VerificationKey2020",
      "controller": "…",
      "blockchainAccountId": "solana:mainnet:9xCc…"
    }
  ]
}
```

For **did:plc** identities (where we can't modify the PLC log), the same verification-method payload is served by a sidecar endpoint:

```ts
GET /xrpc/net.openfederation.identity.getDidAugmentation?did={did}
```

A standards-compliant W3C DID resolver can merge this with the PLC doc to get the full identity surface — or dApps can query both endpoints directly.

### Why this matters

- **Zero OF lock-in.** Any DID resolver that understands `blockchainAccountId` sees OF users as full web3 citizens.
- **Proof is portable.** The resolver's `proof` JWT is offline-verifiable — cache it, serve it, forward it.
- **User-controlled surface.** Users pick which wallet shows up as "their" Ethereum or Solana address; changes are atomic, and the address stays identical across custody-tier upgrades.


---

## Tier upgrades (M2.5)

The whole point of progressive custody is that users can move *up* the security ladder as a wallet's value grows — without losing their on-chain identity. Supported transitions: **Tier 1 → Tier 2**, **Tier 1 → Tier 3**, **Tier 2 → Tier 3**. The wallet address never changes.

```ts
// Tier 1 → Tier 2: wrap the server-held key under a user passphrase.
const res = await client.wallet.upgradeToTier({
  chain: 'ethereum',
  walletAddress: t1.walletAddress,
  currentTier: 'custodial',
  newTier: 'user_encrypted',
  currentPassword,
  newPassphrase: 'correct-horse-battery-staple',
});
// res.newTier === 'user_encrypted'; wallet address unchanged.
// From now on, signing uses `client.wallet.unlockTier2(...)` locally —
// the PDS cannot sign on the user's behalf anymore.

// Tier 1 → Tier 3: export plaintext for cold storage.
const self = await client.wallet.upgradeToTier({
  chain: 'ethereum',
  walletAddress: t1.walletAddress,
  currentTier: 'custodial',
  newTier: 'self_custody',
  currentPassword,
});
// self.exportedPrivateKeyBase64 — store offline.

// Tier 2 → Tier 3: drop the server-held blob.
await client.wallet.upgradeToTier({
  chain: 'solana',
  walletAddress: t2.walletAddress,
  currentTier: 'user_encrypted',
  newTier: 'self_custody',
  currentPassword,
});
// The user already holds the passphrase; at this point they're fully self-custodial.
```

### Security model

- Every upgrade requires the user's **current account password** (re-auth). Session-hijack alone cannot upgrade a wallet.
- The one endpoint that leaks plaintext (`retrieveForUpgrade`) is gated on password re-auth AND works only for Tier 1 wallets. Tier 2 users never need it — they already hold the passphrase and can unwrap locally via `client.wallet.unlockTier2`.
- `finalizeTierChange` atomically revokes all active per-dApp consent grants for the wallet being upgraded. Those grants only make sense for Tier 1.
- Address preserved across every tier. Wallet reputation (attestations, community badges, on-chain history) travels unchanged.

### What's NOT supported

- **Downgrades** (Tier 3 → 2, Tier 2 → 1, etc.) — require handing plaintext back to OpenFederation, which breaks the Tier 2/3 contract. If a user wants lower friction, they create a new wallet at the desired tier.
- **Tier 1 ↔ Tier 1 re-provisioning** under the same address — the key would need to be regenerated, changing the address.


---

## Developer adoption — React + vanilla button (M5)

The "integrate in an afternoon" promise, made concrete. Two paths:

### React

```tsx
import { createClient } from '@openfederation/sdk';
import { OpenFederationProvider, SignInWithOpenFederation, useOFSession } from '@openfederation/react';

const client = createClient({ serverUrl, partnerKey });

function App() {
  return (
    <OpenFederationProvider client={client}>
      <Home />
    </OpenFederationProvider>
  );
}

function Home() {
  const { user, login, logout } = useOFSession();
  if (!user) return <button onClick={() => login({ identifier, password })}>Log in</button>;
  return (
    <>
      <p>Hi, @{user.handle}!</p>
      <SignInWithOpenFederation
        chain="ethereum"
        audience={window.location.origin}
        onSuccess={async (assertion) => {
          await fetch('/api/login', { method: 'POST', body: JSON.stringify(assertion) });
        }}
        onError={(err) => console.error(err)}
      />
    </>
  );
}
```

**Hooks:**

- `useOFClient()` — returns the raw `OpenFederationClient` for anything not covered by the higher-level hooks.
- `useOFSession()` — `{ user, ready, isAuthenticated, login, register, logout }`. Re-renders on auth state changes.
- `useOFWallet()` — `{ wallets, loading, error, refresh, signIn }`. `signIn` is a shorthand for `client.signInWithOpenFederation(...)`.

**Component:**

- `<SignInWithOpenFederation chain onSuccess onError?>` — drop-in button. Auto-resolves the user's wallet on that chain (override via `walletAddress`), runs the CAIP-122 → wallet.sign → assert flow, calls `onSuccess(assertion)`. Supports `render={({ onClick, loading, disabled }) => ...}` for custom styling.

### Vanilla `<script>`-tag

```html
<div id="of-signin"></div>
<script src="https://pds.openfederation.net/sdk/v1.js"></script>
<script>
  const client = OpenFederation.createClient({ serverUrl, partnerKey });
  // ...user logs in first via client.login(...)
  client.mountSignInButton(document.getElementById('of-signin'), {
    chain: 'ethereum',
    audience: window.location.origin,
    onSuccess: (assertion) => {
      fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(assertion),
      });
    },
    onError: (err) => console.error(err),
  });
</script>
```

A full working example lives at `demos/siwof-vanilla-button.html`.

### Server-side verification (no SDK required)

Any Node service can verify the `didToken` + `walletProof` the button produces:

```ts
import { verifySignInAssertion } from '@openfederation/sdk';

const { did, walletAddress, audience, nonce } = await verifySignInAssertion(
  body.didToken,
  body.walletProof,
  { expectedAudience: 'https://your-dapp.com' },
);
// Trust `did`. Issue your dApp session keyed on it.
```

The verifier pulls the issuer DID via public W3C DID resolution (did:plc + did:web), checks the JWT signature, checks the wallet signature — zero calls to OpenFederation required.

### Planned follow-ups

- `@openfederation/wagmi-connector` — wagmi v2 `Connector` so OF appears as a wallet in the EVM dApp ecosystem.
- `@openfederation/solana-adapter` — implements `@solana/wallet-adapter-base.WalletAdapter` for drop-in Solana integrations.
- Full demo dApp (`demos/siwof-dapp/`) wiring an EVM contract call + Solana message sign entirely through OpenFederation.
