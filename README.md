# openfederation-pds

[![License: MIT/Apache-2.0](https://img.shields.io/badge/license-MIT%2FApache--2.0-blue.svg)](./LICENSE)
[![CI](https://github.com/athlon-misa/openfederation-pds/actions/workflows/ci.yml/badge.svg)](https://github.com/athlon-misa/openfederation-pds/actions/workflows/ci.yml)

Personal Data Server (PDS) for OpenFederation communities, built on the AT Protocol.

**Website:** [openfederation.net](https://www.openfederation.net/)

## What is OpenFederation PDS?

OpenFederation PDS is a self-hostable identity and community server built on the [AT Protocol](https://atproto.com/). It gives communities full ownership of their members' identities, data, and governance — without depending on any single platform.

Users get real `did:plc` decentralized identifiers with signed data repositories they can export or migrate at any time. Communities get their own DID, member management, role-based governance with voting and delegation, and cryptographically signed attestations. Everything is stored in AT Protocol-native Merkle Search Trees, so repos are interoperable with Bluesky and other ATProto services out of the box.

The server includes configurable registration (open or invite-only), an admin dashboard, a partner API for third-party apps to register users directly, a JavaScript SDK, cross-network identity bridging (Meshtastic, Nostr, WireGuard, SSH), and full AT Protocol compliance for moderation, portability, and federation.

It is also an identity layer for the fediverse: an OpenID Connect provider lets ActivityPub apps (Mastodon, Lemmy 1.0+, Ghost, GoToSocial, …) sign people in with their account on this server or any other AT Protocol account, Bluesky included. Content stays in the apps. Live demos: [mastodon.openfederation.net](https://mastodon.openfederation.net) and [ghost.opennewsrooms.com](https://ghost.opennewsrooms.com).

## Install your own server

No technical background needed: one click creates the server, its database and the dashboard on Railway, then a setup page in your browser asks for your addresses, email and admin account and generates every secret for you.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/openfederation-pds)

Step by step: [Install on Railway](docs/INSTALL-RAILWAY.md). Operators who prefer environment variables: [RAILWAY.md](RAILWAY.md) and [DEPLOYMENT.md](DEPLOYMENT.md). Your own Linux server (a small VPS) or a Synology NAS: [install guides](docs/install/README.md), with a one-command installer for [any VPS](docs/install/vps.md), plus step-by-step guides for [netcup](docs/install/netcup.md) and [Synology](docs/install/synology.md).

Compare costs, minimum requirements, and tradeoffs for VPS providers, shared hosting, home servers, and NAS platforms in the [hosting comparison](docs/HOSTING-COMPARISON.md).

## Setup (development)

```bash
npm install
cp .env.example .env
# Edit .env with your database credentials and secrets
./scripts/init-db.sh   # or: npm run db:init
npm run build
npm start
```

### Web UI

```bash
cd web-interface
npm install
cp .env.example .env.local
# Edit .env.local — set NEXT_PUBLIC_PDS_URL to your PDS server URL
npm run build
npm start              # Starts on $PORT (default 3000, the PDS's dev port too: set PORT when both run on one machine)
```

For local development, run both in parallel:
```bash
# Terminal 1: PDS API (port 3000, PORT in .env)
npm run dev

# Terminal 2: Web UI (port 3001)
cd web-interface && npm run dev
```

The Docker image and the appliance run the PDS on port 8080 inside the container.

### Required Environment Variables

| Variable | Required In | Description |
|----------|:---:|-------------|
| `AUTH_JWT_SECRET` | Production | Random string, minimum 32 characters. A production server with neither this nor `KEY_ENCRYPTION_SECRET` (and no settings file) starts in setup mode, serving only the `/setup` page that generates them; with `OPENFEDERATION_SETUP=off` it refuses to start instead. |
| `KEY_ENCRYPTION_SECRET` | Production | Encrypts recovery/signing keys at rest. Must be set before creating communities. |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | All | PostgreSQL connection. |
| `DB_SSL` | Production | `true` for SSL connections. |
| `CORS_ORIGINS` | Production | Web UI URL (e.g., `https://your-web-ui.up.railway.app`). |
| `INVITE_REQUIRED` | All | `true` (default) for invite-only registration. |
| `BOOTSTRAP_ADMIN_EMAIL` / `HANDLE` / `PASSWORD` | First run | Creates an admin user on startup. |

See `.env.example` for all options including CORS, token TTLs, rate limits and pool tuning. Many policy settings (invites, account approval, custody modes, pen names, migration, federation peers, the dashboard's look) can also be changed by an admin on Admin → Server settings without a restart; a setting given as an environment variable is fixed there (read-only).

## First Admin Login

On a production server installed with the setup page (Railway template, appliance), the page creates the first admin account: open `/setup`, enter the one-time setup code from the server log, and fill in the admin's handle, email and password.

Without the setup page:

1. Set `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_HANDLE`, and `BOOTSTRAP_ADMIN_PASSWORD` in your environment
2. Start the PDS with a connected database — check logs for `✓ Bootstrap admin user created`
3. Open the Web UI and log in with the handle and password you configured
4. You have full admin access: create communities, approve users, manage invites, moderate communities
5. After verifying login, remove the `BOOTSTRAP_ADMIN_*` variables — the account persists in the database

## Deployment

For Railway deployment (recommended), see **[RAILWAY.md](./RAILWAY.md)**.

A Railway deployment has three parts from the same repo:
- **PDS API** (root directory) — Express.js backend on standard HTTPS
- **PostgreSQL** — the PDS's database
- **Web UI** (`web-interface/` directory) — Next.js dashboard on standard HTTPS

Running your own PLC directory (`plc-server/`, with its own PostgreSQL) is optional; the public `https://plc.openfederation.net` works without one.

For Docker and other platforms, see **[DEPLOYMENT.md](./DEPLOYMENT.md)**.

## Authentication and Admin Flow

### Roles
- **admin**: full access — manage users, communities, moderation (suspend/takedown), server settings, audit log, server stats
- **moderator**: approve/reject users, create and list invites, list accounts, suspend/unsuspend accounts
- **partner-manager**: create, list, verify and revoke partner API keys
- **auditor**: read-only — audit log, server config and stats, account, invite and partner key lists, account moderation status
- **user**: can create communities once approved

Admins assign roles on Admin → Users, or with `ofc account set-roles`.

### Account Status Lifecycle

| Status | Description |
|--------|-------------|
| `pending` | Newly registered, awaiting admin/moderator approval. |
| `approved` | Active account, can log in and use the system. |
| `rejected` | Registration denied by admin/moderator. |
| `disabled` | Previously approved account disabled by admin. |
| `suspended` | Admin-suspended (reversible). User cannot log in or refresh tokens. |
| `takendown` | Admin takedown (requires prior export per AT Protocol "free to go" principle). |
| `deactivated` | User self-deactivated. Can reactivate via `activateAccount`. |

```
pending → approved → suspended → approved     (admin suspend/unsuspend)
                   → deactivated → approved   (user self-deactivate/reactivate)
                   → suspended → takendown    (admin escalation, requires export)
                   → takendown → approved     (admin reversal)
```

### Typical Flow

1. The first admin is created by the setup page, or on first startup from the `BOOTSTRAP_ADMIN_*` variables.
2. Admin creates invite codes (when `INVITE_REQUIRED=true`, the default).
3. Users register with an invite code (status = `pending`).
4. Admin/moderator approves the user. With `ACCOUNT_APPROVAL=automatic` (or "Approve new accounts automatically" on Admin → Server settings) new accounts start `approved` and this step is skipped.
5. User logs in and creates communities.

### Password Requirements

Passwords must be 10-128 characters and contain at least 3 of 4 categories: lowercase, uppercase, digit, special character.

### Handle Requirements

Handles must be 3-30 characters: lowercase letters, numbers, and hyphens. No leading/trailing hyphens, no consecutive hyphens. Some names (admin, root, system, etc.) are reserved.

## API Endpoints

All endpoints are XRPC methods at `/xrpc/{nsid}`: the standard `com.atproto.*` methods (sessions, repos, sync, admin moderation) plus `net.openfederation.*` methods for accounts, communities, governance, partners, identity bridging, pen names, migration and server settings. The full list, with the auth each one needs, is in **[docs/API.md](./docs/API.md)**. Formal lexicon schemas for the custom endpoints are in `src/lexicon/`.

Both communities and user accounts follow the AT Protocol "free to go" principle:
- Owners/users can always export their data
- Suspended communities/accounts remain readable for export purposes
- Takedown requires that an export has been performed first
- A community moves to another PDS with its owner's PLC rotation key (see `docs/adr/ADR-002-community-migration.md`); the DID holder initiates the move, not the PDS admin
- Users can self-deactivate and later reactivate without admin involvement
- Admin-suspended accounts cannot be reactivated by the user — only admins can unsuspend
- All moderation actions (suspend, unsuspend, takedown, delete) are recorded in the audit log

Partner keys (`X-Partner-Key`) let third-party apps register users without an invite code. A key with a ticket key set requires a registration ticket signed by the partner's backend: the account is approved and gets tokens. A key without one creates a `pending` account that becomes usable once its email is verified, and returns no tokens. See the [SDK Integration Guide](./docs/sdk-integration-guide.md).

## Web Interface

The web UI (`web-interface/`) is built with Next.js 16, shadcn/ui, React Query v5, and kbar.

### Features

- **Sidebar shell** with navigation (Dashboard, My Communities, Explore) and admin section
- **Command palette** (Ctrl+K) for quick navigation and admin actions
- **Dashboard** with stat cards and quick actions
- **Community management**: create, browse, join, leave, member management, settings, moving a community to another server
- **Explore**: this server's public communities and, under Federated, those of the peer servers it knows
- **Account area**: identity and keys, devices, recovery, history, moving the account to another server
- **Pen names**: create pen names and sign in as one
- **Themes**: pick how the dashboard looks; the admin sets the default
- **Admin pages**: Users (search/filter/approve/reject, roles), Communities (suspend/unsuspend/takedown/delete), Invites, Partner keys, Server settings (runtime settings without a restart), Audit Log (filter/search)
- **Data tables** with server-side pagination via @tanstack/react-table

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router) |
| UI | shadcn/ui + Tailwind CSS |
| Server state | React Query v5 (30s staleTime, 5min gcTime) |
| Auth state | Zustand (persisted refresh token) |
| Data tables | @tanstack/react-table |
| Command palette | kbar |
| Notifications | Sonner |

## Example Requests

Create invite (admin/moderator):
```bash
curl -X POST http://localhost:3000/xrpc/net.openfederation.invite.create \
  -H "Authorization: Bearer <accessJwt>" \
  -H "Content-Type: application/json" \
  -d '{"maxUses":1}'
```

Register (invite required):
```bash
curl -X POST http://localhost:3000/xrpc/net.openfederation.account.register \
  -H "Content-Type: application/json" \
  -d '{
    "handle": "alice",
    "email": "alice@example.com",
    "password": "MyStr0ng!Pass",
    "inviteCode": "<invite>"
  }'
```

Approve user (admin/moderator):
```bash
curl -X POST http://localhost:3000/xrpc/net.openfederation.account.approve \
  -H "Authorization: Bearer <accessJwt>" \
  -H "Content-Type: application/json" \
  -d '{"handle":"alice"}'
```

Login (approved user):
```bash
curl -X POST http://localhost:3000/xrpc/com.atproto.server.createSession \
  -H "Content-Type: application/json" \
  -d '{"identifier":"alice","password":"MyStr0ng!Pass"}'
```

Create community (approved user):
```bash
curl -X POST http://localhost:3000/xrpc/net.openfederation.community.create \
  -H "Authorization: Bearer <accessJwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "handle": "my-community",
    "didMethod": "plc",
    "displayName": "My Community"
  }'
```

Create a partner API key (admin):
```bash
curl -X POST http://localhost:3000/xrpc/net.openfederation.partner.createKey \
  -H "Authorization: Bearer <accessJwt>" \
  -H "Content-Type: application/json" \
  -d '{"name":"My App","partnerName":"myapp.com","allowedOrigins":["https://myapp.com"]}'
# Returns raw key ONCE — save it immediately
```

Register via partner key (no invite needed):
```bash
curl -X POST http://localhost:3000/xrpc/net.openfederation.partner.register \
  -H "X-Partner-Key: ofp_abc123..." \
  -H "Content-Type: application/json" \
  -d '{"handle":"alice","email":"alice@example.com","password":"MyStr0ng!Pass"}'
# Without a ticket key on the partner key: user is pending, email verification is sent, no tokens.
# With one, add "ticket" (signed by your backend): user is approved and tokens are returned.
```

Export community (owner):
```bash
curl 'http://localhost:3000/xrpc/net.openfederation.community.export?did=did:plc:abc123' \
  -H "Authorization: Bearer <accessJwt>"
```

Suspend a user account (admin):
```bash
curl -X POST http://localhost:3000/xrpc/com.atproto.admin.updateSubjectStatus \
  -H "Authorization: Bearer <accessJwt>" \
  -H "Content-Type: application/json" \
  -d '{"subject":{"did":"did:plc:user123"},"deactivated":{"applied":true,"ref":"Violation of ToS"}}'
```

Unsuspend a user (admin):
```bash
curl -X POST http://localhost:3000/xrpc/com.atproto.admin.updateSubjectStatus \
  -H "Authorization: Bearer <accessJwt>" \
  -H "Content-Type: application/json" \
  -d '{"subject":{"did":"did:plc:user123"},"deactivated":{"applied":false}}'
```

Check account moderation status (admin):
```bash
curl 'http://localhost:3000/xrpc/com.atproto.admin.getSubjectStatus?did=did:plc:user123' \
  -H "Authorization: Bearer <accessJwt>"
```

Export user data (self or admin):
```bash
curl 'http://localhost:3000/xrpc/net.openfederation.account.export?did=did:plc:user123' \
  -H "Authorization: Bearer <accessJwt>"
```

Deactivate own account (user):
```bash
curl -X POST http://localhost:3000/xrpc/com.atproto.server.deactivateAccount \
  -H "Authorization: Bearer <accessJwt>"
```

Reactivate own account (user):
```bash
curl -X POST http://localhost:3000/xrpc/com.atproto.server.activateAccount \
  -H "Authorization: Bearer <accessJwt>"
```

Delete a user account (admin — permanent):
```bash
curl -X POST http://localhost:3000/xrpc/com.atproto.admin.deleteAccount \
  -H "Authorization: Bearer <accessJwt>" \
  -H "Content-Type: application/json" \
  -d '{"did":"did:plc:user123"}'
```

Logout:
```bash
curl -X POST http://localhost:3000/xrpc/com.atproto.server.deleteSession \
  -H "Authorization: Bearer <accessJwt>" \
  -H "Content-Type: application/json" \
  -d '{"refreshJwt":"<refreshJwt>"}'
```

## JavaScript SDK (`@open-federation/sdk`)

A browser SDK for third-party apps to register and log in users. Available via npm or as a `<script>` tag served from the PDS.

**Script tag** (self-contained, about 270 KB gzipped):
```html
<script src="https://pds.openfederation.net/sdk/v1.js"></script>
<script>
  const ofd = OpenFederation.createClient({
    serverUrl: 'https://pds.openfederation.net',
    partnerKey: 'ofp_your_key_here',
  });
  const user = await ofd.register({ handle: 'alice', email: 'a@b.com', password: 'Str0ng!Pass1' });
  console.log(user.did); // "did:plc:..."; pending until the email is verified, unless your backend signed a ticket
</script>
```

**npm**:
```bash
npm install @open-federation/sdk
```
```typescript
import { createClient } from '@open-federation/sdk';
const ofd = createClient({ serverUrl: '...', partnerKey: '...' });
```

See [SDK Integration Guide](./docs/sdk-integration-guide.md) for complete API reference, error handling, and full examples.

## Rate Limits

| Scope | Limit |
|-------|-------|
| Global | 120 requests/minute per IP |
| Authentication | 20 attempts per 15 minutes per IP |
| Registration | 5 per hour per IP |
| Community creation | 10 per hour per IP |
| Partner registration | Configurable per key (default 100/hour) |

Each limit is configurable (`GLOBAL_RATE_LIMIT`, `AUTH_RATE_LIMIT`, `REGISTRATION_RATE_LIMIT`, `CREATE_RATE_LIMIT`, ...); `.env.example` lists them all with their defaults.

## CLI (`ofc`)

The `ofc` CLI follows [clig.dev](https://clig.dev/) best practices with `ofc <noun> <verb>` subcommands, `--json` output, XDG session storage, and secure password handling (no passwords on the command line). See `cli/README.md` for full documentation.

```bash
npm run build
npm run cli -- auth login -u admin          # Prompts for password interactively
npm run cli -- invite create
npm run cli -- account list-pending
npm run cli -- account approve alice
npm run cli -- community create -n my-community -d "My Community"
npm run cli -- community list-mine --json   # Machine-readable JSON output
npm run cli -- auth whoami
npm run cli -- auth logout
```

## Third-Party Integration

- **[SDK Integration Guide](./docs/sdk-integration-guide.md)** — Register and log in users from your website using the JS SDK and partner API keys. Best for game platforms and apps creating new accounts.
- **[OAuth Integration Guide](./docs/third-party-oauth-integration.md)** — "Sign in with OpenFederation" using ATProto OAuth. Best for authenticating existing ATProto users.
- **[Sign-in for other apps (OpenID Connect)](./docs/OIDC.md)** — Let Mastodon, Lemmy 1.0+, GoToSocial or any OIDC client sign people in with any AT Protocol account (Bluesky, OpenFederation, a self-hosted PDS). `ofc oidc add --preset mastodon …` prints the app's configuration. Design: [ADR-005](./docs/adr/ADR-005-oidc-provider.md).
- **[Ghost bridge](./bridges/ghost/README.md)** — Readers and staff of a Ghost site sign in with their AT Protocol account; includes an SSO adapter for Ghost admin and the Open Newsrooms theme. Deployment: [deploy/ghost](./deploy/ghost/README.md).
- **[Joining the AT Protocol network](./docs/ATPROTO-NETWORK.md)** — Reading DIDs from several PLC directories, mirroring into plc.directory, wildcard handle DNS, and `ofc identity check`.

### Live demos

| Demo | What it shows | Tested |
|---|---|---|
| [mastodon.openfederation.net](https://mastodon.openfederation.net) | Mastodon 4.5 whose only sign-in is "your AT Protocol account" through pds.openfederation.net | Bluesky and OpenFederation accounts sign in; the same DID returns to the same Mastodon account; sign-out returns to Mastodon |
| [ghost.opennewsrooms.com](https://ghost.opennewsrooms.com) | Ghost 6 with self-hosted ActivityPub and the Open Newsrooms theme | Readers sign in with Bluesky (email confirmed once) and OpenFederation; staff sign in to Ghost admin with OpenFederation; Mastodon finds and follows `@index@ghost.opennewsrooms.com` |

## Security

- JWT access tokens with configurable TTL. Refresh token rotation with reuse detection.
- Recovery keys and signing keys encrypted at rest (AES-256-GCM).
- Primary rotation key returned to user once, never stored by the server.
- Sanitized error messages. Request body limit of 256kb.
- Audit logging for all admin, moderation, and security-relevant actions.
- Community and account moderation follows AT Protocol composable moderation: suspend (reversible) and takedown (requires prior export). Admin accounts are protected from moderation actions.
- Approve/reject endpoints guard against re-processing already-resolved users.
- Partner API keys are hashed (SHA-256) in the database and never stored in plaintext. Origin validation and per-key rate limiting protect against abuse.

## Lexicon Schemas

AT Protocol lexicon definitions for custom `net.openfederation.*` endpoints are in `src/lexicon/`. These define the formal request/response schemas following the [AT Protocol Lexicon specification](https://atproto.com/specs/lexicon).

## Development

```bash
npm run dev          # Start PDS with ts-node (ESM), port 3000
npm run build        # TypeScript compile + SDK build
npm run build:sdk    # Build SDK only (packages/openfederation-sdk)
npm run db:check     # Check database connectivity
npm run cli:dev      # Run CLI without building
npm run plc:dev      # Start local PLC directory on port 2582
```
