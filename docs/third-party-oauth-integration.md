# OpenFederation OAuth Integration Guide

How to add "Sign in with OpenFederation" to your application. This guide covers authenticating **existing** OpenFederation/ATProto users in third-party apps using the ATProto OAuth standard.

> **Want to register NEW users instead?** See the [SDK Integration Guide](./sdk-integration-guide.md) — it lets third-party apps create accounts directly using the partner API and a lightweight JS SDK, with no invite codes and no redirects.

---

## Overview

OpenFederation PDS implements ATProto OAuth 2.0 with:

- **Pushed Authorization Requests (PAR)** — required by ATProto
- **DPoP** (Demonstrating Proof-of-Possession) — tokens are bound to the client's key
- **PKCE** (Proof Key for Code Exchange) — prevents authorization code interception
- **ES256 signed tokens** — verified via the PDS's JWKS endpoint

Users authenticate on the PDS consent screen, and your app receives a DPoP-bound access token containing the user's DID.

### The Easiest Path: Use `@atproto/oauth-client-node`

The ATProto team provides official OAuth client libraries that handle PAR, DPoP, PKCE, token refresh, and nonce management automatically. **This is strongly recommended over implementing the protocol manually.**

```
npm install @atproto/oauth-client-node
```

For browser apps:

```
npm install @atproto/oauth-client-browser
```

---

## Quick Start (Node.js Backend)

### 1. Serve Your Client Metadata

Your app must serve a JSON document at a public URL. This URL becomes your `client_id`.

**`GET https://your-app.com/oauth/client-metadata.json`**

```json
{
  "client_id": "https://your-app.com/oauth/client-metadata.json",
  "client_name": "Grvty Games",
  "client_uri": "https://your-app.com",
  "redirect_uris": ["https://your-app.com/oauth/callback"],
  "scope": "atproto transition:generic",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none",
  "application_type": "web",
  "dpop_bound_access_tokens": true
}
```

Key fields:
- `client_id` — must be the URL where this document is served
- `redirect_uris` — where the PDS sends the user after consent
- `dpop_bound_access_tokens: true` — required by ATProto OAuth
- `token_endpoint_auth_method: "none"` — public client (no client secret)

### 2. Configure the OAuth Client

```typescript
import { NodeOAuthClient } from '@atproto/oauth-client-node';

const client = new NodeOAuthClient({
  clientMetadata: {
    client_id: 'https://your-app.com/oauth/client-metadata.json',
    client_name: 'Grvty Games',
    client_uri: 'https://your-app.com',
    redirect_uris: ['https://your-app.com/oauth/callback'],
    scope: 'atproto transition:generic',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'web',
    dpop_bound_access_tokens: true,
  },

  // You must implement these stores (database-backed for production)
  stateStore: {
    async set(key: string, state: NodeSavedState): Promise<void> {
      await db.query('INSERT INTO oauth_states (key, state) VALUES ($1, $2)', [key, JSON.stringify(state)]);
    },
    async get(key: string): Promise<NodeSavedState | undefined> {
      const row = await db.query('SELECT state FROM oauth_states WHERE key = $1', [key]);
      return row ? JSON.parse(row.state) : undefined;
    },
    async del(key: string): Promise<void> {
      await db.query('DELETE FROM oauth_states WHERE key = $1', [key]);
    },
  },

  sessionStore: {
    async set(sub: string, session: NodeSavedSession): Promise<void> {
      await db.query(
        'INSERT INTO oauth_sessions (sub, session) VALUES ($1, $2) ON CONFLICT (sub) DO UPDATE SET session = $2',
        [sub, JSON.stringify(session)]
      );
    },
    async get(sub: string): Promise<NodeSavedSession | undefined> {
      const row = await db.query('SELECT session FROM oauth_sessions WHERE sub = $1', [sub]);
      return row ? JSON.parse(row.session) : undefined;
    },
    async del(sub: string): Promise<void> {
      await db.query('DELETE FROM oauth_sessions WHERE sub = $1', [sub]);
    },
  },
});
```

### 3. Initiate Login

```typescript
// Express route: user clicks "Sign in with OpenFederation"
app.post('/auth/login', async (req, res) => {
  const { handle } = req.body;
  // handle can be "alice.openfederation.net" or a DID like "did:plc:abc123"

  const url = await client.authorize(handle, {
    scope: 'atproto transition:generic',
  });

  // The library handles:
  // - Resolving handle → DID → PDS → Authorization Server metadata
  // - Generating PKCE code_verifier/challenge
  // - Creating DPoP key pair
  // - Sending PAR request to the PDS
  // - Returning the authorization URL

  res.json({ redirectUrl: url.toString() });
});
```

### 4. Handle the Callback

```typescript
app.get('/oauth/callback', async (req, res) => {
  try {
    const params = new URLSearchParams(req.url.split('?')[1]);
    const { session } = await client.callback(params);

    // session.did contains the authenticated user's DID (e.g., "did:plc:abc123")
    // session.sub is the same DID

    // Create or find user in YOUR database
    let user = await db.findUserByDid(session.did);
    if (!user) {
      user = await db.createUser({
        did: session.did,
        // Optionally resolve handle from DID document (see below)
      });
    }

    // Issue YOUR app's session token (standard JWT, cookie, etc.)
    const appToken = issueAppToken(user);

    res.redirect(`/dashboard?token=${appToken}`);
  } catch (err) {
    console.error('OAuth callback failed:', err);
    res.redirect('/login?error=auth_failed');
  }
});
```

### 5. Make Authenticated Requests to the PDS

After OAuth, you can call PDS APIs on behalf of the user:

```typescript
// Restore a session for a known user
const session = await client.restore(userDid);

// The session's fetch() automatically handles DPoP proofs and token refresh
const response = await session.fetchHandler(
  'https://pds.openfederation.net/xrpc/com.atproto.server.getSession'
);
const data = await response.json();
// { did: "did:plc:abc123", handle: "alice.openfederation.net", ... }
```

---

## Discovery Endpoints

Your app can discover PDS capabilities at these well-known URLs:

| Endpoint | Returns |
|----------|---------|
| `GET /.well-known/oauth-authorization-server` | OAuth server metadata (endpoints, algorithms, scopes) |
| `GET /.well-known/oauth-protected-resource` | Protected resource metadata |
| `GET /oauth/jwks` | Public keys for verifying access tokens |

Example — fetch server metadata:

```bash
curl https://pds.openfederation.net/.well-known/oauth-authorization-server
```

```json
{
  "issuer": "https://pds.openfederation.net",
  "authorization_endpoint": "https://pds.openfederation.net/oauth/authorize",
  "token_endpoint": "https://pds.openfederation.net/oauth/token",
  "pushed_authorization_request_endpoint": "https://pds.openfederation.net/oauth/par",
  "jwks_uri": "https://pds.openfederation.net/oauth/jwks",
  "revocation_endpoint": "https://pds.openfederation.net/oauth/revoke",
  "scopes_supported": ["atproto", "transition:generic"],
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "token_endpoint_auth_methods_supported": ["none"],
  "dpop_signing_alg_values_supported": ["ES256"],
  "code_challenge_methods_supported": ["S256"]
}
```

---

## What You Get After Authentication

After a successful OAuth flow, you have:

1. **User's DID** — e.g., `did:plc:abc123` — the universal, portable identifier
2. **DPoP-bound access token** — for calling PDS APIs on behalf of the user
3. **Refresh token** — for obtaining new access tokens when they expire

The DID is stable across handle changes, PDS migrations, and key rotations. **Store the DID as the primary user identifier in your database**, not the handle.

### Resolving a Handle from a DID

```typescript
import { DidResolver } from '@atproto/identity';

const resolver = new DidResolver({});
const doc = await resolver.resolve('did:plc:abc123');

// Extract handle from alsoKnownAs
const handle = doc?.alsoKnownAs
  ?.find(aka => aka.startsWith('at://'))
  ?.slice('at://'.length);
// → "alice.openfederation.net"
```

---

## Architecture for Game Services (Grvty)

For a game leaderboard service, the recommended architecture:

```
Browser
  │
  │  1. "Sign in with OpenFederation"
  ▼
Grvty Backend
  │
  │  2. client.authorize(handle)
  │     → Redirects to PDS consent page
  │
  │  3. PDS redirects back with auth code
  │     → client.callback(params)
  │     → Gets user's DID
  │
  │  4. Creates local user row: { did, handle, app_session_token }
  │     → Returns app session to browser
  ▼
Grvty Game API
  │
  │  5. All subsequent requests use YOUR app's session token
  │     (you do NOT need to call the PDS for every game API request)
  │
  │  6. Store scores with DID as player identifier:
  │     INSERT INTO scores (player_did, game_id, score) VALUES (...)
  ▼
Leaderboard
  │  SELECT player_did, score FROM scores
  │  WHERE game_id = 'tetris'
  │  ORDER BY score DESC LIMIT 100
```

Key points:
- Use the PDS OAuth **only for authentication** (login)
- After login, issue **your own session token** for game API calls
- Store the user's **DID** as the foreign key in your scores/achievements tables
- You do NOT need to proxy every API call through the PDS

### Database Schema (Grvty side)

```sql
-- Your users table — DID is the link to OpenFederation identity
CREATE TABLE players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  did TEXT UNIQUE NOT NULL,              -- did:plc:abc123
  handle TEXT,                           -- alice.openfederation.net (cached, may change)
  display_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW()
);

-- Game scores — references player by DID
CREATE TABLE scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_did TEXT NOT NULL REFERENCES players(did),
  game_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  metadata JSONB,                        -- game-specific replay data
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_leaderboard ON scores (game_id, score DESC);
CREATE INDEX idx_player_scores ON scores (player_did, game_id);
```

---

## Writing Attestations Back to the PDS (Optional)

If you want achievements to be portable (stored in the user's ATProto repo):

```typescript
// After the user earns an achievement, write it to their repo
const session = await client.restore(userDid);

await session.fetchHandler(
  'https://pds.openfederation.net/xrpc/com.atproto.repo.createRecord',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repo: userDid,
      collection: 'net.grvty.game.achievement',
      record: {
        $type: 'net.grvty.game.achievement',
        gameId: 'tetris',
        achievementType: 'high_score',
        value: 999999,
        attestation: {
          issuerDid: 'did:plc:grvty-service-did',
          signature: signWithServiceKey({ gameId: 'tetris', value: 999999, playerDid: userDid }),
          issuedAt: new Date().toISOString(),
        },
        createdAt: new Date().toISOString(),
      },
    }),
  }
);
```

This is optional — only do it for achievements/badges you want to survive even if Grvty shuts down.

---

## CORS Configuration

If your frontend calls the PDS directly (e.g., for the OAuth redirect), the PDS must allow your origin. Add your domain to the PDS's `CORS_ORIGINS` environment variable:

```bash
# On the OpenFederation PDS
CORS_ORIGINS=https://web.openfederation.net,https://grvty.com,https://games.grvty.com
```

The PDS exposes these headers for DPoP:

```
Access-Control-Allow-Headers: Content-Type, Authorization, DPoP
Access-Control-Expose-Headers: DPoP-Nonce, WWW-Authenticate
```

---

## Manual Implementation (Without @atproto/oauth-client-node)

If you can't use the official client library, here's the raw protocol flow. **This is significantly more work** — you must handle PAR, PKCE, DPoP key management, nonce rotation, and token refresh yourself.

### Step 1: PAR (Pushed Authorization Request)

```typescript
// Generate PKCE
const codeVerifier = crypto.randomBytes(32).toString('base64url');
const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

// Generate DPoP key pair (ES256)
const dpopKeyPair = await jose.generateKeyPair('ES256');
const dpopJwk = await jose.exportJWK(dpopKeyPair.publicKey);

// Create DPoP proof for PAR request
const dpopProof = await new jose.SignJWT({
  jti: crypto.randomUUID(),
  htm: 'POST',
  htu: 'https://pds.openfederation.net/oauth/par',
})
  .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: dpopJwk })
  .setIssuedAt()
  .sign(dpopKeyPair.privateKey);

// Send PAR
const parResponse = await fetch('https://pds.openfederation.net/oauth/par', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'DPoP': dpopProof,
  },
  body: new URLSearchParams({
    client_id: 'https://your-app.com/oauth/client-metadata.json',
    redirect_uri: 'https://your-app.com/oauth/callback',
    response_type: 'code',
    scope: 'atproto transition:generic',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state: crypto.randomBytes(16).toString('hex'),
  }),
});

const { request_uri } = await parResponse.json();
```

### Step 2: Redirect to Authorization

```typescript
const authorizeUrl = new URL('https://pds.openfederation.net/oauth/authorize');
authorizeUrl.searchParams.set('client_id', 'https://your-app.com/oauth/client-metadata.json');
authorizeUrl.searchParams.set('request_uri', request_uri);

// Redirect user's browser
res.redirect(authorizeUrl.toString());
```

### Step 3: Token Exchange

```typescript
// In your callback handler, after receiving ?code=...&state=...
const dpopProofForToken = await createDpopProof('POST', 'https://pds.openfederation.net/oauth/token');

const tokenResponse = await fetch('https://pds.openfederation.net/oauth/token', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'DPoP': dpopProofForToken,
  },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code: authorizationCode,
    code_verifier: codeVerifier,
    client_id: 'https://your-app.com/oauth/client-metadata.json',
    redirect_uri: 'https://your-app.com/oauth/callback',
  }),
});

const { access_token, refresh_token, token_type, expires_in } = await tokenResponse.json();
// token_type === 'DPoP'
```

### Step 4: Authenticated API Calls

```typescript
// Every request needs a fresh DPoP proof
const ath = crypto.createHash('sha256').update(access_token).digest('base64url');

const dpopProof = await new jose.SignJWT({
  jti: crypto.randomUUID(),
  htm: 'GET',
  htu: 'https://pds.openfederation.net/xrpc/com.atproto.server.getSession',
  ath, // access token hash
})
  .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: dpopJwk })
  .setIssuedAt()
  .sign(dpopKeyPair.privateKey);

const response = await fetch('https://pds.openfederation.net/xrpc/com.atproto.server.getSession', {
  headers: {
    'Authorization': `DPoP ${access_token}`,
    'DPoP': dpopProof,
  },
});
```

### Step 5: Token Refresh

```typescript
const dpopProofForRefresh = await createDpopProof('POST', 'https://pds.openfederation.net/oauth/token');

const refreshResponse = await fetch('https://pds.openfederation.net/oauth/token', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'DPoP': dpopProofForRefresh,
  },
  body: new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: currentRefreshToken,
    client_id: 'https://your-app.com/oauth/client-metadata.json',
  }),
});

// IMPORTANT: Always store the NEW refresh token — old one is invalidated
const { access_token: newAccess, refresh_token: newRefresh } = await refreshResponse.json();
```

---

## Rate Limits

| Endpoint | Limit |
|----------|-------|
| Global | 120 req/min per IP |
| Auth endpoints (`/oauth/*`) | 20 req/15min per IP |
| Discovery (`.well-known/*`) | 60 req/min per IP |

---

## Error Handling

The PDS returns standard OAuth error responses:

```json
{
  "error": "invalid_grant",
  "error_description": "Authorization code has expired"
}
```

Common errors:

| Error | Cause | Action |
|-------|-------|--------|
| `invalid_grant` | Code expired or reused | Restart OAuth flow |
| `invalid_dpop_proof` | DPoP signature wrong or nonce stale | Retry with fresh DPoP proof; check `DPoP-Nonce` response header |
| `unauthorized_client` | PDS can't fetch your client metadata | Ensure `client_id` URL is publicly accessible |
| `invalid_client` | Client metadata validation failed | Check required fields in metadata |
| `access_denied` | User denied consent | Show friendly message, offer retry |

When you receive a `DPoP-Nonce` header in any response, **use that nonce in your next DPoP proof**. The server rotates nonces for replay protection.

---

## Checklist

- [ ] Serve client metadata JSON at a public URL
- [ ] Install `@atproto/oauth-client-node` (recommended) or implement PAR + DPoP + PKCE manually
- [ ] Implement state store and session store (database-backed for production)
- [ ] Add login route that calls `client.authorize(handle)`
- [ ] Add callback route that calls `client.callback(params)` and extracts user DID
- [ ] Store DID as primary user identifier in your database
- [ ] Issue your own app session tokens after OAuth completes
- [ ] Handle token refresh (automatic with the official client library)
- [ ] Add your domain to PDS `CORS_ORIGINS` if your frontend calls the PDS directly
